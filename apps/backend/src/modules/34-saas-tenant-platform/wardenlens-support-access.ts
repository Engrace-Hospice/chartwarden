// M34-owned authorization adapter for a platform superadmin reading WardenLens evidence in a tenant.
// The M22 route receives only this narrow port: M34 remains the sole owner of support-session tables and
// the platform credential. The actual document read still runs through M22's tenant-pooled, RLS-scoped
// service after this adapter resolves the target organization.
import { auditPlatformEvent } from "@chartwarden/audit";
import { type DbClient, schema } from "@chartwarden/db";
import { SupportRepository } from "@chartwarden/saas-tenant-platform";
import { type PlatformBypassAuditor, withPlatformContext } from "@chartwarden/tenancy";
import { ForbiddenError } from "@chartwarden/types";
import { and, eq, gt, isNull } from "drizzle-orm";

const ACCESS_DENIED = "an active tenant-consented support session is required";

export interface WardenLensSupportAccessInput {
  readonly actorMembershipId: string;
  readonly organizationId: string;
  readonly supportSessionId: string;
}

export interface WardenLensSupportReadInput extends WardenLensSupportAccessInput {
  readonly patientId: string | null;
  readonly resourceKind: "intake_review_workspace" | "intake_page_image";
  readonly resourceId: string;
  readonly correlationId: string;
  readonly actorIp: string | null;
  readonly route: string;
  readonly pageNumber?: number;
}

/** The narrow M34 port M22 consumes; no support-session row or grant detail crosses the boundary. */
export interface WardenLensSupportAccess {
  /** Resolve the tenant only after verifying the actor owns an open PHI-capable support session. */
  resolveOrganization(input: WardenLensSupportAccessInput): Promise<string>;
  /** Re-verify patient scope and durably audit the read before M22 may disclose the response. */
  authorizeAndAuditRead(input: WardenLensSupportReadInput): Promise<string>;
}

export interface WardenLensSupportAccessDeps {
  readonly platformDb: DbClient;
  readonly auditBypass: PlatformBypassAuditor<DbClient>;
  readonly platformJobId: string;
  readonly now?: () => Date;
}

interface AccessFacts {
  readonly organizationId: string;
  readonly tenantAccountId: string;
  readonly supportConsentGrantId: string;
  readonly scope: "organization_scoped" | "patient_scoped" | "assist";
  readonly patientIdsInScope: readonly string[] | null;
}

async function accessFacts(
  tx: DbClient,
  input: WardenLensSupportAccessInput,
  now: Date,
): Promise<AccessFacts> {
  // Cross-tenant safeguard: organization_id = input.organizationId is enforced by the final
  // organizations.id predicate, then repeated across the tenant, session, and consent joins.
  const [row] = await tx
    .select({
      organizationId: schema.organizations.id,
      tenantAccountId: schema.tenantAccount.id,
      sessionGrantId: schema.supportSession.supportConsentGrantId,
      grantId: schema.supportConsentGrant.id,
      scope: schema.supportConsentGrant.scope,
      patientIdsInScope: schema.supportConsentGrant.patientIdsInScope,
    })
    .from(schema.organizations)
    .innerJoin(
      schema.tenantAccount,
      eq(schema.tenantAccount.organizationId, schema.organizations.id),
    )
    .innerJoin(
      schema.supportSession,
      and(
        eq(schema.supportSession.organizationId, schema.organizations.id),
        eq(schema.supportSession.id, input.supportSessionId),
        eq(schema.supportSession.actorMembershipId, input.actorMembershipId),
        isNull(schema.supportSession.closedAt),
        gt(schema.supportSession.expiresAt, now),
      ),
    )
    .innerJoin(
      schema.supportConsentGrant,
      and(
        eq(schema.supportConsentGrant.id, schema.supportSession.supportConsentGrantId),
        eq(schema.supportConsentGrant.organizationId, schema.organizations.id),
        eq(schema.supportConsentGrant.tenantAccountId, schema.tenantAccount.id),
        isNull(schema.supportConsentGrant.revokedAt),
        gt(schema.supportConsentGrant.expiresAt, now),
      ),
    )
    .where(eq(schema.organizations.id, input.organizationId))
    .limit(1);

  if (!row || row.scope === "assist" || row.sessionGrantId !== row.grantId) {
    throw new ForbiddenError(ACCESS_DENIED);
  }
  return {
    organizationId: row.organizationId,
    tenantAccountId: row.tenantAccountId,
    supportConsentGrantId: row.grantId,
    scope: row.scope,
    patientIdsInScope: row.patientIdsInScope,
  };
}

function assertPatientScope(facts: AccessFacts, patientId: string | null): void {
  if (facts.scope === "organization_scoped") return;
  if (!patientId || !facts.patientIdsInScope?.includes(patientId)) {
    throw new ForbiddenError(ACCESS_DENIED);
  }
}

/** Build the production adapter over the separately pooled, audited platform credential. */
export function createWardenLensSupportAccess(
  deps: WardenLensSupportAccessDeps,
): WardenLensSupportAccess {
  const now = deps.now ?? (() => new Date());
  const run = <T>(reason: string, fn: (tx: DbClient) => Promise<T>): Promise<T> =>
    withPlatformContext(
      deps.platformDb,
      { jobId: deps.platformJobId, reason, crossTenant: true },
      deps.auditBypass,
      fn,
    );

  return {
    async resolveOrganization(input) {
      return run("m34 WardenLens support read: resolve tenant", async (tx) => {
        const facts = await accessFacts(tx, input, now());
        return facts.organizationId;
      });
    },

    async authorizeAndAuditRead(input) {
      return run("m34 WardenLens support read: authorize and audit", async (tx) => {
        const at = now();
        const facts = await accessFacts(tx, input, at);
        assertPatientScope(facts, input.patientId);

        await new SupportRepository(tx).appendSessionEvent({
          organizationId: facts.organizationId,
          supportSessionId: input.supportSessionId,
          eventKind: "ops.read",
          resourceKind: input.resourceKind,
          resourceId: input.resourceId,
          patientId: input.patientId,
          occurredAt: at,
          actorIp: input.actorIp,
          context: {
            route: input.route,
            method: "GET",
            ...(input.pageNumber === undefined ? {} : { pageNumber: input.pageNumber }),
          },
        });
        await auditPlatformEvent(tx, {
          eventType: "support_session.wardenlens_read",
          resourceKind: input.resourceKind,
          resourceId: input.resourceId,
          outcome: "success",
          severity: "critical",
          correlationId: input.correlationId,
          context: {
            organizationId: facts.organizationId,
            tenantAccountId: facts.tenantAccountId,
            actorMembershipId: input.actorMembershipId,
            actorKind: "platform_ops_via_support_session",
            supportSessionId: input.supportSessionId,
            supportConsentGrantId: facts.supportConsentGrantId,
            authorizationBasis: "superadmin_support_session",
            ...(input.pageNumber === undefined ? {} : { pageNumber: input.pageNumber }),
          },
        });
        return facts.organizationId;
      });
    },
  };
}
