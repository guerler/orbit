import { afterEach, describe, expect, it, vi } from "vitest";
import { chatCommand, listenToElement, listenToGalaxy, tellHost } from "./host";

const GALAXY = "https://galaxy.example";
const later = () => new Promise((resolve) => setTimeout(resolve, 10));

afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(window, "parent", { value: window, configurable: true });
});

describe("tellHost", () => {
  it("posts to the parent window as a Galaxy visualization", () => {
    const parent = { postMessage: vi.fn() };
    Object.defineProperty(window, "parent", { value: parent, configurable: true });
    tellHost({ visualization_saved: false });
    expect(parent.postMessage.mock.calls).toEqual([
      [{ from: "galaxy-visualization", visualization_saved: false }, "*"],
    ]);
  });

  it("posts to the window it is given, where Galaxy listens on the frame it mounted", () => {
    const posted = vi.spyOn(window, "postMessage").mockImplementation(() => {});
    tellHost({ visualization_saved: true }, window);
    expect(posted.mock.calls).toEqual([
      [{ from: "galaxy-visualization", visualization_saved: true }, "*"],
    ]);
  });
});

describe("chatCommand", () => {
  it("reads Galaxy AI's commands", () => {
    expect(chatCommand({ from: "galaxy", type: "open", exchange_id: "c1" })).toEqual({
      type: "open",
      exchange_id: "c1",
    });
    expect(chatCommand({ from: "galaxy", type: "ask", question: "Hi" })).toEqual({
      type: "ask",
      question: "Hi",
    });
  });

  it("reads nothing from other messages", () => {
    expect(chatCommand(null)).toBeNull();
    expect(chatCommand({ type: "ask", question: "Hi" })).toBeNull();
    expect(chatCommand({ from: "galaxy", type: "ask", question: "" })).toBeNull();
    expect(chatCommand({ from: "galaxy", type: "open", exchange_id: 3 })).toBeNull();
    expect(chatCommand({ from: "galaxy-visualization", visualization_saved: true })).toBeNull();
  });
});

describe("listenToGalaxy", () => {
  const ask = { from: "galaxy", type: "ask", question: "Hi" };
  const post = (source: unknown, origin = GALAXY) =>
    window.dispatchEvent(
      new MessageEvent("message", { data: ask, source: source as Window, origin }),
    );

  it("takes commands only from the page that embeds it, at Galaxy's origin", async () => {
    const parent = {};
    Object.defineProperty(window, "parent", { value: parent, configurable: true });
    const commands: unknown[] = [];
    listenToGalaxy(`${GALAXY}/root/`, (command) => commands.push(command));
    post(window);
    post(parent, "https://elsewhere.example");
    await later();
    expect(commands).toEqual([]);
    post(parent);
    await later();
    expect(commands).toEqual([{ type: "ask", question: "Hi" }]);
  });

  it("takes no commands when it is not embedded", async () => {
    const commands: unknown[] = [];
    listenToGalaxy(window.location.href, (command) => commands.push(command));
    post(window, window.location.origin);
    await later();
    expect(commands).toEqual([]);
  });
});

describe("as an element in Galaxy's page", () => {
  it("reports with an event on the element, carrying the message a frame would post", () => {
    const element = document.createElement("div");
    const posted = vi.spyOn(window, "postMessage").mockImplementation(() => {});
    const reports: unknown[] = [];
    element.addEventListener("galaxy-visualization", (e) =>
      reports.push((e as CustomEvent).detail),
    );
    tellHost({ visualization_saved: false, visualization_config: { exchange_id: "c1" } }, element);
    expect(reports).toEqual([
      {
        from: "galaxy-visualization",
        visualization_saved: false,
        visualization_config: { exchange_id: "c1" },
      },
    ]);
    expect(posted).not.toHaveBeenCalled();
  });

  it("takes commands from events on the element until it ends, and none from the window", async () => {
    const element = document.createElement("div");
    const ended = new AbortController();
    const commands: unknown[] = [];
    listenToElement({ element, signal: ended.signal }, (command) => commands.push(command));
    window.postMessage({ from: "galaxy", type: "ask", question: "From the window" }, "*");
    await later();
    element.dispatchEvent(
      new CustomEvent("galaxy", { detail: { from: "galaxy", type: "ask", question: "Hi" } }),
    );
    element.dispatchEvent(
      new CustomEvent("galaxy", { detail: { type: "ask", question: "Unmarked" } }),
    );
    ended.abort();
    element.dispatchEvent(
      new CustomEvent("galaxy", { detail: { from: "galaxy", type: "open", exchange_id: "c2" } }),
    );
    expect(commands).toEqual([{ type: "ask", question: "Hi" }]);
  });
});
