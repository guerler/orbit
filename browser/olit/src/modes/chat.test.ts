import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseIncoming } from "../incoming";
import { chatMode } from "./chat";

const mounted: any[] = [];
vi.mock("@galaxyproject/orbit-browser", () => ({
  mountOrbitBrowser: vi.fn(async (_container: HTMLElement, options: unknown) => {
    mounted.push(options);
    return { dispose() {} };
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

let told: unknown[];
beforeEach(() => {
  mounted.length = 0;
  told = [];
  Object.defineProperty(window, "parent", {
    value: { postMessage: (message: { from: string }) => told.push(message) },
    configurable: true,
  });
});

async function mountWith(config: object) {
  const container = document.createElement("div");
  container.dataset.incoming = JSON.stringify({
    root: "/",
    visualization_config: { view: "chat", ...config },
  });
  await chatMode.mount(container, parseIncoming(container));
  return mounted.at(-1);
}

const without = ({ from, ...message }: any) => message;

describe("chat mode", () => {
  it("launches from its config and saves to Galaxy's chats", async () => {
    expect((await mountWith({ exchange_id: "c1" })).request).toEqual({
      savedId: "c1",
      question: undefined,
      datasetId: undefined,
    });
    expect((await mountWith({ question: "Count my reads" })).request).toEqual({
      savedId: undefined,
      question: "Count my reads",
      datasetId: undefined,
    });
    const plain = await mountWith({});
    expect(plain.request).toEqual({
      savedId: undefined,
      question: undefined,
      datasetId: undefined,
    });
    expect(plain.kind).toBe("chat");
  });

  it("reports saved on mount, then only changes", async () => {
    const { report } = await mountWith({});
    report.savedState(false);
    report.savedState(false);
    report.savedState(true);
    report.savedState(true);
    expect(told.map(without)).toEqual([
      { visualization_saved: true },
      { visualization_saved: false },
      { visualization_saved: true },
    ]);
  });

  it("reports the shown chat's config to Galaxy", async () => {
    const { report } = await mountWith({ question: "Count my reads" });
    told.length = 0;
    report.active("c1");
    report.active(null);
    expect(told.map(without)).toEqual([
      { visualization_config: { view: "chat", exchange_id: "c1" } },
      { visualization_config: { view: "chat" } },
    ]);
  });

  it("sends every message as a Galaxy visualization", async () => {
    await mountWith({});
    expect(told.every((message: any) => message.from === "galaxy-visualization")).toBe(true);
  });
});
