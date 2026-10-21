// apps/backend/src/modules/07-care-plan/lifecycle/required-signer-set.ts — M7-T03 (§2.3 / D5).
//
// The pure quorum core for `care_plan_version` sign-off. The §11 D5 `RequiredSignerSet` constants live
// in @chartwarden/types (leaf contract, shared with consumers); this module resolves which set applies to a
// version `kind`, decides whether a collected set of signer roles satisfies the quorum, and validates a
// single incoming signature against the unmet slots (the `signer_role_match` rule, §6 / §2.3). All pure
// and deterministic — the service layer (M7-T05) composes these inside the version aggregate's
// optimistic-locked transaction; the route's ABAC predicate `signer_role_match` is the same check at
// the edge (D — checked at sign-attempt time, not route load).
import {
  type CarePlanSignerRole,
  type CarePlanVersionKind,
  REQUIRED_SIGNER_SET_IDG_REVIEW,
  REQUIRED_SIGNER_SET_INITIAL,
  type RequiredSignerSet,
  type RequiredSignerSlot,
} from "@chartwarden/types";
import { require_ } from "./errors";

/**
 * The §11 D5 floor quorum for a version `kind`. `initial`, `interim_revision` and `discharge` all use
 * the INITIAL quorum (attending physician/NP + RN case manager — the §418.56(b)(1) authoring pair);
 * `idg_review` uses the full IDG quorum (RN + MSW + chaplain + MD/DO). Tenants may *tighten* (supply
 * extra slots) but never loosen below this floor — enforced where the override is applied (M7-T05).
 */
export function resolveRequiredSignerSet(kind: CarePlanVersionKind): RequiredSignerSet {
  return kind === "idg_review" ? REQUIRED_SIGNER_SET_IDG_REVIEW : REQUIRED_SIGNER_SET_INITIAL;
}

/** Whether `role` satisfies a single slot — a `|`-joined slot role is an either-of union (§11 D5). */
export function roleSatisfiesSlot(slot: RequiredSignerSlot, role: CarePlanSignerRole): boolean {
  return slot.role.split("|").includes(role);
}

/**
 * Greedy consume-once match of collected `signedRoles` against the quorum's slots: each signature is
 * counted toward at most one slot, so a role that could satisfy two slots (via a union) never
 * double-counts. Returns the count of slots still unmet.
 */
function unmetSlotCount(
  set: RequiredSignerSet,
  signedRoles: ReadonlyArray<CarePlanSignerRole>,
): number {
  const remaining = [...signedRoles];
  let unmet = 0;
  for (const slot of set) {
    let need = slot.count;
    for (let i = remaining.length - 1; i >= 0 && need > 0; i--) {
      if (roleSatisfiesSlot(slot, remaining[i]!)) {
        remaining.splice(i, 1);
        need--;
      }
    }
    if (need > 0) unmet += need;
  }
  return unmet;
}

/** Whether the collected `signedRoles` fully satisfy the `set` (every required slot filled). */
export function isQuorumMet(
  set: RequiredSignerSet,
  signedRoles: ReadonlyArray<CarePlanSignerRole>,
): boolean {
  return unmetSlotCount(set, signedRoles) === 0;
}

/** The pure decision a single incoming signature produces against the current state of a version. */
export interface SignatureDecision {
  /** Whether this signature was the last required one — the version transitions to `signed`. */
  readonly quorumMet: boolean;
}

/**
 * Validate and apply a single incoming signature (§2.3 "Required Signer Set met before signed" +
 * `signer_role_match`). Throws:
 *   - `SIGNER_ROLE_MISMATCH` (403) when `role` matches no slot in the version's set,
 *   - `DUPLICATE_SIGNER_ROLE` (409) when `role` cannot fill any *still-unmet* slot (already collected),
 * else returns whether the quorum is now complete. Pure — `alreadySigned` is resolved by the caller.
 */
