import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseIncoming } from "../incoming";
import { chatMode } from "./chat";

const GALAXY = "https://galaxy.example";

interface Shell {
  options: any;
  asked: string[];
  disposed: boolean;
  /** A save running in this shell, if any. */
  saving?: Promise<void>;
}
const shells: Shell[] = [];
let mountDelay = 0;
vi.mock("@galaxyproject/orbit-browser", () => ({
  mountOrbitBrowser: vi.fn(async (_container: HTMLElement, options: unknown) => {
    const shell: Shell = { options, asked: [], disposed: false };
    shells.push(shell);
    await new Promise((resolve) => setTimeout(resolve, mountDelay));
    return {
      dispose: () => (shell.disposed = true),
      ask: (question: string) => shell.asked.push(question),
      settled: async () => shell.saving,
    };
  }),
}));
// Launch is tested in launch.test.ts; this covers the chat mode's inputs and messages.
vi.mock("../launch", () => ({
  shellOptions: (
    _incoming: unknown,
    store: { kind: string },
    request: unknown,
    report: unknown,
  ) => ({
    kind: store.kind,
    request,
    report,
  }),
}));

let told: any[];
let order: string[];
let listeners: EventListenerOrEventListenerObject[];
/** Galaxy's page, which posts commands into Olit's window */
const parent = {};
beforeEach(() => {
  shells.length = 0;
  mountDelay = 0;
  told = [];
  order = [];
  listeners = [];
  Object.defineProperty(window, "parent", { value: parent, configurable: true });
  const add = window.addEventListener.bind(window);
  vi.spyOn(window, "addEventListener").mockImplementation(
    (type: string, listener: any, options?: any) => {
      if (type === "message") {
        order.push("listen");
        listeners.push(listener);
      }
      add(type, listener, options);
    },
  );
  vi.spyOn(window, "postMessage").mockImplementation((message: unknown) => {
    order.push("tell");
    told.push(message);
  });
});

afterEach(() => {
  listeners.forEach((listener) => window.removeEventListener("message", listener));
  vi.restoreAllMocks();
  Object.defineProperty(window, "parent", { value: window, configurable: true });
});

async function mountWith(config: object) {
  const container = document.createElement("div");
  container.dataset.incoming = JSON.stringify({
    root: `${GALAXY}/`,
    visualization_config: { view: "chat", ...config },
  });
  await chatMode.mount(container, parseIncoming(container));
  return shells.at(-1)!;
}

const settled = () => new Promise((resolve) => setTimeout(resolve, 20));
/** Posts as Galaxy does: from the parent, at Galaxy's origin */
const command = (data: object, source: unknown = parent, origin = GALAXY) =>
  window.dispatchEvent(
    new MessageEvent("message", {
      data: { from: "galaxy", ...data },
      source: source as Window,
      origin,
    }),
  );
const fromGalaxy = async (data: object) => {
  await settled();
  command(data);
};
const charts = (saved: boolean, config?: object) => ({
  from: "galaxy-visualization",
  visualization_saved: saved,
  ...(config && { visualization_config: config }),
});

