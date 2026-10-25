/**
 * The shell's generic paths, which Olit never takes: no session store, a launch that stops, and
 * a host that unmounts. Every e2e drive mounts Olit, so these are only held here.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { saveCredentials } from "./credentials";
import { cannotStart, currentHistoryLaunch, mountOrbitBrowser } from "./shell";
import type { Galaxy } from "./agent/galaxy";
import type { WorkerMessage } from "./agent/worker";

const base = { galaxyRoot: "/", galaxyChatUrl: "/api/plugins/test", pyodideURL: "/pyodide/" };

/** Enough of a Worker for AgentClient: what it was sent, and a way to answer. */
function fakeWorker() {
  const worker = {
    sent: [] as any[],
    onmessage: null as ((e: MessageEvent) => void) | null,
    onerror: null as ((e: ErrorEvent) => void) | null,
    postMessage: vi.fn((m: unknown) => worker.sent.push(m)),
    terminate: vi.fn(),
    say: (data: WorkerMessage) => worker.onmessage?.({ data } as MessageEvent),
  };
  return worker;
}

let container: HTMLElement;

beforeEach(() => {
  // A provider that needs no key, so the picker doesn't open.
  saveCredentials({ provider: "galaxy" });
  container = document.body.appendChild(document.createElement("div"));
});

afterEach(() => {
  container.remove();
  sessionStorage.clear();
});

describe("a launch that stops", () => {
  it("says why, starts no worker, and still hands back a handle", async () => {
    const createWorker = vi.fn();
    const handle = await mountOrbitBrowser(container, {
      ...base,
      createWorker,
      launch: async () => ({ stop: cannotStart("the current history") }),
    });
    expect(createWorker).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Could not read the current history from Galaxy");
    expect(container.querySelector<HTMLTextAreaElement>("#input")?.disabled).toBe(true);
    expect(container.querySelector<HTMLButtonElement>("#send-btn")?.disabled).toBe(true);
    handle.dispose();
    expect(container.childElementCount).toBe(0);
  });
});

describe("a flavor with no session store", () => {
  it("offers no Save, and its messages don't send the user looking for one", async () => {
    const worker = fakeWorker();
    await mountOrbitBrowser(container, {
      ...base,
      createWorker: () => worker as unknown as Worker,
      launch: async () => ({ historyId: "h1" }),
    });
    expect(container.querySelector("#save-btn")).toBeNull();
    worker.say({ type: "ready", unkept: "no private file system" } as WorkerMessage);
    worker.say({ type: "recoverable", records: [] } as unknown as WorkerMessage);
    expect(container.textContent).toContain("so this one ends when the page closes.");
    expect(container.textContent).toContain("starts a fresh chat without its earlier transcript.");
    expect(container.textContent).not.toMatch(/\bSave\b/);
  });

  it("does offer Save once a store is given", async () => {
    await mountOrbitBrowser(container, {
      ...base,
      createWorker: vi.fn(),
      launch: async () => ({ stop: "stopped" }),
      sessions: { kind: "test", save: async () => "id", savedState: () => {}, savedNote: "Saved." },
    });
    expect(container.querySelector("#save-btn")).not.toBeNull();
  });
});

describe("saved sessions in this browser", () => {
  const document = { olit_session: 1, session: {}, entries: [] } as any;
  /** Returns what the worker opens when launching save `id` from store `kind`. */
  async function opened(kind: string, id: string) {
    const worker = fakeWorker();
    await mountOrbitBrowser(container, {
      ...base,
      createWorker: () => worker as unknown as Worker,
      launch: async () => ({ saved: { id, document } }),
      sessions: { kind, save: async () => id, savedState: () => {}, savedNote: "Saved." },
    });
    return worker.sent[0]?.request?.saved;
  }

  // A chat and a visualization can have the same id.
  it("keys saves by store and id", async () => {
    expect(await opened("chat", "f2db41e1fa331b3e")).toEqual({
      id: "chat/f2db41e1fa331b3e",
      document,
    });
    container.replaceChildren();
    expect(await opened("visualization", "f2db41e1fa331b3e")).toEqual({
      id: "visualization/f2db41e1fa331b3e",
      document,
    });
  });

  it("keys a new save by store and id", async () => {
    const worker = fakeWorker();
    await mountOrbitBrowser(container, {
      ...base,
      createWorker: () => worker as unknown as Worker,
      launch: async () => ({ historyId: "h1" }),
      sessions: { kind: "chat", save: async () => "c1", savedState: () => {}, savedNote: "Saved." },
    });
    worker.say({ type: "ready", galaxy: { connected: true } } as unknown as WorkerMessage);
    // Add a turn so there is something to save.
    worker.say({
      type: "events",
      events: [
        {
          type: "snapshot",
          entries: [{ kind: "pi.user", model: [{ role: "user", content: "hello" }] }],
          usage: { models: {} },
        },
      ],
    } as unknown as WorkerMessage);
    container.querySelector<HTMLButtonElement>("#save-btn")!.click();
    const exported = await vi.waitFor(() => {
      const found = worker.sent.find((m) => m.type === "export");
      if (!found) throw new Error("not exported yet");
      return found;
    });
    worker.say({ type: "reply", id: exported.id, value: document });
    const saved = await vi.waitFor(() => {
      const found = worker.sent.find((m) => m.type === "saved");
      if (!found) throw new Error("not saved yet");
      return found;
    });
    expect(saved.savedId).toBe("chat/c1");
  });
});

