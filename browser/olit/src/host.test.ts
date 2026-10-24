import { describe, expect, it, vi } from "vitest";
import { tellHost } from "./host";

describe("tellHost", () => {
  /** Galaxy listens on the window that owns the iframe, so a report to our own window is lost. */
  function fakeParent() {
    const postMessage = vi.fn();
    Object.defineProperty(window, "parent", { value: { postMessage }, configurable: true });
    return postMessage;
  }

  it("posts to the parent window as a Galaxy visualization", () => {
    const postMessage = fakeParent();
    tellHost({ visualization_saved: false });
    tellHost({ visualization_config: { view: "chat", exchange_id: "c1" } });
    expect(postMessage.mock.calls).toEqual([
      [{ from: "galaxy-visualization", visualization_saved: false }, "*"],
      [
        { from: "galaxy-visualization", visualization_config: { view: "chat", exchange_id: "c1" } },
        "*",
      ],
    ]);
  });
});
