/** Olit: Orbit's browser shell as a Galaxy visualization plugin, or as Galaxy's AI chat. */
import { CHAT_VIEW, hostSearch, parseIncoming, VISUALIZATION_VIEW, type View } from "./incoming";
import { isDev } from "./launch";
import { chatMode } from "./modes/chat";
import type { OlitMode } from "./modes/mode";
import { visualizationMode } from "./modes/visualization";

const MODES: Record<View, OlitMode> = {
  [VISUALIZATION_VIEW]: visualizationMode,
  [CHAT_VIEW]: chatMode,
};

/** Dev-only: synthesize data-incoming from the plugin XML (no framework host). */
async function seedDevIncoming(container: HTMLElement): Promise<void> {
  const { parseXML } = await import("galaxy-charts-xml-parser");
  const pageUrl = new URL(window.location.href);
  container.dataset.incoming = JSON.stringify({
    root: "/",
    visualization_config: {
      dataset_id: pageUrl.searchParams.get("dataset_id") || undefined,
      settings: {},
    },
    visualization_plugin: await parseXML("olit.xml"),
  });
}

/**
 * Opening a saved visualization opens that conversation; otherwise the history's own, on the
 * dataset Galaxy launched Olit from.
 */
async function launch(
  galaxy: Galaxy,
  visualizationId: string | undefined,
  datasetId: string | undefined,
): Promise<LaunchContext> {
  let savedProblem: string | undefined;
  let notYours: string | undefined;
  const document = visualizationId
    ? await savedSessions(galaxy)
        .load(visualizationId)
        .then(
          (found) => {
            if (!found) savedProblem = "it is not an Olit session this version can open";
            return found;
          },
          (e) => {
            if (e instanceof NotYours) notYours = e.message;
            else savedProblem = String((e as Error)?.message ?? e);
            return null;
          },
        )
    : null;
  // Nothing of another user's session is used, not even the dataset Galaxy launched it with.
  if (notYours) {
    return {
      stop:
        `Olit opens only your own saved conversations, and ${visualizationId} is not ` +
        `one: ${notYours}.`,
    };
  }
  const unopened = savedProblem
    ? {
        savedProblem:
          `Could not open saved conversation ${visualizationId} (${savedProblem}). This ` +
          "is the history's conversation in this browser instead, and Save stores it as a new one.",
      }
    : {};
  // A saved session carries its own history; otherwise the launch decides it.
  if (document && visualizationId) {
    return { saved: { id: visualizationId, document } };
  }
  if (!datasetId) {
    return { ...(await currentHistoryLaunch(galaxy)), ...unopened };
  }
  const found = await resolveLaunch(galaxy, datasetId);
  if (!found.historyId) {
    return { stop: cannotStart(`dataset ${datasetId}`, found.problem) };
  }
  return {
    historyId: found.historyId,
    ...unopened,
    ...(found.dataset ? { greeting: summarize(found.dataset) } : {}),
  };
}

/** The hosting Galaxy page's query; its iframe has no src, so it shares Galaxy's origin. */
function hostSearch(): string {
  try {
    return window.parent === window ? "" : window.parent.location.search;
  } catch {
    return "";
  }
}

async function main() {
  const scriptUrl = new URL(import.meta.url);
  const containerId = scriptUrl.searchParams.get("container") || "app";
  const container = document.getElementById(containerId);
  // Mount only on an element that has data-incoming, as Galaxy provides for plugins.
  if (container && (isDev() || container.dataset.incoming !== undefined)) {
    if (isDev()) {
      await seedDevIncoming(container);
    }
    const incoming = parseIncoming(container, hostSearch());
    await MODES[incoming.view].mount(container, incoming);
  }
}

void main();
