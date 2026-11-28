import { describe, expect, it, vi } from "vitest";
import { parseIncoming } from "../incoming";
import { visualizationMode } from "./visualization";

vi.mock("@galaxyproject/orbit-browser", () => ({ mountOrbitBrowser: vi.fn(async () => ({})) }));
vi.mock("../launch", () => ({ shellOptions: () => ({}) }));

describe("visualization mode", () => {
  it("keeps a visualization shown inside it from reporting to Galaxy as Olit", async () => {
    // Galaxy's listener on Olit's window, added before Olit runs.
    const galaxy = vi.fn();
    window.addEventListener("message", galaxy);
    const container = document.createElement("div");
    container.dataset.incoming = JSON.stringify({ root: "/", visualization_config: {} });
    await visualizationMode.mount(container, parseIncoming(container));
    const frame = document.body.appendChild(document.createElement("iframe"));
    const report = { from: "galaxy-visualization", visualization_saved: true };
    window.dispatchEvent(
      new MessageEvent("message", { data: report, source: frame.contentWindow }),
    );
    window.dispatchEvent(new MessageEvent("message", { data: report, source: window }));
    expect(galaxy).toHaveBeenCalledTimes(1);
    expect(galaxy.mock.calls[0]![0].source).toBe(window);
    window.removeEventListener("message", galaxy);
    frame.remove();
  });
});
