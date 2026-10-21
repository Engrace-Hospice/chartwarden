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

/**
 * The finding statuses considered OPEN for cycle-seed purposes — everything except the two resolved
 * terminal-ish states (`mitigated`, `accepted_risk`). A frozen set mirrored from `m30_sra_finding_status`.
 */
export const OPEN_SRA_FINDING_STATUSES: ReadonlyArray<schema.SraFinding["status"]> = [
  "identified",
  "analyzed",
  "mitigation_planned",
  "mitigation_in_progress",
];

/** Whether a finding is still open (and therefore carried forward into a new cycle). */
export function isOpenFinding(finding: schema.SraFinding): boolean {
  return OPEN_SRA_FINDING_STATUSES.includes(finding.status);
}

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

/**
 * Plan the carry-forward of a prior cycle's open findings into a new cycle (§7.4). Pure: returns the
 * ordered `NewSraFinding` insert payloads (provenance-stamped via `carriedFromPriorCycleId`, renumbered
 * from `startNumber`), preserving each finding's narrative, 5×5 scores, asset category, and in-flight
 * status. The prior findings are ordered by their original `findingNumber` so the new numbering is
 * deterministic. Closed (`mitigated` / `accepted_risk`) findings are not seeded.
 */
export function seedFindingsFromPriorCycle(input: SeedFindingsInput): schema.NewSraFinding[] {
  const start = input.startNumber ?? 1;
  const open = input.priorFindings
    .filter(isOpenFinding)
    .slice()
    .sort((a, b) => a.findingNumber - b.findingNumber);

  return open.map((prior, index) => ({
    sraCycleId: input.newCycleId,
    organizationId: input.organizationId,
    findingNumber: start + index,
    threatDescription: prior.threatDescription,
    vulnerabilityDescription: prior.vulnerabilityDescription,
    impactDescription: prior.impactDescription,
    affectedAssetCategory: prior.affectedAssetCategory,
    inherent5x5Score: prior.inherent5x5Score,
    residual5x5Score: prior.residual5x5Score,
    status: prior.status,
    carriedFromPriorCycleId: prior.id,
  }));
}