describe("dispose", () => {
  // Orbit's ChatPanel adds document listeners of its own that only the renderer could detach.
  it("stops the worker and removes the pane and chat listeners", async () => {
    const worker = fakeWorker();
    const listening = vi.spyOn(document, "addEventListener");
    const handle = await mountOrbitBrowser(container, {
      ...base,
      createWorker: () => worker as unknown as Worker,
      launch: async () => ({ historyId: "h1" }),
    });
    expect(worker.sent[0]?.type).toBe("open");
    const signals = listening.mock.calls
      .filter(([type]) => type === "mousemove" || type === "mouseup")
      .map(([, , options]) => (options as AddEventListenerOptions | undefined)?.signal)
      .filter(Boolean);
    expect(signals).toHaveLength(3);
    const buttons = document.querySelectorAll(".chat-copy-btn").length;
    handle.dispose();
    for (const signal of signals) {
      expect(signal?.aborted).toBe(true);
    }
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    expect(container.childElementCount).toBe(0);
    expect(document.querySelectorAll(".chat-copy-btn")).toHaveLength(buttons - 1);
    listening.mockRestore();
  });

  it("leaves nothing on the container that answers a second mount's shortcut", async () => {
    const mount = () =>
      mountOrbitBrowser(container, {
        ...base,
        createWorker: () => fakeWorker() as unknown as Worker,
        launch: async () => ({ historyId: "h1" }),
      });
    const showSomething = () =>
      container.querySelector("#artifact-content")!.appendChild(document.createElement("div"));
    const first = await mount();
    showSomething();
    first!.dispose();
    await mount();
    showSomething();
    const before = document.body.classList.contains("artifact-collapsed");
    container.dispatchEvent(
      new KeyboardEvent("keydown", { key: "\\", ctrlKey: true, bubbles: true }),
    );
    expect(document.body.classList.contains("artifact-collapsed")).toBe(!before);
  });
});

describe("repeated mounts", () => {
  /** Every listener added to the document or the window, kept until it is removed or aborted. */
  function trackListeners() {
    const live = new Set<string>();
    const keys = new Map<EventListenerOrEventListenerObject, string>();
    const restore: (() => void)[] = [];
    for (const [name, target] of [
      ["document", document],
      ["window", window],
    ] as const) {
      const add = target.addEventListener.bind(target);
      const remove = target.removeEventListener.bind(target);
      const capture = (options?: boolean | AddEventListenerOptions) =>
        typeof options === "boolean" ? options : !!options?.capture;
      target.addEventListener = ((type: string, listener: any, options?: any) => {
        const key = `${name} ${type} ${capture(options)} ${live.size}:${Math.random()}`;
        keys.set(listener, key);
        live.add(key);
        options?.signal?.addEventListener("abort", () => live.delete(key));
        add(type, listener, options);
      }) as typeof target.addEventListener;
      target.removeEventListener = ((type: string, listener: any, options?: any) => {
        const key = keys.get(listener);
        if (key) live.delete(key);
        remove(type, listener, options);
      }) as typeof target.removeEventListener;
      restore.push(() => {
        target.addEventListener = add;
        target.removeEventListener = remove;
      });
    }
    return { live, restore: () => restore.forEach((r) => r()) };
  }

  it("leaves no listener, button, modal or worker behind after each dispose", async () => {
    // happy-dom has no Option constructor, which the provider picker uses.
    vi.stubGlobal("Option", function (text: string, value: string) {
      return Object.assign(document.createElement("option"), { text, value });
    });
    const tracked = trackListeners();
    const workers: ReturnType<typeof fakeWorker>[] = [];
    const buttons = document.querySelectorAll(".chat-copy-btn").length;
    try {
      for (let cycle = 0; cycle < 3; cycle++) {
        const worker = fakeWorker();
        workers.push(worker);
        const handle = await mountOrbitBrowser(container, {
          ...base,
          createWorker: () => worker as unknown as Worker,
          launch: async () => ({ historyId: "h1" }),
        });
        worker.say({ type: "ready" } as WorkerMessage);
        expect(tracked.live.size).toBeGreaterThan(0);
        if (cycle === 2) {
          // The provider picker is open when the page goes away.
          container.querySelector<HTMLButtonElement>("#model-btn")!.click();
          await new Promise((resolve) => setTimeout(resolve));
          expect(container.querySelector("#cred-overlay:not(.hidden)")).not.toBeNull();
        }
        handle.dispose();
        expect([...tracked.live]).toEqual([]);
        expect(document.querySelectorAll(".chat-copy-btn")).toHaveLength(buttons);
        expect(container.childElementCount).toBe(0);
      }
      expect(workers.map((w) => w.terminate.mock.calls.length)).toEqual([1, 1, 1]);
    } finally {
      tracked.restore();
      vi.unstubAllGlobals();
    }
  });
});

