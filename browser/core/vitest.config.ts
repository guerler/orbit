/// <reference types="vitest/config" />
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { configDefaults } from "vitest/config";

import { orbitBrowserVite } from "./vite";

export default defineConfig({
  ...orbitBrowserVite({
    command: "serve",
    flavorRoot: fileURLToPath(new URL(".", import.meta.url)),
  }),
  test: {
    globals: true,
    // The agent runs in Node as well as in the browser, so its tests run without a DOM; the
    // worker hosting it in the browser, and the page, keep one.
    projects: [
      {
        extends: true,
        test: {
          name: "agent",
          environment: "node",
          include: ["src/agent/**/*.test.{js,ts}"],
          exclude: [...configDefaults.exclude, "src/agent/worker*.test.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "page",
          environment: "happy-dom",
          include: ["src/**/*.test.{js,ts}"],
          exclude: [...configDefaults.exclude, "src/agent/**/!(worker*).test.{js,ts}"],
        },
      },
    ],
  },
});
