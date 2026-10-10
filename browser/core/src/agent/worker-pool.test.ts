import { MemoryStorage } from "@earendil-works/pi-durable";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PageMessage, WorkerMessage } from "./worker";

const held: string[] = [];
const opened: Array<[string, string | undefined]> = [];

vi.mock("./storage", () => ({
  openStorage: async (name: string, pool?: string) => {
    opened.push([name, pool]);
    return { storage: new MemoryStorage() };
  },
  holdStorage: async (name: string) => {
    held.push(name);
  },
}));

beforeEach(() => {
  held.length = 0;
  opened.length = 0;
  vi.resetModules();
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = input instanceof Request ? input.url : String(input);
    const body = url.endsWith("api/users/current")
      ? { id: "u1" }
      : url.includes("api/pages")
        ? []
        : {};
    return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  });
});

afterEach(() => vi.unstubAllGlobals());

async function openWith(pool?: string) {
  const posted: WorkerMessage[] = [];
  vi.spyOn(self, "postMessage").mockImplementation(((message: WorkerMessage) => {
    posted.push(message);
  }) as typeof self.postMessage);
  (await import("./worker")).startAgentWorker({});
  const message: PageMessage = {
    type: "open",
    request: {
      pyodideURL: "http://galaxy.test/pyodide/",
      config: {
        galaxy_root: "http://galaxy.test/",
        ai_base_url: "http://llm.test/v1",
        ai_model: "m",
        ai_api_key: "k",
      },
      placement: { historyId: "h1" },
      ...(pool ? { pool } : {}),
    },
  };
  (self.onmessage as (e: MessageEvent<PageMessage>) => void)({ data: message } as MessageEvent);
  for (let i = 0; i < 300 && !opened.length; i++) await new Promise((r) => setTimeout(r, 10));
}

describe("the files a worker keeps sessions in", () => {
  it("holds and opens the brand's pool by default", async () => {
    await openWith();
    expect(held).toEqual(["orbit:storage"]);
    expect(opened).toEqual([["orbit-u1", "orbit"]]);
  });

  it("holds and opens the pool the page names", async () => {
    await openWith("olit-chat");
    expect(held).toEqual(["olit-chat:storage"]);
    expect(opened).toEqual([["olit-chat-u1", "olit-chat"]]);
  });
});
