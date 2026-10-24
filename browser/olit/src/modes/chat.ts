/** Runs Olit as Galaxy's AI chat, saved to Galaxy's chats. Galaxy remounts it for each command. */
import { mountOrbitBrowser } from "@galaxyproject/orbit-browser";
import { CHAT_VIEW } from "../incoming";
import { tellHost } from "../host";
import { shellOptions } from "../launch";
import { chats } from "../stores/chats";
import type { OlitMode } from "./mode";

export const chatMode: OlitMode = {
  async mount(container, incoming) {
    /** Last unsaved state sent to Galaxy; only changes are sent. */
    let unsaved: boolean | undefined;
    function reportUnsaved(value: boolean) {
      if (value !== unsaved) {
        unsaved = value;
        tellHost({ visualization_saved: !value });
      }
    }
    // A newly opened conversation has no unsaved changes.
    reportUnsaved(false);
    await mountOrbitBrowser(
      container,
      shellOptions(
        incoming,
        chats,
        {
          savedId: incoming.exchangeId,
          question: incoming.question,
          datasetId: incoming.datasetId,
        },
        {
          savedState: (saved) => reportUnsaved(!saved),
          active: (id) =>
            tellHost({
              visualization_config: id ? { view: CHAT_VIEW, exchange_id: id } : { view: CHAT_VIEW },
            }),
        },
      ),
    );
  },
};
