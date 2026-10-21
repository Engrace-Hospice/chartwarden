// @chartwarden/quality — M30 §7.2 (WF-04) + §4.13 CAHPS decedent sampling logic. Pure, IO-free.
//
// The monthly CAHPS-Hospice sample is the set of decedents whose deaths fell in the prior calendar month,
// minus the CMS exclusions (caregiver unavailable, survey language unsupported, prior-survey opt-out,
// hospice stay <48h). This module is the PURE core the `cahps-sampling` worker (a later phase) wraps: it
// takes a list of candidate decedents already enumerated from the death feed and decides, per candidate,
// eligibility + the coded exclusion reason. No DB, no I/O — the worker resolves the candidates and persists
// the result rows.
//
// §4.13 source marking (D22): every produced row carries the `deathSource` of the candidate so the QAPI
// Coordinator can spot-check external-source samples for CMS-eligibility-rule correctness. This marker is
// platform-side only and is intentionally NOT forwarded into the vendor-facing `CahpsDecedentSampleRow`.
import { ChartWardenError } from "@chartwarden/types";

/**
 * Where the death record originated (§4.13). `admission_discharge` is the in-system M6 discharge/death
 * path; the others are reconciled in from outside the encounter feed and warrant QAPI spot-checking.
 */
export type DecedentDeathSource = "admission_discharge" | "external_import" | "manual_entry";

/** The coded CMS exclusion reasons (WF-04). `null` (not in this union) means survey-eligible. */
export type CahpsExclusionReason =
  | "caregiver_unavailable"
  | "language_not_supported"
  | "prior_survey_opt_out"
  | "hospice_stay_under_48h";

/**
 * One candidate decedent enumerated from the prior month's death feed, with every fact the CMS exclusion
 * rules need pre-resolved by the worker. The sampler does not fetch anything — it only classifies.
 */
export interface CahpsSampleCandidate {
  readonly deceasedPatientId: string;
  readonly deceasedAdmissionId: string;
  readonly providerEntityId: string;
  /** ISO-8601 date of death (used to assert membership in the sample period). */
  readonly deathDate: string;
  /** ISO-8601 timestamp the hospice stay began (for the <48h-stay exclusion). */
  readonly admissionStartAt: string;
  /** ISO-8601 timestamp the stay ended in death (for the <48h-stay exclusion). */
  readonly deathAt: string;
  /** §4.13 — the data source of this death record. */
  readonly deathSource: DecedentDeathSource;
  /** False when no primary caregiver is reachable (CMS exclusion). */
  readonly caregiverAvailable: boolean;
  /** False when the caregiver's language is not a CMS-supported survey language. */
  readonly languageSupported: boolean;
  /** True when the caregiver opted out of CAHPS surveying on a prior cycle. */
  readonly priorSurveyOptOut: boolean;
}

/**
 * One classified sample row: the decedent keys, the cycle month, eligibility + coded reason, and the
 * §4.13 source marker. Maps onto a `cahps_decedent_sample` insert (the worker adds org id + encrypted
 * caregiver contact). `exclusionReason === null` ⇒ `eligible === true`.
 */
export interface SampledDecedent {
  readonly deceasedPatientId: string;
  readonly deceasedAdmissionId: string;
  readonly providerEntityId: string;
  /** First day of the sample-period month, ISO-8601 date (the `sampling_cycle_month` partition key). */
  readonly samplingCycleMonth: string;
  /** Coded reason the decedent is excluded, or null when survey-eligible. */
  readonly exclusionReason: CahpsExclusionReason | null;
  /** True iff `exclusionReason === null`. */
  readonly eligible: boolean;
  /** §4.13 source marker — platform-side only; never forwarded to the vendor. */
  readonly deathSource: DecedentDeathSource;
}

/** The sample period — the prior calendar month as an ISO-8601 `[start, end]` (both inclusive dates). */
export interface CahpsSamplePeriod {
  readonly start: string;
  readonly end: string;
}

const MIN_STAY_HOURS = 48;
const MS_PER_HOUR = 3_600_000;

/** Parse an ISO-8601 instant, throwing a precise validation error rather than yielding `NaN`. */
function instant(value: string, field: string): number {
  const t = Date.parse(value);
  if (Number.isNaN(t)) {
    throw new ChartWardenError(
      "VALIDATION_FAILED",
      `'${field}' is not a valid ISO-8601 value: '${value}'`,
      422,
    );
  }
  return t;
}

/**
 * Derive the `sampling_cycle_month` (first day of the period's month) from the period start. The death
 * feed is enumerated per calendar month, so the start anchors the cycle.
 */
function cycleMonthOf(periodStart: string): string {
  const start = new Date(instant(periodStart, "samplePeriod.start"));
  const yyyy = start.getUTCFullYear().toString().padStart(4, "0");
  const mm = (start.getUTCMonth() + 1).toString().padStart(2, "0");
  return `${yyyy}-${mm}-01`;
}

/**
 * Classify ONE candidate against the CMS exclusion rules in deterministic priority order. Returns the
 * first applicable coded reason, or null when the decedent is survey-eligible.
 */
function classify(candidate: CahpsSampleCandidate): CahpsExclusionReason | null {
  // <48h hospice stay — the most objective rule, evaluated first.
  const stayHours =
    (instant(candidate.deathAt, "deathAt") -
      instant(candidate.admissionStartAt, "admissionStartAt")) /
    MS_PER_HOUR;
  if (stayHours < 0) {
    throw new ChartWardenError("VALIDATION_FAILED", "deathAt precedes admissionStartAt", 422);
  }
  if (stayHours < MIN_STAY_HOURS) {
    return "hospice_stay_under_48h";
  }
  if (!candidate.caregiverAvailable) {
    return "caregiver_unavailable";
  }
  if (!candidate.languageSupported) {
    return "language_not_supported";
  }
  if (candidate.priorSurveyOptOut) {
    return "prior_survey_opt_out";
  }
  return null;
}

/**
 * Build the monthly CAHPS sample (WF-04). Validates each candidate's death falls within the sample
 * period `[start, end]`, classifies it against the CMS exclusion rules, and stamps the §4.13 source
 * marker. Pure: same inputs ⇒ same output, no I/O. Throws `VALIDATION_FAILED` on a malformed timestamp,
 * an out-of-window death, or an inverted stay interval.
 */
export function sampleDecedents(
  candidates: readonly CahpsSampleCandidate[],
  samplePeriod: CahpsSamplePeriod,
): SampledDecedent[] {
  const periodStart = instant(samplePeriod.start, "samplePeriod.start");
  const periodEnd = instant(samplePeriod.end, "samplePeriod.end");
  if (periodEnd < periodStart) {
    throw new ChartWardenError(
      "VALIDATION_FAILED",
      "samplePeriod.end precedes samplePeriod.start",
      422,
    );
  }
  const samplingCycleMonth = cycleMonthOf(samplePeriod.start);

  return candidates.map((candidate) => {
    const death = instant(candidate.deathDate, "deathDate");
    if (death < periodStart || death > periodEnd) {
      throw new ChartWardenError(
        "VALIDATION_FAILED",
        `decedent '${candidate.deceasedPatientId}' death '${candidate.deathDate}' is outside the sample period`,
        422,
      );
    }
    const exclusionReason = classify(candidate);
    return {
      deceasedPatientId: candidate.deceasedPatientId,
      deceasedAdmissionId: candidate.deceasedAdmissionId,
      providerEntityId: candidate.providerEntityId,
      samplingCycleMonth,
      exclusionReason,
      eligible: exclusionReason === null,
      deathSource: candidate.deathSource,
    };
  });
}
