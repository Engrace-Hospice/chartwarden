// apps/backend/src/modules/02-identity/audit/device-attestation-audit.ts — M2, SecHardening §12.4.
//
// The three device-attestation audit events, emitted through the mandated `audit()` surface rather than
// a direct `audit_event` insert, so each one runs through the PHI field denylist and lands under the
// right retention class (`compliance`, per the M2 catalog).
//
// WHAT IS DELIBERATELY NOT IN THE CONTEXT. The verifier's `reason` is a CATEGORY
// (`device_compromised`, `assertion_signature_invalid`, `os_version_below_floor`) and that category is
// what gets recorded. The detector's own wording never reaches here — the same reasoning that denylists
// `device_attestation.failure_reason`: a precise account of what the platform looks for, filed in a
// table many roles can read, is a map for whoever wants to avoid being looked for.
import { type AuditContext, type AuditExecutor, audit } from "@chartwarden/audit";

/** The three device-attestation audit event types. */
export const DEVICE_ATTESTATION_AUDIT_EVENTS = {
  attested: "m2.device.attested",
  failed: "m2.device.attestation_failed",
  revoked: "m2.device.attestation_revoked",
} as const;

const RESOURCE_KIND = "device_attestation";

/** Record a device that passed the §12.2/§12.4 check and now backs the session. */
export async function auditDeviceAttested(
  tx: AuditExecutor,
  ctx: AuditContext,
  input: { attestationId: string; provider: string; platform: string; expiresAt: string },
): Promise<void> {
  await audit(tx, ctx, {
    eventType: DEVICE_ATTESTATION_AUDIT_EVENTS.attested,
    resourceKind: RESOURCE_KIND,
    resourceId: input.attestationId,
    outcome: "success",
    retentionClass: "compliance",
    context: {
      provider: input.provider,
      platform: input.platform,
      expiresAt: input.expiresAt,
    },
  });
}

/** Record a device that failed. `reason` is the verifier's category, never the detector's wording. */
export async function auditDeviceAttestationFailed(
  tx: AuditExecutor,
  ctx: AuditContext,
  input: { attestationId: string; provider: string; platform: string; reason: string },
): Promise<void> {
  await audit(tx, ctx, {
    eventType: DEVICE_ATTESTATION_AUDIT_EVENTS.failed,
    resourceKind: RESOURCE_KIND,
    resourceId: input.attestationId,
    outcome: "failure",
    retentionClass: "compliance",
    context: { provider: input.provider, platform: input.platform, reason: input.reason },
  });
}

/** Record an administrator taking a device out of service. */
export async function auditDeviceAttestationRevoked(
  tx: AuditExecutor,
  ctx: AuditContext,
  input: { attestationId: string; membershipId: string },
): Promise<void> {
  await audit(tx, ctx, {
    eventType: DEVICE_ATTESTATION_AUDIT_EVENTS.revoked,
    resourceKind: RESOURCE_KIND,
    resourceId: input.attestationId,
    outcome: "success",
    retentionClass: "compliance",
    context: { membershipId: input.membershipId },
  });
}
