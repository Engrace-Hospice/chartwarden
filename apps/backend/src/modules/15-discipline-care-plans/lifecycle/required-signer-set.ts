import { requiredSignersFor } from "@wardenx/discipline-plans";
// apps/backend/src/modules/15-discipline-care-plans/lifecycle/required-signer-set.ts — M15-T03 (§2.3 / D11).
//
// The pure quorum core for `discipline_care_plan_version` sign-off. The §3.5 D11 per-kind sets are pure
// data in `@wardenx/discipline-plans` (`requiredSignersFor`); this module decides whether a collected set
// of signer roles satisfies the quorum the version SEALED at `in_review` — §2.3 is explicit that the
// evaluation runs against `state_snapshot.required_signer_set`, not against today's constants, so a
// mid-admission policy change can never retroactively unsign (or re-open) a signed version.
//
// The CHHA slot is an ACKNOWLEDGMENT, not a cosignature (CoP 418.76): it still fills a quorum slot, but
// the `isAcknowledgment` flag rides through to the signature row and the §2.4 `version_signed` payload so
// M22's PDF and a surveyor read it as "acknowledged", never as co-authorship.
import type {
  DisciplinePlanKind,
  DisciplinePlanVersionKind,
  DisciplineRequiredSigner,
  DisciplineRequiredSignerSet,
  DisciplineSignerRole,
} from "@wardenx/types";
import { require_ } from "./errors";

/** §3.5 / D11 — the floor quorum for a (plan kind × version kind). Re-exported so the machines have one door. */
export function resolveRequiredSignerSet(
  kind: DisciplinePlanKind,
  versionKind: DisciplinePlanVersionKind,
): DisciplineRequiredSignerSet {
  return requiredSignersFor(kind, versionKind);
}

/** Whether `role` fills a single slot. M15's D11 sets use exact roles (no `|`-union slots as in M7 D5). */
export function roleSatisfiesSlot(
  slot: DisciplineRequiredSigner,
  role: DisciplineSignerRole,
): boolean {
  return slot.role === role;
}

/**
 * Greedy consume-once match of collected `signedRoles` against the quorum's slots: each signature counts
 * toward at most one slot, so a repeat of the same role never double-fills a `count: 2` slot it did not
 * earn. Returns the number of slots still unmet.
 */
function unmetSlotCount(
  set: DisciplineRequiredSignerSet,
  signedRoles: ReadonlyArray<DisciplineSignerRole>,
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

/** Whether the collected `signedRoles` fully satisfy the sealed `set` (every required slot filled). */
export function isQuorumMet(
  set: DisciplineRequiredSignerSet,
  signedRoles: ReadonlyArray<DisciplineSignerRole>,
): boolean {
  return unmetSlotCount(set, signedRoles) === 0;
}

/** The pure decision a single incoming signature produces against the current state of a version. */
export interface DisciplineSignatureDecision {
  /** Whether this signature was the last required one — the version transitions to `signed`. */
  readonly quorumMet: boolean;
  /** True when the slot this signature filled is the CoP 418.76 CHHA acknowledgment (§3.5 D11). */
  readonly isAcknowledgment: boolean;
}

/**
 * Validate and apply a single incoming signature against the version's SEALED quorum (§2.3). Throws:
 *   - `SIGNER_ROLE_MISMATCH` (403) when `role` matches no slot in the sealed set,
 *   - `DUPLICATE_SIGNER_ROLE` (409) when `role` cannot fill any still-unmet slot (already collected),
 * else reports whether the quorum is now complete. Pure — `alreadySigned` is resolved by the caller.
 */
export function decideRecordSignature(
  set: DisciplineRequiredSignerSet,
  alreadySigned: ReadonlyArray<DisciplineSignerRole>,
  role: DisciplineSignerRole,
): DisciplineSignatureDecision {
  const slot = set.find((s) => roleSatisfiesSlot(s, role));
  require_(
    slot !== undefined,
    "SIGNER_ROLE_MISMATCH",
    `signer role '${role}' is not part of this version's sealed required-signer set`,
  );
  // The incoming signature must reduce the unmet-slot count — otherwise its slot is already filled and a
  // duplicate adds nothing to quorum (refused so survey reconstruction of who signed what stays clean).
  const before = unmetSlotCount(set, alreadySigned);
  const after = unmetSlotCount(set, [...alreadySigned, role]);
  require_(
    after < before,
    "DUPLICATE_SIGNER_ROLE",
    `signer role '${role}' does not fill an outstanding slot in the required-signer set`,
  );
  return { quorumMet: after === 0, isAcknowledgment: slot!.isAcknowledgment };
}

/**
 * §2.3 — the sign-time assertion behind the `INSUFFICIENT_SIGNERS` (412) code: a version may only leave
 * `in_review` when every sealed slot is filled. The machines call `decideRecordSignature` per signature;
 * this is the explicit whole-set check the finalize/sign route re-runs before it commits the transition.
 */
export function checkQuorumSatisfied(
  set: DisciplineRequiredSignerSet,
  signedRoles: ReadonlyArray<DisciplineSignerRole>,
): void {
  require_(
    isQuorumMet(set, signedRoles),
    "INSUFFICIENT_SIGNERS",
    "the version's sealed required-signer set is not yet satisfied",
  );
}
