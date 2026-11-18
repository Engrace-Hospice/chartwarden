// M25 835 intake — one outcome per FILE from the per-set outcomes of a multi-set interchange.
//
// `receiveAdvice` stores every transaction set of a file on its own and answers with a single outcome, so a
// held set (legacy identity ambiguous, or a staged Claim.MD ERA that matches) must not vanish behind a queued or
// duplicate sibling, and several held sets must not collapse to the first one. Pure: no IO.
import type { HeldSetReason, ReceiveAdviceResult } from "./service";

type HeldOutcome = Extract<
  ReceiveAdviceResult,
  { outcome: "held_duplicate" } | { outcome: "review_required" }
>;
type SetOutcome =
  | Extract<ReceiveAdviceResult, { outcome: "queued" } | { outcome: "duplicate" }>
  | HeldOutcome;

const isHeld = (r: ReceiveAdviceResult): r is HeldOutcome =>
  r.outcome === "held_duplicate" || r.outcome === "review_required";

const isSetOutcome = (r: ReceiveAdviceResult): r is SetOutcome =>
  r.outcome === "queued" || r.outcome === "duplicate" || isHeld(r);

/**
 * The file's single outcome. Primary = the first queued set, else the first duplicate, else the first held one;
 * `heldSets` then lists EVERY held set's reason whenever the primary is queued/duplicate and a set was held, or the
 * primary is itself held and a second set was held too. A file with one held set and nothing else keeps its plain
 * held outcome (no `heldSets`).
 */
export function summarizeSetOutcomes(results: readonly ReceiveAdviceResult[]): ReceiveAdviceResult {
  const sets = results.filter(isSetOutcome);
  const primary =
    sets.find((r) => r.outcome === "queued") ??
    sets.find((r) => r.outcome === "duplicate") ??
    sets[0];
  if (!primary) throw new Error("receiveAdvice: a file produced no transaction-set outcome");
  const heldSets: HeldSetReason[] = sets.filter(isHeld).map((r) => r.reason);
  if (heldSets.length === 0 || (isHeld(primary) && heldSets.length === 1)) return primary;
  return { ...primary, heldSets };
}
