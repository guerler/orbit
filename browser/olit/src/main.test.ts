import { beforeEach, describe, expect, it, vi } from "vitest";

const mounted = vi.hoisted(() => [] as string[]);
vi.mock("./modes/visualization", () => ({
  visualizationMode: { mount: async () => void mounted.push("visualization") },
}));
vi.mock("./modes/chat", () => ({ chatMode: { mount: async () => void mounted.push("chat") } }));
// Test the production build.
vi.mock("./launch", () => ({ isDev: () => false }));

/** Loads a fresh copy of the entry into the current document. */
async function load() {
  vi.resetModules();
  await import("./main");
  await new Promise((r) => setTimeout(r, 0));
}

beforeEach(() => {
  mounted.length = 0;
  document.body.innerHTML = "";
});

describe("Olit's page entry", () => {
  it("mounts on an element with data-incoming", async () => {
    document.body.innerHTML = `<div id="app" data-incoming='{"visualization_config":{"view":"chat"}}'></div>`;
    await load();
    expect(mounted).toEqual(["chat"]);
  });

  it("ignores an element without data-incoming, and a page without the element", async () => {
    document.body.innerHTML = `<div id="app">someone else's</div>`;
    await load();
    document.body.innerHTML = "";
    await load();
    expect(mounted).toEqual([]);
  });
});
