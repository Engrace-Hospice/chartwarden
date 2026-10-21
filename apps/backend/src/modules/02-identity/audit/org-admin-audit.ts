// apps/backend/src/modules/02-identity/audit/org-admin-audit.ts — audit events for the M2 org-admin surface
// (GAP-115): organization / provider-entity / location management, the tenant step-up override registry, and
// the funeral-home link. Every one goes through the mandated @chartwarden/audit `audit()` helper (the PHI field
// denylist runs there) at `compliance` retention. NO tax id, no address line, no token ever enters a payload —
// field NAMES that changed, never their values (a changed `taxId` is recorded as the word "taxId").
import { type AuditContext, type AuditExecutor, audit } from "@chartwarden/audit";

export const ORG_ADMIN_AUDIT_EVENTS = {
  organizationCreated: "m2.organization.created",
  organizationUpdated: "m2.organization.updated",
  providerEntityCreated: "m2.provider_entity.created",
  providerEntityUpdated: "m2.provider_entity.updated",
  locationCreated: "m2.location.created",
  locationUpdated: "m2.location.updated",
  stepUpOverrideConfigured: "m2.session.step_up_policy_override.configured",
  stepUpOverrideRemoved: "m2.session.step_up_policy_override.removed",
  funeralInvited: "m2.funeral.invited",
} as const;

type AdminEvent = (typeof ORG_ADMIN_AUDIT_EVENTS)[keyof typeof ORG_ADMIN_AUDIT_EVENTS];

async function record(
  tx: AuditExecutor,
  ctx: AuditContext,
  eventType: AdminEvent,
  resourceKind: string,
  resourceId: string,
  context: Record<string, unknown>,
): Promise<void> {
  await audit(tx, ctx, {
    eventType,
    resourceKind,
    resourceId,
    outcome: "success",
    retentionClass: "compliance",
    context,
  });
}

export const auditOrganizationCreated = (tx: AuditExecutor, ctx: AuditContext, orgId: string) =>
  record(tx, ctx, ORG_ADMIN_AUDIT_EVENTS.organizationCreated, "organization", orgId, {});

export const auditOrganizationUpdated = (
  tx: AuditExecutor,
  ctx: AuditContext,
  orgId: string,
  changedFields: readonly string[],
) =>
  record(tx, ctx, ORG_ADMIN_AUDIT_EVENTS.organizationUpdated, "organization", orgId, {
    changedFields: [...changedFields],
  });

export const auditProviderEntityCreated = (
  tx: AuditExecutor,
  ctx: AuditContext,
  input: { organizationId: string; providerEntityId: string },
) =>
  record(
    tx,
    ctx,
    ORG_ADMIN_AUDIT_EVENTS.providerEntityCreated,
    "provider_entity",
    input.providerEntityId,
    { organizationId: input.organizationId },
  );

export const auditProviderEntityUpdated = (
  tx: AuditExecutor,
  ctx: AuditContext,
  input: { organizationId: string; providerEntityId: string; changedFields: readonly string[] },
) =>
  record(
    tx,
    ctx,
    ORG_ADMIN_AUDIT_EVENTS.providerEntityUpdated,
    "provider_entity",
    input.providerEntityId,
    { organizationId: input.organizationId, changedFields: [...input.changedFields] },
  );

export const auditLocationCreated = (
  tx: AuditExecutor,
  ctx: AuditContext,
  input: { organizationId: string; locationId: string; providerEntityId: string },
) =>
  record(tx, ctx, ORG_ADMIN_AUDIT_EVENTS.locationCreated, "location", input.locationId, {
    organizationId: input.organizationId,
    providerEntityId: input.providerEntityId,
  });

export const auditLocationUpdated = (
  tx: AuditExecutor,
  ctx: AuditContext,
  input: { organizationId: string; locationId: string; changedFields: readonly string[] },
) =>
  record(tx, ctx, ORG_ADMIN_AUDIT_EVENTS.locationUpdated, "location", input.locationId, {
    organizationId: input.organizationId,
    changedFields: [...input.changedFields],
  });

export const auditStepUpOverrideConfigured = (
  tx: AuditExecutor,
  ctx: AuditContext,
  input: {
    organizationId: string;
    operationKey: string;
    qualifyingFactors: readonly string[];
    maxAgeSec: number;
    configuredByMembershipId: string;
  },
) =>
  record(
    tx,
    ctx,
    ORG_ADMIN_AUDIT_EVENTS.stepUpOverrideConfigured,
    "step_up_policy_override",
    `${input.organizationId}:${input.operationKey}`,
    {
      organizationId: input.organizationId,
      operationKey: input.operationKey,
      qualifyingFactors: [...input.qualifyingFactors],
      maxAgeSec: input.maxAgeSec,
      configuredByMembershipId: input.configuredByMembershipId,
    },
  );

export const auditStepUpOverrideRemoved = (
  tx: AuditExecutor,
  ctx: AuditContext,
  input: { organizationId: string; operationKey: string },
) =>
  record(
    tx,
    ctx,
    ORG_ADMIN_AUDIT_EVENTS.stepUpOverrideRemoved,
    "step_up_policy_override",
    `${input.organizationId}:${input.operationKey}`,
    { organizationId: input.organizationId, operationKey: input.operationKey },
  );

export const auditFuneralInvited = (
  tx: AuditExecutor,
  ctx: AuditContext,
  input: { linkId: string; organizationId: string; patientId: string },
) =>
  record(tx, ctx, ORG_ADMIN_AUDIT_EVENTS.funeralInvited, "funeral_link", input.linkId, {
    organizationId: input.organizationId,
    patientId: input.patientId,
  });
