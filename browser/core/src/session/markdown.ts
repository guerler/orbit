import type { Message } from "@earendil-works/pi-ai";
import type { EntryRecord } from "@earendil-works/pi-durable";
import { artifactsOf, fenced, toPage, type Artifact } from "../artifacts/kinds";
import type { SessionDocument } from "../agent/saved";

const said = (message: Message): string => {
  if (typeof message.content === "string") return message.content;
  return message.content
    .filter((c) => c.type === "text")
    .map((c) => (c as { text: string }).text)
    .join("");
};

const artifactText = (artifact: Artifact): string =>
  `### ${artifact.title || artifact.kind}\n\n` +
  (toPage(artifact) ?? fenced("json", JSON.stringify(artifact, null, 2)));

/** The conversation as Markdown: each question, each answer and each artifact, in order. */
export function conversationMarkdown(saved: SessionDocument): string {
  const parts = [`# ${saved.session.title.trim() || "Conversation"}`];
  for (const entry of saved.entries as EntryRecord[]) {
    for (const message of (entry.model ?? []) as Message[]) {
      const text = said(message).trim();
      if (message.role === "user" && text) {
        parts.push(`## Question\n\n${text}`);
      } else if (message.role === "assistant" && text) {
        parts.push(text);
      } else if (
        message.role === "toolResult" &&
        message.toolName === "finish" &&
        !message.isError &&
        text
      ) {
        parts.push(text);
      }
    }
    parts.push(...artifactsOf([entry]).map(artifactText));
  }
  return parts.join("\n\n") + "\n";
}

/** A file name for the conversation's Markdown. */
export function markdownName(saved: SessionDocument): string {
  const slug = saved.session.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
  return `${slug || `conversation-${saved.session.id.slice(0, 8)}`}.md`;
}
