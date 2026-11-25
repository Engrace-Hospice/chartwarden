// M34-owned authorization adapter for a platform superadmin reading WardenLens evidence in a tenant.
// The M22 route receives only this narrow port: M34 remains the sole owner of support-session tables and
// the platform credential. The actual document read still runs through M22's tenant-pooled, RLS-scoped
// service after this adapter resolves the target organization.
import { auditPlatformEvent } from "@chartwarden/audit";
import { type DbClient, schema } from "@chartwarden/db";
import { SupportRepository } from "@chartwarden/saas-tenant-platform";
import { type PlatformBypassAuditor, withPlatformContext } from "@chartwarden/tenancy";
import { ConflictError, ForbiddenError, NotFoundError } from "@chartwarden/types";
import { and, eq, gt, isNull } from "drizzle-orm";

const ACCESS_DENIED = "an active tenant-consented support session is required";

export interface WardenLensSupportAccessInput {
  readonly actorMembershipId: string;
  readonly organizationId: string;
  readonly supportSessionId: string;
}

export interface WardenLensSupportReadInput extends WardenLensSupportAccessInput {
  readonly resourceKind: "intake_review_workspace" | "intake_page_image";
  readonly resourceId: string;
  readonly correlationId: string;
  readonly actorIp: string | null;
  readonly route: string;
  readonly pageNumber?: number;
}

/** The narrow M34 port M22 consumes; no support-session row or grant detail crosses the boundary. */
export interface WardenLensSupportAccess {
  /**
   * Hold the session and consent rows stable while M22 resolves patient scope and prepares the
   * disclosure, then append the support ledger and critical authorization audit.
   */
  runAuthorizedRead<T>(
    input: WardenLensSupportReadInput,
    resolvePatient: (organizationId: string) => Promise<string | null>,
    read: (
      organizationId: string,
      patientId: string | null,
      scope: "organization_scoped" | "patient_scoped",
    ) => Promise<T>,
  ): Promise<T>;
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
  /** An "assist" grant is non-PHI and is refused before facts are built. */
  readonly scope: "organization_scoped" | "patient_scoped";
  readonly patientIdsInScope: readonly string[] | null;
  readonly sessionExpiresAt: Date;
  readonly grantExpiresAt: Date;
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
      grantId: schema.supportConsentGrant.id,
      scope: schema.supportConsentGrant.scope,
      patientIdsInScope: schema.supportConsentGrant.patientIdsInScope,
      sessionExpiresAt: schema.supportSession.expiresAt,
      grantExpiresAt: schema.supportConsentGrant.expiresAt,
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
    .limit(1)
    // Lock only the session and grant rows: a row lock needs UPDATE privilege, which the platform role holds
    // (column-level) on these two tables but not on organization or tenant_account.
    .for("share", { of: [schema.supportSession, schema.supportConsentGrant] });

  // The join above already ties the grant to the session's own grant id.
  if (!row || row.scope === "assist") {
    throw new ForbiddenError(ACCESS_DENIED);
  }
  return {
    organizationId: row.organizationId,
    tenantAccountId: row.tenantAccountId,
    supportConsentGrantId: row.grantId,
    scope: row.scope,
    patientIdsInScope: row.patientIdsInScope,
    sessionExpiresAt: row.sessionExpiresAt,
    grantExpiresAt: row.grantExpiresAt,
  };
}

/** Why a read was refused, as recorded on the denial audit. */
type DenialReason =
  | "authorization_denied"
  | "content_scope_refused"
  | "target_not_found"
  | "target_conflict";

