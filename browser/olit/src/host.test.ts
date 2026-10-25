import { afterEach, describe, expect, it, vi } from "vitest";
import { chatCommand, connectChatHost, tellHost } from "./host";

/** Galaxy listens on the window that owns the iframe, so a report to our own window is lost. */
function fakeParent() {
  const parent = { postMessage: vi.fn() };
  Object.defineProperty(window, "parent", { value: parent, configurable: true });
  return parent;
}

afterEach(() => {
  Object.defineProperty(window, "parent", { value: window, configurable: true });
});

describe("tellHost", () => {
  it("posts to the parent window as a Galaxy visualization", () => {
    const { postMessage } = fakeParent();
    tellHost({ visualization_saved: false });
    expect(postMessage.mock.calls).toEqual([
      [{ from: "galaxy-visualization", visualization_saved: false }, "*"],
    ]);
  });
});

describe("chatCommand", () => {
  it("reads Galaxy AI's commands", () => {
    expect(chatCommand({ channel: "galaxy-ai", type: "open", exchange_id: "c1" })).toEqual({
      type: "open",
      exchange_id: "c1",
    });
    expect(chatCommand({ channel: "galaxy-ai", type: "ask", question: "Hi" })).toEqual({
      type: "ask",
      question: "Hi",
    });
  });

  it("reads nothing from other messages", () => {
    expect(chatCommand(null)).toBeNull();
    expect(chatCommand({ type: "ask", question: "Hi" })).toBeNull();
    expect(chatCommand({ channel: "galaxy-ai", type: "ask", question: "" })).toBeNull();
    expect(chatCommand({ channel: "galaxy-ai", type: "open", exchange_id: 3 })).toBeNull();
    expect(chatCommand({ channel: "galaxy-ai", type: "ready" })).toBeNull();
    expect(chatCommand({ from: "galaxy-visualization", visualization_saved: true })).toBeNull();
  });
});

describe("connectChatHost", () => {
  const GALAXY = "https://galaxy.example";
  const later = () => new Promise((resolve) => setTimeout(resolve, 10));

  /** Answers as Galaxy would: a port into the frame, from `source` at `origin`. */
  function connect(source: unknown, origin = GALAXY) {
    const channel = new MessageChannel();
    const reports: unknown[] = [];
    channel.port1.onmessage = (event) => reports.push(event.data);
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { channel: "galaxy-ai", type: "connect" },
        source: source as Window,
        origin,
        ports: [channel.port2],
      }),
    );
    return { galaxy: channel.port1, reports };
  }

  it("says ready to Galaxy's origin only", () => {
    const { postMessage } = fakeParent();
    connectChatHost(`${GALAXY}/root/`, () => {});
    expect(postMessage.mock.calls).toEqual([[{ channel: "galaxy-ai", type: "ready" }, GALAXY]]);
  });

  it("reports and takes commands over the port Galaxy answers with", async () => {
    const parent = fakeParent();
    const commands: unknown[] = [];
    const host = connectChatHost(`${GALAXY}/`, (command) => commands.push(command));
    host.report({ type: "unsaved", value: false });
    const { galaxy, reports } = connect(parent);
    host.report({ type: "active", exchange_id: "c1" });
    galaxy.postMessage({ channel: "galaxy-ai", type: "ask", question: "Hi" });
    galaxy.postMessage({ channel: "galaxy-ai", type: "ready" });
    await later();
    expect(reports).toEqual([
      { channel: "galaxy-ai", type: "unsaved", value: false },
      { channel: "galaxy-ai", type: "active", exchange_id: "c1" },
    ]);
    expect(commands).toEqual([{ type: "ask", question: "Hi" }]);
    expect(parent.postMessage).toHaveBeenCalledTimes(1);
  });

  it("takes a port only from the page that embeds it, on Galaxy's origin, once", async () => {
    const parent = fakeParent();
    const commands: unknown[] = [];
    connectChatHost(`${GALAXY}/`, (command) => commands.push(command));
    const ask = { channel: "galaxy-ai", type: "ask", question: "Hi" };
    connect(window).galaxy.postMessage(ask);
    connect(parent, "https://elsewhere.example").galaxy.postMessage(ask);
    const { galaxy } = connect(parent);
    connect(parent).galaxy.postMessage(ask);
    await later();
    expect(commands).toEqual([]);
    galaxy.postMessage(ask);
    await later();
    expect(commands).toEqual([{ type: "ask", question: "Hi" }]);
  });

  it("neither says ready nor connects when it is not embedded", async () => {
    const posted = vi.spyOn(window, "postMessage");
    const commands: unknown[] = [];
    connectChatHost(window.location.href, (command) => commands.push(command));
    connect(window, window.location.origin).galaxy.postMessage({
      channel: "galaxy-ai",
      type: "ask",
      question: "Hi",
    });
    await later();
    expect(posted).not.toHaveBeenCalled();
    expect(commands).toEqual([]);
  });
});
