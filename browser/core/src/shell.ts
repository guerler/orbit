/**
 * Orbit's browser shell: mounts Orbit's ChatPanel, starts the agent worker, drives the chat. A
 * flavor mounts it with its own worker, artifact kinds, launch context and session store.
 */
import "../../../app/src/renderer/styles.css";
import "./shell.css";
import orbitStyles from "../../../app/src/renderer/styles.css?inline";
import shellStyles from "./shell.css?inline";
import fontStyles from "../../../app/src/renderer/assets/fonts/fonts.css?inline";
import { useChatMarkdown } from "./chat-markdown";
import { settlePlanDrafts } from "./plan-drafts";

import { ChatPanel } from "../../../app/src/renderer/chat/chat-panel";
import { applyOrbitTheme } from "../../../app/src/renderer/theme";

import { answerPlan } from "./session/plans";
import {
  heldNotice,
  outcomeNotice,
  readyNotices,
  settledNotices,
  type Notice,
} from "./session/notices";
import { buildConfig } from "./config";
import { saveCredentials } from "./credentials";
import { ensureCredentials, switchProvider } from "./credentials-modal";
import { offeredProviders } from "./agent/providers";
import { ChatView, type RunOutcome } from "./session/transcript";

import { createConfirm } from "./confirm-modal";
import { conversationMarkdown, markdownName } from "./session/markdown";
import { droppedItems, itemReference, withReferences } from "./history-drop";
import { DEFAULT_BRAND, type Brand } from "./agent/brand";
import { AgentClient } from "./agent/client";
import { briefly, connectGalaxy, type Galaxy } from "./agent/galaxy";
import type { GalaxyStatus } from "./agent/prompt";
import type { SessionDocument } from "./agent/saved";
import {
  kindsWithoutRenderer,
  paneArtifacts,
  registerArtifactRenderers,
  renderArtifact,
  type Artifact,
  type ArtifactRenderers,
} from "./artifacts";
import { registerArtifactKinds, type ArtifactKind } from "./artifacts/kinds";
import { hostOf, mountLayout } from "./layout";
import { mountArtifactPane } from "./artifact-pane";
import { mountUsageBar } from "./usage-bar";
import { mountBuildStamp } from "./build-stamp";
import { localTime } from "./galaxy-time";
import { createRetryNotice } from "./retry-notice";
import { isDictationShortcut, mountDictation, rememberedConsent } from "./dictation";

export type { ArtifactRenderer, ArtifactRenderers } from "./artifacts";

const MAX_INPUT_HEIGHT = 150;

/** A url the worker can use: resolved against the page. */
const absolute = (url: string) => new URL(url, document.baseURI).href;

/** Where a conversation starts, and what the page says about it once the agent is ready. */
export interface LaunchContext {
  historyId?: string;
  /** A saved session the page was opened on: said as "Opened a saved conversation." */
  saved?: { id: string; document: SessionDocument };
  /** Why a saved session could not be opened, as a whole line, said before the ready line. */
  savedProblem?: string;
  /** Why the page cannot start at all, as a whole line, said in place of a conversation. */
  stop?: string;
  /** Said after the ready line. */
  greeting?: string;
  /** Question to ask in a new conversation once the page is ready. */
  ask?: string;
}

/** Where a conversation is saved, when the flavor saves them: absent, the page offers no Save. */
export interface SessionStore {
  /**
   * Store name. Saves are keyed by name and id, since two stores can use the same id.
   */
  kind: string;
  save(document: SessionDocument, id?: string): Promise<string>;
  /** Whether the conversation as it stands is saved, for a host that asks before closing. */
  savedState(saved: boolean): void;
  /** Said once a save succeeds. */
  savedNote: string;
  /** The Save button's tooltip, saying where a save goes. */
  label?: string;
  /** Appended when the browser can't keep the conversation, saying how to keep it anyway. */
  keepHint?: string;
  /** Appended when the browser keeps nothing for this history, saying where saves reopen from. */
  reopenHint?: string;
  /**
   * Called with the shown saved session's id at launch and after a save, and with null for a new
   * unsaved conversation.
   */
  active?(id: string | null): void;
}

