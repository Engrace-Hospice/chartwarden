// @chartwarden/hope — RFA (Reason-For-Assessment) domain metadata (§2, D1/D11).
//
// The cross-module ENUM/seam surface lives in the leaf `@chartwarden/types` (`HopeRfaKind` etc.); this
// FEATURE package owns the rich per-RFA metadata the scheduling, recording, and section-TypeBox modules
// build on. T01 pins the RFA descriptor table (label, how each timepoint is generated, whether the
// Participation Section Q is required); the per-section TypeBox `data` shapes + the required-items
// matrix land per-folder under `sections/` in later M10 tasks.

import { HOPE_RFA_KINDS } from "@chartwarden/types";
import type { HopeRfaKind, HopeScheduleGeneratedBy } from "@chartwarden/types";

export { HOPE_RFA_KINDS };
export type { HopeRfaKind };

/** One RFA's domain descriptor: display label + how its timepoint schedule is generated (§2
 * `generated_by`) + whether the row requires the Participation Section Q (omitted on Death/Transfer
 * RFAs per §2.3). The full required-items-per-RFA matrix lands in `sections/required-items.ts`. */
export interface RfaDescriptor {
  readonly rfaKind: HopeRfaKind;
  readonly label: string;
  /** How the `hope_timepoint_schedule` row for this RFA originates (§2). */
  readonly generatedBy: HopeScheduleGeneratedBy;
  /** True when the RFA requires Section Q (§2.3): all but Death/Transfer-driven Discharge RFAs. The
   * discharge-reason discriminator narrows the Discharge RFA at record-time (the schema default is the
   * live-discharge branch, which includes Q). */
  readonly requiresParticipationSection: boolean;
}

/** The §2 RFA descriptor table (one entry per {@link HopeRfaKind}). Scheduling: Admission/HUV1/HUV2 are
 * auto-scheduled off M6's `admission.activated` (window calc in M10-T03); SFV is created by the J2051
 * trigger (D4); Discharge is created off M6's `admission.discharged` outbox (D9). */
export const RFA_DESCRIPTORS: { readonly [K in HopeRfaKind]: RfaDescriptor } = {
  "01_admission": {
    rfaKind: "01_admission",
    label: "Admission",
    generatedBy: "auto_admission",
    requiresParticipationSection: true,
  },
  "02_huv1": {
    rfaKind: "02_huv1",
    label: "HOPE Update Visit 1",
    generatedBy: "auto_admission",
    requiresParticipationSection: true,
  },
  "03_huv2": {
    rfaKind: "03_huv2",
    label: "HOPE Update Visit 2",
    generatedBy: "auto_admission",
    requiresParticipationSection: true,
  },
  "04_sfv": {
    rfaKind: "04_sfv",
    label: "Symptom Follow-Up Visit",
    generatedBy: "sfv_trigger",
    requiresParticipationSection: true,
  },
  "05_discharge": {
    rfaKind: "05_discharge",
    label: "Discharge",
    generatedBy: "auto_discharge",
    // Section Q is included on live-discharge but omitted on Death/Transfer (§2.3); the recording path
    // narrows this by `discharge_reason`. The descriptor default reflects the live-discharge branch.
    requiresParticipationSection: true,
  },
};

/** The §2 RFAs auto-scheduled from M6's admission activation (vs trigger- or discharge-driven). */
export function isAdmissionScheduled(rfaKind: HopeRfaKind): boolean {
  return RFA_DESCRIPTORS[rfaKind].generatedBy === "auto_admission";
}
