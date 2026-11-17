/** Turning the conversation's entries and events into what the chat panel shows. */
import { contentText, type AssistantMessage, type Message } from "@earendil-works/pi-ai";
import type { EntryRecord } from "@earendil-works/pi-durable";

import { artifactsOf, type Artifact } from "../artifacts/kinds";

import { DEFAULT_BRAND, followUpMark, type Brand } from "../agent/brand";
import { EMPTY_REPLY } from "../agent/markers";
import type { ChatEvent } from "../agent/events";
import { usageTotals } from "../agent/saved";
import { StreamedReply } from "./streamed-reply";

export interface Chat {
  addUserMessage(text: string): void;
  addToolCard(id: string, name: string): void;
  updateToolCard(id: string, status: "running" | "done" | "error", result?: string): void;
  startAssistantMessage(): void;
  appendDelta(delta: string): void;
  finishAssistantMessage(): void;
  hideThinking(): void;
  showThinking(): void;
  clear(): void;
}

/** How the run that just ended went, for the one line that explains a quiet ending. */
export interface RunOutcome {
  spoke: boolean;
  done: boolean;
  aborted: boolean;
  /** The run spent its turns before it answered. */
  exhausted: boolean;
  error?: string;
}

export interface ViewHooks {
  info(text: string): void;
  /** Artifacts results carried: all of them on a snapshot, else what one result just made. */
  artifacts(artifacts: Artifact[], restored: boolean): void;
  /** A run ended, and how. */
  ended(outcome: RunOutcome): void;
  busy(running: boolean): void;
  usage(totals: { input: number; output: number; cost: number | null }): void;
  retry(errorMessage: string, at: number, attempt: number): void;
  retried(): void;
  /** Something failed outside any one run. */
  failed(message: string): void;
  /** The user wrote a message, which answers whatever plan draft was open. */
  wrote(): void;
}

/** Why pi-durable left a user's message unanswered, as the user should hear it. */
function unanswered(reason: string | undefined, detail: unknown): string {
  const why = typeof detail === "string" && detail ? `: ${detail}` : "";
  switch (reason) {
    case "model_error":
      return `The model request failed${why}`;
    case "no_model":
      return "No model is configured for this conversation, so nothing could answer.";
    case "faulted":
      return `Answering failed${why}`;
    default:
      return `This message was not answered (${reason ?? "unknown reason"}${why}).`;
  }
}

const textOf = (message: Message) =>
  message.role === "assistant"
    ? message.content
        .filter((c) => c.type === "text")
        .map((c) => (c as { text: string }).text)
        .join("")
    : contentText((message as { content: Parameters<typeof contentText>[0] }).content);

/** The chat as a conversation's events draw it. */
export class ChatView {
  private speaking = false;
  private reply = new StreamedReply();
  private cards = new Set<string>();
  private run: RunOutcome = { spoke: false, done: false, aborted: false, exhausted: false };
  private restoring = false;
  /** What the user has written in the conversation shown. */
  turns = 0;

  constructor(
    private readonly chat: Chat,
    private readonly hooks: ViewHooks,
    private readonly brand: Brand = DEFAULT_BRAND,
  ) {}

  /** How the latest run went. */
  get outcome(): RunOutcome {
    return this.run;
  }

