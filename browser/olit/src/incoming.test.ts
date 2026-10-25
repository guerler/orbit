import { describe, expect, it } from "vitest";
import { CHAT_VIEW, DEFAULT_PLUGIN, parseIncoming, VISUALIZATION_VIEW } from "./incoming";

const container = (incoming: object) => {
  const element = document.createElement("div");
  element.dataset.incoming = JSON.stringify(incoming);
  return element;
};

describe("view", () => {
  it("defaults to visualization", () => {
    expect(parseIncoming(container({ visualization_config: { dataset_id: "d1" } })).view).toBe(
      VISUALIZATION_VIEW,
    );
  });

  it("is chat when the config says so", () => {
    expect(parseIncoming(container({ visualization_config: { view: CHAT_VIEW } })).view).toBe(
      CHAT_VIEW,
    );
  });

  it("falls back to visualization for an unknown view", () => {
    expect(parseIncoming(container({ visualization_config: { view: "pane" } })).view).toBe(
      VISUALIZATION_VIEW,
    );
  });

  it("reads the visualization id from the config or the page query", () => {
    expect(parseIncoming(container({ visualization_id: "v1" })).visualizationId).toBe("v1");
    expect(parseIncoming(container({}), "?visualization_id=v2").visualizationId).toBe("v2");
  });

  it("reads the chat id and question from the config, ignoring non-strings", () => {
    const chat = (config: object) =>
      parseIncoming(container({ visualization_config: { view: CHAT_VIEW, ...config } }));
    expect(chat({ exchange_id: "c1" })).toMatchObject({ exchangeId: "c1", question: undefined });
    expect(chat({ question: "Count my reads" })).toMatchObject({
      exchangeId: undefined,
      question: "Count my reads",
    });
    expect(chat({ exchange_id: 3, question: {} })).toMatchObject({
      exchangeId: undefined,
      question: undefined,
    });
  });
});

describe("plugin", () => {
  it("is the name Galaxy serves the plugin under", () => {
    expect(parseIncoming(container({ visualization_plugin: { name: "chat_agent" } })).plugin).toBe(
      "chat_agent",
    );
  });

  it("is the default without a usable name", () => {
    expect(parseIncoming(container({})).plugin).toBe(DEFAULT_PLUGIN);
    expect(parseIncoming(container({ visualization_plugin: { name: "../x" } })).plugin).toBe(
      DEFAULT_PLUGIN,
    );
  });
});
