// apps/backend/src/modules/23-billing-medicare/services/claim-sia-snapshot.ts
//
// The SIA snapshot a claim persists: `ClaimSia` (the shared units engine's result plus the rate it was priced with)
// mapped onto the append-only `sia_calculation` row, and the test that decides whether a re-evaluation actually changed
// anything. The table refuses UPDATE, so a change is a NEW revision; appending one on every re-validation would churn
// the history, so a revision is appended only when the evaluation really moved (a clinician confirmed a visit's delivery
// mode, a start/stop was documented, the CHC rate was re-keyed). PURE: no I/O. No PHI (encounter ids, dates, units).
import { DEFAULT_SIA_POLICY, type repositories } from "@chartwarden/billing";
import type { ClaimSia } from "./claim-assembly-facts";

/** The columns of a stored revision that define "the same evaluation". */
export interface StoredSiaEvaluation {
  readonly basis: string;
  readonly patientDeceasedDate: string;
  readonly windowStart: string;
  readonly paidUnits: number | null;
  readonly siaAddOnCents: number;
  readonly chcHourlyRateCents: number | null;
  readonly wageIndexFiscalYear: number | null;
  readonly wageIndexFactor: string | null;
  readonly policy: unknown;
  readonly visitOutcomes: unknown;
  readonly priorClaimAdvisory: unknown;
}

/** JSON with object keys sorted, so a jsonb round-trip (which reorders keys) does not look like a change. */
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, v: unknown) =>
    v !== null && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)),
        )
      : v,
  );

export function siaSnapshotInputOf(
  sia: ClaimSia,
  ids: { readonly orgId: string; readonly claimId: string },
): repositories.SiaSnapshotInput {
  const { result, pricing, priorClaimAdvisory } = sia;
  if (result.patientDeceasedDate === null || result.windowStart === null) {
    throw new Error("a SIA snapshot needs a date of death");
  }
  return {
    organizationId: ids.orgId,
    claimId: ids.claimId,
    patientDeceasedDate: result.patientDeceasedDate,
    windowStart: result.windowStart,
    qualifyingVisits: result.qualifyingVisits.map((v) => ({ ...v })),
    totalQualifyingMinutes: result.totalQualifyingMinutes,
    siaAddOnCents: result.siaAddOnCents,
    paidUnits: result.paidUnits,
    eligibleUnits: result.eligibleUnits,
    truncatedUnits: result.truncatedUnits,
    // No rate is resolved when nothing is payable: NULL means "not priced", never a fabricated 0.
    chcHourlyRateCents: pricing?.chcHourlyRateCents ?? null,
    wageIndexFiscalYear: pricing?.fiscalYear ?? null,
    wageIndexFactor: pricing?.wageIndexFactor ?? null,
    policy: { ...result.evaluation.policy },
    visitOutcomes: result.evaluation.visits.map((v) => ({
      encounterId: v.encounterId,
      serviceDate: v.serviceDate,
      discipline: v.discipline,
      durationMinutes: v.durationMinutes,
      timeSource: v.timeSource,
      units: v.units,
      paidUnits: v.paidUnits,
      counted: v.counted,
      excluded: v.excluded,
    })),
    priorClaimAdvisory: priorClaimAdvisory ? { ...priorClaimAdvisory } : null,
  };
}

/**
 * True when `next` would record exactly what `stored` already does. A legacy `minutes_v1` row is never "the same":
 * the first re-validation after the units model ships appends the first `units_v2` revision.
 */
export function sameSiaEvaluation(
  stored: StoredSiaEvaluation,
  next: repositories.SiaSnapshotInput,
): boolean {
  return (
    stored.basis === "units_v2" &&
    // A corrected date of death moves the window even when no visit outcome changes: that is a different evaluation.
    stored.patientDeceasedDate === next.patientDeceasedDate &&
    stored.windowStart === next.windowStart &&
    stored.paidUnits === next.paidUnits &&
    stored.siaAddOnCents === next.siaAddOnCents &&
    stored.chcHourlyRateCents === next.chcHourlyRateCents &&
    stored.wageIndexFiscalYear === next.wageIndexFiscalYear &&
    stored.wageIndexFactor === next.wageIndexFactor &&
    canonical(stored.policy) === canonical(next.policy) &&
    canonical(stored.visitOutcomes) === canonical(next.visitOutcomes) &&
    canonical(stored.priorClaimAdvisory) === canonical(next.priorClaimAdvisory)
  );
}

const advisoryUnitsOf = (advisory: unknown): number =>
  typeof advisory === "object" &&
  advisory !== null &&
  typeof (advisory as { units?: unknown }).units === "number"
    ? (advisory as { units: number }).units
    : 0;

/**
 * Does the latest stored revision still promise money: units, a legacy minutes-based amount, or a prior-month advisory
 * that tells billing the add-on moves on another claim? A zero-unit revision whose only content is that advisory is
 * just as stale as a payable one when the death record is withdrawn.
 */
export function siaStillPromised(
  stored: Pick<StoredSiaEvaluation, "paidUnits" | "siaAddOnCents"> &
    Partial<Pick<StoredSiaEvaluation, "priorClaimAdvisory">>,
): boolean {
  return (
    (stored.paidUnits ?? 0) > 0 ||
    stored.siaAddOnCents > 0 ||
    advisoryUnitsOf(stored.priorClaimAdvisory) > 0
  );
}

/**
 * The revision that records "this claim no longer carries an add-on" (a visit voided, a death record withdrawn or moved
 * out of the claim). The table is append-only, so a stale revision cannot be edited away: without a zero revision the
 * claim detail would keep publishing the old units and dollars while the expected payment had already dropped them. The
 * death date and window are carried from the revision it supersedes; nothing was priced, so no rate (the 1512 CHECK
 * allows a NULL rate only on a row that pays zero units).
 */
export function siaEndedSnapshotInput(
  stored: Pick<StoredSiaEvaluation, "patientDeceasedDate" | "windowStart">,
  ids: { readonly orgId: string; readonly claimId: string },
): repositories.SiaSnapshotInput {
  return {
    organizationId: ids.orgId,
    claimId: ids.claimId,
    patientDeceasedDate: stored.patientDeceasedDate,
    windowStart: stored.windowStart,
    qualifyingVisits: [],
    totalQualifyingMinutes: 0,
    siaAddOnCents: 0,
    paidUnits: 0,
    eligibleUnits: 0,
    truncatedUnits: 0,
    chcHourlyRateCents: null,
    wageIndexFiscalYear: null,
    wageIndexFactor: null,
    policy: { ...DEFAULT_SIA_POLICY },
    visitOutcomes: [],
    priorClaimAdvisory: null,
  };
}
