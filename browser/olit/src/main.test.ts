import { beforeEach, describe, expect, it, vi } from "vitest";

const mounted = vi.hoisted(() => [] as string[]);
const mountings = vi.hoisted(
  () =>
    [] as { container: HTMLElement; mounting?: { element: HTMLElement; signal: AbortSignal } }[],
);
vi.mock("./modes/visualization", () => ({
  visualizationMode: {
    mount: async (container: HTMLElement, _incoming: unknown, mounting?: any) => {
      mounted.push("visualization");
      mountings.push({ container, mounting });
    },
  },
}));
vi.mock("./modes/chat", () => ({
  chatMode: {
    mount: async (container: HTMLElement, _incoming: unknown, mounting?: any) => {
      mounted.push("chat");
      mountings.push({ container, mounting });
    },
  },
}));
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
  mountings.length = 0;
  document.body.innerHTML = "";
});

describe("Olit's page entry", () => {
  it("mounts on an element with data-incoming", async () => {
    document.body.innerHTML = `<div id="app" data-incoming='{"visualization_config":{"view":"chat"}}'></div>`;
    await load();
    expect(mounted).toEqual(["chat"]);
  });

  it("leaves other elements and pages alone", async () => {
    document.body.innerHTML = `<div id="app">someone else's</div>`;
    await load();
    document.body.innerHTML = "";
    await load();
    expect(mounted).toEqual([]);
  });
});

describe("the olit-plugin element", () => {
  const nextTask = () => new Promise((r) => setTimeout(r, 0));
  const element = (config: object) => {
    const el = document.createElement("olit-plugin");
    el.setAttribute("data-incoming", JSON.stringify({ visualization_config: config }));
    return el;
  };

  it("is defined by the page entry, which mounts nothing on a page without data-incoming", async () => {
    document.body.innerHTML = `<div id="app">Galaxy</div>`;
    await load();
    expect(customElements.get("olit-plugin")).toBeDefined();
    expect(mounted).toEqual([]);
    expect(document.getElementById("app")!.textContent).toBe("Galaxy");
  });

  it("can be imported again", async () => {
    await load();
    await expect(load()).resolves.toBeUndefined();
  });

  it("mounts the view its data-incoming names, in its own shadow root", async () => {
    await load();
    const el = document.body.appendChild(element({ view: "chat" }));
    expect(mounted).toEqual(["chat"]);
    expect(mountings[0].mounting?.element).toBe(el);
    expect(el.shadowRoot!.contains(mountings[0].container)).toBe(true);
    expect(mountings[0].mounting?.signal.aborted).toBe(false);
  });

  it("ends when it is removed, also while it is still starting", async () => {
    await load();
    const el = document.body.appendChild(element({}));
    el.remove();
    await nextTask();
    expect(mounted).toEqual(["visualization"]);
    expect(mountings[0].mounting?.signal.aborted).toBe(true);
    expect(el.shadowRoot!.childElementCount).toBe(0);
  });

  it("keeps running when it is moved within a task", async () => {
    await load();
    const target = document.body.appendChild(document.createElement("section"));
    const el = document.body.appendChild(element({}));
    target.appendChild(el);
    await nextTask();
    expect(mounted).toEqual(["visualization"]);
    expect(mountings[0].mounting?.signal.aborted).toBe(false);
    expect(el.shadowRoot!.childElementCount).toBe(1);
  });

  it("starts again when it is put back after it ended", async () => {
    await load();
    const el = document.body.appendChild(element({}));
    el.remove();
    await nextTask();
    document.body.appendChild(el);
    expect(mounted).toEqual(["visualization", "visualization"]);
    expect(mountings[1].mounting?.signal.aborted).toBe(false);
  });
});
