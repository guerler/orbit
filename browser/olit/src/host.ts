/** Messages Olit sends to the Galaxy page that embeds it. */
import { CHAT_VIEW } from "./incoming";

/** Config Galaxy uses to remount the chat; includes the chat id once saved. */
export interface ChatConfig {
  view: typeof CHAT_VIEW;
  exchange_id?: string;
}

export type HostMessage = { visualization_saved: boolean } | { visualization_config: ChatConfig };

export function tellHost(message: HostMessage) {
  window.parent?.postMessage({ from: "galaxy-visualization", ...message }, "*");
}
