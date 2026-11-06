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
// (`tenant-onboarding-lock.ts`), and the go-live approval (`activateApprovedTenant`) and `transitionStatus` take it
// EXCLUSIVE: an activation waits for in-flight writes to commit, and a write that starts after it sees `active` (409).
import { type DbClient, schema } from "@chartwarden/db";
import {
  type PlatformBypassAuditor,
  withOrgContext,
  withPlatformContext,
} from "@chartwarden/tenancy";
import { ChartWardenError, NotFoundError } from "@chartwarden/types";
import { eq } from "drizzle-orm";
import type { OnboardingClearinghousePort } from "../../../../bootstrap/onboarding-clearinghouse-port";
import type {
  OnboardingCredentialPort,
  OnboardingWriteScope,
} from "../../../../bootstrap/onboarding-credential-port";
import type {
  OnboardingNoticeKind,
  OnboardingNoticePort,
  OnboardingNoticeView,
} from "../../../../bootstrap/onboarding-notice-port";
import { createDrizzleSiteAdminRepository } from "../../../../bootstrap/site-admin-repository";
import {
  type SiteWriteDeps,
  type TaxIdCipherPort,
  createLocationForOrg,
  createProviderEntityForOrg,
  updateLocationForOrg,
  updateProviderEntityForOrg,
} from "../../../02-identity/org-admin-site-service";
import { voidPendingGoLiveForDataChange } from "../../onboarding/go-live-void";
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
  /** The tenant's clearinghouse choice, masked (`hasSecret`, never the credential). One audited read. */
  getClearinghouse(op: OnboardingOperator, orgSlug: string): Promise<unknown>;
  putClearinghouse(
    op: OnboardingOperator,
    orgSlug: string,
    fields: OnboardingFields,
    reason: string,
    expectedVersion: number | undefined,
  ): Promise<{ readonly created: boolean; readonly view: unknown }>;
  verifyClearinghouse(
    op: OnboardingOperator,
    orgSlug: string,
    fields: OnboardingFields,
    reason: string,
  ): Promise<{ readonly config: unknown; readonly test: unknown }>;
  activateClearinghouse(op: OnboardingOperator, orgSlug: string, reason: string): Promise<unknown>;
  /**
   * The operator verifies the vendor BAA the tenant recorded. NOT gated on the tenant's onboarding status: a live tenant that
   * changed vendor or re-recorded its BAA needs this too.
   */
  /** `expected` is the `baa.recordedAt` the operator read: a record that changed since is a 409, not a verification. */
  verifyClearinghouseBaa(
    op: OnboardingOperator,
    orgSlug: string,
    reason: string,
    expected: { readonly recordedAt: string },
  ): Promise<unknown>;
  /**
   * The operator withdraws the tenant's "filed outside ChartWarden" record of one NOE / NOTR: the notice returns to its pre-record
   * state (a watchdog's breach stamp stays; the one a withdrawn LATE record wrote itself is cleared with it). NOT gated on the tenant's onboarding status. `expected` is the `externalFiling.recordedAt`
   * the operator read: a record that changed since is a 409.
   */
  withdrawNoticeExternalFiling(
    op: OnboardingOperator,
    orgSlug: string,
    kind: OnboardingNoticeKind,
    noticeId: string,
    reason: string,
    expected: { readonly recordedAt: string },
  ): Promise<OnboardingNoticeView>;
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
  /**
   * Runs the advance sweep for the tenant after a write COMMITS (best effort: a failure is warned and never fails the write), so
   * the step the data satisfies settles at once (the MAC credential, a location) instead of waiting for the daily pass.
   */
  readonly advance?: (tenant: { tenantAccountId: string; organizationId: string }) => Promise<void>;
  /** `err` carries the raw error for the redacting logger (a database error holds bound values). */
  readonly warn?: (message: string, context: Record<string, unknown>) => void;
  /** M23's clearinghouse adapter (ADR-0053 amendment 2026-11-06); unbound -> the clearinghouse routes answer 503. */
  readonly clearinghouse?: OnboardingClearinghousePort;
  /** M23's notice adapter (an operator withdraws a tenant's external-filing record); unbound -> that route answers 503. */
  readonly notices?: OnboardingNoticePort;
  /**
   * Runs the onboarding advance pass for the tenant after a clearinghouse change COMMITS, so wizard step 7
   * (`clearinghouse_selected`) settles at once. Best effort: a failure is the caller's to log and never fails the write.
   */
  readonly settleOnboarding?: (organizationId: string) => Promise<void>;
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
  /** Non-sensitive facts for the audit row (counts, codes, kinds). */
  readonly detail?: Readonly<Record<string, string | number | boolean>>;
}

