import { briefly } from "../agent/galaxy";
import { WHAT } from "../agent/markers";
import type { Waiting } from "../agent/worker";
import type { Settled } from "../agent/watch";
import type { RunOutcome } from "../transcript";

export interface Notice {
  level: "info" | "error";
  text: string;
}

const info = (text: string): Notice => ({ level: "info", text });
const error = (text: string): Notice => ({ level: "error", text });

/** Exactly one explanation for a quiet ending, most specific first. */
export function outcomeNotice(outcome: RunOutcome): Notice | undefined {
  let notice: Notice | undefined;
  if (outcome.error) {
    notice = error(briefly(outcome.error));
  } else if (outcome.aborted) {
    notice = info("Stopped.");
  } else if (outcome.exhausted) {
    // Orbit has no step cap; this one's must not look like completion.
    notice = info(
      'I ran out of steps for one turn while still working. Say "continue" to pick it up.',
    );
  } else if (!outcome.spoke && !outcome.done) {
    notice = info("The model ended the turn without a reply. Ask again, or rephrase.");
  }
  return notice;
}

export function settledNotices({ watched: w, state, outcome, record }: Settled): Notice[] {
  const what = WHAT[w.kind];
  const notices: Notice[] = [];
  if (record) {
    notices.push(error(`The record was not updated for ${what} ${w.id}: ${record}.`));
  }
  if (outcome === "failed") {
    notices.push(error(`${what} ${w.id} finished as ${state}.`));
  } else if (outcome === "paused") {
    notices.push(error(`${what} ${w.id} is paused: it waits on an input that failed.`));
  } else if (outcome === "unreadable") {
    notices.push(error(`${what} ${w.id} is no longer shown by Galaxy (${state}).`));
  } else if (outcome === "cancelled" || outcome === "skipped") {
    // Someone chose this; an alarm about it would be the loudest thing in the room.
    notices.push(info(`${what} ${w.id} was ${outcome}.`));
  } else {
    notices.push(info(`${what} ${w.id} finished (${state}).`));
  }
  return notices;
}

export function heldNotice(held: Waiting): Notice | undefined {
  let notice: Notice | undefined;
  if (held === "paused") {
    notice = info(
      "Galaxy results are waiting -- automatic follow-up is paused. Say continue when you're ready.",
    );
  } else if (held === "capped") {
    notice = info(
      "Galaxy results are waiting -- automatic follow-up paused after several automatic turns. Say continue to resume.",
    );
  }
  return notice;
}

export interface Readiness {
  unkept?: string;
  galaxyProblem?: string;
  recordsProblem?: string;
  savedProblem?: string;
  saved?: boolean;
  restored?: boolean;
  continuing?: string;
  greeting?: string;
  keepHint?: string;
}

export function readyNotices(ready: Readiness): Notice[] {
  const notices: Notice[] = [];
  if (ready.unkept) {
    notices.push(
      error(
        `This browser can't keep conversations (${ready.unkept}), so this one ends when the ` +
          "page closes." +
          (ready.keepHint ? ` ${ready.keepHint}` : ""),
      ),
    );
  }
  if (ready.galaxyProblem) {
    notices.push(
      error(
        `Galaxy did not answer when this session opened (${ready.galaxyProblem}), so no Galaxy tool ` +
          "can run in this session. Reload once Galaxy is back.",
      ),
    );
  }
  if (ready.recordsProblem) {
    notices.push(
      error(
        `Could not look for notebooks on this history (${ready.recordsProblem}), so this ` +
          "starts a new one.",
      ),
    );
  }
  if (ready.savedProblem) {
    notices.push(error(ready.savedProblem));
  }
  if (ready.saved) {
    notices.push(info("Opened a saved conversation."));
  }
  if (ready.continuing) {
    notices.push(info(ready.continuing));
  }
  notices.push(
    info(
      ready.saved
        ? "Ready."
        : ready.restored
          ? "Restored this history's conversation from this browser. Ready."
          : "Ready. Ask me to run something.",
    ),
  );
  if (ready.greeting) {
    notices.push(info(ready.greeting));
  }
  return notices;
}

export function retryLine(errorMessage: string, left: number, attempt: number): string {
  // The first number the message names, when it is an HTTP error status rather than a wait.
  const status = /^\D*\b([45]\d\d)\b/.exec(errorMessage)?.[1];
  const label =
    status === "429"
      ? "Rate limited by the model provider"
      : status
        ? `Provider error ${status}`
        : "The model provider failed";
  return `${label} — retrying in ${left}s (attempt ${attempt + 1}).`;
}