/** The denial reason for a refusal, or null for an error that is not a refusal. */
function denialReasonOf(error: unknown): DenialReason | null {
  if (error instanceof ForbiddenError) {
    // The session or grant does not authorize the read, or M22 refused the batch's content for the scope.
    return error.message === ACCESS_DENIED ? "authorization_denied" : "content_scope_refused";
  }
  if (error instanceof NotFoundError) return "target_not_found";
  if (error instanceof ConflictError) return "target_conflict";
  return null;
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

  // The authorization transaction rolls back on a refusal, taking its own audit rows with it, so a denied read
  // is recorded in a transaction of its own. Identifiers only; the requested organization is a client value.
  const recordDenial = (input: WardenLensSupportReadInput, reason: DenialReason): Promise<void> =>
    run("m34 WardenLens support read: record denial", (tx) =>
      auditPlatformEvent(tx, {
        eventType: "support_session.wardenlens_read_denied",
        resourceKind: input.resourceKind,
        resourceId: input.resourceId,
        outcome: "denied",
        severity: "warn",
        correlationId: input.correlationId,
        context: {
          requestedOrganizationId: input.organizationId,
          actorMembershipId: input.actorMembershipId,
          supportSessionId: input.supportSessionId,
          authorizationBasis: "superadmin_support_session",
          reason,
          ...(input.pageNumber === undefined ? {} : { pageNumber: input.pageNumber }),
        },
      }),
    );

  return {
    async runAuthorizedRead(input, resolvePatient, read) {
      try {
        return await authorizeAndRead(input, resolvePatient, read);
      } catch (error) {
        // If the denial record cannot be written the read is still refused; that failure surfaces as a 500.
        // An infrastructure error (a timeout, a pool failure) is not a refusal and is never recorded as one.
        const reason = denialReasonOf(error);
        if (reason) await recordDenial(input, reason);
        throw error;
      }
    },
  };

  function authorizeAndRead<T>(
    input: WardenLensSupportReadInput,
    resolvePatient: (organizationId: string) => Promise<string | null>,
    read: (
      organizationId: string,
      patientId: string | null,
      scope: "organization_scoped" | "patient_scoped",
    ) => Promise<T>,
  ): Promise<T> {
    return run("m34 WardenLens support read: authorize and audit", async (tx) => {
      const at = now();
      const facts = await accessFacts(tx, input, at);

      // accessFacts holds the session/grant rows FOR SHARE until this platform transaction ends.
      // Resolve patient scope inside the same locked authorization window, then prepare the read.
      let patientId: string | null;
      try {
        patientId = await resolvePatient(facts.organizationId);
      } catch (error) {
        // A patient-scoped session must not become a batch-existence oracle: an unknown batch and
        // an existing out-of-scope batch both fail with the same authorization response. Only the
        // not-found case is masked: any other failure (a timeout, a pool error) stays a server error.
        if (facts.scope === "patient_scoped" && error instanceof NotFoundError) {
          throw new ForbiddenError(ACCESS_DENIED);
        }
        throw error;
      }
      assertPatientScope(facts, patientId);
      const result = await read(facts.organizationId, patientId, facts.scope);
      const completedAt = now();
      if (
        facts.sessionExpiresAt.getTime() <= completedAt.getTime() ||
        facts.grantExpiresAt.getTime() <= completedAt.getTime()
      ) {
        throw new ForbiddenError(ACCESS_DENIED);
      }

      await new SupportRepository(tx).appendSessionEvent({
        organizationId: facts.organizationId,
        supportSessionId: input.supportSessionId,
        eventKind: "ops.read",
        resourceKind: input.resourceKind,
        resourceId: input.resourceId,
        patientId,
        occurredAt: completedAt,
        actorIp: input.actorIp,
        context: {
          route: input.route,
          method: "GET",
          disclosureState: "prepared_before_response",
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
          actorKind: "superadmin_via_support_session",
          supportSessionId: input.supportSessionId,
          supportConsentGrantId: facts.supportConsentGrantId,
          authorizationBasis: "superadmin_support_session",
          disclosureState: "prepared_before_response",
          patientId,
          ...(input.pageNumber === undefined ? {} : { pageNumber: input.pageNumber }),
        },
      });
      const returnAt = now();
      if (
        facts.sessionExpiresAt.getTime() <= returnAt.getTime() ||
        facts.grantExpiresAt.getTime() <= returnAt.getTime()
      ) {
        // The platform transaction rolls both preparation audit records back if authority expires
        // during their writes; no prepared PHI is returned outside the authorized time window.
        throw new ForbiddenError(ACCESS_DENIED);
      }
      return result;
    });
  }
}
