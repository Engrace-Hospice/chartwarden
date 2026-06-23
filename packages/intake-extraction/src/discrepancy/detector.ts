// @wardenx/intake-extraction — the §7.1 W1 step-6 discrepancy detector (M22-T08).
//
// PURE. Given the field-level candidates a batch produced + the current chart values fetched through M22's reader
// seams, computes the two §2.3 discrepancy kinds:
//   • `cross_source` — two candidates targeting the SAME `fieldPath` carry DIFFERENT values (two source docs in the
//     bundle disagree; e.g. the discharge summary and the med-recon list a different dose). Surfaces in the
//     reviewer queue (W3 / §4.10 `m22.extraction.discrepancy_detected`).
//   • `chart_existing` — a candidate's value differs from the value already in the chart for that field (the
//     reviewer must explicitly confirm overwrite vs keep, W6 / §4.10 `m22.extraction.chart_overwrite_required`).
//
// No auto-resolution: the detector only reports. The reviewer resolves every discrepancy (D4) before commit. This
// is the surveyor-defensible "DocLens proposes, never auto-commits" rule applied to conflicts.

import type { ExtractionDiscrepancyKind } from "@wardenx/types";

/** The minimal candidate shape the detector compares (a projection of the pipeline candidate). */
export interface DiscrepancyCandidate {
  readonly candidateId: string;
  readonly fieldPath: string;
  readonly value: string;
  /** The source page the value came from (distinguishes two genuinely different sources from a duplicate read). */
  readonly sourcePage: number;
}

/** A current chart value for a field (fetched via M5/M7/M9/M11/M12 reader seams at the backend). */
export interface ChartValue {
  readonly fieldPath: string;
  readonly value: string;
}

/** One detected discrepancy the reviewer must resolve before the field can commit. */
export interface Discrepancy {
  readonly kind: ExtractionDiscrepancyKind;
  readonly fieldPath: string;
  /** The candidates participating in the conflict (one for `chart_existing`; ≥2 for `cross_source`). */
  readonly candidateIds: readonly string[];
  /** The conflicting extracted value(s) — distinct values seen for the field. */
  readonly extractedValues: readonly string[];
  /** The current chart value (only for `chart_existing`; null for `cross_source`). */
  readonly chartExistingValue: string | null;
}

export interface DetectDiscrepanciesInput {
  readonly candidates: readonly DiscrepancyCandidate[];
  readonly chartValues: readonly ChartValue[];
}

/** Detect cross-source + chart-existing discrepancies across a batch's candidates (§7.1 W1 step 6). */
export function detectDiscrepancies(input: DetectDiscrepanciesInput): readonly Discrepancy[] {
  const out: Discrepancy[] = [];

  // Group candidates by fieldPath (stable insertion order).
  const byField = new Map<string, DiscrepancyCandidate[]>();
  for (const c of input.candidates) {
    const list = byField.get(c.fieldPath);
    if (list) list.push(c);
    else byField.set(c.fieldPath, [c]);
  }

  const chartByField = new Map<string, string>();
  for (const cv of input.chartValues) chartByField.set(cv.fieldPath, cv.value);

  for (const [fieldPath, group] of byField) {
    const distinctValues = [...new Set(group.map((c) => c.value))];

    // cross_source: the same field carries ≥2 distinct extracted values.
    if (distinctValues.length > 1) {
      out.push({
        kind: "cross_source",
        fieldPath,
        candidateIds: group.map((c) => c.candidateId),
        extractedValues: distinctValues,
        chartExistingValue: null,
      });
    }

    // chart_existing: an extracted value differs from the value already in the chart.
    const chartValue = chartByField.get(fieldPath);
    if (chartValue !== undefined) {
      const conflicting = group.filter((c) => c.value !== chartValue);
      if (conflicting.length > 0) {
        out.push({
          kind: "chart_existing",
          fieldPath,
          candidateIds: conflicting.map((c) => c.candidateId),
          extractedValues: [...new Set(conflicting.map((c) => c.value))],
          chartExistingValue: chartValue,
        });
      }
    }
  }

  return out;
}
