// @chartwarden/quality — HVLDL (Hospice Visits in Last Days of Life) ratio calculator (§1.1, §4.11 D20).
// Pure, IO-free.
//
// HVLDL = % of decedents who received ≥ 2 visits by a qualifying discipline in the last three days of
// life. The deceased census is M6 `m6.discharge.kind='death'` in the period; the qualifying-visit count
// is M8 `EncounterStatisticsProvider`. The §4.11 v0.3 enrichment: EXTERNAL-source deaths (M6 v0.3
// `source='hl7_external'`) STAY in the denominator (CMS does not exclude them) — the calculator records a
// per-source breakdown and computes a Risk-Register flag when the breakdown MATERIALLY affects the score
// (below national average AND ≥ 10% external-source). P2a is pure: the spec's example fetches via deps and
// emits via a riskRegisterEmitter — here the population is passed IN and the flag is RETURNED in the
// snapshot for the worker to act on. No IO, no emit.
import type { ComputeMeasureInput, QualityMeasureValueResult } from "../result";
import { ratioResult } from "../result";
import { HVLDL_MIN_QUALIFYING_VISITS } from "./qualifying_disciplines";

export * from "./qualifying_disciplines";

/** The death-source discriminator carried on `m6.discharge.death` (M6 v0.3 D6). */
export type HvldlDeathSource = "internal_clinician_recorded" | "hl7_external";

/** Cosign state of an external-source death attestation (D21). */
export type HvldlCosignStatus = "cosigned" | "pending";

/** One decedent in the HVLDL denominator, with its already-fetched qualifying-visit count + provenance. */
export interface HvldlDecedentInput {
  /** The decedent patient (logical id). */
  readonly patientId: string;
  /** Where the death record originated (M6 v0.3). */
  readonly source: HvldlDeathSource;
  /** Cosign state for `hl7_external` deaths (undefined for internal-source). */
  readonly cosignStatus?: HvldlCosignStatus;
  /** Count of qualifying-discipline visits in the decedent's last three days of life (M8). */
  readonly qualifyingDisciplineVisitsInLastDays: number;
}

/** Input to the HVLDL calculator — the decedent census plus the per-FY tuning constants. */
export interface ComputeHvldlInput extends ComputeMeasureInput {
  /** The decedent census in the reporting period (all sources). */
  readonly decedents: readonly HvldlDecedentInput[];
  /** Minimum qualifying visits to satisfy the numerator (defaults to {@link HVLDL_MIN_QUALIFYING_VISITS}). */
  readonly minQualifyingVisits?: number;
  /** The CMS national-average HVLDL rate used for the §4.11 Risk-Register flag. */
  readonly nationalAvg: number;
}

/** The §4.11 external-source death breakdown recorded on the snapshot. */
export interface HvldlExternalSourceBreakdown {
  readonly totalDecedentsInPeriod: number;
  readonly internalClinicianRecorded: number;
  readonly hl7External: number;
  readonly hl7ExternalSubset: {
    readonly withCosign: number;
    readonly pendingCosign: number;
    /** All external-source decedents are counted in the denominator regardless of cosign (CMS rule). */
    readonly denominatorIncludedAnyway: number;
  };
}

/** The §4.11 Risk-Register flag the worker emits when the breakdown materially affects the score. */
export interface HvldlRiskRegisterFlag {
  readonly indicator: "cms_attribution_under_review";
  readonly severity: "medium";
  readonly rationale: string;
}

/** The fraction of external-source decedents at/above which the §4.11 flag may fire. */
export const HVLDL_EXTERNAL_SOURCE_FLAG_FRACTION = 0.1;

/**
 * Compute the HVLDL ratio with the §4.11 v0.3 enriched snapshot. The denominator is ALL decedents (CMS
 * does not exclude external-source). The snapshot carries the per-source breakdown; `riskRegisterFlag` is
 * non-null when the rate is below national average AND ≥ 10% of the denominator is external-source. Pure.
 */
export function computeHvldl(input: ComputeHvldlInput): QualityMeasureValueResult {
  const minVisits = input.minQualifyingVisits ?? HVLDL_MIN_QUALIFYING_VISITS;

  const externalSource = input.decedents.filter((d) => d.source === "hl7_external");
  const internalSource = input.decedents.filter((d) => d.source === "internal_clinician_recorded");
  const externalWithCosign = externalSource.filter((d) => d.cosignStatus === "cosigned");
  const externalPendingCosign = externalSource.filter((d) => d.cosignStatus === "pending");

  const numerator = input.decedents.filter(
    (d) => d.qualifyingDisciplineVisitsInLastDays >= minVisits,
  ).length;
  const denominator = input.decedents.length;

  const breakdown: HvldlExternalSourceBreakdown = {
    totalDecedentsInPeriod: denominator,
    internalClinicianRecorded: internalSource.length,
    hl7External: externalSource.length,
    hl7ExternalSubset: {
      withCosign: externalWithCosign.length,
      pendingCosign: externalPendingCosign.length,
      denominatorIncludedAnyway: externalSource.length,
    },
  };

  const externalFraction = denominator > 0 ? externalSource.length / denominator : 0;
  const rate = denominator > 0 ? numerator / denominator : null;
  const belowNational = rate !== null && rate < input.nationalAvg;

  const riskRegisterFlag: HvldlRiskRegisterFlag | null =
    belowNational && externalFraction >= HVLDL_EXTERNAL_SOURCE_FLAG_FRACTION
      ? {
          indicator: "cms_attribution_under_review",
          severity: "medium",
          rationale: `HVLDL below national average (${(rate ?? 0).toFixed(4)}) with ${(externalFraction * 100).toFixed(1)}% external-source decedents; QAPI review recommended.`,
        }
      : null;

  return ratioResult({
    numerator,
    denominator,
    threshold: { value: input.nationalAvg, direction: "gte", label: "HVLDL vs national average" },
    snapshot: {
      measure: "hvldl",
      minQualifyingVisits: minVisits,
      nationalAvg: input.nationalAvg,
      externalSourceBreakdown: breakdown,
      riskRegisterFlag,
    },
  });
}
