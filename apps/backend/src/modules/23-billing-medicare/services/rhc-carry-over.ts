// apps/backend/src/modules/23-billing-medicare/services/rhc-carry-over.ts
//
// The two-tier RHC day-count carry-over as M23 prices it: M6's earlier stays with us (the claim-range seam's
// `rhcPriorStays`) merged with the beneficiary's cross-hospice history from the latest RESOLVED HETS 271 check
// (M23's own `eligibility_check.parsed_payload`), counted by the pure `computeRhcCarryOver` (@wardenx/billing,
// which carries the CMS citations). Used by the claim assembly + re-validation (HIPPS split, persisted on
// `per_diem_rate_calculation.rhc_carry_over`) and by the readmission screen's hospice-periods read.
//
// BASIS: `internal_only` (no resolved check, or it returned no hospice section), `hets_merged` (a fresh check),
// `hets_stale` (merged, but the check is past its stale_at or older than 30 days). With no HETS history AND no
// M6 stays list (an older seam reader), M6's own `rhcPriorHospiceDays` number is used as is.
import {
  type IsoDate,
  type RhcCarryOverResult,
  type RhcCarryOverSnapshot,
  type RhcHetsHistory,
  computeRhcCarryOver,
  repositories,
} from "@wardenx/billing";
import { type EligibilityCheckRowLike, projectHospicePeriods } from "../routes/hospice-periods";
import type { PriorStayFact, RhcCarryOverView, RhcHetsCheckRef } from "./rhc-carry-over-view";

export type { PriorStayFact, RhcCarryOverView, RhcHetsCheckRef } from "./rhc-carry-over-view";

const MS_PER_DAY = 86_400_000;
/** A HETS check older than this no longer vouches for other hospices' recent days (the freshness rule's 30). */
export const RHC_HETS_MAX_AGE_DAYS = 30;
const RHC_HIGH_RATE_DAYS = 60;

type CheckRow = EligibilityCheckRowLike;

/** The HETS hospice history of a resolved check (null when none / no hospice section), + the check ref. */
export function hetsHistoryOfCheck(
  check: CheckRow | null,
  now: Date,
): { readonly history: RhcHetsHistory | null; readonly ref: RhcHetsCheckRef | null } {
  if (!check) return { history: null, ref: null };
  const view = projectHospicePeriods({
    patientId: "",
    hetsConfigured: true,
    resolved: check,
    latest: check,
    now,
  });
  const ageDays = Math.max(0, Math.floor((now.getTime() - check.checkedAt.getTime()) / MS_PER_DAY));
  const stale = view.stale === true || ageDays > RHC_HETS_MAX_AGE_DAYS;
  const ref = { checkId: check.id, checkedAt: check.checkedAt.toISOString(), ageDays, stale };
  if (!view.hospiceHistoryReturned) return { history: null, ref };
  return {
    history: {
      stale,
      truncated: view.hospiceHistoryTruncated === true,
      periods: view.hospicePeriods,
    },
    ref,
  };
}

/** Merge our stays with the HETS history of `check` for a new election on `electionDate`. */
export function resolveRhcCarryOver(input: {
  readonly electionDate: IsoDate;
  /** M6's earlier stays; undefined when the seam reader predates them (then `fallbackPriorDays` is used). */
  readonly priorStays: readonly PriorStayFact[] | undefined;
  readonly fallbackPriorDays: number;
  readonly check: CheckRow | null;
  readonly now: Date;
}): RhcCarryOverView {
  const { history, ref } = hetsHistoryOfCheck(input.check, input.now);
  const result: RhcCarryOverResult =
    input.priorStays === undefined && history === null
      ? {
          priorDays: Math.min(RHC_HIGH_RATE_DAYS, Math.max(0, input.fallbackPriorDays)),
          chainDays: Math.max(0, input.fallbackPriorDays),
          chain: [],
          basis: "internal_only",
          warnings: [],
          daysSinceLastCare: null,
        }
      : computeRhcCarryOver({
          electionDate: input.electionDate,
          internalStays: (input.priorStays ?? []).map((s) => ({
            start: s.startedOn,
            end: s.endedOn,
            ref: s.admissionId,
            ...(s.otherHospice ? { atOtherHospice: true, hospiceNpi: s.otherHospice.npi } : {}),
          })),
          hets: history,
        });
  return {
    ...result,
    electionDate: input.electionDate,
    startsAtDay: result.priorDays + 1,
    highRateDaysRemaining: Math.max(0, RHC_HIGH_RATE_DAYS - result.priorDays),
    hetsCheck: ref,
  };
}

/** The §11.A context slice the `rhc_carry_over_hets_fresh` rule reads. */
export function rhcCarryOverSnapshot(view: RhcCarryOverView): RhcCarryOverSnapshot {
  return {
    priorDays: view.priorDays,
    basis: view.basis,
    readmittedWithin60Days: view.priorDays > 0 || view.chain.length > 0,
    hetsCheckAgeDays: view.hetsCheck?.ageDays ?? null,
    warningCodes: view.warnings.map((w) => w.code),
  };
}

/** The claim's carry-over: the admission's M6 facts + the patient's latest resolved HETS check (own table). */
export async function readClaimRhcCarryOver(
  tx: repositories.BillingDb,
  orgId: string,
  patientId: string,
  admission: {
    readonly hospiceAdmissionDate: IsoDate;
    readonly rhcPriorHospiceDays?: number;
    readonly rhcPriorStays?: readonly PriorStayFact[];
  },
  now: Date,
): Promise<RhcCarryOverView> {
  const check = await new repositories.EligibilityCheckRepository(tx).findLatestResolvedForPatient(
    orgId,
    patientId,
  );
  return resolveRhcCarryOver({
    electionDate: admission.hospiceAdmissionDate,
    priorStays: admission.rhcPriorStays,
    fallbackPriorDays: admission.rhcPriorHospiceDays ?? 0,
    check,
    now,
  });
}