export interface OrbitBrowserOptions {
  galaxyRoot: string;
  datasetId?: string;
  /**
   * Galaxy's AI proxy for the flavor's visualization plugin (`<root>api/plugins/<plugin>`), which
   * the "galaxy" provider talks to; it is the first-launch default when given. A flavor Galaxy
   * doesn't host as a plugin has none, and its picker offers every other provider.
   */
  galaxyChatUrl?: string;
  pyodideURL: string;
  /** The flavor's agent worker; see AgentClient. */
  createWorker: () => Worker;
  artifactKinds?: readonly ArtifactKind<any>[];
  renderers?: ArtifactRenderers;
  launch?: (galaxy: Galaxy) => Promise<LaunchContext>;
  sessions?: SessionStore;
  /** The same brand as the flavor's worker, whose stored state the page reads under it. */
  brand?: Brand;
  pool?: string;
  signal?: AbortSignal;
}

/** The mounted page, as its host sees it. */
export interface OrbitBrowserHandle {
  /** End the agent's worker, detach what the shell attached to `container` and outside it, and empty it. */
  dispose(): void;
  /**
   * Ask `question` in a new conversation once the page is ready, after the questions asked before
   * it. A run in progress is held, as New would hold it.
   */
  ask(question: string): void;
  /** Resolves once no save is running; a host waits for it before it replaces the conversation. */
  settled(): Promise<void>;
}

/** With no dataset to start from, the conversation is Galaxy's current history's. */
export async function currentHistoryLaunch(galaxy: Galaxy): Promise<LaunchContext> {
  try {
    const id = (await galaxy.get("history/current_history_json"))?.id;
    if (typeof id === "string" && id) return { historyId: id };
    return { stop: cannotStart("the current history") };
  } catch (e) {
    const problem = String((e as Error)?.message ?? e);
    return { stop: cannotStart("the current history", problem) };
  }
}

/** The line a launch stops with when Galaxy names no history to work in. */
export const cannotStart = (what: string, problem = "it named no history") =>
  `Could not read ${what} from Galaxy (${problem}). This works in a history, so it ` +
  "cannot start; reload to try again.";

/** Grow the composer with its content, up to a few lines. */
function autosize(input: HTMLTextAreaElement): void {
  input.style.height = "auto";
  // scrollHeight excludes the border that border-box counts in height.
  const chrome = input.offsetHeight - input.clientHeight;
  const wanted = input.scrollHeight + chrome;
  input.style.height = Math.min(wanted, MAX_INPUT_HEIGHT) + "px";
  input.style.overflowY = wanted > MAX_INPUT_HEIGHT ? "auto" : "hidden";
}

/**
 * Mount the shell into `container`, one mount per page or shadow root. It puts the theme on the
 * root element and the pane's state and drag cursor on body, or on the shadow host, where it also
 * adds its styles. It sizes the pane from the window's width, injects fixed element ids, configures
 * the shared `marked`, and its worker holds a per-origin tab lock.
 */
