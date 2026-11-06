// @chartwarden/quality — SRA prior-cycle finding-seed logic (M30-P2a). Pure, IO-free.
//
// §7.4 — when a new annual SRA cycle opens, the prior cycle's still-OPEN findings carry forward so the
// remediation work is not lost across the cycle boundary (NIST 800-66r2 continuity). A carried-forward
// finding keeps its threat / vulnerability / impact narrative and 5×5 scores, preserves its in-flight
// status, records its provenance via `carried_from_prior_cycle_id`, and is renumbered sequentially in
// the new cycle. `mitigated` and `accepted_risk` findings are CLOSED for seed purposes (accepted-risk
// findings are handled separately by their 12-month auto-reopen reminder, not by cycle seeding). This is
// the pure planner; the route inserts the returned `NewSraFinding` payloads inside the open-cycle tx.
import type { schema } from "@chartwarden/db";

/** The inputs to {@link seedFindingsFromPriorCycle}. */
export interface SeedFindingsInput {
  /** All findings from the prior (closing) cycle. */
  readonly priorFindings: ReadonlyArray<schema.SraFinding>;
  /** The id of the newly-opened cycle the seeded findings attach to. */
  readonly newCycleId: string;
  /** The org the new cycle belongs to (carried onto each seeded finding for RLS). */
  readonly organizationId: string;
  /** The starting `finding_number` for the new cycle (default 1; per-cycle unique, V-13 sibling). */
  readonly startNumber?: number;
}
