// @wardenx/billing — M23 Type-of-Bill derivation (spec §1.1, D4 / D14). A PURE function deriving the
// UB-04 hospice Type of Bill from the admission/claim cadence — assembly is server-authoritative, so the
// server (not the client) decides the TOB from three facts: (a) whether a prior claim already exists for
// this admission, (b) whether the patient has been discharged within/at the claim's through-date, and
// (c) whether this claim is a replacement (817) or void (818) of a prior accepted claim (D14). The four
// "normal" frequency codes follow the CMS interim-billing cadence:
//
//   • 811 — admission-through-discharge (a single claim covering the whole stay): no prior claim AND discharged.
//   • 812 — first interim:                no prior claim AND not yet discharged.
//   • 813 — continuing interim:           a prior claim exists AND not yet discharged.
//   • 814 — last interim before discharge: a prior claim exists AND now discharged.
//
// A replacement/void overrides the cadence entirely (817/818 with `replaces_claim_id` set, per D14).
//
// PURE DOMAIN: no Fastify, no Drizzle/DB, no BullMQ, no `@wardenx/db`, no `getSeam`, no clock. No PHI (D13).
import type { TypeOfBill } from "../contracts";

/** Whether this claim is an adjustment of a prior accepted claim (D14) — `none` for a normal interim. */
export type ClaimAdjustmentKind = "none" | "replacement" | "void";

/** The injected cadence facts the TOB is derived from (all plain booleans). */
export interface TobDerivationInput {
  /** True iff at least one prior (non-voided) claim already exists for this admission. */
  readonly hasPriorClaimForAdmission: boolean;
  /** True iff the patient is discharged (incl. discharge-by-death) on/before the claim's through-date. */
  readonly patientDischarged: boolean;
  /** `"replacement"` ⇒ TOB 817, `"void"` ⇒ TOB 818 (D14); `"none"` ⇒ normal interim cadence. */
  readonly adjustment: ClaimAdjustmentKind;
}

/**
 * Derive the UB-04 Type of Bill for a hospice claim (D4 / D14). A replacement/void takes precedence over
 * the interim cadence (you replace/void an already-submitted claim regardless of discharge state); the
 * four normal frequency codes then follow the prior-claim × discharged truth table above. Pure +
 * deterministic; total over its inputs (every combination resolves to exactly one TOB).
 */
export function deriveTypeOfBill(input: TobDerivationInput): TypeOfBill {
  if (input.adjustment === "replacement") return "817";
  if (input.adjustment === "void") return "818";

  if (!input.hasPriorClaimForAdmission) {
    return input.patientDischarged ? "811" : "812";
  }
  return input.patientDischarged ? "814" : "813";
}
