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

describe("the files the worker keeps sessions in", () => {
  async function poolOf(pool?: string) {
    const worker = fakeWorker();
    await mountOrbitBrowser(container, {
      ...base,
      createWorker: () => worker as unknown as Worker,
      launch: async () => ({ historyId: "h1" }),
      ...(pool ? { pool } : {}),
    });
    return worker.sent[0]?.request;
  }

  it("opens the worker on the pool the flavor names, and on none otherwise", async () => {
    expect(await poolOf("olit-chat")).toMatchObject({ pool: "olit-chat" });
    container.replaceChildren();
    expect(await poolOf()).not.toHaveProperty("pool");
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

  it("offers the conversation as a download when it cannot be saved", async () => {
    const worker = fakeWorker();
    await mountOrbitBrowser(container, {
      ...base,
      createWorker: () => worker as unknown as Worker,
      launch: async () => ({ historyId: "h1" }),
      sessions: {
        kind: "chat",
        save: async () => {
          throw new Error("HTTP 400: This conversation is too large to save");
        },
        savedState: () => {},
        savedNote: "Saved.",
      },
    });
    worker.say({ type: "ready", galaxy: { connected: true } } as unknown as WorkerMessage);
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
    const made = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:conversation");
    const clicked = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    const accept = container.querySelector<HTMLButtonElement>("#ext-accept")!;
    container.querySelector<HTMLButtonElement>("#save-btn")!.click();
    const exported = await vi.waitFor(() => {
      const found = worker.sent.find((m) => m.type === "export");
      if (!found) throw new Error("not exported yet");
      return found;
    });
    const session = { id: "0123abcd", title: "", createdAt: "2026-11-27T20:00:00Z" };
    worker.say({ type: "reply", id: exported.id, value: { ...document, session } });
    await vi.waitFor(() => expect(accept.textContent).toBe("Download"));
    expect(container.querySelector("#ext-message")!.textContent).toContain("too large to save");
    accept.click();
    await vi.waitFor(() => expect(made).toHaveBeenCalledWith(expect.any(Blob)));
    expect(clicked).toHaveBeenCalledTimes(1);
    made.mockRestore();
    clicked.mockRestore();
  });
});

describe("a save that Galaxy answers late", () => {
  const exportedDocument = { olit_session: 1, session: { id: "a", title: "" }, entries: [] };
  const snapshot = (text: string) =>
    ({
      type: "events",
      events: [
        {
          type: "snapshot",
          entries: [{ kind: "pi.user", model: [{ role: "user", content: text }] }],
          usage: { models: {} },
        },
      ],
    }) as unknown as WorkerMessage;
  const sent = (worker: ReturnType<typeof fakeWorker>, type: string, count = 1) =>
    vi.waitFor(() => {
      const found = worker.sent.filter((m) => m.type === type);
      if (found.length < count) throw new Error(`no ${type} yet`);
      return found[count - 1];
    });

  /** Mounts with a store whose first save waits for `finish`; later saves answer at once. */
  async function slowSave(extra: { ready?: object } = {}) {
    const worker = fakeWorker();
    const calls = {
      saves: [] as (string | undefined)[],
      states: [] as boolean[],
      active: [] as (string | null)[],
    };
    let finish: ((id: string) => void) | undefined;
    const handle = await mountOrbitBrowser(container, {
      ...base,
      createWorker: () => worker as unknown as Worker,
      launch: async () => ({ historyId: "h1" }),
      sessions: {
        kind: "chat",
        savedNote: "Saved.",
        save: (_document, id) => {
          calls.saves.push(id);
          return calls.saves.length === 1
            ? new Promise((resolve) => (finish = resolve))
            : Promise.resolve(id ?? "c2");
        },
        savedState: (saved) => calls.states.push(saved),
        active: (id) => calls.active.push(id),
      },
    });
    worker.say({
      type: "ready",
      galaxy: { connected: true },
      ...extra.ready,
    } as unknown as WorkerMessage);
    worker.say(snapshot("first question"));
    const save = container.querySelector<HTMLButtonElement>("#save-btn")!;
    save.click();
    const exported = await sent(worker, "export");
    worker.say({ type: "reply", id: exported.id, value: exportedDocument });
    await vi.waitFor(() => expect(finish).toBeDefined());
    return { worker, handle, calls, save, finish: (id: string) => finish!(id) };
  }

  it("keeps Save off until it ends, whatever the worker says meanwhile", async () => {
    const { worker, save, finish } = await slowSave();
    worker.say(snapshot("first question"));
    expect(save.disabled).toBe(true);
    finish("c1");
    const noted = await sent(worker, "saved");
    expect(save.disabled).toBe(true);
    worker.say({ type: "reply", id: noted.id, value: undefined } as unknown as WorkerMessage);
    await vi.waitFor(() => expect(save.disabled).toBe(false));
  });

  it("holds New, Send and the host's questions until it ends", async () => {
    const { worker, handle, save, finish } = await slowSave();
    const reset = container.querySelector<HTMLButtonElement>("#reset-btn")!;
    const input = container.querySelector<HTMLTextAreaElement>("#input")!;
    expect([reset.disabled, input.disabled]).toEqual([true, true]);
    reset.click();
    handle.ask("asked meanwhile");
    let settled = false;
    void handle.settled().then(() => (settled = true));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(worker.sent.some((m) => m.type === "reset" || m.type === "submit")).toBe(false);
    expect(settled).toBe(false);
    finish("c1");
    const noted = await sent(worker, "saved");
    worker.say({ type: "reply", id: noted.id, value: undefined } as unknown as WorkerMessage);
    await vi.waitFor(() => expect(settled).toBe(true));
    expect(save.textContent).toBe("Saved");
    // The question waited for the save, then started a new conversation for itself.
    await vi.waitFor(() => expect(worker.sent.some((m) => m.type === "reset")).toBe(true));
  });

  it("tells the host nothing once the page is disposed", async () => {
    const { worker, handle, calls, finish } = await slowSave();
    const before = calls.active.length;
    handle.dispose();
    finish("c1");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls.active.length).toBe(before);
    expect(worker.sent.some((m) => m.type === "saved")).toBe(false);
  });

  it("is reported saved though this browser could not note it", async () => {
    const { worker, calls, save, finish } = await slowSave();
    finish("c1");
    const noted = await sent(worker, "saved");
    worker.say({
      type: "reply",
      id: noted.id,
      error: "storage is gone",
    } as unknown as WorkerMessage);
    await vi.waitFor(() => expect(save.textContent).toBe("Saved"));
    expect(calls.states.at(-1)).toBe(true);
    expect(container.textContent).not.toContain("Could not save");
  });

  it("is where a conversation this browser kept was saved", async () => {
    const { calls } = await slowSave({ ready: { savedAs: "chat/c7" } });
    expect(calls.active).toContain("c7");
    expect(calls.saves).toEqual(["c7"]);
  });
});

describe("history items dropped on the input", () => {
  it("go into the question with their ids, and other drops are left to the browser", async () => {
    await mountOrbitBrowser(container, {
      ...base,
      createWorker: () => fakeWorker() as unknown as Worker,
      launch: async () => ({ historyId: "h1" }),
    });
    const input = container.querySelector<HTMLTextAreaElement>("#input")!;
    const drop = (text: string) => {
      const event = new Event("drop", { bubbles: true, cancelable: true });
      Object.defineProperty(event, "dataTransfer", { value: { getData: () => text } });
      input.dispatchEvent(event);
      return event.defaultPrevented;
    };
    input.value = "Count the reads in";
    input.setSelectionRange(input.value.length, input.value.length);
    const item = {
      id: "f2db41e1fa331b3e",
      hid: 12,
      name: "reads.fastq",
      history_content_type: "dataset",
    };
    expect(drop(JSON.stringify([item]))).toBe(true);
    expect(input.value).toBe('Count the reads in [dataset #12 "reads.fastq", id f2db41e1fa331b3e]');
    expect(drop("plain text")).toBe(false);
    const subcollection = { id: "e1", object: { id: "c1", model_class: "DatasetCollection" } };
    expect(drop(JSON.stringify([subcollection]))).toBe(true);
    expect(input.value).toBe('Count the reads in [dataset #12 "reads.fastq", id f2db41e1fa331b3e]');
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

describe("a mount inside a shadow root", () => {
  it("keeps its styles and state in the root and on the host, and takes them away on dispose", async () => {
    const host = document.body.appendChild(document.createElement("div"));
    const inside = host.attachShadow({ mode: "open" }).appendChild(document.createElement("div"));
    const heads = document.head.childElementCount;
    const handle = await mountOrbitBrowser(inside, {
      ...base,
      createWorker: () => fakeWorker() as unknown as Worker,
      launch: async () => ({ historyId: "h1" }),
    });
    expect(host.shadowRoot!.querySelectorAll("style")).toHaveLength(1);
    expect(document.head.childElementCount).toBe(heads + 1);
    expect(host.getAttribute("data-theme")).toBe("light");
    expect(host.classList.contains("artifact-collapsed")).toBe(true);
    expect(document.body.classList.contains("artifact-collapsed")).toBe(false);
    handle.dispose();
    expect(host.shadowRoot!.querySelectorAll("style")).toHaveLength(0);
    expect(document.head.childElementCount).toBe(heads);
    host.remove();
  });

  it("adds no styles of its own to a page that links them", async () => {
    const heads = document.head.childElementCount;
    const handle = await mountOrbitBrowser(container, {
      ...base,
      createWorker: () => fakeWorker() as unknown as Worker,
      launch: async () => ({ historyId: "h1" }),
    });
    expect(document.head.childElementCount).toBe(heads);
    handle.dispose();
  });
});

describe("a host that ends the page while it starts", () => {
  it("starts no worker when it ends during the launch, and leaves nothing behind", async () => {
    const ended = new AbortController();
    const createWorker = vi.fn();
    const heads = document.head.childElementCount;
    let launched!: (context: { historyId: string }) => void;
    const mounting = mountOrbitBrowser(container, {
      ...base,
      createWorker,
      signal: ended.signal,
      launch: () => new Promise((resolve) => (launched = resolve)),
    });
    await vi.waitFor(() => expect(launched).toBeDefined());
    ended.abort();
    expect(container.childElementCount).toBe(0);
    expect(document.head.childElementCount).toBe(heads);
    launched({ historyId: "h1" });
    const handle = await mounting;
    expect(createWorker).not.toHaveBeenCalled();
    expect(container.childElementCount).toBe(0);
    handle.dispose();
  });

  it("closes the provider picker and starts no worker when it ends there", async () => {
    vi.stubGlobal("Option", function (text: string, value: string) {
      return Object.assign(document.createElement("option"), { text, value });
    });
    saveCredentials({ provider: "openrouter" });
    const ended = new AbortController();
    const createWorker = vi.fn();
    try {
      const mounting = mountOrbitBrowser(container, {
        ...base,
        createWorker,
        signal: ended.signal,
        launch: async () => ({ historyId: "h1" }),
      });
      await vi.waitFor(() => expect(container.querySelector("#cred-overlay")).not.toBeNull());
      ended.abort();
      await mounting;
      expect(createWorker).not.toHaveBeenCalled();
      expect(container.childElementCount).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("ends a started page as dispose does", async () => {
    const ended = new AbortController();
    const worker = fakeWorker();
    await mountOrbitBrowser(container, {
      ...base,
      createWorker: () => worker as unknown as Worker,
      signal: ended.signal,
      launch: async () => ({ historyId: "h1" }),
    });
    ended.abort();
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    expect(container.childElementCount).toBe(0);
  });

  it("starts nothing when it has already ended", async () => {
    const ended = new AbortController();
    ended.abort();
    const createWorker = vi.fn();
    await mountOrbitBrowser(container, {
      ...base,
      createWorker,
      signal: ended.signal,
      launch: async () => ({ historyId: "h1" }),
    });
    expect(createWorker).not.toHaveBeenCalled();
    expect(container.childElementCount).toBe(0);
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
