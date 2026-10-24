/** Runs Olit as a regular visualization, saved as a Galaxy visualization. */
import { mountOrbitBrowser } from "@galaxyproject/orbit-browser";
import { tellHost } from "../host";
import { shellOptions } from "../launch";
import { visualizations } from "../stores/visualizations";
import type { OlitMode } from "./mode";

export const visualizationMode: OlitMode = {
  async mount(container, incoming, mounting) {
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
