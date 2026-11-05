// apps/backend/src/modules/34-saas-tenant-platform/routes/platform/onboarding-data-audit.ts — the audit row every
// platform onboarding-data call leaves. It names the OPERATOR (the actor), the TARGET org (the row's own organization,
// so the tenant's auditors see it in their trail) and the operator's recorded reason, plus WHAT was done to which
// resource. It carries field NAMES only: no EIN, no secret, no address value ever enters the payload.
//
// Written on the SAME transaction as the business write (`audit()` is the only sanctioned writer of audit_event), so
// the row commits or rolls back with the change it records.
import { type AuditContext, type AuditExecutor, audit } from "@chartwarden/audit";

/** The platform operator making the call. Every field is server-assembled from the session, never from a body. */
export interface OnboardingOperator {
  readonly userId: string;
  readonly membershipId: string;
  /** The operator's HOME org (the platform org) — recorded on the audit row beside the target. */
  readonly organizationId: string;
  readonly roles: readonly string[];
  readonly stepUpRecent: boolean;
  readonly request: {
    readonly correlationId: string;
    readonly requestId?: string;
    readonly sourceIp?: string;
    readonly userAgent?: string;
    /** `METHOD /route/template` (the matched route, never the concrete URL), recorded on the audit row. */
    readonly route?: string;
  };
}

export const ONBOARDING_DATA_AUDIT_EVENTS = {
  providerEntityCreated: "m34.tenant_onboarding.provider_entity_created",
  providerEntityUpdated: "m34.tenant_onboarding.provider_entity_updated",
  locationCreated: "m34.tenant_onboarding.location_created",
  locationUpdated: "m34.tenant_onboarding.location_updated",
  macCredentialUpserted: "m34.tenant_onboarding.mac_credential_upserted",
  medicaidCredentialUpserted: "m34.tenant_onboarding.medicaid_credential_upserted",
  dataRead: "m34.tenant_onboarding.data_read",
  /** The tenant is not provisioning/onboarding: the write was refused before it ran. */
  writeRefused: "m34.tenant_onboarding.write_refused",
  /** The write ran into the tenant's own rules (404, 422, 409, 412/428) or a 5xx and rolled back. */
  writeFailed: "m34.tenant_onboarding.write_failed",
} as const;

export type OnboardingAuditEvent =
  (typeof ONBOARDING_DATA_AUDIT_EVENTS)[keyof typeof ONBOARDING_DATA_AUDIT_EVENTS];

export interface OnboardingAuditTarget {
  readonly organizationId: string;
  readonly orgSlug: string;
}

export interface OnboardingAuditInput {
  readonly eventType: OnboardingAuditEvent;
  readonly resourceKind: string;
  readonly resourceId?: string;
  readonly outcome: "success" | "denied";
  /** Null only on a read (the reason is a write-time attestation). */
  readonly reason: string | null;
  readonly changedFields?: readonly string[];
  /** Extra non-sensitive facts (counts, the tenant status a refusal saw, the error code of a failed attempt). */
  readonly detail?: Readonly<Record<string, string | number | boolean>>;
}

/** The operator's platform role as recorded on the row (the `tenant_lifecycle_platform_ops` predicate admits only this). */
const OPERATOR_ROLE = "platform_ops";

const contextOf = (op: OnboardingOperator, target: OnboardingAuditTarget): AuditContext => ({
  organizationId: target.organizationId,
  userId: op.userId,
  actorKind: "user",
  actorRole: OPERATOR_ROLE,
  correlationId: op.request.correlationId ?? op.request.requestId ?? "",
  ...(op.request.requestId ? { requestId: op.request.requestId } : {}),
  ...(op.request.sourceIp ? { sourceIp: op.request.sourceIp } : {}),
  ...(op.request.userAgent ? { userAgent: op.request.userAgent } : {}),
});

export function recordOnboardingAudit(
  tx: AuditExecutor,
  op: OnboardingOperator,
  target: OnboardingAuditTarget,
  input: OnboardingAuditInput,
): Promise<void> {
  return audit(tx, contextOf(op, target), {
    eventType: input.eventType,
    resourceKind: input.resourceKind,
    ...(input.resourceId ? { resourceId: input.resourceId } : {}),
    outcome: input.outcome,
    // A platform operator changing another tenant's records is always worth surfacing.
    severity: input.eventType === ONBOARDING_DATA_AUDIT_EVENTS.dataRead ? "info" : "warn",
    retentionClass: "compliance",
    context: {
      targetOrganizationId: target.organizationId,
      targetOrgSlug: target.orgSlug,
      operatorUserId: op.userId,
      operatorMembershipId: op.membershipId,
      operatorOrganizationId: op.organizationId,
      reason: input.reason,
      ...(op.request.route ? { route: op.request.route } : {}),
      ...(input.changedFields ? { changedFields: [...input.changedFields] } : {}),
      ...(input.detail ?? {}),
    },
  });
}
