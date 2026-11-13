import { describe, expect, it } from "vitest";

import type { Settled } from "../agent/watch";
import { heldNotice, outcomeNotice, readyNotices, retryLine, settledNotices } from "./notices";

const run = { spoke: true, done: false, aborted: false, exhausted: false };

describe("how a run ended", () => {
  it("names an error before anything else", () => {
    expect(outcomeNotice({ ...run, aborted: true, error: "boom" })).toEqual({
      level: "error",
      text: "boom",
    });
  });

  it("says Stopped for an aborted run", () => {
    expect(outcomeNotice({ ...run, aborted: true })).toEqual({ level: "info", text: "Stopped." });
  });

  it("says a run that spent its steps is not finished", () => {
    expect(outcomeNotice({ ...run, exhausted: true })?.text).toMatch(/ran out of steps/);
  });

  it("explains a turn that ended without a reply", () => {
    expect(outcomeNotice({ ...run, spoke: false })?.text).toMatch(/without a reply/);
  });

  it("says nothing about a run that answered", () => {
    expect(outcomeNotice(run)).toBeUndefined();
  });
});

const settled = (outcome: string, record?: string) =>
  ({
    watched: { kind: "job", id: "j1" },
    state: outcome === "ok" ? "ok" : "error",
    outcome,
    ...(record ? { record } : {}),
  }) as unknown as Settled;

describe("Galaxy work that settled", () => {
  it("raises a failure as an error", () => {
    const [notice] = settledNotices(settled("failed"));
    expect(notice.level).toBe("error");
    expect(notice.text).toMatch(/j1 finished as error\./);
  });

  it("reports a cancellation quietly", () => {
    expect(settledNotices(settled("cancelled"))[0]).toMatchObject({ level: "info" });
  });

  it("reports a finished job as information", () => {
    expect(settledNotices(settled("ok"))).toEqual([
      { level: "info", text: expect.stringMatching(/j1 finished \(ok\)\./) },
    ]);
  });

  it("says first when the record was not updated", () => {
    const notices = settledNotices(settled("ok", "the page is gone"));
    expect(notices).toHaveLength(2);
    expect(notices[0]).toEqual({
      level: "error",
      text: expect.stringMatching(/record was not updated .* j1: the page is gone\./),
    });
  });
});

describe("held follow-ups", () => {
  it("says why follow-ups wait", () => {
    expect(heldNotice("paused")?.text).toMatch(/paused\. Say continue/);
    expect(heldNotice("capped")?.text).toMatch(/several automatic turns/);
  });

  it("says nothing once they no longer wait", () => {
    expect(heldNotice(undefined)).toBeUndefined();
  });
});

describe("the session being ready", () => {
  it("welcomes a new conversation", () => {
    expect(readyNotices({})).toEqual([{ level: "info", text: "Ready. Ask me to run something." }]);
  });

  it("says a restored conversation was restored", () => {
    expect(readyNotices({ restored: true }).at(-1)?.text).toMatch(/^Restored this history's/);
  });

  it("puts problems first, then the saved session, the record, Ready and the greeting", () => {
    const texts = readyNotices({
      unkept: "no storage",
      keepHint: "Save it.",
      galaxyProblem: "timeout",
      recordsProblem: "403",
      savedProblem: "The saved one is gone.",
      saved: true,
      continuing: "Notes go to the notebook N.",
      greeting: "Hello.",
    }).map((n) => n.text);
    expect(texts).toEqual([
      "This browser can't keep conversations (no storage), so this one ends when the page closes. Save it.",
      expect.stringMatching(/^Galaxy did not answer when this session opened \(timeout\)/),
      expect.stringMatching(/^Could not look for notebooks on this history \(403\)/),
      "The saved one is gone.",
      "Opened a saved conversation.",
      "Notes go to the notebook N.",
      "Ready.",
      "Hello.",
    ]);
  });
});

describe("the retry line", () => {
  it("counts the attempt from one", () => {
    expect(retryLine("429 Too Many Requests", 5, 0)).toBe(
      "Rate limited by the model provider — retrying in 5s (attempt 1).",
    );
  });
});
