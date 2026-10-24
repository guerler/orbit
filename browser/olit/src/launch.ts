/** Launch and save logic shared by both modes. */
import {
  cannotStart,
  currentHistoryLaunch,
  type Galaxy,
  type LaunchContext,
  type OrbitBrowserOptions,
  type SessionStore,
} from "@galaxyproject/orbit-browser";
import { OLIT_ARTIFACTS } from "./artifacts/renderers";
import { OLIT_BRAND } from "./brand";
import type { OlitIncoming } from "./incoming";
import { resolveLaunch, summarize } from "./seed-dataset";
import { NotYours, type Opened, type Saves, type Store } from "./stores/store";

export const PLUGIN_NAME = "olit";

export const isDev = () => (import.meta as any).env.DEV;

/** What to open: a saved conversation, or a new one on a dataset. */
export interface LaunchRequest {
  savedId?: string;
  datasetId?: string;
  /** Question to ask in a new conversation once the page is ready. */
  question?: string;
}

/** Callbacks that report the shown conversation to Galaxy. */
export type Report = Pick<SessionStore, "savedState" | "active">;

/** Builds the shell options for opening `request` and saving to `store`. */
export function shellOptions(
  incoming: OlitIncoming,
  store: Store,
  request: LaunchRequest,
  report: Report,
): OrbitBrowserOptions {
  const base = isDev() ? "" : `static/plugins/visualizations/${PLUGIN_NAME}/`;
  // Set at launch, which always runs before the first save.
  let saves: Saves | undefined;
  return {
    galaxyRoot: incoming.root,
    datasetId: incoming.datasetId,
    galaxyChatUrl: `${incoming.root}api/plugins/${PLUGIN_NAME}`,
    pyodideURL: new URL(`${incoming.root}${base}static/pyodide`, document.baseURI).href,
    createWorker: () => new Worker(new URL("./worker.ts", import.meta.url), { type: "module" }),
    ...OLIT_ARTIFACTS,
    brand: OLIT_BRAND,
    launch: (galaxy) => {
      saves = store.connect(galaxy);
      return launch(galaxy, saves, request);
    },
    sessions: {
      kind: store.kind,
      save: (document, id) => saves!.save(document, id),
      ...report,
      ...store.wording,
    },
  };
}

/**
 * Opens the saved conversation if possible, otherwise starts a new one and says why. Never opens
 * another user's save.
 */
async function launch(
  galaxy: Galaxy,
  saves: Saves,
  { savedId, datasetId, question }: LaunchRequest,
): Promise<LaunchContext> {
  let problem: string | undefined;
  let notYours: string | undefined;
  let opened: Opened | null = null;
  if (savedId) {
    opened = await saves.load(savedId).then(
      (found) => {
        if (!found) problem = "it is not a conversation this version can open";
        return found;
      },
      (e) => {
        if (e instanceof NotYours) notYours = e.message;
        else problem = String((e as Error)?.message ?? e);
        return null;
      },
    );
  }
  let context: LaunchContext;
  if (notYours) {
    context = {
      stop: `Only your own saved conversations can be opened, and ${savedId} is not one: ${notYours}.`,
    };
  } else if (opened) {
    context = await continued(galaxy, savedId!, opened);
  } else {
    context = await fresh(galaxy, datasetId);
    if (problem) {
      context.savedProblem =
        `Could not open saved conversation ${savedId} (${problem}). This is the history's ` +
        "conversation in this browser instead, and Save stores it as a new one.";
    }
  }
  return question ? { ...context, ask: question } : context;
}

/**
 * Opens a saved conversation in its own history. A chat saved without a session continues in the
 * current history.
 */
async function continued(galaxy: Galaxy, id: string, opened: Opened): Promise<LaunchContext> {
  let context: LaunchContext;
  if (opened.held) {
    const current = await currentHistoryLaunch(galaxy);
    context = current.historyId
      ? {
          saved: { id, document: { ...opened.document, history_id: current.historyId } },
          greeting: opened.held.note,
        }
      : current;
  } else {
    context = { saved: { id, document: opened.document } };
  }
  return context;
}

/** Starts a new conversation on the given dataset, or in the current history. */
async function fresh(galaxy: Galaxy, datasetId: string | undefined): Promise<LaunchContext> {
  let context: LaunchContext;
  if (datasetId) {
    const found = await resolveLaunch(galaxy, datasetId);
    if (found.historyId) {
      context = {
        historyId: found.historyId,
        ...(found.dataset ? { greeting: summarize(found.dataset) } : {}),
      };
    } else {
      context = { stop: cannotStart(`dataset ${datasetId}`, found.problem) };
    }
  } else {
    context = await currentHistoryLaunch(galaxy);
  }
  return context;
}
