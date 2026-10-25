/** Runs Olit as Galaxy AI's chat, saved to Galaxy's chats. Galaxy mounts it once and sends it commands. */
import { mountOrbitBrowser, type OrbitBrowserHandle } from "@galaxyproject/orbit-browser";
import { type ChatCommand, connectChatHost } from "../host";
import { type LaunchRequest, shellOptions } from "../launch";
import { chats } from "../stores/chats";
import type { OlitMode } from "./mode";

export const chatMode: OlitMode = {
  async mount(container, incoming) {
    let shown: OrbitBrowserHandle | undefined;
    /** Commands run one at a time, in the order Galaxy sent them. */
    let work: Promise<unknown> = Promise.resolve();
    const host = connectChatHost(incoming.root, (command) => {
      work = work.then(() => run(command)).catch(failed);
    });

    /** Last unsaved state sent to Galaxy; only changes are sent. */
    let unsaved: boolean | undefined;
    function reportUnsaved(value: boolean) {
      if (value !== unsaved) {
        unsaved = value;
        host.report({ type: "unsaved", value });
      }
    }

    /** Shows `request` in a new shell, in place of the one shown. */
    async function show(request: LaunchRequest) {
      shown?.dispose();
      shown = undefined;
      // A newly opened conversation has no unsaved changes.
      reportUnsaved(false);
      shown = await mountOrbitBrowser(
        container,
        shellOptions(incoming, chats, request, {
          savedState: (saved) => reportUnsaved(!saved),
          active: (id) => host.report({ type: "active", exchange_id: id }),
        }),
      );
    }

    async function run(command: ChatCommand) {
      if (command.type === "open") {
        await show({ savedId: command.exchange_id });
      } else if (shown) {
        shown.ask(command.question);
      } else {
        throw new Error(`the chat did not start, so it cannot ask "${command.question}"`);
      }
    }

    work = show({
      savedId: incoming.exchangeId,
      question: incoming.question,
      datasetId: incoming.datasetId,
    }).catch(failed);
    await work;
  },
};

function failed(e: unknown) {
  console.error("[olit] the chat could not run a command from Galaxy", e);
}
