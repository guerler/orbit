import { describe, expect, it } from "vitest";
import { SCHEMA, type SessionDocument } from "../agent/saved";
import { conversationMarkdown, markdownName } from "./markdown";

const document = (title: string): SessionDocument =>
  ({
    olit_session: SCHEMA,
    session: {
      id: "0123abcd-0000-0000-0000-000000000000",
      title,
      createdAt: "2026-11-27T20:00:00Z",
      updatedAt: "2026-11-27T20:00:00Z",
      turn: 1,
      models: [],
      usage: { input: 0, output: 0, cost: null },
    },
    entries: [
      { kind: "pi.user", model: [{ role: "user", content: "Draw the flow", timestamp: 0 }] },
      {
        kind: "pi.assistant",
        model: [{ role: "assistant", content: [{ type: "text", text: "Here it is." }] }],
      },
      {
        kind: "pi.tool",
        model: [
          {
            role: "toolResult",
            toolName: "make_artifact",
            content: [{ type: "text", text: "made" }],
            details: {
              artifacts: [{ kind: "mermaid", title: "Flow", diagram: "graph LR; a-->b" }],
            },
          },
        ],
      },
      {
        kind: "pi.tool",
        model: [
          {
            role: "toolResult",
            toolName: "finish",
            isError: false,
            content: [{ type: "text", text: "Done." }],
          },
        ],
      },
    ],
  }) as unknown as SessionDocument;

describe("a conversation as Markdown", () => {
  it("has each question, answer and artifact in order", () => {
    expect(conversationMarkdown(document("Read counts"))).toBe(
      [
        "# Read counts",
        "## Question\n\nDraw the flow",
        "Here it is.",
        "### Flow\n\n```json\n" +
          JSON.stringify({ kind: "mermaid", title: "Flow", diagram: "graph LR; a-->b" }, null, 2) +
          "\n```",
        "Done.",
      ].join("\n\n") + "\n",
    );
  });

  it("is named after the conversation", () => {
    expect(markdownName(document("Read counts: run 2"))).toBe("read-counts-run-2.md");
    expect(markdownName(document(""))).toBe("conversation-0123abcd.md");
  });
});
