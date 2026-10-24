/** Checks that mode-specific code stays in modes/ and stores/. */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { specifiers } from "@galaxyproject/orbit-browser/testing";

const SRC = join(__dirname, "..");

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    let found: string[] = [];
    if (statSync(path).isDirectory()) found = sources(path);
    else if (/\.ts$/.test(name) && !/\.test\.ts$/.test(name)) found = [path];
    return found;
  });
}

/** Maps each source under src/ to the src/ modules it imports. */
const graph = new Map(
  sources(SRC).map((file) => [
    relative(SRC, file),
    specifiers(readFileSync(file, "utf8"))
      .filter((spec) => spec.startsWith("."))
      .map((spec) => relative(SRC, resolve(dirname(file), spec)).replace(/\.ts$/, "")),
  ]),
);

/** Returns the src/ modules under `prefix` that import a module matching `target`. */
function importing(prefix: string, target: RegExp): string[] {
  return [...graph]
    .filter(([file, imports]) => file.startsWith(prefix) && imports.some((i) => target.test(i)))
    .map(([file]) => file);
}

const MODE_SPECIFIC = /^(modes\/|stores\/|launch$|incoming$|main$|host$)/;

describe("olit's two modes", () => {
  it("are found by the checks below", () => {
    expect([...graph.keys()]).toEqual(
      expect.arrayContaining(["main.ts", "launch.ts", "modes/chat.ts", "stores/chats.ts"]),
    );
  });

  it("stay out of the agent, tools and artifacts", () => {
    expect(importing("agent/", MODE_SPECIFIC)).toEqual([]);
    expect(importing("artifacts/", MODE_SPECIFIC)).toEqual([]);
    expect(importing("worker", MODE_SPECIFIC)).toEqual([]);
  });

  it("are imported only by main.ts", () => {
    expect(
      [...graph]
        .filter(
          ([file, imports]) =>
            !file.startsWith("modes/") && imports.some((i) => i.startsWith("modes/")),
        )
        .map(([file]) => file),
    ).toEqual(["main.ts"]);
  });

  it("each import only their own store", () => {
    expect(importing("modes/visualization", /^stores\/(?!visualizations$|store$)/)).toEqual([]);
    expect(importing("modes/chat", /^stores\/(?!chats$|store$)/)).toEqual([]);
  });

  it("share a launch that uses only the store interface", () => {
    expect(importing("launch", /^(stores\/(?!store$)|modes\/|host$)/)).toEqual([]);
  });

  it("have independent stores", () => {
    expect(importing("stores/", /^(modes\/|launch$|host$|stores\/(?!store$))/)).toEqual([]);
  });

  it("are the only modules that message Galaxy", () => {
    expect(importing("", /^host$/).filter((file) => !file.startsWith("modes/"))).toEqual([]);
  });

  it("keep chat code out of the visualization mode", () => {
    expect(importing("modes/visualization", /^modes\/(?!mode$)/)).toEqual([]);
  });
});
