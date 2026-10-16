import type { Context as Chord } from "@earendil-works/chord/context";
import type { Op } from "@earendil-works/chord/delta";
import type { AssistantMessage, Message, Usage } from "@earendil-works/pi-ai";
import type {
  AgentState,
  Conversation,
  ConversationView,
  Cursor,
  EntryId,
  EntryRecord,
  Harness,
  InboxState,
  LiveState,
  RunFailureReason,
  SubmissionId,
  UsageState,
} from "@earendil-works/pi-durable";

type Block = AssistantMessage["content"][number];

export type MessageChange =
  | { type: "text_start" | "thinking_start" | "toolcall_start"; contentIndex: number; block: Block }
  | { type: "text_delta" | "thinking_delta"; contentIndex: number; delta: string }
  | {
      type: "toolcall_delta";
      contentIndex: number;
      path: readonly (string | number)[];
      delta: string;
    }
  | { type: "block"; contentIndex: number; block: Block }
  | { type: "message"; message: AssistantMessage };

export type ChatEvent =
  | {
      type: "snapshot";
      entries: readonly EntryRecord[];
      run?: { inputs: readonly SubmissionId[] };
      generation?: LiveState["generation"];
      inbox: number;
      agent: Partial<AgentState>;
      usage: Partial<UsageState>;
    }
  | { type: "run_start"; inputs: readonly SubmissionId[] }
  | { type: "run_end"; inputs: readonly SubmissionId[] }
  | {
      type: "unanswered";
      inputs: readonly SubmissionId[];
      reason: RunFailureReason;
      detail?: string;
    }
  | { type: "message_start"; message: Message }
  | { type: "message_update"; usage?: Usage; changes: readonly MessageChange[] }
  | { type: "message_end"; entry: EntryRecord }
  | { type: "entry_appended"; entry: EntryRecord }
  | { type: "tool_execution_start"; toolCallId: string; toolName: string }
  | { type: "auto_retry_start"; attempt: number; at: number; errorMessage: string }
  | { type: "auto_retry_end"; attempt: number }
  | { type: "compaction_end"; error?: string }
  | { type: "inbox_update"; items: number }
  | { type: "agent_changed"; agent: Partial<AgentState> }
  | { type: "usage_changed"; usage: Partial<UsageState> }
  | { type: "task_failed"; kind: string; message: string };

export interface ChatStream {
  snapshot: Extract<ChatEvent, { type: "snapshot" }>;
  start(listener: (events: readonly ChatEvent[]) => Promise<void>): void;
  stop(): void;
}

function parts(view: ConversationView) {
  return {
    live: (view.docs["pi.live"] ?? {}) as LiveState,
    inbox: view.docs["pi.inbox"] as InboxState | undefined,
    agent: view.docs["pi.agent"] as Partial<AgentState> | undefined,
    usage: view.docs["pi.usage"] as Partial<UsageState> | undefined,
  };
}

async function history(
  conversation: Pick<Conversation, "entries">,
  maxEntryId: EntryId,
  ctx: Chord,
) {
  const found: EntryRecord[] = [];
  let cursor: Cursor | undefined;
  do {
    const page = await conversation.entries({ maxEntryId }, 500, cursor, ctx);
    found.push(...page.items);
    cursor = page.next;
  } while (cursor !== undefined);
  return found.sort((a, b) => a.id - b.id);
}

export async function watchChat(
  harness: Pick<Harness, "observeConversation">,
  conversation: Pick<Conversation, "id" | "entries">,
  ctx: Chord,
): Promise<ChatStream> {
  let before: ConversationView | undefined;
  let seen = new Set<EntryId>();
  const pending: ChatEvent[][] = [];
  let listener: ((events: readonly ChatEvent[]) => Promise<void>) | undefined;
  let draining = false;

  const drain = async () => {
    if (draining || !listener) return;
    draining = true;
    try {
      while (pending.length && listener) {
        try {
          await listener(pending.shift()!);
        } catch (error) {
          console.warn("conversation events:", error);
        }
      }
    } finally {
      draining = false;
    }
  };

  const observation = await harness.observeConversation(
    conversation.id,
    {
      advance: (call) => {
        if (call.kind !== "value" || before === undefined) return;
        const events = translate(before, call.value, call.ops, seen);
        before = call.value;
        if (events.length) {
          pending.push(events);
          void drain();
        }
      },
      end: () => {
        listener = undefined;
      },
    },
    ctx,
  );
  before = observation.value;
  seen = new Set(before.entries.map((e) => e.id));
  const { live, inbox, agent, usage } = parts(before);
  const newest = before.entries.at(-1)?.id;
  const snapshot: ChatStream["snapshot"] = {
    type: "snapshot",
    entries: newest === undefined ? [] : await history(conversation, newest, ctx),
    ...(live.run ? { run: { inputs: live.run.inputs } } : {}),
    ...(live.generation ? { generation: live.generation } : {}),
    inbox: inbox?.items.length ?? 0,
    agent: agent ?? {},
    usage: usage ?? {},
  };
  return {
    snapshot,
    start: (next) => {
      listener = next;
      void drain();
    },
    stop: () => {
      listener = undefined;
      pending.length = 0;
      observation.detach();
    },
  };
}

