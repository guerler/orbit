import { afterEach, describe, expect, it, vi } from "vitest";
import { visualizationStore } from "../agent/fake-visualizations";
import { connectGalaxy } from "@galaxyproject/orbit-browser/testing";
import { SCHEMA, type SessionDocument } from "@galaxyproject/orbit-browser/agent";
import { NotYours } from "./store";
import { PLUGIN_TYPE, title, visualizations } from "./visualizations";

const document = (over: Partial<SessionDocument["session"]> = {}): SessionDocument => ({
  olit_session: SCHEMA,
  session: {
    id: "0123abcd-0000-0000-0000-000000000000",
    title: "",
    createdAt: "2026-10-06T00:00:00Z",
    updatedAt: "2026-10-06T00:00:00Z",
    turn: 1,
    models: [],
    usage: { input: 0, output: 0, cost: null },
    ...over,
  },
  entries: [{ kind: "pi.user", model: [{ role: "user", content: "a", timestamp: 0 }] }],
});

const ME = "f2db41e1fa331b3e";

/** A Galaxy that keeps visualizations in memory, each owned by the user who saved it. */
function fakeGalaxy(me: string | null = ME) {
  const { rows, answer } = visualizationStore(me);
  const fetchMock = vi.fn(async (request: Request) => (await answer(request))!);
  return { rows, fetchMock };
}

describe("a saved Olit visualization", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("is created as the olit type and never shared", async () => {
    const { rows, fetchMock } = fakeGalaxy();
    vi.stubGlobal("fetch", fetchMock);
    const id = await visualizations
      .connect(connectGalaxy({ root: "http://galaxy/" }))
      .save(document());
    const row = rows.get(id)! as any;
    expect(row.type).toBe(PLUGIN_TYPE);
    for (const key of ["importable", "published", "slug", "users_shared_with"]) {
      expect(row).not.toHaveProperty(key);
    }
  });

  it("reads back what was saved", async () => {
    const { fetchMock } = fakeGalaxy();
    vi.stubGlobal("fetch", fetchMock);
    const saved = visualizations.connect(connectGalaxy({ root: "http://galaxy/" }));
    const id = await saved.save(document());
    expect(await saved.load(id)).toEqual({ document: document() });
  });

  it.each([
    ["shared with this user, or open to anyone with the link", "0a248a1f62a0cc04"],
    ["saved with no owner Galaxy reports", undefined],
  ])("refuses a session %s, before reading it", async (_, owner) => {
    const { rows, fetchMock } = fakeGalaxy();
    vi.stubGlobal("fetch", fetchMock);
    rows.set("v9", { title: "theirs", config: document(), owner });
    await expect(
      visualizations.connect(connectGalaxy({ root: "http://galaxy/" })).load("v9"),
    ).rejects.toThrow(NotYours);
  });

  it("refuses every session to a user who is not signed in", async () => {
    const { rows, fetchMock } = fakeGalaxy(null);
    vi.stubGlobal("fetch", fetchMock);
    rows.set("v9", { title: "theirs", config: document(), owner: ME });
    await expect(
      visualizations.connect(connectGalaxy({ root: "http://galaxy/" })).load("v9"),
    ).rejects.toThrow(NotYours);
  });

  it("refuses a visualization that is not an Olit session", async () => {
    const { rows, fetchMock } = fakeGalaxy();
    vi.stubGlobal("fetch", fetchMock);
    rows.set("v1", { title: "chart", config: { settings: {}, tracks: [] }, owner: ME });
    expect(
      await visualizations.connect(connectGalaxy({ root: "http://galaxy/" })).load("v1"),
    ).toBeNull();
  });

  it("meets Galaxy's three-character title minimum", () => {
    expect(title(document({ title: "x" })).length).toBeGreaterThanOrEqual(3);
  });

  it("keeps a name the user gave it", () => {
    expect(title(document({ title: "Rabies dating run" }))).toBe("Rabies dating run");
  });

  it("surfaces a failed save instead of pretending it worked", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("boom", { status: 500 })),
    );
    await expect(
      visualizations.connect(connectGalaxy({ root: "http://galaxy/" })).save(document()),
    ).rejects.toThrow(/500/);
  });
});