  apply(events: readonly ChatEvent[]) {
    let ended = false;
    for (const event of events) {
      if (event.type === "snapshot") {
        this.chat.clear();
        this.speaking = false;
        this.cards.clear();
        this.turns = 0;
        this.restoring = true;
        for (const entry of event.entries) this.entry(entry);
        this.restoring = false;
        this.hooks.artifacts(artifactsOf(event.entries), true);
        this.stream(this.reply.start(event.generation?.message));
        this.hooks.busy(event.run !== undefined);
        this.hooks.usage(usageTotals(Object.values(event.usage.models ?? {})));
      } else if (event.type === "run_start") {
        this.run = { spoke: false, done: false, aborted: false, exhausted: false };
        this.hooks.busy(true);
        this.chat.showThinking();
      } else if (event.type === "run_end") {
        this.close();
        this.chat.hideThinking();
        this.hooks.busy(false);
        ended = true;
      } else if (event.type === "unanswered") {
        const { reason, detail } = event;
        if (reason === "aborted") this.run.aborted = true;
        else if (reason === "turn_limit") this.run.exhausted = true;
        // A model error already reached the chat as its own entry; anything else says it here.
        else this.run.error ??= unanswered(reason, detail);
      } else if (event.type === "task_failed") {
        this.hooks.failed(`The ${event.kind} task failed: ${event.message}`);
      } else if (event.type === "message_start" && event.message.role === "assistant") {
        this.stream(this.reply.start(event.message));
      } else if (event.type === "message_update") {
        this.stream(this.reply.update(event.changes));
      } else if (event.type === "message_end") {
        this.entry(event.entry);
      } else if (event.type === "tool_execution_start") {
        this.card(event.toolCallId, event.toolName);
      } else if (event.type === "auto_retry_start") {
        this.hooks.retry(event.errorMessage, event.at, event.attempt);
      } else if (event.type === "auto_retry_end") {
        this.hooks.retried();
      } else if (event.type === "compaction_end") {
        this.hooks.info("Summarized the earlier conversation to make room.");
      } else if (event.type === "usage_changed") {
        this.hooks.usage(usageTotals(Object.values(event.usage.models ?? {})));
      }
    }
    if (ended) this.hooks.ended(this.run);
  }

  private stream(delta: string) {
    if (!delta) return;
    this.chat.hideThinking();
    if (!this.speaking) {
      this.chat.startAssistantMessage();
      this.speaking = true;
    }
    this.chat.appendDelta(delta);
    this.run.spoke = true;
  }

  private close() {
    if (this.speaking) {
      this.chat.finishAssistantMessage();
      this.speaking = false;
    }
  }

  private card(id: string, name: string) {
    if (this.cards.has(id)) return;
    this.cards.add(id);
    this.close();
    this.chat.hideThinking();
    this.chat.addToolCard(id, name || "tool");
  }

  private say(text: string) {
    this.close();
    this.chat.startAssistantMessage();
    this.chat.appendDelta(text);
    this.chat.finishAssistantMessage();
    this.run.spoke = true;
  }

  private entry(entry: EntryRecord) {
    const message = entry.model?.[0];
    if (!message || entry.kind === "pi.system") return;
    if (entry.kind === "pi.compaction") {
      this.hooks.info("Summarized the earlier conversation to make room.");
    } else if (message.role === "user") {
      const text = textOf(message);
      if (text.startsWith(followUpMark(this.brand))) {
        this.hooks.info("Checking the Galaxy results that just landed.");
      } else if (text !== EMPTY_REPLY) {
        this.turns += 1;
        this.hooks.wrote();
        this.chat.addUserMessage(text);
      }
    } else if (message.role === "assistant") {
      const answer = message as AssistantMessage;
      const text = textOf(answer);
      // The answer as stored is what a reload shows; the streamed text ends the same way.
      const rest = this.reply.end(text);
      if (this.speaking) {
        this.stream(rest);
        this.close();
      } else if (text) this.say(text);
      if (answer.stopReason === "error") this.run.error = answer.errorMessage;
      if (answer.stopReason === "aborted") this.run.aborted = true;
      // A call's id is unique only within its response; some servers reuse ids across responses.
      this.cards.clear();
      for (const c of answer.content) {
        if (c.type === "toolCall") this.card(c.id, c.name);
      }
    } else if (message.role === "toolResult") {
      const text = textOf(message);
      // `finish` puts the model's closing words in a tool argument, not in content.
      if (message.toolName === "finish" && !message.isError && text) {
        this.run.done = true;
        this.say(text);
      } else {
        this.card(message.toolCallId, message.toolName);
        this.chat.updateToolCard(message.toolCallId, message.isError ? "error" : "done", text);
      }
      const made = artifactsOf([entry]);
      if (made.length && !this.restoring) this.hooks.artifacts(made, false);
    }
  }
}
