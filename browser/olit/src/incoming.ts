/** Thin adapter for the Charts framework `data-incoming` contract. */

/** Default view: Olit runs as a regular visualization. */
export const VISUALIZATION_VIEW = "visualization";
/** View used when Galaxy mounts Olit as its AI chat. */
export const CHAT_VIEW = "chat";
export type View = typeof VISUALIZATION_VIEW | typeof CHAT_VIEW;

const VIEWS: readonly string[] = [VISUALIZATION_VIEW, CHAT_VIEW];

export interface OlitIncoming {
  root: string;
  /** How Galaxy mounted Olit. */
  view: View;
  /** Id of the saved visualization Galaxy opened, if any. */
  visualizationId?: string;
  datasetId?: string;
  /** Chat view: id of the saved chat to open. */
  exchangeId?: string;
  /** Chat view: question to ask in a new conversation. */
  question?: string;
  specs: Record<string, any>;
  settings: Record<string, any>;
}

/** Reads Galaxy's data-incoming config; takes `visualization_id` from the page query if missing. */
export function parseIncoming(container: HTMLElement, hostSearch = ""): OlitIncoming {
  let raw: any;
  try {
    raw = JSON.parse(container.dataset.incoming || "{}");
  } catch (e) {
    throw new Error(`data-incoming is not JSON: ${e}`);
  }
  const config = raw.visualization_config || {};
  const plugin = raw.visualization_plugin || {};
  return {
    root: raw.root || "/",
    view: VIEWS.includes(config.view) ? config.view : VISUALIZATION_VIEW,
    visualizationId:
      raw.visualization_id || new URLSearchParams(hostSearch).get("visualization_id") || undefined,
    datasetId: config.dataset_id,
    exchangeId: typeof config.exchange_id === "string" ? config.exchange_id : undefined,
    question: typeof config.question === "string" ? config.question : undefined,
    specs: plugin.specs || raw.specs || {},
    settings: config.settings || {},
  };
}

/** Returns the parent page's query string, or an empty string if it cannot be read. */
export function hostSearch(): string {
  try {
    return window.parent === window ? "" : window.parent.location.search;
  } catch {
    return "";
  }
}
