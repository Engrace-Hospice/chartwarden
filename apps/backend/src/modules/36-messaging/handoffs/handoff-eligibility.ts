// apps/backend/src/modules/36-messaging/handoffs/handoff-eligibility.ts - WP 3.5: who may RECEIVE a handoff (ADR-0062 D11).
//
// A handoff discloses a patient's identity ("First L." + MRN suffix) and the status of open work to a named colleague. It
// is NOT chart access, so the recipient may be off the sender's caseload (that is the point of covering a shift) and the
// owning module's caseload ABAC is deliberately not applied to them. What is checked instead, at offer AND at accept: the
// recipient is a different, active messaging user, holds the three messaging/patient read-send permissions, and passes the
// 42 CFR Part 2 gate for EVERY patient involved. Any failure - including a gate or permission lookup that throws - is the
// same answer: not eligible. The caller turns that into one uniform 422 that names no reason.
import type { Part2ChannelGate } from "../part2-channel-gate";

export const HANDOFF_RECIPIENT_PERMISSIONS = [
  "messaging.read",
  "messaging.send",
  "patient.read",
] as const;

export interface EligibilityPorts {
  permissionsFor(orgId: string, userId: string): Promise<ReadonlySet<string>>;
  isActiveUser(orgId: string, userId: string): Promise<boolean>;
  part2Gate: Part2ChannelGate;
}

/** True only when the Part 2 gate admits `userId` for every patient. A gate that throws admits nobody. */
export async function gateAdmits(
  gate: Part2ChannelGate,
  orgId: string,
  userId: string,
  patientIds: readonly string[],
): Promise<boolean> {
  try {
    for (const patientId of new Set(patientIds)) {
      const allowed = await gate.allowedUserIds({
        organizationId: orgId,
        patientId,
        userIds: [userId],
      });
      if (!allowed.has(userId)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

export async function recipientEligible(
  ports: EligibilityPorts,
  orgId: string,
  userId: string,
  patientIds: readonly string[],
): Promise<boolean> {
  try {
    if (!(await ports.isActiveUser(orgId, userId))) return false;
    const permissions = await ports.permissionsFor(orgId, userId);
    if (!HANDOFF_RECIPIENT_PERMISSIONS.every((p) => permissions.has(p))) return false;
  } catch {
    return false;
  }
  return gateAdmits(ports.part2Gate, orgId, userId, patientIds);
}
