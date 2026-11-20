// apps/web/src/modules/08-encounters/review — what the blocker panel shows for a note's status and the last attempt on this screen (one
// place for the composer and the record). Pure.
import type { GateAttempt } from "./refusal-model";

/** One object, so a panel that is memoised on its attempt is not re-rendered by a screen that derives "finalized" again. */
const FINALIZED: GateAttempt = { state: "finalized" };

/**
 * A finalized note says so from the server's own status, so a reload shows it too; a refused try is shown until the next one. The status
 * is the encounter's (`finalized` is the one that matters here; the panel is not mounted for any other end state).
 */
export function panelAttemptFor(status: string, attempt: GateAttempt): GateAttempt {
  return status === "finalized" && attempt.state !== "refused" ? FINALIZED : attempt;
}