type WriteOutcome<T> = { readonly refusedStatus: string } | { readonly value: T };

interface WriteSpec {
  readonly event: OnboardingAuditEvent;
  readonly resourceKind: string;
  readonly reason: string;
  /** True for a write a LIVE tenant needs too (the BAA verification): the shared lock and the audit row stay, the status gate goes. */
  readonly anyTenantStatus?: boolean;
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
    let tenantAccountId: string | undefined;
    try {
      outcome = await withOrgContext<DbClient, WriteOutcome<T>>(
        db,
        { organizationId: target.organizationId, userId: op.userId },
        async (tx) => {
          await lockTenantOnboardingShared(tx, target.organizationId);
          const [account] = await tx
            .select({ id: ACCOUNT.id, status: ACCOUNT.status })
            .from(ACCOUNT)
            .where(eq(ACCOUNT.organizationId, target.organizationId))
            .limit(1);
          if (!account) throw new NotFoundError("tenant");
          tenantAccountId = account.id;
          if (!spec.anyTenantStatus && !ONBOARDING_WRITABLE_STATUSES.has(account.status)) {
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
          // A pending go-live attestation said this data was ready: the write makes that stale, so it is voided in the same
          // transaction (the attestation and the write commit or roll back together).
          await voidPendingGoLiveForDataChange(tx, {
            organizationId: target.organizationId,
            revokedByUserId: op.userId,
            revokedByMembershipId: op.membershipId,
          });
          await recordOnboardingAudit(tx, op, target, {
            eventType: spec.event,
            resourceKind: spec.resourceKind,
            resourceId: done.resourceId,
            outcome: "success",
            reason: spec.reason,
            ...(done.changedFields ? { changedFields: done.changedFields } : {}),
            ...(done.detail ? { detail: done.detail } : {}),
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
    await settleAfterWrite(target.organizationId, tenantAccountId);
    return outcome.value;
  }

  /** Post-commit, best effort: let the advance sweep settle whatever step this write satisfied. */
  async function settleAfterWrite(
    organizationId: string,
    tenantAccountId: string | undefined,
  ): Promise<void> {
    if (!deps.advance || !tenantAccountId) return;
    try {
      await deps.advance({ tenantAccountId, organizationId });
    } catch (error) {
      deps.warn?.("m34.onboarding data: advance after a write failed", {
        tenantAccountId,
        organizationId,
        err: error,
      });
    }
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

  /** The bound clearinghouse adapter, or a typed 503 (the credential lanes' posture). */
  function clearinghousePort(): OnboardingClearinghousePort {
    if (!deps.clearinghouse) {
      throw new ChartWardenError(
        "ONBOARDING_CLEARINGHOUSE_UNBOUND",
        "the clearinghouse adapter is not bound in this deployment",
        503,
      );
    }
    return deps.clearinghouse;
  }

  function noticePort(): OnboardingNoticePort {
    if (!deps.notices) {
      throw new ChartWardenError(
        "ONBOARDING_NOTICES_UNBOUND",
        "the notice adapter is not bound in this deployment",
        503,
      );
    }
    return deps.notices;
  }

  /** Post-commit, best effort: the advance pass that settles wizard step 7. A failure is logged and never thrown. */
  async function settleStepAfter<T>(organizationId: string, result: T): Promise<T> {
    if (!deps.settleOnboarding) return result;
    try {
      await deps.settleOnboarding(organizationId);
    } catch (cause) {
      deps.logError?.(cause, { organizationId });
    }
    return result;
  }

  const CLEARINGHOUSE_KIND = "tenant_clearinghouse_config";

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
    getClearinghouse: async (op, orgSlug) => {
      const { items } = await read(op, orgSlug, CLEARINGHOUSE_KIND, async (t) => ({
        items: [await clearinghousePort().get(scopeOf(op, t.organizationId))],
      }));
      return items[0];
    },

    putClearinghouse: async (op, orgSlug, fields, reason, expectedVersion) => {
      let organizationId = "";
      const result = await write(
        op,
        orgSlug,
        { event: EVENTS.clearinghouseSet, resourceKind: CLEARINGHOUSE_KIND, reason },
        async (tx, t) => {
          organizationId = t.organizationId;
          const done = await clearinghousePort().put(
            tx,
            scopeOf(op, t.organizationId),
            fields,
            expectedVersion,
          );
          return {
            value: { created: done.created === true, view: done.view },
            resourceId: done.resourceId,
            ...(done.changedFields ? { changedFields: done.changedFields } : {}),
          };
        },
      );
      return settleStepAfter(organizationId, result);
    },

    verifyClearinghouse: async (op, orgSlug, fields, reason) => {
      // The vendor probe is a network call: it runs with NO transaction open (and no row lock held). Step 1 reads and unseals
      // the credential on its own short read, step 2 is the probe, step 3 is the audited write transaction, which
      // compare-and-sets on the version step 1 read (409 when the config moved meanwhile).
      // ponytail: the tenant-status gate is inside `write`, so a verify against a tenant that is no longer onboarding probes
      // the vendor once and is then refused (audited); the probe holds no PHI and no lock, so the waste is one vendor call.
      const target = await targetOf(orgSlug);
      const scope = scopeOf(op, target.organizationId);
      const port = clearinghousePort();
      const plan = await port.prepareVerify(scope, fields);
      const outcome = await port.runProbe(plan);
      let organizationId = "";
      const result = await write(
        op,
        orgSlug,
        { event: EVENTS.clearinghouseVerified, resourceKind: CLEARINGHOUSE_KIND, reason },
        async (tx, t) => {
          organizationId = t.organizationId;
          const done = await port.completeVerify(tx, scope, plan, outcome);
          return {
            value: { config: done.view, test: done.test ?? null },
            resourceId: done.resourceId,
            ...(done.detail ? { detail: done.detail } : {}),
          };
        },
      );
      return settleStepAfter(organizationId, result);
    },

    activateClearinghouse: async (op, orgSlug, reason) => {
      let organizationId = "";
      const view = await write(
        op,
        orgSlug,
        { event: EVENTS.clearinghouseActivated, resourceKind: CLEARINGHOUSE_KIND, reason },
        async (tx, t) => {
          organizationId = t.organizationId;
          const done = await clearinghousePort().activate(tx, scopeOf(op, t.organizationId));
          return { value: done.view, resourceId: done.resourceId };
        },
      );
      return settleStepAfter(organizationId, view);
    },

    verifyClearinghouseBaa: (op, orgSlug, reason, expected) =>
      write(
        op,
        orgSlug,
        {
          event: EVENTS.clearinghouseBaaVerified,
          resourceKind: CLEARINGHOUSE_KIND,
          reason,
          anyTenantStatus: true,
        },
        async (tx, t) => {
          const done = await clearinghousePort().verifyBaa(
            tx,
            scopeOf(op, t.organizationId),
            expected,
          );
          return {
            value: done.view,
            resourceId: done.resourceId,
            ...(done.detail ? { detail: done.detail } : {}),
          };
        },
      ),

    withdrawNoticeExternalFiling: (op, orgSlug, kind, noticeId, reason, expected) =>
      write(
        op,
        orgSlug,
        {
          event: EVENTS.noticeExternalFilingWithdrawn,
          resourceKind: kind === "noe" ? "noe_record" : "notr_record",
          reason,
          anyTenantStatus: true,
        },
        async (tx, t) => {
          const done = await noticePort().withdrawExternalFiling(
            tx,
            scopeOf(op, t.organizationId),
            {
              kind,
              noticeId,
              expectedRecordedAt: expected.recordedAt,
            },
          );
          return { value: done.view, resourceId: done.resourceId, detail: done.detail };
        },
      ),

    listMedicaidCredentials: (op, orgSlug) => listCredentials(op, orgSlug, MEDICAID_LANE),
    upsertMedicaidCredential: (op, orgSlug, fields, reason) =>
      upsertCredential(op, orgSlug, MEDICAID_LANE, fields, reason),
  };
}
