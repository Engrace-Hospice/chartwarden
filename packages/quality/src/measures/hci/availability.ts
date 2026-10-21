// @chartwarden/quality — the HCI indicators whose input a provider-side EHR structurally cannot assemble.
// Pure data. No IO.
//
// The other seven indicators are computable here because their populations are things the agency itself
// records: its own election periods, its own level-of-care ledger, its own discharges, its own signed
// encounters. Three are not, and the reason is not "unbuilt" — it is that CMS defines them over the
// beneficiary's Medicare claims across EVERY provider, which is a data set that exists only at CMS:
//
//   • 5 / 6 (Burdensome Transitions type 1 and 2) count a live discharge followed by an INPATIENT HOSPITAL
//     stay and then either a hospice readmission (type 1) or a death in that hospital (type 2). The
//     hospital stay is another provider's encounter. WardenX sees a live discharge and, sometimes, a later
//     readmission — the middle term is invisible, and a sequence missing its middle term cannot be
//     classified as burdensome or not. M29 ingests ADT, but as demographic PROPOSALS for review
//     (`hl7_inbound_proposal`), not a retained longitudinal external-encounter record — and only from
//     facilities that have an interface with this agency, which is never all of them.
//   • 7 (Per-beneficiary Medicare spending) is total Part A + Part B spend attributed to the beneficiary
//     during the election, against a CMS risk-adjusted benchmark. The agency's own claims (M23) are one
//     term of the numerator and none of the denominator; the benchmark is not published as a formula a
//     payer-blind system can evaluate.
//
// This file exists so those three are a DECLARED absence carrying its reason, never an unbound resolver
// that throws — the same rule `deviceAttestationValid` and the F-030 registry follow. The recompute worker
// reads it, the value row records it, and the quality hub shows it, so a blank cell on a compliance
// dashboard reads as "not computable here, because X" rather than as "low N" (which it is not) or as a bug.
//
// If a future WardenX ingests a Medicare claims feed (a CMS Data at the Point of Care / Blue Button pull,
// or a state HIE's inpatient feed), DELETE the entry rather than editing it — an entry that outlives its
// reason is the failure mode this pattern is meant to prevent, and `hci-availability.test.ts` fails the
// moment an entry names an indicator the worker also binds a resolver for.
import type { MeasureUnavailability } from "../result";
import type { HciIndicatorKey } from "./thresholds";

/** An HCI indicator that cannot be computed from provider-held data, with why and what would change it. */
export interface HciIndicatorUnavailability extends MeasureUnavailability {
  readonly indicator: HciIndicatorKey;
}

/** The three claims-file indicators, keyed by measure code (`hci_indicator_NN`). */
export const HCI_UNAVAILABLE_INDICATORS: Readonly<Record<string, HciIndicatorUnavailability>> = {
  hci_indicator_05: {
    indicator: "indicator_05",
    reason:
      "A type-1 burdensome transition is a live discharge followed by an inpatient hospital stay and then a hospice readmission. The hospital stay is another provider's encounter, which this agency's record does not contain.",
    requires:
      "a retained longitudinal external-encounter record — a Medicare claims feed, or an HIE/ADT inpatient feed covering every facility a discharged patient could reach",
  },
  hci_indicator_06: {
    indicator: "indicator_06",
    reason:
      "A type-2 burdensome transition is a live discharge followed by an inpatient hospital stay ending in death in that hospital. Both the stay and the in-hospital death are outside this agency's record.",
    requires:
      "a retained longitudinal external-encounter record — a Medicare claims feed, or an HIE/ADT inpatient feed covering every facility a discharged patient could reach",
  },
  hci_indicator_07: {
    indicator: "indicator_07",
    reason:
      "Per-beneficiary spending is total Medicare Part A + Part B spend for the beneficiary during the election, against a CMS risk-adjusted benchmark. This agency's own claims are one term of the numerator and none of the benchmark.",
    requires:
      "a beneficiary-level Medicare claims feed across all providers, plus the CMS-published risk-adjusted spending benchmark for the period",
  },
};

/** The measure codes declared unavailable above (the worker's routing predicate). */
export const HCI_UNAVAILABLE_MEASURE_CODES: ReadonlySet<string> = new Set(
  Object.keys(HCI_UNAVAILABLE_INDICATORS),
);

/** The declared unavailability for a measure code, or null when the code is computable. */
export function hciUnavailabilityFor(measureCode: string): HciIndicatorUnavailability | null {
  return HCI_UNAVAILABLE_INDICATORS[measureCode] ?? null;
}