describe("currentHistoryLaunch", () => {
  const galaxy = (get: () => Promise<unknown>) => ({ get }) as unknown as Galaxy;

  it("starts in the history Galaxy names", async () => {
    expect(await currentHistoryLaunch(galaxy(async () => ({ id: "h9" })))).toEqual({
      historyId: "h9",
    });
  });

  it("stops when Galaxy names none", async () => {
    expect((await currentHistoryLaunch(galaxy(async () => ({})))).stop).toContain(
      "it named no history",
    );
  });

  it("stops with Galaxy's own problem when the request fails", async () => {
    const launch = await currentHistoryLaunch(
      galaxy(async () => {
        throw new Error("502 Bad Gateway");
      }),
    );
    expect(launch.stop).toContain("502 Bad Gateway");
  });
});

describe("a question from the host", () => {
  const snapshot = (entries: unknown[]) =>
    ({
      type: "events",
      events: [
        {
          type: "snapshot",
          entries,
          tools: [],
          compactions: [],
          inbox: [],
          agent: {},
          usage: { models: {}, tools: {} },
        },
      ],
    }) as unknown as WorkerMessage;
  const user = {
    id: 1,
    conversationId: 1,
    kind: "pi.user",
    model: [{ role: "user", content: "hi" }],
  };
  const submitted = (worker: ReturnType<typeof fakeWorker>) =>
    worker.sent.filter((m) => m.type === "submit").map((m) => m.text);

  async function mountAsking(worker: ReturnType<typeof fakeWorker>) {
    await mountOrbitBrowser(container, {
      ...base,
      createWorker: () => worker as unknown as Worker,
      launch: async () => ({ historyId: "h1", ask: "How many datasets?" }),
    });
  }

  it("is asked once the conversation is ready", async () => {
    const worker = fakeWorker();
    await mountAsking(worker);
    worker.say(snapshot([]));
    worker.say({ type: "ready" } as WorkerMessage);
    expect(submitted(worker)).toEqual(["How many datasets?"]);
  });

  it("starts a new conversation if the current one has turns", async () => {
    const worker = fakeWorker();
    await mountAsking(worker);
    worker.say(snapshot([user]));
    worker.say({ type: "ready" } as WorkerMessage);
    expect(submitted(worker)).toEqual([]);
    expect(worker.sent.some((m) => m.type === "reset")).toBe(true);
    worker.say(snapshot([]));
    expect(submitted(worker)).toEqual(["How many datasets?"]);
  });

  it("asks later questions in order, each in a new conversation of the same worker", async () => {
    const worker = fakeWorker();
    const createWorker = vi.fn(() => worker as unknown as Worker);
    const handle = await mountOrbitBrowser(container, {
      ...base,
      createWorker,
      launch: async () => ({ historyId: "h1" }),
    });
    handle.ask("First?");
    handle.ask("Second?");
    expect(submitted(worker)).toEqual([]);
    worker.say(snapshot([]));
    worker.say({ type: "ready" } as WorkerMessage);
    expect(submitted(worker)).toEqual(["First?"]);
    // The first is still running: it is held, and the second asked in a new conversation.
    expect(worker.sent.filter((m) => m.type === "reset")).toHaveLength(1);
    worker.say(snapshot([]));
    expect(submitted(worker)).toEqual(["First?", "Second?"]);
    expect(container.textContent).toContain(
      "Its running turn stopped; Galaxy jobs it started are still watched.",
    );
    expect(createWorker).toHaveBeenCalledTimes(1);
  });

  it("says a question cannot be asked on a page that cannot start", async () => {
    const handle = await mountOrbitBrowser(container, {
      ...base,
      createWorker: vi.fn(),
      launch: async () => ({ stop: "stopped" }),
    });
    handle.ask("Anyone there?");
    expect(container.textContent).toContain(
      'Could not ask "Anyone there?": this page cannot start.',
    );
  });
});
