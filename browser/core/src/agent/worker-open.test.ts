import { MemoryStorage } from "@earendil-works/pi-durable";
import { afterAll, expect, it, vi } from "vitest";

import { json } from "./fake-model";
import { SCHEMA } from "./saved";
import type { PageMessage, WorkerMessage } from "./worker";

vi.mock("./storage", () => ({
  openStorage: async () => ({ storage: new MemoryStorage() }),
  holdStorage: async () => {},
}));
vi.mock("./python", async (original) => ({
  ...(await original<typeof import("./python")>()),
  browserPython: () => ({
    run: async () => "",
    write: async () => {},
    read: async () => undefined,
  }),
}));

afterAll(() => vi.unstubAllGlobals());

it("starts the history afresh when a saved conversation cannot be opened", async () => {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.endsWith("api/users/current")) return json({ id: "u1" });
    if (url.endsWith("api/version")) return json({ version_major: "26.1" });
    return json([]);
  });
  const posted: WorkerMessage[] = [];
  vi.spyOn(self, "postMessage").mockImplementation(((message: WorkerMessage) => {
    posted.push(message);
  }) as typeof self.postMessage);
  (await import("./worker")).startAgentWorker({});
  // Valid as a document, but an assistant message without content breaks the conversation.
  const document = {
    olit_session: SCHEMA,
    history_id: "h1",
    session: {
      id: "s1",
      title: "",
      createdAt: "2026-11-28T00:00:00Z",
      updatedAt: "2026-11-28T00:00:00Z",
      turn: 1,
      models: [],
      usage: { input: 0, output: 0, cost: null },
    },
    entries: [
      { kind: "pi.user", model: [{ role: "user", content: "q", timestamp: 0 }] },
      { kind: "pi.assistant", model: [{ role: "assistant" }] },
    ],
  };
  const send = (message: PageMessage) =>
    (self.onmessage as (e: MessageEvent<PageMessage>) => void)({ data: message } as MessageEvent);
  send({
    type: "open",
    request: {
      pyodideURL: "http://galaxy.test/pyodide/",
      config: {
        galaxy_root: "http://galaxy.test/",
        ai_base_url: "http://llm.test/v1",
        ai_model: "m",
      },
      placement: {},
      saved: { id: "chat/c1", document },
    },
  } as unknown as PageMessage);
  for (let i = 0; i < 300 && !posted.some((m) => m.type === "ready"); i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const ready = posted.find((m) => m.type === "ready") as {
    savedProblem?: string;
    savedAs?: string;
  };
  expect(ready.savedProblem).toBeTruthy();
  expect(ready.savedAs).toBeUndefined();
  send({ type: "export", id: 1, title: "" } as PageMessage);
  for (let i = 0; i < 300 && !posted.some((m) => m.type === "reply"); i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const reply = posted.find((m) => m.type === "reply") as { value?: any; error?: string };
  expect(reply.error).toBeUndefined();
  expect(reply.value.history_id).toBe("h1");
  expect(reply.value.entries).toEqual([]);
});
