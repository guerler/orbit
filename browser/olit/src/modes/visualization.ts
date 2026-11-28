/** Runs Olit as a regular visualization, saved as a Galaxy visualization. */
import { mountOrbitBrowser } from "@galaxyproject/orbit-browser";
import { tellHost } from "../host";
import { shellOptions } from "../launch";
import { visualizations } from "../stores/visualizations";
import type { OlitMode } from "./mode";

export const visualizationMode: OlitMode = {
  async mount(container, incoming, mounting) {
    // Galaxy listens on this window for Olit's reports; a visualization shown inside Olit posts
    // its own reports here too, and they must not reach Galaxy as Olit's.
    window.addEventListener(
      "message",
      (event) => {
        const frames = Array.from(document.querySelectorAll("iframe"));
        if (frames.some((frame) => frame.contentWindow === event.source)) {
          event.stopImmediatePropagation();
        }
      },
      { capture: true, signal: mounting?.signal },
    );
    await mountOrbitBrowser(container, {
      ...shellOptions(
        incoming,
        visualizations,
        { savedId: incoming.visualizationId, datasetId: incoming.datasetId },
        {
          savedState: (saved) =>
            tellHost({ visualization_saved: saved }, mounting?.element ?? window.parent),
        },
      ),
      signal: mounting?.signal,
    });
  },
};
