// @chartwarden/quality — the SSVI metrics whose input a provider-side EHR structurally cannot assemble. Pure data.
//
// The HCI precedent exactly (`../hci/availability.ts`): a DECLARED absence carrying its reason, so the nightly
// recompute writes a suppressed row that says why, never an unbound resolver that throws.
//
//   • 9 (Total non-hospice spending) is the Medicare Part A/B/D amount paid to OTHER providers for the
//     beneficiary on hospice election days (excluding admission and live-discharge days). Those are other
//     providers' claims, which only CMS holds — the same blocker as HCI indicator 7 (per-beneficiary spending),
//     whose availability entry this mirrors. The agency's own M23 claims are hospice claims and contribute
//     nothing to this metric by definition.
//
// Because metric 9 carries up to 8 of the 16 points, the SSVI composite is withheld while it is unavailable
// (see `computeSsviScore`): a total missing half its range is not a lower score, it is an unknown one.
//
// If a future ChartWarden ingests a beneficiary-level Medicare claims feed, DELETE the entry (do not edit it) —
// `ssvi-measures.test.ts` fails if an entry names a metric the worker also binds a resolver for.
import type { MeasureUnavailability } from "../result";
import type { SsviMetricKey } from "./thresholds";

/** An SSVI metric that cannot be computed from provider-held data, with why and what would change it. */
export interface SsviMetricUnavailability extends MeasureUnavailability {
  readonly metric: SsviMetricKey;
}

/** The claims-file SSVI metrics, keyed by measure code (`ssvi_metric_NN`). */
export const SSVI_UNAVAILABLE_METRICS: Readonly<Record<string, SsviMetricUnavailability>> = {
  ssvi_metric_09: {
    metric: "metric_09",
    reason:
      "Total non-hospice spending is what Medicare paid OTHER providers (Parts A, B and D) for this hospice's beneficiaries during their elections. Those claims exist only at CMS; this agency's own claims are hospice claims and are excluded from the metric by definition.",
    requires:
      "a beneficiary-level Medicare claims feed across all providers (the same input HCI indicator 7 needs)",
  },
};

/** The measure codes declared unavailable above (the worker's routing predicate). */
export const SSVI_UNAVAILABLE_MEASURE_CODES: ReadonlySet<string> = new Set(
  Object.keys(SSVI_UNAVAILABLE_METRICS),
);

/** The declared unavailability for a measure code, or null when the code is computable. */
export function ssviUnavailabilityFor(measureCode: string): SsviMetricUnavailability | null {
  return SSVI_UNAVAILABLE_METRICS[measureCode] ?? null;
}
