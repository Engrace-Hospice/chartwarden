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

export interface MedicaidTobCadenceFacts {
  /** True when a non-superseded normal claim already exists for this admission. */
  readonly hasPriorClaimForAdmission: boolean;
  /** True when the admission ended on or before this claim's through date. */
  readonly patientDischarged: boolean;
}

export interface MedicaidAdmissionCadenceFacts {
  readonly hasPriorClaimForAdmission: boolean;
  /** M6's completed stay-ending date; null while active, on hold, or awaiting a LOC assignment. */
  readonly dischargedAt: string | null;
  readonly serviceTo: string;
}

/**
 * Derive an original claim's TOB from server-owned admission facts. Keeping this truth table in the
 * pure adapter package prevents an assembly route from silently collapsing every claim to 811.
 */
export function deriveMedicaidTobFromFacts(input: MedicaidTobCadenceFacts): MedicaidTob {
  if (!input.hasPriorClaimForAdmission) {
    return deriveMedicaidTob(input.patientDischarged ? "admit_through_discharge" : "first_interim");
  }
  return deriveMedicaidTob(input.patientDischarged ? "last_interim" : "continuing");
}

/** Derive an original TOB directly from M6's authoritative discharge projection. */
export function deriveMedicaidTobFromAdmission(input: MedicaidAdmissionCadenceFacts): MedicaidTob {
  return deriveMedicaidTobFromFacts({
    hasPriorClaimForAdmission: input.hasPriorClaimForAdmission,
    patientDischarged: input.dischargedAt !== null && input.dischargedAt <= input.serviceTo,
  });
}

/** A replaced original still carries cadence history; rejected, abandoned, or voided originals do not. */
export function isMedicaidCadenceBearingClaim(input: {
  readonly tob: string;
  readonly state: string;
}): boolean {
  return (
    ["811", "812", "813", "814"].includes(input.tob) &&
    !["VOIDED", "ACK_REJECTED", "ABANDONED"].includes(input.state)
  );
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
