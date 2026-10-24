/**
 * Saves conversations as Galaxy visualizations: one Visualization whose config is the whole session
 * document.
 *
 * Saving is deliberate, as it is for any other Galaxy visualization, so a revision marks a
 * save the user asked for rather than a conversation turn.
 */

import {
  isSessionDocument,
  segment,
  type Galaxy,
  type SessionDocument,
} from "@galaxyproject/orbit-browser";
import { NotYours, type Saves, type Store } from "./store";

export const PLUGIN_TYPE = "olit";

/** Galaxy requires at least three characters and shows this in the user's visualization list. */
export function title(document: SessionDocument): string {
  const given = (document.session.title || "").trim();
  return given.length >= 3 ? given : `Conversation (${document.session.id.slice(0, 8)})`;
}

export const visualizations: Store = {
  kind: "visualization",
  wording: {
    savedNote: "Saved. Open it from Galaxy's visualizations on any device.",
    label: "Save this conversation to Galaxy to reopen it on any device",
    keepHint: "Save it to Galaxy to keep it.",
    reopenHint: "To reopen a saved conversation, open it from Galaxy's visualizations.",
  },
  connect(galaxy: Galaxy): Saves {
    return {
      async load(id) {
        const [body, user] = await Promise.all([
          galaxy.get(`api/visualizations/${segment(id)}`),
          galaxy.get("api/users/current"),
        ]);
        // Galaxy also shows a visualization shared with the user or open to anyone with its link.
        const owner = body?.user_id;
        if (typeof owner !== "string" || !owner || owner !== user?.id) {
          throw new NotYours("it was not saved by the signed-in user");
        }
        const config = body?.latest_revision?.config;
        return isSessionDocument(config) ? { document: config } : null;
      },
      async save(document, id) {
        // Sharing stays off deliberately: a transcript carries far more than a chart
        // config does, so `importable`, `published` and `slug` are never set here.
        const payload = { title: title(document), config: document };
        let saved: string;
        if (id) {
          await galaxy.put(`api/visualizations/${segment(id)}`, payload);
          saved = id;
        } else {
          const created = await galaxy.post("api/visualizations", {
            ...payload,
            type: PLUGIN_TYPE,
          });
          saved = created.id;
        }
        return saved;
      },
    };
  },
};
