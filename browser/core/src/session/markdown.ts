import type { Message } from "@earendil-works/pi-ai";
import type { EntryRecord } from "@earendil-works/pi-durable";
import { artifactsOf, fenced, toPage, type Artifact } from "../artifacts/kinds";
import type { Brand } from "../agent/brand";
import type { SessionDocument } from "../agent/saved";
import { answerOf, questionOf } from "./turns";

const artifactText = (artifact: Artifact): string =>
  `### ${artifact.title || artifact.kind}\n\n` +
  (toPage(artifact) ?? fenced("json", JSON.stringify(artifact, null, 2)));

/** The conversation as Markdown: each question, each answer and each artifact, in order. */
export function conversationMarkdown(saved: SessionDocument, brand: Brand): string {
  const parts = [`# ${saved.session.title.trim() || "Conversation"}`];
  for (const entry of saved.entries as EntryRecord[]) {
    for (const message of (entry.model ?? []) as Message[]) {
      const question = questionOf(message, brand);
      const answer = answerOf(message);
      if (question) parts.push(`## Question\n\n${question}`);
      if (answer) parts.push(answer);
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