export function translate(
  was: ConversationView,
  now: ConversationView,
  ops: readonly Op[],
  seen: Set<EntryId>,
): ChatEvent[] {
  const a = parts(was);
  const b = parts(now);
  const events: ChatEvent[] = [];
  const entries = now.entries.filter((entry) => !seen.has(entry.id));
  for (const entry of entries) seen.add(entry.id);

  const slotsBefore = new Map((a.live.tools ?? []).map((slot) => [slot.callId, slot]));
  for (const slot of b.live.tools ?? []) {
    if (slot.status === "running" && slotsBefore.get(slot.callId)?.status !== "running") {
      events.push({ type: "tool_execution_start", toolCallId: slot.callId, toolName: slot.name });
    }
  }

  const partialBefore = a.live.generation?.message;
  const partial = b.live.generation?.message as AssistantMessage | undefined;
  if (partial !== undefined && partialBefore === undefined) {
    events.push({ type: "message_start", message: partial });
  } else if (partial !== undefined && partial !== partialBefore) {
    events.push({
      type: "message_update",
      usage: partial.usage,
      changes: messageChanges(ops, partial),
    });
  }

  const generation = b.live.generation;
  const generationBefore = a.live.generation;
  if (generation?.retry !== undefined && generationBefore?.retry === undefined) {
    const { at, error } = generation.retry;
    events.push({ type: "auto_retry_start", attempt: generation.attempt, at, errorMessage: error });
  }
  if (generationBefore?.retry !== undefined && generation?.retry === undefined) {
    events.push({ type: "auto_retry_end", attempt: generationBefore.attempt });
  }

  let assistantAppended = false;
  for (const entry of entries) {
    const message = entry.model?.[0];
    if (message === undefined) {
      events.push({ type: "entry_appended", entry });
      continue;
    }
    const streamed =
      message.role === "assistant" && partialBefore !== undefined && !assistantAppended;
    if (message.role === "assistant") assistantAppended = true;
    if (!streamed) events.push({ type: "message_start", message });
    events.push({ type: "message_end", entry });
  }

  const compactions = b.live.compactions ?? [];
  for (const { taskId } of a.live.compactions ?? []) {
    if (!compactions.some((status) => status.taskId === taskId)) {
      const failure = b.live.compactionFailure;
      events.push({
        type: "compaction_end",
        ...(failure?.taskId === taskId ? { error: failure.error } : {}),
      });
    }
  }

  const run = b.live.run;
  const runBefore = a.live.run;
  const runChanged = run?.inputs[0] !== runBefore?.inputs[0];
  if (runBefore !== undefined && runChanged)
    events.push({ type: "run_end", inputs: runBefore.inputs });
  const failure = b.live.runFailure;
  if (failure !== undefined && failure !== a.live.runFailure) {
    events.push({
      type: "unanswered",
      inputs: failure.inputs,
      reason: failure.reason,
      ...(failure.detail === undefined ? {} : { detail: failure.detail }),
    });
  }
  if (b.inbox !== a.inbox) events.push({ type: "inbox_update", items: b.inbox?.items.length ?? 0 });
  if (b.agent !== a.agent) events.push({ type: "agent_changed", agent: b.agent ?? {} });
  if (b.usage !== a.usage) events.push({ type: "usage_changed", usage: b.usage ?? {} });
  if (run !== undefined && runChanged) events.push({ type: "run_start", inputs: run.inputs });
  return events;
}

const PARTIAL_PATH = ["docs", "pi.live", "generation", "message"];

function messageChanges(ops: readonly Op[], message: AssistantMessage): MessageChange[] {
  const changes: MessageChange[] = [];
  const whole = new Set<number>();
  for (const op of ops) {
    if (op[0] === "r") return [{ type: "message", message }];
    const path = op[1] as readonly (string | number)[];
    if (!startsWith(path, PARTIAL_PATH)) {
      if (startsWith(PARTIAL_PATH, path)) return [{ type: "message", message }];
      continue;
    }
    const rest = path.slice(PARTIAL_PATH.length);
    if (rest[0] === "usage") continue;
    if (rest[0] !== "content") return [{ type: "message", message }];
    if (rest.length === 1) {
      if (op[0] !== "p" || op[3] !== 0) return [{ type: "message", message }];
      for (const [offset, block] of (op[4] as unknown as Block[]).entries()) {
        const type =
          block.type === "text"
            ? "text_start"
            : block.type === "thinking"
              ? "thinking_start"
              : "toolcall_start";
        changes.push({ type, contentIndex: op[2] + offset, block });
      }
      continue;
    }
    const contentIndex = rest[1] as number;
    const field = rest[2];
    if (whole.has(contentIndex)) continue;
    if (op[0] === "a" && rest.length === 3 && (field === "text" || field === "thinking")) {
      changes.push({
        type: field === "text" ? "text_delta" : "thinking_delta",
        contentIndex,
        delta: op[2],
      });
    } else if (op[0] === "a" && field === "arguments") {
      changes.push({ type: "toolcall_delta", contentIndex, path: rest.slice(3), delta: op[2] });
    } else {
      whole.add(contentIndex);
      changes.push({ type: "block", contentIndex, block: message.content[contentIndex] });
    }
  }
  return changes;
}

function startsWith(path: readonly unknown[], prefix: readonly unknown[]) {
  return prefix.length <= path.length && prefix.every((segment, index) => path[index] === segment);
}
