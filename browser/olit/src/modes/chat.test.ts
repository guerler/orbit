import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseIncoming } from "../incoming";
import { chatMode } from "./chat";

const GALAXY = "https://galaxy.example";

interface Shell {
  options: any;
  asked: string[];
  disposed: boolean;
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
let saidReady: string[];
let galaxy: MessagePort | undefined;
/** Galaxy's page: it answers `ready` with a port, over which it takes reports. */
let parent: { postMessage: (message: unknown, origin: string) => void };
beforeEach(() => {
  shells.length = 0;
  mountDelay = 0;
  told = [];
  saidReady = [];
  galaxy = undefined;
  parent = {
    postMessage: (message, origin) => {
      saidReady.push(origin);
      const channel = new MessageChannel();
      galaxy = channel.port1;
      const into = told;
      galaxy.onmessage = (event) => into.push(event.data);
      setTimeout(() =>
        window.dispatchEvent(
          new MessageEvent("message", {
            data: { channel: "galaxy-ai", type: "connect" },
            source: parent as unknown as Window,
            origin: GALAXY,
            ports: [channel.port2],
          }),
        ),
      );
    },
  };
  Object.defineProperty(window, "parent", { value: parent, configurable: true });
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
const fromGalaxy = async (data: object) => {
  await settled();
  galaxy!.postMessage({ channel: "galaxy-ai", ...data });
};

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

  it("says ready to Galaxy's origin, then reports saved and the shown chat over the port", async () => {
    const { options } = await mountWith({});
    options.report.savedState(false);
    options.report.savedState(false);
    options.report.savedState(true);
    options.report.active("c1");
    options.report.active(null);
    await settled();
    expect(saidReady).toEqual([GALAXY]);
    expect(told).toEqual([
      { channel: "galaxy-ai", type: "unsaved", value: false },
      { channel: "galaxy-ai", type: "unsaved", value: true },
      { channel: "galaxy-ai", type: "unsaved", value: false },
      { channel: "galaxy-ai", type: "active", exchange_id: "c1" },
      { channel: "galaxy-ai", type: "active", exchange_id: null },
    ]);
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
    expect(told.at(-1)).toEqual({ channel: "galaxy-ai", type: "unsaved", value: false });
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
    galaxy!.postMessage({ channel: "galaxy-ai", type: "ask", question: "Before?" });
    galaxy!.postMessage({ channel: "galaxy-ai", type: "open", exchange_id: "c2" });
    galaxy!.postMessage({ channel: "galaxy-ai", type: "ask", question: "After?" });
    await mounting;
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(shells.map((shell) => shell.asked)).toEqual([["Before?"], ["After?"]]);
    expect(shells[0]!.disposed).toBe(true);
  });

  it("sends no Charts messages", async () => {
    const { options } = await mountWith({});
    options.report.savedState(false);
    options.report.active("c1");
    await settled();
    expect(told.length).toBeGreaterThan(0);
    expect(told.some((message) => "from" in message)).toBe(false);
  });
});
