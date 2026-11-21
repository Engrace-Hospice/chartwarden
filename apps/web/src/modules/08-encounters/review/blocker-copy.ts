// apps/web/src/modules/08-encounters/review — the words of the blocker panel, in one place. Every sentence says what the server last said
// and nothing it has not: no "ready", no "complete", no "passed", and nothing about the acknowledgment but that the server does not
// record it. Pure, so the exact copy is easy to review and to test.
import type { CheckGroup } from "./gate-register";
import { type GateAttempt, type Moment, type Refusal, refusalMovedStatus } from "./refusal-model";

export const PANEL_HEADING = "Finalize and sign checks";

/** The sentence that says finalize is not a harmless preview: it freezes the note when the checks pass, and it is not the signature. */
export const FINALIZE_COPY =
  "Finalize runs the server checks; if they pass the note is finalized and its text is frozen. It is not signed.";

/** The sentence that says what a sign does when the note is already finalized: it runs the checks again, and it is the signature. */
export const SIGN_COPY = "Signing runs the server checks again; if they pass the note is signed.";

export const GROUP_HEADING: Readonly<Record<CheckGroup, string>> = {
  finalize: "Checked when you finalize",
  sign: "Checked when you sign",
  not_checked: "Not checked by ChartWarden",
};

export const GROUP_NOTE: Readonly<Partial<Record<CheckGroup, string>>> = {
  sign: "The server runs the gate again when you sign.",
};

export const RETRY_LABEL = "Try again";

interface AttemptWords {
  readonly headline: string;
  readonly body: string;
}

const done = (moment: Moment): string => (moment === "finalize" ? "finalized" : "signed");

function blockedHeadline(count: number): string {
  if (count === 0) return "Blocked: the server did not list what to fix";
  return `Blocked: ${count} ${count === 1 ? "item" : "items"} to fix`;
}

type BlockedRefusal = Extract<Refusal, { outcome: "blocked" }>;

/**
 * "Not finalized" and "nothing was frozen" are said only for a refusal the server raises before it writes anything for the step. A code this
 * model does not know (a note another tab already finalized, say) says nothing about the note: the author is sent to its current status.
 */
function blockedBody(refusal: BlockedRefusal): string {
  if (refusalMovedStatus({ state: "refused", refusal })) {
    return "The server refused this request. This screen has read the note again and shows its current status.";
  }
  if (!refusal.gateRanInFull && !refusal.decidedBeforeWrite) {
    return "The server refused this request. Reload to see the note's current status.";
  }
  return refusal.moment === "finalize"
    ? "The note was not finalized. Nothing was frozen or signed. This is the server's last answer: finalize again to check again."
    : "The note was not signed. This is the server's last answer: sign again to check again.";
}

/** What runs after the gate, per step, in the order the server reaches it: none of it ran when the gate refused. */
const AFTER_THE_GATE: Readonly<Record<Moment, string>> = {
  finalize: "complete selections, vocabulary version, your edited note text",
  sign: "the RN cosigner, the face-to-face record, the visit delivery and times",
};

/** The sentence under a gate failure about the checks it did not name. Shown only when the gate ran every check in one pass. */
export function gateSilenceNote(moment: Moment): string {
  return `The other checks in the ${moment} gate did not list a failure in this attempt; some checks are not evaluated (see below). Checks that run after the gate (${AFTER_THE_GATE[moment]}) were not reached.`;
}

/** The sentence under the status: what the step the author is on does. Nothing once the note is finalized. */
export function introCopy(attempt: GateAttempt): string | null {
  if (attempt.state === "finalized") return null;
  return attempt.state === "refused" && attempt.refusal.moment === "sign"
    ? SIGN_COPY
    : FINALIZE_COPY;
}

/** Whether the panel lists what is checked when the note is finalized: not once the note is finalized, nor after a refused sign. */
export function showsFinalizeChecks(attempt: GateAttempt): boolean {
  if (attempt.state === "finalized") return false;
  return attempt.state !== "refused" || attempt.refusal.moment === "finalize";
}

function unavailableBody(refusal: Extract<Refusal, { outcome: "unavailable" }>): string {
  switch (refusal.reason) {
    case "connection":
      return "The connection was interrupted before the server answered, so the result is not known. Reload the note to see its status.";
    case "unconfirmed":
      return "The server answered with an error that does not say whether the note changed, so the result is not known. Reload the note to see its status.";
    case "service":
      return `The server could not run its checks right now, so the note was not ${done(refusal.moment)}. Try again in a moment.`;
  }
}

/** The headline and the line under it for what the server last said: the one place the panel's status is worded. */
export function describeAttempt(attempt: GateAttempt): AttemptWords {
  switch (attempt.state) {
    case "none":
      return {
        headline: "Not checked yet",
        body: "The server checks the note only when you finalize. Nothing here has been checked.",
      };
    case "running":
      return {
        headline: "Finalizing: waiting for the server",
        body: "The server is running its checks.",
      };
    case "finalized":
      return {
        headline: "Finalized, not signed",
        body: "The server finalized this note and its text is frozen. It is not signed. Signing is a separate step.",
      };
    case "refused": {
      const { refusal } = attempt;
      if (refusal.outcome === "blocked") {
        return {
          headline: refusalMovedStatus(attempt)
            ? "Refused: the note changed elsewhere"
            : blockedHeadline(refusal.blockers.length),
          body: blockedBody(refusal),
        };
      }
      return { headline: "Unavailable", body: unavailableBody(refusal) };
    }
  }
}
