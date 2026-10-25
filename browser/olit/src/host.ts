/** Messages between Olit and the Galaxy page that embeds it. */

/** A visualization's message to Galaxy, as every Galaxy visualization sends it. */
export type HostMessage = { visualization_saved: boolean };

export function tellHost(message: HostMessage) {
  window.parent?.postMessage({ from: "galaxy-visualization", ...message }, "*");
}

/** Marks the messages between Galaxy AI and the chat it hosts. */
export const CHAT_CHANNEL = "galaxy-ai";

/** A command from Galaxy AI. */
export type ChatCommand = { type: "open"; exchange_id: string } | { type: "ask"; question: string };

/** A report to Galaxy AI. */
export type ChatReport =
  { type: "active"; exchange_id: string | null } | { type: "unsaved"; value: boolean };

/** Returns the command a message carries, or null if it carries none. */
export function chatCommand(data: unknown): ChatCommand | null {
  const message = data as Record<string, unknown> | null;
  let command: ChatCommand | null = null;
  if (message?.channel === CHAT_CHANNEL) {
    if (message.type === "open" && typeof message.exchange_id === "string" && message.exchange_id) {
      command = { type: "open", exchange_id: message.exchange_id };
    } else if (message.type === "ask" && typeof message.question === "string" && message.question) {
      command = { type: "ask", question: message.question };
    }
  }
  return command;
}

/**
 * Connects to Galaxy AI on the page that embeds Olit, at the origin of Galaxy's `root`. Says
 * `ready` to that page and takes the port it answers with; commands and reports then go only over
 * that port. Reports made before then wait for it.
 */
export function connectChatHost(root: string, onCommand: (command: ChatCommand) => void) {
  const origin = new URL(root, document.baseURI).origin;
  const parent = window.parent;
  const framed = parent !== window;
  let port: MessagePort | undefined;
  const waiting: ChatReport[] = [];
  const send = (report: ChatReport) => port!.postMessage({ channel: CHAT_CHANNEL, ...report });
  window.addEventListener("message", (event) => {
    const message = event.data as Record<string, unknown> | null;
    const connect = message?.channel === CHAT_CHANNEL && message.type === "connect";
    if (framed && !port && connect && event.source === parent && event.origin === origin) {
      port = event.ports[0];
      if (port) {
        port.onmessage = (incoming) => {
          const command = chatCommand(incoming.data);
          if (command) onCommand(command);
        };
        waiting.splice(0).forEach(send);
      }
    }
  });
  if (framed) parent.postMessage({ channel: CHAT_CHANNEL, type: "ready" }, origin);
  return {
    report(report: ChatReport) {
      if (port) send(report);
      else waiting.push(report);
    },
  };
}
