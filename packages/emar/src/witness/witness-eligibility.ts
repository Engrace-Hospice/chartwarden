// @wardenx/emar — §2.6 D7 controlled-substance witness eligibility (M13-T04). PURE, IO-free.
//
// Two operations require a second clinical-discipline witness: ADMINISTRATION of a Schedule II–V medication
// and WASTAGE of any partial dose of one. The administration route resolves the witness's membership from
// the consumed witness-attestation token (§7.4) and runs `controlled_substance_witness_eligible` (§4.7);
// the lifecycle gate (`administration-record.ts`) only consumes the resulting boolean. This module IS that
// predicate — the five §2.6 rules, all pure: the witness must NOT be the administering clinician, must hold
// an eligible discipline ({rn, lpn, md, np, pa}), must be active on the same tenant, must not be a caregiver,
// and a break-glass witness is ALLOWED but flagged (the route emits the warn audit event). Every fact is
// resolved upstream (M2 session, M3 membership) and injected, so the predicate is deterministic.
import { AdministrationStateError } from "../lifecycle/errors";

/** §2.6 — the clinical disciplines that may witness a controlled-substance administration/wastage. */
export const WITNESS_ELIGIBLE_DISCIPLINES = ["rn", "lpn", "md", "np", "pa"] as const;
export type WitnessEligibleDiscipline = (typeof WITNESS_ELIGIBLE_DISCIPLINES)[number];

/** Normalize a discipline string for matching (case-insensitive, trimmed) — the M11 `key()` convention. */
function disciplineKey(d: string): string {
  return d.trim().toLowerCase();
}

/** The facts the route resolves about the prospective witness before writing `administration_witness`. */
export interface WitnessEligibilityInput {
  /** The witness's M3 membership id (resolved from the consumed §7.4 attestation token). */
  readonly witnessMembershipId: string;
  /** The administering clinician's membership id (a clinician cannot witness themselves). */
  readonly administeringClinicianMembershipId: string;
  /** The witness's membership discipline (M3). */
  readonly witnessDiscipline: string;
  /** The witness's membership is active. */
  readonly witnessMembershipActive: boolean;
  /** The witness's membership is on the SAME tenant as the administration. */
  readonly sameTenant: boolean;
  /** The witness is a caregiver (M31 portal actor) — caregivers cannot witness clinician-administered doses. */
  readonly witnessIsCaregiver: boolean;
  /** The witness's session is break-glass (allowed, but emits a warn audit event). */
  readonly witnessIsBreakGlass: boolean;
}

/** Why a witness is ineligible (§2.6) — the route maps it to a precise client message. */
export type WitnessIneligibleReason =
  | "is_administering_clinician"
  | "discipline_ineligible"
  | "membership_inactive"
  | "different_tenant"
  | "is_caregiver";

/** The §2.6 eligibility verdict. When `eligible`, `isBreakGlass` tells the route to emit the warn audit. */
export type WitnessEligibilityResult =
  | { readonly eligible: true; readonly isBreakGlass: boolean }
  | { readonly eligible: false; readonly reason: WitnessIneligibleReason };

/**
 * §2.6 D7 / §4.7 — `controlled_substance_witness_eligible(witnessMembershipId)`. Returns the verdict (never
 * throws) so the route can render the exact reason. The five rules are checked in a stable order; a
 * break-glass witness is eligible but carries `isBreakGlass=true` (the route emits
 * `administration.controlled_witnessed_break_glass`). PURE — every fact is injected.
 */
export function controlledSubstanceWitnessEligible(
  input: WitnessEligibilityInput,
): WitnessEligibilityResult {
  if (input.witnessMembershipId === input.administeringClinicianMembershipId) {
    return { eligible: false, reason: "is_administering_clinician" };
  }
  if (input.witnessIsCaregiver) {
    return { eligible: false, reason: "is_caregiver" };
  }
  if (
    !(WITNESS_ELIGIBLE_DISCIPLINES as readonly string[]).includes(
      disciplineKey(input.witnessDiscipline),
    )
  ) {
    return { eligible: false, reason: "discipline_ineligible" };
  }
  if (!input.witnessMembershipActive || !input.sameTenant) {
    return {
      eligible: false,
      reason: input.witnessMembershipActive ? "different_tenant" : "membership_inactive",
    };
  }
  return { eligible: true, isBreakGlass: input.witnessIsBreakGlass };
}

/**
 * Server-side throwing wrapper: runs {@link controlledSubstanceWitnessEligible} and throws
 * `AdministrationStateError` `CONTROLLED_WITNESS_NOT_ELIGIBLE` (HTTP 403) with the precise reason when the
 * witness is ineligible. On success returns `{ isBreakGlass }` so the route emits the warn audit event for a
 * break-glass witness (§2.6). Used by the administration write gate before the `administration_witness` insert.
 */
export function assertWitnessEligible(input: WitnessEligibilityInput): {
  readonly isBreakGlass: boolean;
} {
  const r = controlledSubstanceWitnessEligible(input);
  if (!r.eligible) {
    throw new AdministrationStateError(
      "CONTROLLED_WITNESS_NOT_ELIGIBLE",
      `the controlled-substance witness is not eligible: ${r.reason}`,
    );
  }
  return { isBreakGlass: r.isBreakGlass };
}