export function decideRecordSignature(
  set: RequiredSignerSet,
  alreadySigned: ReadonlyArray<CarePlanSignerRole>,
  role: CarePlanSignerRole,
): SignatureDecision {
  require_(
    set.some((slot) => roleSatisfiesSlot(slot, role)),
    "SIGNER_ROLE_MISMATCH",
    `signer role '${role}' is not part of this version's Required Signer Set`,
  );
  // The incoming signature must reduce the number of unmet slots — otherwise the role's slot is already
  // filled (a duplicate signer adds nothing to quorum and is rejected so survey reconstruction is clean).
  const before = unmetSlotCount(set, alreadySigned);
  const after = unmetSlotCount(set, [...alreadySigned, role]);
  require_(
    after < before,
    "DUPLICATE_SIGNER_ROLE",
    `signer role '${role}' does not fill an outstanding slot in the Required Signer Set`,
  );
  return { quorumMet: after === 0 };
}

/** The signer roles a signature may be captured under — the M3 role key IS the signer role (GAP-011). */
const KNOWN_SIGNER_ROLES: ReadonlySet<string> = new Set<CarePlanSignerRole>([
  "rn_case_manager",
  "hospice_physician",
  "nurse_practitioner",
  "msw",
  "chaplain",
  "medical_director",
]);

/**
 * GAP-011 — the claimed `signerRole` is a BODY field; it is only a valid attestation if the AUTHENTICATED
 * actor holds that role. Without this the `signer_role_match` edge predicate (which passes when the caller
 * holds ANY slot's role) let a one-role user stamp whichever seat they liked. Mirrors M15's GAP-045.
 */
export function assertActorHoldsSignerRole(
  actorRoles: ReadonlyArray<string>,
  signerRole: CarePlanSignerRole,
): void {
  require_(
    actorRoles.includes(signerRole),
    "SIGNER_ROLE_MISMATCH",
    "the caller does not hold the requested signer role",
  );
}

/** GAP-011 — one membership fills at most ONE slot per version, so one person can never fill a quorum. */
export function assertMembershipNotAlreadySigned(
  signedMembershipIds: ReadonlyArray<string | null>,
  membershipId: string,
): void {
  require_(
    !signedMembershipIds.includes(membershipId),
    "SIGNER_ALREADY_SIGNED",
    "this membership has already signed a slot of this version",
  );
}

/**
 * GAP-012 — a caller may TIGHTEN the floor quorum but never loosen it (§11 D5). Comparing array LENGTH
 * (the old check) let `[rn_case_manager, chaplain]` replace `[physician|NP, rn_case_manager]`: same
 * length, physician seat gone. The requested set must COVER every floor slot — each floor slot is matched
 * to a distinct requested slot whose roles are a non-empty subset of the floor slot's roles and whose count
 * is at least the floor's — and every requested role must be a known signer role. Extra slots are the
 * tightening. Returns the set to store (the requested one) or throws REQUIRED_SIGNER_SET_UNMET.
 */
export function resolveTightenedSignerSet(
  floor: RequiredSignerSet,
  requested: RequiredSignerSet,
): RequiredSignerSet {
  for (const slot of requested) {
    const tokens = slot.role.split("|");
    require_(
      tokens.every((t) => KNOWN_SIGNER_ROLES.has(t)) && slot.count >= 1,
      "REQUIRED_SIGNER_SET_UNMET",
      "the Required Signer Set names an unknown signer role or a zero count",
    );
  }
  const used = new Set<number>();
  for (const floorSlot of floor) {
    const floorRoles = new Set(floorSlot.role.split("|"));
    const index = requested.findIndex(
      (slot, i) =>
        !used.has(i) &&
        slot.count >= floorSlot.count &&
        slot.role.split("|").every((t) => floorRoles.has(t)),
    );
    require_(
      index >= 0,
      "REQUIRED_SIGNER_SET_UNMET",
      `the Required Signer Set may not loosen the floor quorum (missing '${floorSlot.role}')`,
    );
    used.add(index);
  }
  return requested;
}
