// apps/backend/src/modules/14-idg/routes/packet-disclosure.ts — the W-SUD-01 caller verdict for the packet READ
// (§2.7 / §4.7 `sud_disclosure_allowed`, applied as a FILTER — the packet is still readable, the Part 2 content
// is elided). This is the SAME per-actor decision M7 / M15 / M30 resolve, over the SAME M39 primitive
// (`evaluateForInternalAccess`), with the SAME ordering: consent is consulted FIRST, and the RN-Case-Manager
// treatment carve-out (42 CFR §2.12(c)(3)) applies only when no release restricts disclosure to OTHER named
// workforce members — a role key never outranks a release the patient deliberately narrowed.
//
// M14's manifest `dependsOn` is [1, 7, 8, 36] — no M7/M39 import edge — so, exactly like M15's
// `disclosure.ts`, M39 is resolved lazily through the seam registry at CALL time and cast to the minimal
// structural shape M14 calls. FAIL-CLOSED: an unbound/erroring M39 (deny-stub) denies in BOTH fields.
import { getSeam } from "../../../bootstrap/index";

/** The M39 surface M14 calls — structural, so no `@wardenx/consent` import edge is taken. */
interface ConsentEvaluatorShape {
  evaluateForInternalAccess(args: {
    organizationId: string;
    patientId: string;
    actor: { membershipId: string | null };
    callerModule: string;
  }): Promise<{ redactSubstanceUseDisorderFields: boolean; basis: string }>;
}

export interface PacketPart2Verdict {
  readonly allowed: boolean;
  /** The patient's release names workforce members and this actor is not one — the RN-CM carve-out may not override. */
  readonly restrictedToNamedWorkforce: boolean;
}

/** The port the verdict resolves M39 through (injected in tests; the seam registry in prod). */
export interface PacketDisclosurePort {
  part2ReleaseActive(input: {
    organizationId: string;
    patientId: string;
    membershipId: string | null;
  }): Promise<PacketPart2Verdict>;
}

/** The production port — lazy `getSeam` per call, fail-CLOSED on any throw. */
export const seamPacketDisclosurePort: PacketDisclosurePort = {
  async part2ReleaseActive({ organizationId, patientId, membershipId }) {
    try {
      const evaluator = getSeam("ConsentEvaluator") as unknown as ConsentEvaluatorShape;
      const verdict = await evaluator.evaluateForInternalAccess({
        organizationId,
        patientId,
        actor: { membershipId },
        callerModule: "m14",
      });
      return {
        allowed: !verdict.redactSubstanceUseDisorderFields,
        restrictedToNamedWorkforce:
          verdict.basis === "release_names_others" || verdict.basis === "actor_unidentified",
      };
    } catch {
      return { allowed: false, restrictedToNamedWorkforce: true };
    }
  },
};

const RN_CASE_MANAGER_ROLE = "rn_case_manager";

/** May THIS caller see the patient's Part 2 packet content? (`true` ⇒ no redaction.) Never throws. */
export async function sudDisclosureAllowedForPacket(
  port: PacketDisclosurePort,
  caller: {
    readonly organizationId: string;
    readonly patientId: string;
    readonly membershipId: string | null;
    readonly roles: readonly string[];
  },
): Promise<boolean> {
  let verdict: PacketPart2Verdict;
  try {
    verdict = await port.part2ReleaseActive({
      organizationId: caller.organizationId,
      patientId: caller.patientId,
      membershipId: caller.membershipId,
    });
  } catch {
    return false;
  }
  if (verdict.allowed) return true;
  return !verdict.restrictedToNamedWorkforce && caller.roles.includes(RN_CASE_MANAGER_ROLE);
}
