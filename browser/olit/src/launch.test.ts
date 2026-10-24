import { afterEach, describe, expect, it, vi } from "vitest";

import { SCHEMA, type SessionDocument } from "@galaxyproject/orbit-browser/agent";
import { connectGalaxy } from "@galaxyproject/orbit-browser/testing";
import type { LaunchContext } from "@galaxyproject/orbit-browser";
import { parseIncoming } from "./incoming";
import { shellOptions, type LaunchRequest } from "./launch";
import { NotYours, type Opened, type Saves, type Store } from "./stores/store";

const galaxy = connectGalaxy({ root: "http://galaxy/" });

afterEach(() => vi.unstubAllGlobals());

const session = (over: Partial<SessionDocument> = {}): SessionDocument => ({
  olit_session: SCHEMA,
  session: {
    id: "0123abcd-0000-0000-0000-000000000000",
    title: "",
    createdAt: "2026-10-06T00:00:00Z",
    updatedAt: "2026-10-06T00:00:00Z",
    turn: 1,
    models: [],
    usage: { input: 0, output: 0, cost: null },
  },
  entries: [],
  ...over,
});

/** Fake Galaxy that answers by path and records requests. */
function routes(answers: Record<string, unknown>) {
  const asked: string[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const path = new URL(input instanceof Request ? input.url : String(input)).pathname.slice(1);
    asked.push(path);
    return path in answers
      ? new Response(JSON.stringify(answers[path]), { status: 200 })
      : new Response("not found", { status: 404 });
  });
  return asked;
}

const DATASET = {
  "api/datasets/d1": { name: "a.csv", extension: "csv", state: "ok", history_id: "h1" },
};
const CURRENT = { "history/current_history_json": { id: "h9" } };

/** Fake store that returns `load` and records saves. */
function store(load: (id: string) => Promise<Opened | null>) {
  const saved: Array<{ document: SessionDocument; id?: string }> = [];
  const saves: Saves = {
    load,
    async save(document, id) {
      saved.push({ document, id });
      return id ?? "new";
    },
  };
  const definition: Store = {
    kind: "test",
    wording: { savedNote: "Saved here." },
    connect: () => saves,
  };
  return { definition, saved };
}

function options(definition: Store, request: LaunchRequest, report = { savedState: vi.fn() }) {
  const incoming = parseIncoming(document.createElement("div"));
  return shellOptions({ ...incoming, root: "http://galaxy/" }, definition, request, report);
}

const launched = (definition: Store, request: LaunchRequest): Promise<LaunchContext> =>
  options(definition, request).launch!(galaxy);

describe("launching a saved conversation", () => {
  it("opens it in its saved history", async () => {
    const asked = routes({});
    const document = session({ history_id: "h1" });
    const { definition } = store(async () => ({ document }));
    expect(await launched(definition, { savedId: "s1", datasetId: "d1" })).toEqual({
      saved: { id: "s1", document },
    });
    expect(asked).toEqual([]);
  });

  it("opens it without a history, not in the current history", async () => {
    const asked = routes(CURRENT);
    const document = session();
    const { definition } = store(async () => ({ document }));
    expect(await launched(definition, { savedId: "s1" })).toEqual({
      saved: { id: "s1", document },
    });
    expect(asked).toEqual([]);
  });

  it("continues an older GalaxyAI chat in the current history, with a note", async () => {
    routes(CURRENT);
    const document = session();
    const { definition } = store(async () => ({ document, held: { note: "Held before." } }));
    expect(await launched(definition, { savedId: "g1" })).toEqual({
      saved: { id: "g1", document: { ...document, history_id: "h9" } },
      greeting: "Held before.",
    });
  });

  it("refuses another user's save, including its dataset", async () => {
    const asked = routes(DATASET);
    const { definition } = store(async () => {
      throw new NotYours("it was not saved by the signed-in user");
    });
    const context = await launched(definition, { savedId: "s1", datasetId: "d1" });
    expect(context.stop).toMatch(/only your own saved conversations, and s1 is not one/);
    expect(context.saved).toBeUndefined();
    expect(asked).toEqual([]);
  });

  it("starts on the dataset when the save cannot be opened, and says why", async () => {
    routes(DATASET);
    const { definition } = store(async () => null);
    const context = await launched(definition, { savedId: "s1", datasetId: "d1" });
    expect(context.historyId).toBe("h1");
    expect(context.savedProblem).toMatch(
      /Could not open saved conversation s1 \(it is not a conversation this version can open\)/,
    );
  });

  it("says what went wrong when loading the save fails", async () => {
    routes(CURRENT);
    const { definition } = store(async () => {
      throw new Error("Galaxy answered 500");
    });
    const context = await launched(definition, { savedId: "s1" });
    expect(context.historyId).toBe("h9");
    expect(context.savedProblem).toMatch(/\(Galaxy answered 500\)/);
  });
});

describe("launching without a save", () => {
  it("starts on the given dataset", async () => {
    routes(DATASET);
    const { definition } = store(async () => null);
    const context = await launched(definition, { datasetId: "d1" });
    expect(context.historyId).toBe("h1");
    expect(context.greeting).toMatch(/a\.csv/);
  });

  it("starts in the current history without a dataset", async () => {
    routes(CURRENT);
    const { definition } = store(async () => null);
    expect((await launched(definition, {})).historyId).toBe("h9");
  });

  it("asks the given question once ready", async () => {
    routes(CURRENT);
    const { definition } = store(async () => null);
    expect((await launched(definition, { question: "how many?" })).ask).toBe("how many?");
  });
});

describe("saving through the store", () => {
  it("passes the store's name and wording, and saves to it after launch", async () => {
    routes(CURRENT);
    const { definition, saved } = store(async () => null);
    const report = { savedState: vi.fn() };
    const shell = options(definition, {}, report);
    await shell.launch!(galaxy);
    const document = session();
    expect(await shell.sessions!.save(document, "s1")).toBe("s1");
    expect(saved).toEqual([{ document, id: "s1" }]);
    expect(shell.sessions).toMatchObject({ kind: "test", savedNote: "Saved here." });
    shell.sessions!.savedState(true);
    expect(report.savedState).toHaveBeenCalledWith(true);
  });
});
