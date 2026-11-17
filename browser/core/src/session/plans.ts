import { GALAXY_UNREACHABLE, type GalaxyStatus } from "../agent/prompt";

/** Whether a plan can start; unreported means the agent has not answered yet. */
export function galaxyCanRun(galaxy: GalaxyStatus | null | undefined): boolean {
  return galaxy !== GALAXY_UNREACHABLE;
}

export function galaxyRefusalMessage(): string {
  return (
    "Galaxy did not answer, so nothing in this plan can run. Check that the server is up and " +
    "reload the page — the plan is kept."
  );
}

export type PlanAction = "approve" | "reject" | "edit";

export type PlanAnswer = { send: string } | { draft: string } | { refused: string };

export function answerPlan(
  action: string,
  body: string,
  galaxy: GalaxyStatus | null | undefined,
): PlanAnswer | undefined {
  let answer: PlanAnswer | undefined;
  if (action === "approve") {
    // loom's init gate refuses /execute when Galaxy cannot run the plan.
    answer = galaxyCanRun(galaxy)
      ? {
          send: "I approve the plan above. Show the full parameter table for review before executing.",
        }
      : { refused: galaxyRefusalMessage() };
  } else if (action === "reject") {
    answer = { send: "Reject the plan above — let's rethink it." };
  } else if (action === "edit") {
    // Edit hands the draft back for the user to change; it does not submit.
    answer = {
      draft:
        "Here is the plan with my edits — please revise your draft accordingly:\n\n```plan\n" +
        body +
        "\n```",
    };
  }
  return answer;
}