export async function mountOrbitBrowser(
  container: HTMLElement,
  options: OrbitBrowserOptions,
): Promise<OrbitBrowserHandle> {
  registerArtifactKinds(options.artifactKinds ?? []);
  registerArtifactRenderers(options.renderers ?? {});
  // Caught at mount rather than when the first artifact of the kind arrives mid-conversation.
  const undrawable = kindsWithoutRenderer();
  if (undrawable.length) {
    throw new Error(`No renderer is registered for artifact kinds: ${undrawable.join(", ")}.`);
  }
  const sessions = options.sessions;
  const brand = options.brand ?? DEFAULT_BRAND;
  const target = {
    root: options.galaxyRoot,
    datasetId: options.datasetId,
    galaxyChatUrl: options.galaxyChatUrl,
  };
  const host = hostOf(container);
  const styles: HTMLStyleElement[] = [];
  if (host) {
    const inside = document.createElement("style");
    inside.textContent = orbitStyles + shellStyles;
    const fonts = document.createElement("style");
    fonts.textContent = fontStyles;
    (container.getRootNode() as ShadowRoot).append(inside);
    document.head.append(fonts);
    styles.push(inside, fonts);
  }
  applyOrbitTheme("light", host ?? document.documentElement);

  const el = mountLayout(container, { save: !!sessions });
  if (el.save && sessions?.label) el.save.title = sessions.label;
  const mounted = new AbortController();
  let started: AgentClient | undefined;
  /** Questions from the host, each asked in a new conversation, in the order they came. */
  const asks: string[] = [];
  /** Asks the next question once the page can; set once the page is up. */
  let askNext = () => {};
  /** The save running, if any: nothing changes the conversation until it ends. */
  let saving: Promise<void> | undefined;
  const handle: OrbitBrowserHandle = {
    dispose() {
      mounted.abort();
      retryNotice.stop();
      started?.close();
      chat.dispose();
      container.replaceChildren();
      styles.forEach((style) => style.remove());
    },
    ask(question) {
      asks.push(question);
      askNext();
    },
    settled: async () => saving,
  };
  const artifactPane = mountArtifactPane(container, mounted.signal, brand);
  useChatMarkdown();
  const chat = new ChatPanel(el.messages);
  /** An info line as text: the vendored panel parses it as HTML, and dataset names, ids and
   * approval prompts reach it. */
  const info = (text: string) => {
    const line = chat.addInfoMessage("");
    line.textContent = text;
    return line;
  };
  const retryNotice = createRetryNotice({ addInfoMessage: info });
  const say = (notice: Notice | undefined) => {
    if (notice?.level === "error") chat.addErrorMessage(notice.text);
    else if (notice) info(notice.text);
  };

  options.signal?.addEventListener("abort", () => handle.dispose(), {
    once: true,
    signal: mounted.signal,
  });
  if (options.signal?.aborted) handle.dispose();

  // Ask for a provider/key before the worker starts.
  const offered = offeredProviders(!!options.galaxyChatUrl);
  let creds = await ensureCredentials(container, brand, offered, mounted.signal);
  if (mounted.signal.aborted) return handle;
  const config = buildConfig(target, creds);
  const rootPath = new URL(config.galaxy_root, document.baseURI).pathname;
  chat.setGalaxyServerUrl(absolute(config.galaxy_root));
  const credentials = (process.env.credentials as RequestCredentials) || "include";
  // The page's own Galaxy requests take the transport the agent's do.
  const galaxy = connectGalaxy({ root: config.galaxy_root, credentials });
  const launch = await (options.launch ?? currentHistoryLaunch)(galaxy);
  if (mounted.signal.aborted) return handle;
  if (launch.ask) asks.push(launch.ask);
  if (launch.stop) {
    chat.addErrorMessage(launch.stop);
    el.input.disabled = true;
    el.send.disabled = true;
    askNext = () =>
      chat.addErrorMessage(`Could not ask "${asks.shift()}": this page cannot start.`);
    return handle;
  }
  let savedId = launch.saved?.id;
  /** Key for a saved session in this browser: store name and id. */
  const keptAs = (id: string) => `${sessions?.kind ?? ""}/${id}`;
  /** Sets the shown saved session and reports changes to the store. */
  function showing(id: string | undefined) {
    const changed = id !== savedId;
    savedId = id;
    if (changed) sessions?.active?.(id ?? null);
  }
  sessions?.active?.(savedId ?? null);

  const usage = mountUsageBar(container);
  mountBuildStamp(container, {
    commit: (process.env.build_commit as string) || "",
    built: (process.env.build_built as string) || "",
    galaxy: config.galaxy_root,
    // ensureCredentials answered, so buildConfig had a provider to name.
    provider: config.ai_provider || creds.provider,
    model: config.ai_model || "",
  });

  el.input.addEventListener("input", () => autosize(el.input));
  // Datasets and collections dragged from Galaxy's history go into the question with their ids,
  // highlighted as Orbit highlights files dragged onto its input.
  el.input.addEventListener("dragover", (e) => {
    if (e.dataTransfer?.types.includes("text/plain")) el.input.classList.add("file-drop-target");
  });
  el.input.addEventListener("dragleave", () => el.input.classList.remove("file-drop-target"));
  el.input.addEventListener("drop", (e) => {
    el.input.classList.remove("file-drop-target");
    const items = droppedItems(e.dataTransfer?.getData("text") ?? "");
    // Galaxy's payload is never pasted as it is, even when nothing in it can be referred to.
    if (items) e.preventDefault();
    if (items?.length) {
      const { selectionStart, selectionEnd, value } = el.input;
      const next = withReferences(value, selectionStart, selectionEnd, items.map(itemReference));
      el.input.value = next.value;
      el.input.setSelectionRange(next.caret, next.caret);
      el.input.focus();
      autosize(el.input);
    }
  });
  // Asked on the first use; `confirm` is made below, before any click can reach the button.
  const dictation = mountDictation(el.mic, el.input, {
    consent: rememberedConsent(`${brand.id}.dictationConsent`, (request) => confirm.ask(request)),
  });
  mounted.signal.addEventListener("abort", () => dictation?.cancel());

  let busy = false;
  let ready = false;
  /** Said once the new conversation is on screen, which clears the old one. */
  let afterReset: string | undefined;
  let galaxyStatus: GalaxyStatus | undefined;

  /** Stop replaces Send for the duration of a run, as in Orbit. */
  function setBusy(running: boolean) {
    busy = running;
    el.send.classList.toggle("hidden", running);
    el.abort.classList.toggle("hidden", !running);
    if (!running) retryNotice.stop();
    refreshControls();
  }

  /** Exactly one explanation for a quiet ending, most specific first. */
  function ended(outcome: RunOutcome) {
    if (outcome.error) console.error(`[${brand.id}] run failed`, outcome.error);
    say(outcomeNotice(outcome));
    if (el.save && !saving) el.save.textContent = "Save";
    sessions?.savedState(false);
    refreshControls();
  }

  /**
   * On open, the newest artifacts: a conversation that can still place a chart but shows an empty
   * pane is telling the user it lost something it did not. Live, only what a result just made.
   */
  async function showArtifacts(artifacts: Artifact[], restored: boolean) {
    if (!artifacts.length) return;
    el.artifactContent.innerHTML = "";
    try {
      for (const artifact of restored ? paneArtifacts(artifacts) : artifacts) {
        await renderArtifact(el.artifactContent, artifact, rootPath, galaxy);
      }
    } catch (e) {
      // Fire-and-forget from the view, so a throw here would reach only the console.
      console.error(`[${brand.id}] could not draw an artifact`, e);
      chat.addErrorMessage(
        `Could not show the artifact: ${briefly(String((e as Error)?.message ?? e))}`,
      );
      return;
    }
    // After filling, so the pane opens on something rather than on an empty frame.
    if (!restored) artifactPane.reveal();
  }

  const view = new ChatView(
    chat,
    {
      info,
      busy: setBusy,
      artifacts: (artifacts, restored) => void showArtifacts(artifacts, restored),
      ended,
      usage: (totals) => usage.set(totals),
      retry: (errorMessage, at, attempt) => retryNotice.start(errorMessage, at, attempt),
      failed: (message) => chat.addErrorMessage(message),
      wrote: () => settlePlanDrafts(el.messages),
      retried: () => retryNotice.stop(),
    },
    brand,
  );

  /**
   * Saving mid-run would store a half-finished run, and an empty conversation has none. A model
   * switch configures the open conversation, so it waits for the worker to have one, as does a
   * message.
   */
  function refreshControls() {
    if (el.save) el.save.disabled = !!saving || busy || !ready || view.turns === 0;
    el.model.disabled = !ready;
    el.input.disabled = !ready || !!saving;
    el.send.disabled = !ready || !!saving;
    el.reset.disabled = !!saving;
    el.reset.classList.toggle("hidden", view.turns === 0);
  }

  // Naming the active model makes a misconfigured run obvious.
  const showModel = () =>
    (el.model.textContent = creds.model ? `${creds.provider} · ${creds.model}` : creds.provider);
  showModel();
  refreshControls();

  /** What the worker runs on: urls resolved against the page, and the key. */
  function workerConfig() {
    return {
      ...config,
      ai_base_url: config.ai_base_url && absolute(config.ai_base_url),
      galaxy_root: absolute(config.galaxy_root),
      ai_api_key: creds.apiKey,
      credentials,
    };
  }

  const opening = {
    pyodideURL: options.pyodideURL,
    config: workerConfig(),
    placement: { historyId: launch.historyId, datasetId: config.dataset_id },
    ...(options.pool ? { pool: options.pool } : {}),
    ...(launch.saved ? { saved: { ...launch.saved, id: keptAs(launch.saved.id) } } : {}),
  };

  const confirm = createConfirm({
    container,
    respond: (id, approved) => agent.confirm(Number(id), approved),
    note: (text) => info(text),
    signal: mounted.signal,
  });

  /** Said once ready, when the user chose to continue a record whose conversation is gone. */
  let continuing: string | undefined;
  /** "Use it here", offered while another tab holds the session. */
  let take: HTMLButtonElement | undefined;

  /** Asks the host's next question in an empty conversation, starting one when needed. */
  askNext = () => {
    if (asks.length && ready && !saving && afterReset === undefined) {
      if (view.turns || busy) {
        startNew(busy);
      } else {
        el.input.value = asks.shift()!;
        submit();
        askNext();
      }
    }
  };

  const agent = new AgentClient((message) => {
    if (message.type === "events") {
      view.apply(message.events);
      if (afterReset && message.events.some((e) => e.type === "snapshot")) {
        info(afterReset);
        afterReset = undefined;
        askNext();
      }
      refreshControls();
    } else if (message.type === "settled") {
      settledNotices(message.settled).forEach(say);
    } else if (message.type === "held") {
      say(heldNotice(message.held));
    } else if (message.type === "confirm") {
      confirm.show(String(message.id), message);
    } else if (message.type === "withdrawn") {
      confirm.dismiss(String(message.id));
    } else if (message.type === "ready") {
      ready = true;
      take?.remove();
      galaxyStatus = message.galaxy;
      const kind = `${sessions?.kind}/`;
      if (sessions && savedId === undefined && message.savedAs?.startsWith(kind)) {
        showing(message.savedAs.slice(kind.length));
      }
      refreshControls();
      readyNotices({
        unkept: message.unkept,
        galaxyProblem: message.galaxyProblem,
        recordsProblem: message.recordsProblem,
        savedProblem: launch.savedProblem,
        saved: !!launch.saved,
        restored: view.turns > 0,
        continuing,
        greeting: launch.greeting,
        keepHint: sessions?.keepHint,
      }).forEach(say);
      askNext();
    } else if (message.type === "recoverable") {
      // The browser kept nothing of a session here; the user says which, if any, this is.
      const line = info(
        "This browser has no conversation for this history. Start a new one, with a new notebook " +
          "or adding to one of this history's notebooks. Adding to a notebook starts a fresh chat " +
          "without its earlier transcript." +
          (sessions?.reopenHint ? ` ${sessions.reopenHint}` : ""),
      );
      const choices = document.createElement("div");
      choices.className = "launch-choices";
      line.append(choices);
      const choose = (pageId?: string) => {
        choices.querySelectorAll("button").forEach((b) => (b.disabled = true));
        agent.recover(pageId);
      };
      for (const record of message.records) {
        const button = document.createElement("button");
        button.className = "plan-btn";
        button.textContent = `New conversation, add to ${record.title} (updated ${localTime(record.updated)})`;
        button.addEventListener("click", () => {
          continuing =
            `New conversation, without the earlier transcript. Notes go to the notebook ` +
            `${record.title}.`;
          choose(record.pageId);
        });
        choices.append(button);
      }
      const fresh = document.createElement("button");
      fresh.className = "plan-btn";
      fresh.textContent = "New conversation, new notebook";
      fresh.addEventListener("click", () => choose());
      choices.append(fresh);
    } else if (message.type === "waiting") {
      const line = info("This session is open in another tab. ");
      const button = document.createElement("button");
      button.className = "plan-btn";
      button.textContent = "Use it here";
      button.addEventListener("click", () => {
        button.disabled = true;
        agent.open({ ...opening, steal: true });
      });
      line.append(button);
      take = button;
    } else if (message.type === "lost") {
      ready = false;
      refreshControls();
      chat.addErrorMessage("This session was opened in another tab, which has it now.");
    } else if (message.type === "failed") {
      console.error(`[${brand.id}] worker failed`, message.message);
      chat.hideThinking();
      setBusy(false);
      chat.addErrorMessage(briefly(message.message));
    }
  }, options.createWorker);
  started = agent;
  agent.open(opening);

  el.model.addEventListener("click", async () => {
    const picked = await switchProvider(container, brand, offered, mounted.signal);
    if (picked) {
      const previous = { creds, model: { ...config } };
      creds = picked;
      const { ai_base_url, ai_provider, ai_model } = buildConfig(target, picked);
      Object.assign(config, { ai_base_url, ai_provider, ai_model });
      showModel();
      const { ai_base_url: url, ai_api_key } = workerConfig();
      await agent
        .switchModel({ ai_base_url: url, ai_provider, ai_model, ai_api_key })
        .catch((e) => {
          // The worker kept the model it had, so the page, and the next reload, keep it too.
          creds = previous.creds;
          saveCredentials(previous.creds, brand);
          Object.assign(config, previous.model);
          showModel();
          chat.addErrorMessage(`Could not switch the model: ${briefly(String(e))}`);
        });
    }
  });

  // Saving is deliberate, as for any other Galaxy visualization: a revision then marks a
  // save the user asked for rather than a conversation turn.
  const save = el.save;
  save?.addEventListener("click", () => {
    saving = saveConversation(save).finally(() => {
      saving = undefined;
      refreshControls();
      askNext();
    });
    refreshControls();
  });

  /** Exports, saves to Galaxy, and notes the save here; failures are said, not thrown. */
  async function saveConversation(button: HTMLButtonElement) {
    button.textContent = "Saving...";
    let exported: SessionDocument | undefined;
    let id: string | undefined;
    try {
      exported = await agent.export("");
      id = await sessions!.save(exported, savedId);
    } catch (e) {
      // The conversation itself is untouched; only the save failed.
      console.error(`[${brand.id}] could not save the session`, e);
      if (!mounted.signal.aborted) {
        button.textContent = "Save";
        const reason = briefly(String(e));
        chat.addErrorMessage(`Could not save this conversation: ${reason}`);
        if (exported) offerDownload(exported, reason);
      }
    }
    if (id !== undefined && !mounted.signal.aborted) {
      // Galaxy has it; this browser's note only lets a reload reopen it as that save.
      await agent
        .saved(keptAs(id), exported!)
        .catch((e) => console.warn(`[${brand.id}] could not note the save here`, e));
      showing(id);
      button.textContent = "Saved";
      sessions!.savedState(true);
      info(sessions!.savedNote);
    }
  }

  /** Offers a conversation that could not be saved as a Markdown file. */
  async function offerDownload(exported: SessionDocument, reason: string) {
    const wanted = await confirm.ask({
      title: "Download conversation",
      message: `Download its questions, answers and artifacts as a Markdown file? It could not be saved: ${reason}`,
      accept: "Download",
      deny: "Cancel",
    });
    if (wanted) {
      const link = document.createElement("a");
      link.href = URL.createObjectURL(
        new Blob([conversationMarkdown(exported, brand)], { type: "text/markdown" }),
      );
      link.download = markdownName(exported);
      link.click();
      setTimeout(() => URL.revokeObjectURL(link.href), 10000);
    }
  }

  function submit() {
    const text = el.input.value.trim();
    if (!text || busy || saving) {
      return;
    }
    if (!ready) {
      info("Still starting; send again once it says it is ready.");
      return;
    }
    dictation?.cancel();
    el.input.value = "";
    el.input.style.height = "auto";
    // Busy from the click: the run starts once the worker has stored the message.
    setBusy(true);
    // Mark the conversation unsaved as soon as a question is sent.
    sessions?.savedState(false);
    chat.showThinking();
    agent.submit(text);
  }

  function stop() {
    if (busy) {
      agent.stop();
    }
  }

  el.send.addEventListener("click", submit);
  el.abort.addEventListener("click", stop);
  // loom: "reset session -- fresh start, no --continue".
  el.reset.addEventListener("click", () => {
    if (!busy && ready && !saving) {
      startNew();
    }
  });

  /**
   * Starts a new conversation. The previous one is kept, saved or not; `holding` says its running
   * turn stops.
   */
  function startNew(holding = false) {
    showing(undefined);
    sessions?.savedState(true);
    el.artifactContent.innerHTML = "";
    afterReset =
      "Started a new conversation. The previous one can't be reopened here unless you saved it; " +
      "its notebook is unchanged." +
      (holding ? " Its running turn stopped; Galaxy jobs it started are still watched." : "");
    agent.reset();
  }
  el.input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  });
  // Esc stops the run; bound on the container because the shell may live in an iframe.
  container.addEventListener(
    "keydown",
    (e) => {
      if ((e as KeyboardEvent).key === "Escape" && busy) {
        stop();
      }
      if (dictation && isDictationShortcut(e as KeyboardEvent)) {
        e.preventDefault();
        dictation.toggle();
      }
    },
    { signal: mounted.signal },
  );

  // Approve / Edit / Reject on a plan draft card.
  el.messages.addEventListener("plan-draft-action", (e) => {
    const { action, body } = (e as CustomEvent<{ action: string; body: string }>).detail;
    const answer = answerPlan(action, body, galaxyStatus);
    if (answer && "refused" in answer) {
      chat.addErrorMessage(answer.refused);
    } else if (answer && "send" in answer) {
      el.input.value = answer.send;
      submit();
    } else if (answer && "draft" in answer) {
      el.input.value = answer.draft;
      el.input.focus();
      // Setting .value does not raise `input`, so the box would stay one line tall.
      el.input.dispatchEvent(new Event("input"));
    }
  });

  return handle;
}
