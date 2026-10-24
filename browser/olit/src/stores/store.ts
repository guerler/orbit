/** Where Olit saves conversations in Galaxy: visualizations or chats, depending on the mode. */
import type { Galaxy, SessionDocument, SessionStore } from "@galaxyproject/orbit-browser";

/** Thrown when a saved session belongs to another user. */
export class NotYours extends Error {}

/** A loaded saved conversation. */
export interface Opened {
  document: SessionDocument;
  /** Set for a chat saved without a session: it continues in the current history and saves as new. */
  held?: { note: string };
}

/** Loads and saves conversations for the signed-in user. */
export interface Saves {
  /**
   * Returns the conversation saved at `id`, or null if Olit cannot open it. Throws `NotYours` for
   * another user's save.
   */
  load(id: string): Promise<Opened | null>;
  /** Creates a save, or replaces the one at `id`, and returns its id. */
  save(document: SessionDocument, id?: string): Promise<string>;
}

export interface Store {
  /** Store name; this browser keys its saves by it. */
  kind: string;
  /** Text the page shows about saving. */
  wording: Pick<SessionStore, "savedNote" | "label" | "keepHint" | "reopenHint">;
  connect(galaxy: Galaxy): Saves;
}
