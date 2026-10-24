/** Test helper: an in-memory version of Galaxy's chat API. */
import { json } from "@galaxyproject/orbit-browser/testing";

/** A stored chat: its turns, and its session document or null. */
export interface ChatRow {
  agent_type: string;
  messages: Array<{ query: string; response: string }>;
  document: unknown;
}

/**
 * In-memory chats. `answer` handles `api/chat/` requests and returns undefined for anything else.
 * Like Galaxy, it refuses to replace a chat that has no document.
 */
export function chatStore() {
  const rows = new Map<string, ChatRow>();
  let next = 1;
  async function answer(request: Request): Promise<Response | undefined> {
    const path = new URL(request.url).pathname;
    let response: Response | undefined;
    if (path.endsWith("/api/chat/exchanges") && request.method === "POST") {
      const created = `c${next++}`;
      rows.set(created, JSON.parse(await request.text()));
      response = json({ id: created });
    } else if (path.includes("/api/chat/exchange/")) {
      const [id, part] = path.split("/api/chat/exchange/")[1]!.split("/");
      const row = rows.get(id!);
      if (!row || (request.method === "PUT" && row.document === null)) {
        response = json({ err_msg: "No accessible chat exchange found" }, 404);
      } else if (request.method === "PUT") {
        rows.set(id!, JSON.parse(await request.text()));
        response = json({ id });
      } else if (part === "document") {
        response = json({ id, agent_type: row.agent_type, document: row.document });
      } else if (part === "messages") {
        response = json(
          row.messages.flatMap((turn) => [
            { role: "user", content: turn.query, timestamp: "2026-10-01T10:00:00" },
            {
              role: "assistant",
              content: turn.response,
              agent_type: row.agent_type,
              timestamp: "2026-10-01T10:00:00",
            },
          ]),
        );
      }
    }
    return response;
  }
  return { rows, answer };
}
