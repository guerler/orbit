import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { specifiers } from "../flavor-boundary";

const SESSION = __dirname;
const SRC = resolve(SESSION, "..");
const DOM =
  /\b(?:document|window|HTMLElement|Element|Node|customElements|localStorage|sessionStorage|navigator)\b\s*[.(]/;

const sources = readdirSync(SESSION)
  .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
  .map((name) => join(SESSION, name));

function outside(file: string, spec: string): string | undefined {
  let problem: string | undefined;
  if (spec.startsWith(".")) {
    const target = relative(SRC, resolve(SESSION, spec));
    const allowed =
      target.startsWith("session/") || target.startsWith("agent/") || target === "artifacts/kinds";
    if (!allowed) problem = `${relative(SRC, file)} imports ${spec}`;
  } else if (!spec.startsWith("@earendil-works/")) {
    problem = `${relative(SRC, file)} imports ${spec}`;
  }
  return problem;
}

describe("the session", () => {
  it("has modules to check", () => {
    expect(sources.length).toBeGreaterThan(0);
  });

  it("touches no DOM", () => {
    const touching = sources.filter((file) => DOM.test(readFileSync(file, "utf8")));
    expect(touching.map((file) => relative(SRC, file))).toEqual([]);
  });

  it("imports only itself, the agent, artifact kinds and pi", () => {
    const problems = sources.flatMap((file) =>
      specifiers(readFileSync(file, "utf8"))
        .map((spec) => outside(file, spec))
        .filter((problem): problem is string => problem !== undefined),
    );
    expect(problems).toEqual([]);
  });

  it("catches a page module and a DOM call", () => {
    expect(outside(join(SESSION, "x.ts"), "../shell")).toBeDefined();
    expect(
      outside(join(SESSION, "x.ts"), "../../../app/src/renderer/chat/chat-panel"),
    ).toBeDefined();
    expect(outside(join(SESSION, "x.ts"), "../agent/galaxy")).toBeUndefined();
    expect(DOM.test('document.createElement("div")')).toBe(true);
    expect(DOM.test("const documented = 1;")).toBe(false);
  });
});
