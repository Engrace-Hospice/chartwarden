// apps/backend/src/modules/34-saas-tenant-platform/routes/platform/onboarding-data-service.ts — a platform operator
// fills in a tenant's onboarding data on its behalf: provider entities (CCN / NPI / EIN), service locations and the MAC
// submitter credential.
//
// THE TENANT'S OWN LOGIC, THE TENANT'S OWN RLS. Nothing here re-implements a validation, a seal or a row write. The
// provider-entity and location writes are M2's `org-admin-site-service` (the functions the tenant's own admin routes
// call), the credential write is M23's own write service behind the bootstrap `OnboardingCredentialPort`. Each runs
// on the TENANT POOL (the real NOBYPASSRLS `chartwarden_app` role) inside `withOrgContext` for the TARGET org, so
// Postgres RLS scopes every statement to that tenant exactly as if its own administrator had made the call, and the
// M4 write-audit trigger attributes each row to the OPERATOR (`app.user_id`), not to a NULL actor.
//
// ONE TRANSACTION. The tenant-status check, the write and the audit row share one transaction, so a refused or
// failed write leaves no row and a successful one cannot be un-audited. A write that FAILS (404, 422, 409, 412/428, 5xx)
// rolls its own audit row back with it, so its attempt is recorded afterwards as a `denied` `write_failed` row in a
// small follow-up transaction (best effort, logged when it cannot be written; the original error is what the caller sees).
//
// LOCKED ONCE ACTIVE. A write is accepted only while `tenant_account.status` is `provisioning` or `onboarding`
// (the tenant's own RLS lets the app role read its own row). Any other status answers 409 `TENANT_NOT_ONBOARDING`
// and the refusal itself is audited. The app role holds no UPDATE on `tenant_account`, so `FOR SHARE` is unavailable;
// instead every write takes the SHARED advisory lock `tenant-onboarding:<org id>` BEFORE it reads the status
// (`tenant-onboarding-lock.ts`), and the activation sweep and `transitionStatus` take it EXCLUSIVE: an activation
// waits for in-flight writes to commit, and a write that starts after it sees `active` (409).
import { type DbClient, schema } from "@chartwarden/db";
import {
  type PlatformBypassAuditor,
  withOrgContext,
  withPlatformContext,
} from "@chartwarden/tenancy";
import { ChartWardenError, NotFoundError } from "@chartwarden/types";
import { eq } from "drizzle-orm";
import type {
  OnboardingCredentialPort,
  OnboardingWriteScope,
} from "../../../../bootstrap/onboarding-credential-port";
import { createDrizzleSiteAdminRepository } from "../../../../bootstrap/site-admin-repository";
import {
  type SiteWriteDeps,
  type TaxIdCipherPort,
  createLocationForOrg,
  createProviderEntityForOrg,
  updateLocationForOrg,
  updateProviderEntityForOrg,
} from "../../../02-identity/org-admin-site-service";
import {
  ONBOARDING_DATA_AUDIT_EVENTS as EVENTS,
  type OnboardingAuditEvent,
  type OnboardingAuditTarget,
  type OnboardingOperator,
  recordOnboardingAudit,
} from "./onboarding-data-audit";
import { ONBOARDING_WRITABLE_STATUSES, lockTenantOnboardingShared } from "./tenant-onboarding-lock";

export type { OnboardingOperator } from "./onboarding-data-audit";

/** A body field set with the platform `reason` already removed, ready for the tenant's own validators. */
export type OnboardingFields = Readonly<Record<string, unknown>>;

export interface OnboardingDataService {
  listProviderEntities(op: OnboardingOperator, orgSlug: string): Promise<{ items: unknown[] }>;
  createProviderEntity(
    op: OnboardingOperator,
    orgSlug: string,
    fields: OnboardingFields,
    reason: string,
  ): Promise<unknown>;
  updateProviderEntity(
    op: OnboardingOperator,
    orgSlug: string,
    id: string,
    fields: OnboardingFields,
    reason: string,
  ): Promise<unknown>;
  listLocations(op: OnboardingOperator, orgSlug: string): Promise<{ items: unknown[] }>;
  createLocation(
    op: OnboardingOperator,
    orgSlug: string,
    fields: OnboardingFields,
    reason: string,
  ): Promise<unknown>;
  updateLocation(
    op: OnboardingOperator,
    orgSlug: string,
    id: string,
    fields: OnboardingFields,
    reason: string,
  ): Promise<unknown>;
  listMacCredentials(op: OnboardingOperator, orgSlug: string): Promise<{ items: unknown[] }>;
  upsertMacCredential(
    op: OnboardingOperator,
    orgSlug: string,
    fields: OnboardingFields & { providerEntityId: string },
    reason: string,
    expectedVersion: number | undefined,
  ): Promise<unknown>;
  listMedicaidCredentials(op: OnboardingOperator, orgSlug: string): Promise<{ items: unknown[] }>;
  upsertMedicaidCredential(
    op: OnboardingOperator,
    orgSlug: string,
    fields: OnboardingFields & { providerEntityId: string },
    reason: string,
  ): Promise<unknown>;
}

