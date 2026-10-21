// @chartwarden/medicaid-adapters — M24 Type-of-Bill derivation + replacement/void mapping (D13). Most states'
// Medicaid 837I uses the same hospice TOB frequency codes as Medicare (81X): the trailing digit is the
// billing-cadence frequency. Per-state TOB variations are expressed by the adapter's replacementTob /
// voidTob methods (§4.5). PURE DOMAIN: deterministic, no I/O.
import type { MedicaidTob } from "./contracts";

/** The billing cadence of a claim within its election period — drives the TOB trailing frequency digit. */
export type ClaimCadence =
  | "admit_through_discharge" // single claim covering the whole stay → 811
  | "first_interim" // first of several interim claims → 812
  | "continuing" // a middle interim claim → 813
  | "last_interim"; // final interim claim → 814

const CADENCE_TO_TOB: Readonly<Record<ClaimCadence, MedicaidTob>> = {
  admit_through_discharge: "811",
  first_interim: "812",
  continuing: "813",
  last_interim: "814",
};

/** Derive the originating TOB (811/812/813/814) from the claim's billing cadence. */
export function deriveMedicaidTob(cadence: ClaimCadence): MedicaidTob {
  return CADENCE_TO_TOB[cadence];
}

/** The standard replacement TOB (817) for an original. Adapters override only for proprietary-code states. */
export function replacementTob(_originalTob: string): MedicaidTob {
  return "817";
}

/** The standard void/cancel TOB (818) for an original. */
export function voidTob(_originalTob: string): MedicaidTob {
  return "818";
}

/** True iff the TOB is a replacement (817) or void (818) — these require a `replaces_claim_id` (§2.3). */
export function isReplacementOrVoid(tob: string): boolean {
  return tob === "817" || tob === "818";
}
