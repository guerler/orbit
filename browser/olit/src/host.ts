/** Messages between Olit and the Galaxy page that embeds it. */

/** A visualization's message to Galaxy, as every Galaxy visualization sends it. */
export type HostMessage = {
  visualization_saved: boolean;
  visualization_config?: Record<string, unknown>;
};

export interface Mounting {
  element: HTMLElement;
  signal: AbortSignal;
}

/** Posts to the page that embeds Olit, or to `target`: Galaxy also listens on the frame it mounted. */
export function tellHost(message: HostMessage, target: Window | HTMLElement = window.parent) {
  const data = { from: "galaxy-visualization", ...message };
  if (target instanceof HTMLElement) {
    target.dispatchEvent(new CustomEvent("galaxy-visualization", { detail: data }));
  } else {
    target?.postMessage(data, "*");
  }
}

/** A command from Galaxy AI. */
export type ChatCommand = { type: "open"; exchange_id: string } | { type: "ask"; question: string };

/** Returns the command a message carries, or null if it carries none. */
export function chatCommand(data: unknown): ChatCommand | null {
  const message = data as Record<string, unknown> | null;
  let command: ChatCommand | null = null;
  if (message?.from === "galaxy") {
    if (message.type === "open" && typeof message.exchange_id === "string" && message.exchange_id) {
      command = { type: "open", exchange_id: message.exchange_id };
    } else if (message.type === "ask" && typeof message.question === "string" && message.question) {
      command = { type: "ask", question: message.question };
    }
  }
  return command;
}

/**
 * Takes Galaxy AI's commands from the page that embeds Olit, at the origin of Galaxy's `root`. Galaxy
 * sends them after Olit's first message, so this listens before Olit sends one. Every engine names the
 * parent as the source of what the parent posts here.
 */
export function listenToGalaxy(root: string, onCommand: (command: ChatCommand) => void) {
  const origin = new URL(root, document.baseURI).origin;
  const parent = window.parent;
  window.addEventListener("message", (event) => {
    const command = chatCommand(event.data);
    if (command && parent !== window && event.source === parent && event.origin === origin) {
      onCommand(command);
    }
  });
}

export function listenToElement(
  { element, signal }: Mounting,
  onCommand: (command: ChatCommand) => void,
) {
  element.addEventListener(
    "galaxy",
    (event) => {
      const command = chatCommand((event as CustomEvent).detail);
      if (command) onCommand(command);
    },
    { signal },
  );
}
