/// <reference types="vitest/config" />
import { fileURLToPath } from "node:url";
import { orbitBrowserVite } from "@galaxyproject/orbit-browser/vite";
import { defineConfig } from "vite";

export default defineConfig(({ command }) => ({
  ...orbitBrowserVite({
    command,
    flavorRoot: fileURLToPath(new URL(".", import.meta.url)),
    // Visualization plugins the artifact pane mounts, from where Galaxy serves them.
    galaxyPaths: ["/static/plugins/visualizations"],
  }),
  test: {
    environment: "happy-dom",
    // Artifacts mount into an iframe's document, which happy-dom 21 no longer loads by default.
    environmentOptions: { happyDOM: { settings: { enableIframePageLoading: true } } },
    globals: true,
    include: ["src/**/*.test.{js,ts}"],
  },
}));