describe("chat mode", () => {
  it("launches from its config and saves to Galaxy's chats", async () => {
    expect((await mountWith({ exchange_id: "c1" })).options.request).toEqual({
      savedId: "c1",
      question: undefined,
      datasetId: undefined,
    });
    expect((await mountWith({ question: "Count my reads" })).options.request).toEqual({
      savedId: undefined,
      question: "Count my reads",
      datasetId: undefined,
    });
    const plain = await mountWith({});
    expect(plain.options.request).toEqual({
      savedId: undefined,
      question: undefined,
      datasetId: undefined,
    });
    expect(plain.options.kind).toBe("chat");
  });

  it("listens before its first message, then reports saved and the shown chat as Charts messages", async () => {
    const { options } = await mountWith({});
    options.report.savedState(false);
    options.report.savedState(false);
    options.report.savedState(true);
    options.report.active("c1");
    options.report.active("c1");
    options.report.active(null);
    expect(order.slice(0, 2)).toEqual(["listen", "tell"]);
    expect(told).toEqual([
      charts(true),
      charts(false),
      charts(true),
      charts(true, { exchange_id: "c1" }),
      charts(true, { exchange_id: null }),
    ]);
  });

  it("takes commands only from the page that embeds it, at Galaxy's origin", async () => {
    const shell = await mountWith({});
    await settled();
    command({ type: "ask", question: "From itself?" }, window);
    command({ type: "ask", question: "From elsewhere?" }, parent, "https://elsewhere.example");
    command({ type: "ask", question: "" });
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { type: "ask", question: "Unmarked?" },
        source: parent as Window,
        origin: GALAXY,
      }),
    );
    await settled();
    expect(shell.asked).toEqual([]);
  });

  it("asks questions in the shell it shows", async () => {
    const shell = await mountWith({});
    await fromGalaxy({ type: "ask", question: "First?" });
    await fromGalaxy({ type: "ask", question: "Second?" });
    await settled();
    expect(shell.asked).toEqual(["First?", "Second?"]);
    expect(shells).toHaveLength(1);
  });

  it("opens a saved chat in a new shell in the same page, and reports it unchanged", async () => {
    const first = await mountWith({});
    first.options.report.savedState(false);
    await fromGalaxy({ type: "open", exchange_id: "c2" });
    await settled();
    expect(first.disposed).toBe(true);
    expect(shells).toHaveLength(2);
    expect(shells[1]!.options.request).toEqual({ savedId: "c2" });
    expect(told.at(-1)).toEqual(charts(true));
  });

  it("runs commands in the order Galaxy sent them, after the shell is up", async () => {
    mountDelay = 10;
    const container = document.createElement("div");
    container.dataset.incoming = JSON.stringify({
      root: `${GALAXY}/`,
      visualization_config: { view: "chat" },
    });
    const mounting = chatMode.mount(container, parseIncoming(container));
    await new Promise((resolve) => setTimeout(resolve, 1));
    command({ type: "ask", question: "Before?" });
    command({ type: "open", exchange_id: "c2" });
    command({ type: "ask", question: "After?" });
    await mounting;
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(shells.map((shell) => shell.asked)).toEqual([["Before?"], ["After?"]]);
    expect(shells[0]!.disposed).toBe(true);
  });

  it("opens another chat only once the shown one's save has ended", async () => {
    await mountWith({});
    let finish = () => {};
    shells[0]!.saving = new Promise<void>((resolve) => (finish = resolve));
    await fromGalaxy({ type: "open", exchange_id: "c2" });
    await settled();
    expect([shells.length, shells[0]!.disposed]).toEqual([1, false]);
    finish();
    await settled();
    expect([shells.length, shells[0]!.disposed]).toEqual([2, true]);
  });

  it("runs commands Galaxy's element sends on the first report, after the shell is up", async () => {
    mountDelay = 10;
    const element = document.createElement("div");
    const send = (data: object) =>
      element.dispatchEvent(new CustomEvent("galaxy", { detail: { from: "galaxy", ...data } }));
    // As Galaxy AI does: the first report marks the plugin ready, and queued commands go at once.
    element.addEventListener(
      "galaxy-visualization",
      () => {
        send({ type: "ask", question: "Queued?" });
        send({ type: "open", exchange_id: "c9" });
      },
      { once: true },
    );
    const container = document.createElement("div");
    container.dataset.incoming = JSON.stringify({
      root: `${GALAXY}/`,
      visualization_config: { view: "chat", exchange_id: "c1" },
    });
    const mounting = { element, signal: new AbortController().signal };
    await chatMode.mount(container, parseIncoming(container), mounting);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(shells.map((shell) => [shell.options.request.savedId, shell.asked])).toEqual([
      ["c1", ["Queued?"]],
      ["c9", []],
    ]);
    expect(shells[0]!.disposed).toBe(true);
  });
});
