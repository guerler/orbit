import type { Message } from "@earendil-works/pi-ai";
import { followUpMark, type Brand } from "../agent/brand";
import { EMPTY_REPLY } from "../agent/markers";

/** A message's text: the typed string, or the text blocks of a reply or result. */
export function textOf(message: { content?: unknown }): string {
  let text = "";
  if (typeof message.content === "string") {
    text = message.content;
  } else if (Array.isArray(message.content)) {
    text = message.content
      .filter((block) => block?.type === "text" && typeof block.text === "string")
      .map((block) => block.text)
      .join("");
  }
  return text;
}

/** The question a user message carries, or undefined for one the agent sent itself. */
export function questionOf(message: Message, brand: Brand): string | undefined {
  const text = message.role === "user" ? textOf(message).trim() : "";
  const own = text === EMPTY_REPLY || text.startsWith(followUpMark(brand));
  return text && !own ? text : undefined;
}

/** What a message answers: the assistant's words, or what it said through `finish`. */
export function answerOf(message: Message): string | undefined {
  const finished =
    message.role === "toolResult" && message.toolName === "finish" && !message.isError;
  const text = message.role === "assistant" || finished ? textOf(message).trim() : "";
  return text || undefined;
}
