import { createGalaxyContext, type GalaxyContext } from "@galaxyproject/galaxy-ops/browser";

import type { ArtifactKind } from "../artifacts/kinds";
import { DEFAULT_BRAND, noteTag, type Brand } from "./brand";
import { resolveArtifacts } from "./artifacts";
import { enaTools } from "./ena";
import { galaxyFetch, type GalaxyOptions } from "./galaxy";
import { annotating, galaxyTools, OPS_POLICY } from "./galaxy-tools";
import { gtnTools } from "./gtn";
import { notebookTools } from "./notebook";
import { opsTools, type Annotate } from "./ops";
import { processTools } from "./processes";
import { pythonTool } from "./python";
import { flavoredSkills, skillsTool } from "./skills";
import { fail, type Context, type AgentTool } from "./tool";

/**
 * What a flavor adds to the agent: the browser agent's seam until it runs on Orbit's extensions,
 * where each field has a counterpart.
 */
export interface AgentFlavor {
  /** Who the agent is and what it keeps things under; DEFAULT_BRAND when the flavor names none. */
  brand?: Brand;
  /** Placed right after Galaxy's tools: {{artifact}} placement, counted in misrouted()'s own set. */
  tools?: () => AgentTool[];
  /** Raw files keyed "./skills/<repo>/<path>", merged over the packaged corpus. */
  skills?: Record<string, string>;
  /** Galaxy-op result notes, tried after IWC's and before invocation-outcome and fetch-failure. */
  annotators?: Annotate[];
  /** System prompt sections, right after the identity line or after the skills router text. */
  promptSections?: (input: { model?: string; provider?: string; datasetId?: string }) => {
    afterIdentity?: string[];
    /** Bullets for the Galaxy terminology list, for terms only this flavor's tools act on. */
    terminology?: string[];
    afterRouter?: string[];
  };
  /** Registered in whichever realm the runtime runs in. */
  artifactKinds?: readonly ArtifactKind<any>[];
}

/** A tool whose string arguments may carry `{{artifact}}` tokens, resolved before it runs. */
function placingArtifacts(tool: AgentTool): AgentTool {
  return {
    ...tool,
    run: async (args: Record<string, unknown>, ctx: Context) => {
      const known = [...ctx.artifacts.prior, ...ctx.artifacts.produced];
      const placed: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(args)) {
        const { text, refusal } = resolveArtifacts(value, known);
        if (refusal) {
          return fail(`Refused: ${refusal}`);
        }
        placed[key] = text;
      }
      return tool.run(placed, ctx);
    },
  };
}

/** Every tool the agent can offer, before a session filters them by capability. */
export function agentTools(skills = flavoredSkills(), flavor: AgentFlavor = {}): AgentTool[] {
  const brand = flavor.brand ?? DEFAULT_BRAND;
  const python = pythonTool();
  const flavored = flavor.tools?.() ?? [];
  const rest = [
    ...notebookTools(),
    ...gtnTools(),
    ...enaTools(),
    skillsTool(skills),
    ...processTools(),
  ];
  const own = new Set([python, ...flavored, ...rest].map((t) => t.name));
  const tag = noteTag(brand);
  const galaxy = [
    ...opsTools(annotating(flavor.annotators, tag), OPS_POLICY),
    ...galaxyTools(tag),
  ].map((t) => misrouted(t, own));
  return [python, ...[...galaxy, ...flavored].map(placingArtifacts), ...rest];
}

/**
 * A Galaxy tool asked about one of the agent's own tools: Galaxy answers "not found", or nothing at
 * all, so say where the tool lives instead. A tool_id asks for it directly; a query hunts the
 * catalog for it.
 */
function misrouted(tool: AgentTool, own: Set<string>): AgentTool {
  return {
    ...tool,
    run: async (args: Record<string, unknown>, ctx: Context) => {
      const wanted = [args.tool_id, args.query].find(
        (v): v is string => typeof v === "string" && own.has(v.trim()),
      );
      if (wanted && wanted === args.tool_id) {
        return fail(`'${wanted}' is a built-in tool, not a Galaxy tool. Call ${wanted} directly.`);
      }
      if (wanted) {
        return fail(
          `'${wanted}' is a built-in tool rather than a Galaxy tool, so the tool catalog does not ` +
            "hold it. It is already in your tool list if you need it.",
        );
      }
      return tool.run(args, ctx);
    },
  };
}

/** galaxy-ops over the same transport as the agent's own Galaxy client. */
export function galaxyOps(options: GalaxyOptions): GalaxyContext {
  return createGalaxyContext({
    baseUrl: options.root,
    apiKey: options.key ?? "",
    fetchImpl: galaxyFetch(options),
  });
}