/** The organization behind a tenant slug, or null. A slug lookup spans tenants, so it needs the platform credential. */
export type OnboardingTenantResolver = (
  orgSlug: string,
) => Promise<{ organizationId: string } | null>;

export interface OnboardingDataDeps {
  /** The TENANT pool (NOBYPASSRLS): the write must be bound by the target org's RLS, never bypass it. */
  readonly db: DbClient;
  /** Slug -> organization on the audited platform credential; absent => every call answers 503 (never a tenant-pool guess). */
  readonly resolveTenant?: OnboardingTenantResolver;
  /** Unbound -> creating a provider entity answers 503 TAX_ID_CIPHER_UNBOUND (an EIN is never stored in the clear). */
  readonly taxIdCipher?: TaxIdCipherPort;
  /** M23's MAC credential adapter; unbound -> the MAC credential routes answer 503. */
  readonly macCredentials?: OnboardingCredentialPort;
  /** M24's state Medicaid trading-partner credential adapter; unbound -> those routes answer 503. */
  readonly medicaidCredentials?: OnboardingCredentialPort;
  readonly logError?: (cause: unknown, context: { organizationId: string }) => void;
  /** Cause logging for a failed-attempt audit row that could not be written (the original error still reaches the caller). */
  readonly logAuditError?: (cause: unknown, context: { organizationId: string }) => void;
}

const ORG = schema.organizations;
const ACCOUNT = schema.tenantAccount;

/**
 * The slug resolver on the separately-pooled platform credential: one allowlisted `withPlatformContext` per lookup, so
 * the bypass is entered, audited (`platform.bypass_invoked`) and left before any tenant row is touched.
 */
export function buildPlatformTenantResolver(deps: {
  readonly platformDb: DbClient;
  readonly auditBypass: PlatformBypassAuditor<DbClient>;
  readonly platformJobId: string;
}): OnboardingTenantResolver {
  return (orgSlug) =>
    withPlatformContext<DbClient, { organizationId: string } | null>(
      deps.platformDb,
      {
        jobId: deps.platformJobId,
        reason: "M34 platform operator enters tenant onboarding data (tenant slug lookup)",
        crossTenant: true,
      },
      deps.auditBypass,
      async (tx) => {
        const [org] = await tx
          .select({ id: ORG.id })
          .from(ORG)
          .where(eq(ORG.slug, orgSlug))
          .limit(1);
        return org ? { organizationId: org.id } : null;
      },
    );
}

/** One billing lane's credential adapter: which port serves it, what it is called, what its audit row names. */
interface CredentialLane {
  readonly label: string;
  readonly resourceKind: string;
  readonly event: OnboardingAuditEvent;
  readonly port: (deps: OnboardingDataDeps) => OnboardingCredentialPort | undefined;
}
const MAC_LANE: CredentialLane = {
  label: "MAC",
  resourceKind: "mac_submitter_credential",
  event: EVENTS.macCredentialUpserted,
  port: (d) => d.macCredentials,
};
const MEDICAID_LANE: CredentialLane = {
  label: "state Medicaid trading-partner",
  resourceKind: "state_medicaid_trading_partner_credential",
  event: EVENTS.medicaidCredentialUpserted,
  port: (d) => d.medicaidCredentials,
};

/** What a write callback hands back: the response value plus what the audit row names. */
interface WriteResult<T> {
  readonly value: T;
  readonly resourceId: string;
  readonly changedFields?: readonly string[];
}

type WriteOutcome<T> = { readonly refusedStatus: string } | { readonly value: T };

interface WriteSpec {
  readonly event: OnboardingAuditEvent;
  readonly resourceKind: string;
  readonly reason: string;
}

const scopeOf = (op: OnboardingOperator, organizationId: string): OnboardingWriteScope => ({
  organizationId,
  operatorUserId: op.userId,
  operatorMembershipId: op.membershipId,
  operatorRoles: op.roles,
  stepUpRecent: op.stepUpRecent,
  request: op.request,
});

