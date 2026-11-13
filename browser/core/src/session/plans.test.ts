import { describe, expect, it } from "vitest";

import { GALAXY_READY, GALAXY_UNAVAILABLE, GALAXY_UNREACHABLE, systemText } from "../agent/prompt";
import { answerPlan, galaxyCanRun, galaxyRefusalMessage } from "./plans";

describe("the approval gate and the prompt, on the same Galaxy state", () => {
  it.each([GALAXY_READY, GALAXY_UNREACHABLE] as const)(
    "refuses exactly when the prompt says nothing can run: %s",
    (status) => {
      const saysNothingCanRun = systemText({ galaxyStatus: status }).includes(GALAXY_UNAVAILABLE);
      expect(galaxyCanRun(status)).toBe(!saysNothingCanRun);
    },
  );

  it("does not block before the agent has reported", () => {
    expect(galaxyCanRun(undefined)).toBe(true);
    expect(galaxyCanRun(null)).toBe(true);
  });

  it("names the server when it refuses", () => {
    expect(galaxyRefusalMessage()).toMatch(/Galaxy did not answer/);
  });
});

describe("the answer to a plan draft", () => {
  it("approves with the request for the parameter table", () => {
    expect(answerPlan("approve", "1. Filter", GALAXY_READY)).toEqual({
      send: "I approve the plan above. Show the full parameter table for review before executing.",
    });
  });

  it("refuses an approval Galaxy cannot run, and sends nothing", () => {
    expect(answerPlan("approve", "1. Filter", GALAXY_UNREACHABLE)).toEqual({
      refused: galaxyRefusalMessage(),
    });
  });

  it("rejects without looking at Galaxy", () => {
    expect(answerPlan("reject", "1. Filter", GALAXY_UNREACHABLE)).toEqual({
      send: "Reject the plan above — let's rethink it.",
    });
  });

  it("hands an edit back as a draft fenced as a plan", () => {
    const answer = answerPlan("edit", "1. Filter\n2. Sort", GALAXY_READY);
    expect(answer).toEqual({
      draft:
        "Here is the plan with my edits — please revise your draft accordingly:\n\n```plan\n1. Filter\n2. Sort\n```",
    });
  });

  it("ignores an action it does not know", () => {
    expect(answerPlan("discard", "1. Filter", GALAXY_READY)).toBeUndefined();
  });
});
