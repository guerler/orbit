/** Runs Olit as Galaxy AI's chat, saved to Galaxy's chats. Galaxy mounts it once and sends it commands. */
import { mountOrbitBrowser, type OrbitBrowserHandle } from "@galaxyproject/orbit-browser";
import { type ChatCommand, listenToElement, listenToGalaxy, tellHost } from "../host";
import { type LaunchRequest, shellOptions } from "../launch";
import { chats } from "../stores/chats";
import type { OlitMode } from "./mode";

export const chatMode: OlitMode = {
  async mount(container, incoming, mounting) {
    let shown: OrbitBrowserHandle | undefined;
    /** Commands run one at a time, in the order Galaxy sent them. */
    let work: Promise<unknown> = Promise.resolve();
    const take = (command: ChatCommand) => {
      work = work.then(() => run(command)).catch(failed);
    };
    if (mounting) {
      listenToElement(mounting, take);
    } else {
      listenToGalaxy(incoming.root, take);
    }

    /** What Galaxy was last told: the chat shown, once known, and whether it has unsaved changes. */
    let active: string | null | undefined;
    let unsaved: boolean | undefined;
    function tell() {
      const config = active === undefined ? {} : { visualization_config: { exchange_id: active } };
      tellHost({ visualization_saved: !unsaved, ...config }, mounting?.element ?? window);
    }
    function reportUnsaved(value: boolean) {
      if (value !== unsaved) {
        unsaved = value;
        tell();
      }
    }
    function reportActive(id: string | null) {
      if (id !== active) {
        active = id;
        tell();
      }
    }

    /** Shows `request` in a new shell, in place of the one shown. */
    async function show(request: LaunchRequest) {
      shown?.dispose();
      shown = undefined;
      // A newly opened conversation has no unsaved changes.
      reportUnsaved(false);
      shown = await mountOrbitBrowser(container, {
        ...shellOptions(incoming, chats, request, {
          savedState: (saved) => reportUnsaved(!saved),
          active: reportActive,
        }),
        signal: mounting?.signal,
      });
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