export function buildDrizzleOnboardingDataService(deps: OnboardingDataDeps): OnboardingDataService {
  const { db } = deps;

  /** The organization behind a slug. Only the lookup is cross-tenant; every read and write below is RLS-scoped to it. */
  async function targetOf(orgSlug: string): Promise<OnboardingAuditTarget> {
    if (!deps.resolveTenant) {
      throw new ChartWardenError(
        "PLATFORM_CONTEXT_UNAVAILABLE",
        "entering tenant onboarding data requires a bound platform credential",
        503,
      );
    }
    const org = await deps.resolveTenant(orgSlug);
    if (!org) throw new NotFoundError("tenant"); // non-leaking
    return { organizationId: org.organizationId, orgSlug };
  }

  const siteDeps = (tx: DbClient, op: OnboardingOperator): SiteWriteDeps => ({
    store: createDrizzleSiteAdminRepository(tx, op.userId),
    ...(deps.taxIdCipher ? { taxIdCipher: deps.taxIdCipher } : {}),
    ...(deps.logError ? { logError: deps.logError } : {}),
  });

  /** The error code a failed attempt records: the typed error's own code, else a generic one (never the message). */
  const errorCodeOf = (err: unknown): string =>
    err instanceof ChartWardenError ? err.code : "INTERNAL_ERROR";

  /**
   * The audit row of an attempt whose transaction rolled back. A follow-up transaction on the same tenant scope; it
   * carries the operator, the tenant, the reason, the route and the error code, never a body value or an error message.
   * Best effort: a failure here is logged and must never replace the error the caller is about to receive.
   */
  async function recordFailedWrite(
    op: OnboardingOperator,
    target: OnboardingAuditTarget,
    spec: WriteSpec,
    err: unknown,
  ): Promise<void> {
    try {
      await withOrgContext<DbClient, void>(
        db,
        { organizationId: target.organizationId, userId: op.userId },
        (tx) =>
          recordOnboardingAudit(tx, op, target, {
            eventType: EVENTS.writeFailed,
            resourceKind: spec.resourceKind,
            outcome: "denied",
            reason: spec.reason,
            detail: { attemptedEvent: spec.event, errorCode: errorCodeOf(err) },
          }),
      );
    } catch (auditError) {
      deps.logAuditError?.(auditError, { organizationId: target.organizationId });
    }
  }

  /**
   * One tenant write: shared onboarding lock -> status gate -> the tenant's own write -> the audit row, all in one
   * transaction scoped to the target org. A status refusal is audited (outcome `denied`) and committed, then thrown
   * after the transaction closes; any other failure rolls back and is audited afterwards by `recordFailedWrite`.
   */
  async function write<T>(
    op: OnboardingOperator,
    orgSlug: string,
    spec: WriteSpec,
    run: (tx: DbClient, target: OnboardingAuditTarget) => Promise<WriteResult<T>>,
  ): Promise<T> {
    const target = await targetOf(orgSlug);
    let outcome: WriteOutcome<T>;
    try {
      outcome = await withOrgContext<DbClient, WriteOutcome<T>>(
        db,
        { organizationId: target.organizationId, userId: op.userId },
        async (tx) => {
          await lockTenantOnboardingShared(tx, target.organizationId);
          const [account] = await tx
            .select({ status: ACCOUNT.status })
            .from(ACCOUNT)
            .where(eq(ACCOUNT.organizationId, target.organizationId))
            .limit(1);
          if (!account) throw new NotFoundError("tenant");
          if (!ONBOARDING_WRITABLE_STATUSES.has(account.status)) {
            await recordOnboardingAudit(tx, op, target, {
              eventType: EVENTS.writeRefused,
              resourceKind: spec.resourceKind,
              outcome: "denied",
              reason: spec.reason,
              detail: { attemptedEvent: spec.event, tenantStatus: account.status },
            });
            return { refusedStatus: account.status };
          }
          const done = await run(tx, target);
          await recordOnboardingAudit(tx, op, target, {
            eventType: spec.event,
            resourceKind: spec.resourceKind,
            resourceId: done.resourceId,
            outcome: "success",
            reason: spec.reason,
            ...(done.changedFields ? { changedFields: done.changedFields } : {}),
          });
          return { value: done.value };
        },
      );
    } catch (err) {
      await recordFailedWrite(op, target, spec, err);
      throw err;
    }
    if ("refusedStatus" in outcome) {
      throw new ChartWardenError(
        "TENANT_NOT_ONBOARDING",
        `onboarding data can be entered only while the tenant is provisioning or onboarding (it is ${outcome.refusedStatus})`,
        409,
      );
    }
    return outcome.value;
  }

  /** One audited read: the data first (the tenant's own scoped read), then the row — nothing is returned un-audited. */
  async function read<T extends { items: unknown[] }>(
    op: OnboardingOperator,
    orgSlug: string,
    resourceKind: string,
    run: (target: OnboardingAuditTarget) => Promise<T>,
  ): Promise<T> {
    const target = await targetOf(orgSlug);
    const value = await run(target);
    await withOrgContext<DbClient, void>(
      db,
      { organizationId: target.organizationId, userId: op.userId },
      (tx) =>
        recordOnboardingAudit(tx, op, target, {
          eventType: EVENTS.dataRead,
          resourceKind,
          outcome: "success",
          reason: null,
          detail: { count: value.items.length },
        }),
    );
    return value;
  }

  const sitesFor = (op: OnboardingOperator) => createDrizzleSiteAdminRepository(db, op.userId);

  /** The bound credential adapter for one billing lane, or a typed 503 naming the lane that is not bound. */
  function credentialPort(lane: CredentialLane): OnboardingCredentialPort {
    const port = lane.port(deps);
    if (!port) {
      throw new ChartWardenError(
        "ONBOARDING_CREDENTIALS_UNBOUND",
        `the ${lane.label} credential adapter is not bound in this deployment`,
        503,
      );
    }
    return port;
  }

  const listCredentials = (op: OnboardingOperator, orgSlug: string, lane: CredentialLane) =>
    read(op, orgSlug, lane.resourceKind, async (t) => ({
      items: [...(await credentialPort(lane).list(scopeOf(op, t.organizationId)))],
    }));

  const upsertCredential = (
    op: OnboardingOperator,
    orgSlug: string,
    lane: CredentialLane,
    fields: OnboardingFields & { providerEntityId: string },
    reason: string,
    expectedVersion?: number,
  ) =>
    write(
      op,
      orgSlug,
      { event: lane.event, resourceKind: lane.resourceKind, reason },
      async (tx, t) => {
        const port = credentialPort(lane);
        // A credential row is keyed by provider-entity id with no foreign key to the tenant: confirm the entity is
        // THIS tenant's, so an operator cannot hang a credential on another org's entity.
        const owned = await siteDeps(tx, op).store.getProviderEntity(
          t.organizationId,
          fields.providerEntityId,
        );
        if (!owned) throw new NotFoundError("provider entity");
        const record = await port.upsert(
          tx,
          scopeOf(op, t.organizationId),
          fields,
          expectedVersion,
        );
        return { value: record.view, resourceId: record.resourceId };
      },
    );

  return {
    listProviderEntities: (op, orgSlug) =>
      read(op, orgSlug, "provider_entity", async (t) => ({
        items: await sitesFor(op).listProviderEntities(t.organizationId),
      })),

    createProviderEntity: (op, orgSlug, fields, reason) =>
      write(
        op,
        orgSlug,
        { event: EVENTS.providerEntityCreated, resourceKind: "provider_entity", reason },
        async (tx, t) => {
          const created = await createProviderEntityForOrg(
            siteDeps(tx, op),
            t.organizationId,
            fields,
          );
          return { value: created, resourceId: created.id };
        },
      ),

    updateProviderEntity: (op, orgSlug, id, fields, reason) =>
      write(
        op,
        orgSlug,
        { event: EVENTS.providerEntityUpdated, resourceKind: "provider_entity", reason },
        async (tx, t) => {
          const { updated, changedFields } = await updateProviderEntityForOrg(
            siteDeps(tx, op),
            t.organizationId,
            id,
            fields,
          );
          return { value: updated, resourceId: id, changedFields };
        },
      ),

    listLocations: (op, orgSlug) =>
      read(op, orgSlug, "location", async (t) => ({
        items: await sitesFor(op).listLocations(t.organizationId),
      })),

    createLocation: (op, orgSlug, fields, reason) =>
      write(
        op,
        orgSlug,
        { event: EVENTS.locationCreated, resourceKind: "location", reason },
        async (tx, t) => {
          const created = await createLocationForOrg(siteDeps(tx, op), t.organizationId, fields);
          return { value: created, resourceId: created.id };
        },
      ),

    updateLocation: (op, orgSlug, id, fields, reason) =>
      write(
        op,
        orgSlug,
        { event: EVENTS.locationUpdated, resourceKind: "location", reason },
        async (tx, t) => {
          const { updated, changedFields } = await updateLocationForOrg(
            siteDeps(tx, op),
            t.organizationId,
            id,
            fields,
          );
          return { value: updated, resourceId: id, changedFields };
        },
      ),

    listMacCredentials: (op, orgSlug) => listCredentials(op, orgSlug, MAC_LANE),
    upsertMacCredential: (op, orgSlug, fields, reason, expectedVersion) =>
      upsertCredential(op, orgSlug, MAC_LANE, fields, reason, expectedVersion),
    listMedicaidCredentials: (op, orgSlug) => listCredentials(op, orgSlug, MEDICAID_LANE),
    upsertMedicaidCredential: (op, orgSlug, fields, reason) =>
      upsertCredential(op, orgSlug, MEDICAID_LANE, fields, reason),
  };
}
