import { randomUUID } from "node:crypto";
// apps/backend/src/modules/34-saas-tenant-platform/routes/platform/service-drizzle.ts — M34 Phase 2D.
//
// The PRODUCTION `TenantPlatformRouteService` (§4.1 platform-ops surface). It implements the SAME
// interface the in-memory slice does (routes/platform/service.ts) so the four platform-ops route plugins
// (tenants / tenant-invitations / key-ring / onboarding-templates) — plus support-sessions / signup-
// intents / baa-register / feature-flags-admin — are UNCHANGED. The slice stays for the route tests; this
// adapter is what `mountTenantPlatformRoutes` injects when a DB client is present.
//
// EXECUTION MODEL (the two rules this file enforces structurally):
//   - Every read/command runs inside ONE `withPlatformContext` transaction (M1 @wardenx/tenancy — the
//     separately-pooled, RLS-bypass, AUDITED cross-tenant platform path, F03/F09). `withPlatformContext`
//     refuses any caller not on the platform-job allowlist and emits the mandatory `platform.bypass_invoked`
//     audit event before `fn` runs — so every platform-ops cross-tenant read is audited by construction.
//   - READ/LIST methods project the §3 repository rows to the SAME DTO shapes the slice returns.
//   - COMMAND methods (provision / transition / offboard / shred / dek-rotate / qualify-intent / …) run
//     the §2.2 `transitionTenant(...)` lifecycle machine, append the `tenant_account_status_event` ledger
//     row, enqueue the §4.3 worker job through the injected {@link EnqueuePort}, and emit the `m34.*`
//     outbox event — all inside the one platform-context tx.
//
// The pure 2B workers (provision/shred/dek-rotate/export) are NOT rewritten here: a command method only
// ENQUEUES the named queue job (the live BullMQ worker construction binds each worker port to its real
// repo/seam separately). SAFETY: the shred command requires `status='destruction_pending'` and enqueues
// `tenant.shred` (whose worker calls the `m34_destroy_tenant_key_ring` SECURITY DEFINER fn + M4 destruction-
// cert registry — never this request thread); this adapter never nulls DEK ciphertext directly.
import { type DbClient, schema } from "@wardenx/db";
import {
  BaaRegisterRepository,
  OnboardingRepository,
  SignupIntentRepository,
  SupportRepository,
  TENANT_EXPORT_OBJECT_TTL_MS,
  TenantAccountRepository,
  TenantExportRepository,
  TenantKeyRingRepository,
} from "@wardenx/saas-tenant-platform";
import {
  type LifecycleActorKind,
  type LifecycleEvent,
  type LifecycleSideEffect,
  type NowPort,
  type SupportSessionAlertPort,
  type SupportSessionAuditPort,
  type SupportSessionOutboxPort,
  type SupportSessionServiceDeps,
  elevateSupportSession,
  startSupportSession,
  transitionTenant,
} from "@wardenx/saas-tenant-platform";
import { type PlatformBypassAuditor, withPlatformContext } from "@wardenx/tenancy";
import { NotFoundError, WardenXError } from "@wardenx/types";
import { and, desc, eq } from "drizzle-orm";
import { type CursorPage, decodeCursor, encodeCursor, pageSizeOf, paginate } from "./concurrency";
import type {
  BaaRecordView,
  CloseSupportSessionArgs,
  CreateBaaRecordArgs,
  ElevateSupportSessionArgs,
  EnqueuePort,
  FeatureFlagView,
  KeyRingMetadataView,
  OnboardingTemplateView,
  ProvisionTenantArgs,
  SetKillSwitchArgs,
  SignupIntentView,
  StartSupportSessionArgs,
  StatusTransitionArgs,
  SupportSessionEventView,
  SupportSessionView,
  TenantExportJobView,
  TenantOverview,
  TenantPlatformRouteService,
  TenantSummaryView,
  UpdateBaaRecordArgs,
  UpsertFeatureFlagArgs,
} from "./service";

// ── injected ports the composition root binds (Phase-2D wiring; kept off the request thread) ──────────

/** The platform M1 FeatureFlagAdmin seam (§4.7 / D13 — M1 owns the schema; M34 routes delegate to it). */
export interface FeatureFlagAdminPort {
  list(
    organizationId: string | null,
    flagKind: string | undefined,
  ): Promise<readonly FeatureFlagView[]>;
  upsert(actorUserId: string, args: UpsertFeatureFlagArgs): Promise<FeatureFlagView>;
  setKillSwitch(actorUserId: string, args: SetKillSwitchArgs): Promise<FeatureFlagView>;
}

/**
 * Validated-outbox publish port. The composition root binds this to `publishOutboxEvent` (catalog-
 * validated) over the SAME platform tx, so the `m34.*` event commits atomically with the lifecycle row.
 * Returning `void` keeps the per-event payload construction in the wiring layer (the catalog schemas live
 * in events-by-m34.ts); a lifecycle command calls this once per `outbox` side effect whose event name is
 * present in the catalog.
 */
export interface OutboxPublishPort {
  publish(
    tx: PlatformTx,
    input: {
      eventName: string;
      organizationId: string;
      aggregateKind: string;
      aggregateId: string;
      payload: Record<string, unknown>;
    },
  ): Promise<void>;
}

/** M2-owned organization-spine creation. M34 never writes the organization table directly. */
export interface OrganizationProvisionPort {
  ensure(input: {
    readonly organizationId: string;
    readonly tenantAccountId: string;
    readonly legalBusinessName: string;
  }): Promise<{ readonly organizationId: string }>;
}

/** The structural platform-context transaction handle the repos + outbox/audit write through. */
export type PlatformTx = DbClient;

/** The dependencies the production platform route service binds (the Integration agent supplies these). */
export interface DrizzleTenantPlatformDeps {
  /** Separately-pooled platform credential (RLS-bypass; NOT the tenant pool). */
  readonly platformDb: DbClient;
  /** The §4.3 worker-trigger port (BullMQ producer in prod; the slice records the call in tests). */
  readonly enqueue: EnqueuePort;
  /** Emits the mandatory `platform.bypass_invoked` audit event for every platform-context entry (F09). */
  readonly auditBypass: PlatformBypassAuditor<PlatformTx>;
  /** Catalog-validated outbox publish, over the same platform tx. */
  readonly outbox: OutboxPublishPort;
  readonly organizations: OrganizationProvisionPort;
  /** M1's FeatureFlagAdmin seam (§4.7 / D13). */
  readonly featureFlags: FeatureFlagAdminPort;
  /** Support-session side-effect ports (audit/alert/outbox/now) — the per-tx repo is bound here. */
  readonly supportSessionPorts: {
    readonly audit: SupportSessionAuditPort;
    readonly outbox: SupportSessionOutboxPort;
    readonly alerts: SupportSessionAlertPort;
    readonly now: NowPort;
  };
  /** The registered platform-job id used as the `withPlatformContext` caller (allowlisted at boot). */
  readonly platformJobId: string;
}

const A = schema.tenantAccount;
const ORG = schema.organizations;
const BAA = schema.platformTenantBaaRecord;
const TASK = schema.onboardingTask;
const SS = schema.supportSession;
const SCG = schema.supportConsentGrant;

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);
const isoReq = (d: Date): string => d.toISOString();

// The lifecycle MACHINE emits a wider set of `m34.tenant.*` effect names than events-by-m34.ts catalogs, and
// the per-event payload schemas differ from the generic payload below. With the live transactional-outbox
// dispatcher now bound (#107), a non-conformant publish would ROLL BACK the lifecycle mutation — so this gate
// emits ONLY the event whose generic payload provably conforms to its registered schema: `m34.tenant.provisioned`
// ({ tenantAccountId, orgId, legalBusinessName, billingContactEmail } — an exact match). The other lifecycle
// transitions (suspension/offboarding/retention/destruction) need per-event payloads (reason / purpose /
// initiatedByMembershipId / initiatedAt …) threaded from the command context + their catalog entries — a noted
// follow-up (#107) — so they stay un-emitted (the mutation still lands) rather than rolling back.
const CATALOG_LIFECYCLE_EVENTS = new Set<string>(["m34.tenant.provisioned"]);

export function createDrizzleTenantPlatformBackend(deps: DrizzleTenantPlatformDeps): {
  service: TenantPlatformRouteService;
} {
  /** Run `fn` in one audited platform-context tx (the only place cross-tenant rows are read/written). */
  const inPlatformCtx = <T>(reason: string, fn: (tx: PlatformTx) => Promise<T>): Promise<T> =>
    withPlatformContext<PlatformTx, T>(
      deps.platformDb,
      { jobId: deps.platformJobId, reason, crossTenant: true },
      deps.auditBypass,
      fn,
    );

  const toSummary = (a: schema.TenantAccount, orgSlug: string): TenantSummaryView => ({
    id: a.id,
    organizationId: a.organizationId,
    orgSlug,
    legalBusinessName: a.legalBusinessName,
    status: a.status,
    planLabel: a.planLabel,
    createdAt: isoReq(a.createdAt),
    updatedAt: isoReq(a.updatedAt),
  });

  /** Resolve an account by org slug (the platform routes address tenants by slug). */
  async function loadByOrgSlug(
    tx: PlatformTx,
    orgSlug: string,
  ): Promise<{ account: schema.TenantAccount; orgSlug: string }> {
    const [org] = await tx.select().from(ORG).where(eq(ORG.slug, orgSlug)).limit(1);
    if (!org) throw new NotFoundError("tenant"); // non-leaking
    const account = await new TenantAccountRepository(tx).findByOrganizationId(org.id);
    if (!account) throw new NotFoundError("tenant");
    return { account, orgSlug };
  }

  /** Run the lifecycle machine + commit the §2.5 in-tx effects (ledger / timestamps / enqueue / outbox). */
  async function applyTransition(
    tx: PlatformTx,
    account: schema.TenantAccount,
    actorUserId: string,
    actorKind: LifecycleActorKind,
    event: LifecycleEvent,
  ): Promise<schema.TenantAccount> {
    const repo = new TenantAccountRepository(tx);
    const res = transitionTenant(account.status, event);

    // 1) status patch (status + any set_timestamp / retention effects)
    const patch: Parameters<TenantAccountRepository["updateStatus"]>[1] = {
      status: res.to as schema.TenantAccount["status"],
    };
    for (const eff of res.effects) {
      if (eff.kind === "set_timestamp") patch[eff.field] = new Date();
    }
    const updated = await repo.updateStatus(account.id, patch);

    // 2) the always-present §2.4.1 status-event ledger row
    await repo.appendStatusEvent({
      tenantAccountId: account.id,
      organizationId: account.organizationId,
      fromStatus: res.from as schema.TenantAccount["status"],
      toStatus: res.to as schema.TenantAccount["status"],
      transitionReason: event.transitionReason,
      actorMembershipId: null,
      actorKind,
      sideEffectsRecorded: { effects: res.effects.map((e) => e.kind) },
    });

    // 3) enqueue worker jobs + 4) emit catalog outbox, both in this same tx
    await runSideEffects(tx, updated, res.effects);
    void actorUserId;
    return updated;
  }

  async function runSideEffects(
    tx: PlatformTx,
    account: schema.TenantAccount,
    effects: ReadonlyArray<LifecycleSideEffect>,
  ): Promise<void> {
    for (const eff of effects) {
      if (eff.kind === "queue_job") {
        const queue = eff.job === "tenant.provision" ? "tenant.provision" : "tenant.shred";
        if (eff.job === "tenant.provision" || eff.job === "tenant.shred") {
          await deps.enqueue.enqueue(queue, account.id, { tenantAccountId: account.id });
        }
        // tenant.shred_eligibility_check is a scheduled cron job, not a request-thread enqueue.
      } else if (eff.kind === "outbox" && CATALOG_LIFECYCLE_EVENTS.has(eff.event)) {
        await deps.outbox.publish(tx, {
          eventName: eff.event,
          organizationId: account.organizationId,
          aggregateKind: "tenant_account",
          aggregateId: account.id,
          payload: {
            tenantAccountId: account.id,
            orgId: account.organizationId,
            legalBusinessName: account.legalBusinessName,
            billingContactEmail: account.billingContactEmail,
          },
        });
      }
    }
  }

  /** Build the per-tx `SupportSessionServiceDeps` (tx-bound repo + the injected side-effect ports). */
  const supportDeps = (tx: PlatformTx): SupportSessionServiceDeps => ({
    repo: new SupportRepository(tx),
    audit: deps.supportSessionPorts.audit,
    outbox: deps.supportSessionPorts.outbox,
    alerts: deps.supportSessionPorts.alerts,
    now: deps.supportSessionPorts.now,
  });

  const service: TenantPlatformRouteService = {
    // ── tenants (live cross-tenant reads under withPlatformContext) ──
    async listTenants(filter, cursor, limit): Promise<CursorPage<TenantSummaryView>> {
      return inPlatformCtx("platform-ops list tenants", async (tx) => {
        const rows = await tx
          .select({ account: A, slug: ORG.slug })
          .from(A)
          .innerJoin(ORG, eq(A.organizationId, ORG.id))
          .orderBy(desc(A.createdAt), desc(A.id));
        const views = rows
          .map((r) => toSummary(r.account, r.slug))
          .filter((v) => (filter.status ? v.status === filter.status : true))
          .filter((v) => (filter.planLabel ? v.planLabel === filter.planLabel : true))
          .filter((v) => (filter.createdAfter ? v.createdAt > filter.createdAfter : true))
          .filter((v) =>
            filter.search
              ? v.legalBusinessName.toLowerCase().includes(filter.search.toLowerCase())
              : true,
          );
        return paginate(views, cursor, limit);
      });
    },

    async getTenantOverview(orgSlug): Promise<TenantOverview> {
      return inPlatformCtx("platform-ops tenant overview", async (tx) => {
        const { account, orgSlug: slug } = await loadByOrgSlug(tx, orgSlug);
        const accRepo = new TenantAccountRepository(tx);
        const krRepo = new TenantKeyRingRepository(tx);

        const [event] = await accRepo.listStatusEvents(account.id, { limit: 1 });
        const keyRing = await krRepo.findByTenantAccountId(account.id);
        const tasks = await tx.select().from(TASK).where(eq(TASK.tenantAccountId, account.id));
        const baaRows = await new BaaRegisterRepository(tx).listByTenantAccountId(account.id);
        const latestBaa = baaRows[0] ?? null;
        const sessions = await tx
          .select()
          .from(SS)
          .innerJoin(SCG, eq(SS.supportConsentGrantId, SCG.id))
          .where(and(eq(SCG.tenantAccountId, account.id)));
        const activeSessions = sessions.filter((s) => s.support_session.closedAt === null).length;
        const grants = await new SupportRepository(tx).listActiveConsentGrants(account.id);

        const doneTasks = tasks.filter((t) => t.status === "done" || t.status === "skipped").length;
        const currentStep =
          tasks.find((t) => t.status === "in_progress")?.templateKey ??
          tasks.find((t) => t.status === "pending")?.templateKey ??
          null;

        return {
          ...toSummary(account, slug),
          latestStatusEvent: event
            ? {
                id: event.id,
                toStatus: event.toStatus,
                occurredAt: isoReq(event.occurredAt),
                reason: event.transitionReason,
              }
            : null,
          keyRing: keyRing
            ? {
                currentDekVersion: keyRing.currentDekVersion,
                dekLastRotatedAt: iso(keyRing.dekLastRotatedAt),
                destroyedAt: iso(keyRing.destroyedAt),
              }
            : null,
          onboarding: { totalTasks: tasks.length, doneTasks, currentStep },
          baa: latestBaa
            ? { status: latestBaa.baaStatus, expiresOn: dateOnly(latestBaa.expiresOn) }
            : null,
          activeGrants: grants.length,
          activeSessions,
        };
      });
    },

    // ── tenants: command methods (lifecycle machine + ledger + enqueue + outbox, one tx) ──
    async provisionTenant(actorMembershipId, args: ProvisionTenantArgs) {
      return inPlatformCtx("platform-ops provision tenant", async (tx) => {
        const tenantAccountId = args.signupIntentId ?? randomUUID();
        const organizationId = tenantAccountId;
        const accounts = new TenantAccountRepository(tx);
        const existing = await accounts.findById(tenantAccountId);

        await deps.organizations.ensure({
          organizationId,
          tenantAccountId,
          legalBusinessName: args.legalBusinessName,
        });

        if (!existing) {
          await accounts.create({
            id: tenantAccountId,
            organizationId,
            status: "provisioning",
            planLabel: args.planLabel,
            legalBusinessName: args.legalBusinessName,
            billingContactEmail: args.billingContactEmail,
            breachNotificationEmail: args.breachNotificationContactEmail,
            createdByMembershipId: actorMembershipId,
          });
          await accounts.appendStatusEvent({
            tenantAccountId,
            organizationId,
            fromStatus: "signup_intent",
            toStatus: "provisioning",
            transitionReason: "platform operator requested tenant provisioning",
            actorMembershipId,
            actorKind: "platform_ops",
            sideEffectsRecorded: { queue: "tenant.provision" },
          });
        } else if (existing.status !== "provisioning") {
          throw new WardenXError(
            "ILLEGAL_TENANT_TRANSITION",
            `tenant cannot provision from '${existing.status}'`,
            409,
          );
        }

        if (args.signupIntentId) {
          const intentRepo = new SignupIntentRepository(tx);
          const intent = await intentRepo.findIntentById(args.signupIntentId);
          if (intent) {
            await intentRepo.updateIntent(intent.id, {
              intentStatus: "qualified",
              processedAt: deps.supportSessionPorts.now(),
              tenantAccountId,
            });
          }
        }

        const provisionJob = {
          tenantAccountId,
          organizationId,
          legalBusinessName: args.legalBusinessName,
          billingContactEmail: args.billingContactEmail,
          firstAdminEmail: args.firstAdminEmail,
          firstAdminFullName: args.firstAdminFullName,
          actorMembershipId,
          transitionReason: "platform operator requested tenant provisioning",
        };
        const { jobId } = await deps.enqueue.enqueue(
          "tenant.provision",
          tenantAccountId,
          provisionJob,
        );
        await deps.outbox.publish(tx, {
          eventName: "m34.tenant.provision_started",
          organizationId,
          aggregateKind: "tenant_account",
          aggregateId: tenantAccountId,
          payload: provisionJob,
        });
        return { tenantAccountId, jobId };
      });
    },

    async transitionStatus(orgSlug, actorUserId, args: StatusTransitionArgs) {
      return inPlatformCtx("platform-ops transition tenant status", async (tx) => {
        const { account } = await loadByOrgSlug(tx, orgSlug);
        const event = lifecycleEventForStatus(args.toStatus, args.transitionReason);
        const updated = await applyTransition(tx, account, actorUserId, "platform_ops", event);
        return { tenantAccountId: updated.id, status: updated.status };
      });
    },

    async offboardTenant(orgSlug, actorUserId, args) {
      return inPlatformCtx("platform-ops offboard tenant", async (tx) => {
        const { account } = await loadByOrgSlug(tx, orgSlug);
        const purpose = args.exportPurpose === "baa_termination" ? "baa_termination" : "migration";
        const updated = await applyTransition(tx, account, actorUserId, "platform_ops", {
          type: "initiateOffboarding",
          actorKind: "platform_ops",
          transitionReason: args.transitionReason,
          exportPurpose: purpose,
        });
        return { tenantAccountId: updated.id, status: updated.status };
      });
    },

    async requestShred(orgSlug, actorMembershipId, args) {
      return inPlatformCtx("platform-ops request tenant shred", async (tx) => {
        const { account } = await loadByOrgSlug(tx, orgSlug);
        if (account.status !== "destruction_pending") {
          throw new WardenXError(
            "ILLEGAL_TENANT_TRANSITION",
            "shred requires status='destruction_pending'",
            409,
          );
        }
        // SAFETY: never destroy ciphertext here. Enqueue the tenant.shred worker (which calls the
        // m34_destroy_tenant_key_ring SECURITY DEFINER fn via M4's destruction-cert registry).
        const { jobId } = await deps.enqueue.enqueue(
          "tenant.shred",
          `${account.id}+${args.destructionCertificateId}`,
          {
            tenantAccountId: account.id,
            orgId: account.organizationId,
            destructionCertId: args.destructionCertificateId,
            actorMembershipId,
            transitionReason: args.transitionReason,
          },
        );
        return { tenantAccountId: account.id, jobId };
      });
    },

    async requestDekRotate(orgSlug, actorMembershipId, args) {
      return inPlatformCtx("platform-ops request DEK rotate", async (tx) => {
        const { account } = await loadByOrgSlug(tx, orgSlug);
        const keyRing = await new TenantKeyRingRepository(tx).findByTenantAccountId(account.id);
        if (!keyRing || keyRing.destroyedAt || !keyRing.currentDekKekWrappedCiphertext) {
          throw new WardenXError("TENANT_KEY_UNAVAILABLE", "tenant key ring is unavailable", 409);
        }
        const current = /^v(\d+)$/.exec(keyRing.currentDekVersion)?.[1];
        if (!current) throw new Error("malformed tenant DEK version");
        const targetVersion = `v${Number.parseInt(current, 10) + 1}`;
        const { jobId } = await deps.enqueue.enqueue(
          "tenant.dek_rotate",
          `${account.id}+${targetVersion}`,
          { orgId: account.organizationId, actorMembershipId, targetVersion },
        );
        return { tenantAccountId: account.id, jobId };
      });
    },

    // ── tenant-invitations ──
    async listInvitations(filter, cursor, limit) {
      return inPlatformCtx("platform-ops list invitations", async (tx) => {
        const rows = await tx
          .select()
          .from(schema.tenantInvitation)
          .orderBy(desc(schema.tenantInvitation.issuedAt), desc(schema.tenantInvitation.id));
        const views = rows
          .filter((i) => (filter.status ? i.status === filter.status : true))
          .map((i) => ({
            id: i.id,
            tenantAccountId: i.tenantAccountId,
            firstAdminEmail: i.inviteeEmail,
            status: i.status,
            issuedAt: isoReq(i.issuedAt),
            expiresAt: iso(i.expiresAt),
            createdAt: isoReq(i.issuedAt),
          }));
        const p = paginate(views, cursor, limit);
        return { ...p, items: p.items.map(({ createdAt: _c, ...i }) => i) };
      });
    },

    async issueInvitation(actorUserId, args) {
      return inPlatformCtx("platform-ops issue invitation", async (tx) => {
        const { account } = await loadByOrgSlug(tx, args.orgSlug);
        const repo = new TenantAccountRepository(tx);
        const expiresAt = new Date(Date.now() + (args.expiresInDays ?? 7) * 86_400_000);
        const row = await repo.createInvitation({
          tenantAccountId: account.id,
          organizationId: account.organizationId,
          inviteeEmail: args.firstAdminEmail,
          inviteeFullName: args.firstAdminEmail,
          inviterMembershipId: actorUserId,
          tokenHash: `pending-${account.id}-${Date.now()}`,
          status: "pending",
          expiresAt,
        });
        return {
          id: row.id,
          tenantAccountId: row.tenantAccountId,
          firstAdminEmail: row.inviteeEmail,
          status: row.status,
          issuedAt: isoReq(row.issuedAt),
          expiresAt: iso(row.expiresAt),
        };
      });
    },

    async revokeInvitation(invitationId) {
      return inPlatformCtx("platform-ops revoke invitation", async (tx) => {
        const [existing] = await tx
          .select()
          .from(schema.tenantInvitation)
          .where(eq(schema.tenantInvitation.id, invitationId))
          .limit(1);
        if (!existing) throw new NotFoundError("tenant invitation");
        await new TenantAccountRepository(tx).updateInvitationStatus(invitationId, {
          status: "revoked",
        });
        return { id: invitationId, status: "revoked" as const };
      });
    },

    // ── key-ring (§3.5 metadata-only; ciphertext NEVER projected) ──
    async getKeyRingMetadata(orgSlug): Promise<KeyRingMetadataView> {
      return inPlatformCtx("platform-ops key-ring metadata", async (tx) => {
        const { account } = await loadByOrgSlug(tx, orgSlug);
        const kr = await new TenantKeyRingRepository(tx).findByTenantAccountId(account.id);
        if (!kr) throw new NotFoundError("tenant key ring");
        const prior = Array.isArray(kr.priorDekVersions) ? kr.priorDekVersions.length : 0;
        return {
          id: kr.id,
          tenantAccountId: kr.tenantAccountId,
          currentDekVersion: kr.currentDekVersion,
          currentDekKekId: kr.currentDekKekId ?? "",
          priorDekVersionCount: prior,
          dekCreatedAt: isoReq(kr.dekCreatedAt ?? account.createdAt),
          dekLastRotatedAt: iso(kr.dekLastRotatedAt),
          destroyedAt: iso(kr.destroyedAt),
          destructionCertificateId: kr.destructionCertificateId ?? null,
        };
      });
    },

    // ── onboarding-templates (platform-shared catalog) ──
    async listOnboardingTemplates(cursor, limit): Promise<CursorPage<OnboardingTemplateView>> {
      return inPlatformCtx("platform-ops list onboarding templates", async (tx) => {
        const rows = await new OnboardingRepository(tx).listTemplates();
        const views = rows.map((t) => ({
          id: t.key,
          key: t.key,
          title: t.displayLabel,
          canonicalOrder: t.canonicalOrder,
          isCanonical: t.isCanonical,
          createdAt: isoReq(t.createdAt),
        }));
        // catalog is small + canonical-ordered; sort DESC by (createdAt,id) for keyset.
        const sorted = [...views].sort((a, b) =>
          a.createdAt === b.createdAt ? (a.id < b.id ? 1 : -1) : a.createdAt < b.createdAt ? 1 : -1,
        );
        return paginate(sorted, cursor, limit);
      });
    },

    async upsertOnboardingTemplate(actorUserId, args): Promise<OnboardingTemplateView> {
      return inPlatformCtx("platform-ops upsert onboarding template", async (tx) => {
        const T = schema.onboardingTaskTemplate;
        const [row] = await tx
          .insert(T)
          .values({
            key: args.key,
            displayLabel: args.title,
            description: args.description ?? "",
            canonicalOrder: args.canonicalOrder,
            // The route DTO does not carry requiredRole / defaultDueDays — default on first insert
            // (preserved on update: the onConflictDoUpdate set below intentionally omits them).
            requiredRole: "platform_ops",
            defaultDueDaysAfterProvisioning: 0,
            isCanonical: args.isCanonical,
          })
          .onConflictDoUpdate({
            target: T.key,
            set: {
              displayLabel: args.title,
              description: args.description ?? "",
              canonicalOrder: args.canonicalOrder,
              isCanonical: args.isCanonical,
            },
          })
          .returning();
        if (!row) throw new Error("onboarding_task_template upsert returned no row");
        void actorUserId;
        return {
          id: row.key,
          key: row.key,
          title: row.displayLabel,
          canonicalOrder: row.canonicalOrder,
          isCanonical: row.isCanonical,
          createdAt: isoReq(row.createdAt),
        };
      });
    },

    // ── support sessions (§7.4; F01/D8/D16) ──
    async listSessions(filter, cursor, limit): Promise<CursorPage<SupportSessionView>> {
      return inPlatformCtx("platform-ops list support sessions", async (tx) => {
        const rows = await tx
          .select({ s: SS, grant: SCG })
          .from(SS)
          .innerJoin(SCG, eq(SS.supportConsentGrantId, SCG.id))
          .orderBy(desc(SS.startedAt), desc(SS.id));
        const now = deps.supportSessionPorts.now();
        const views: SupportSessionView[] = rows
          .filter((r) =>
            filter.tenantAccountId ? r.grant.tenantAccountId === filter.tenantAccountId : true,
          )
          .map((r) => sessionView(r.s, r.grant, now))
          .filter((v) => (filter.status ? v.status === filter.status : true));
        const withCursor = views.map((v) => ({ ...v, createdAt: v.startedAt }));
        const p = paginate(withCursor, cursor, limit);
        return { ...p, items: p.items.map(({ createdAt: _c, ...v }) => v) };
      });
    },

    async listSessionEvents(
      sessionId,
      cursor,
      limit,
    ): Promise<CursorPage<SupportSessionEventView>> {
      return inPlatformCtx("platform-ops list support session events", async (tx) => {
        const session = await new SupportRepository(tx).findSessionById(sessionId);
        if (!session) throw new NotFoundError("support session");
        const rows = await new SupportRepository(tx).listSessionEvents(sessionId, { limit: 200 });
        const views = rows.map((e) => ({
          id: e.id,
          supportSessionId: e.supportSessionId,
          eventKind: e.eventKind,
          resourceKind: e.resourceKind ?? null,
          resourceId: e.resourceId ?? null,
          occurredAt: isoReq(e.occurredAt),
          actorIp: e.actorIp ?? null,
          createdAt: isoReq(e.occurredAt),
        }));
        const p = paginate(views, cursor, limit);
        return { ...p, items: p.items.map(({ createdAt: _c, ...v }) => v) };
      });
    },

    async startSession(args: StartSupportSessionArgs) {
      return inPlatformCtx("platform-ops start support session", async (tx) => {
        // The pure §7.4 service enforces the active-grant + D16 distinct-actor invariants and writes the
        // session + opening ledger event + critical audit + outbox + grantor alert through the tx-bound ports.
        const res = await startSupportSession(supportDeps(tx), {
          organizationId: args.organizationId,
          supportConsentGrantId: args.supportConsentGrantId,
          actorMembershipId: args.actorMembershipId,
          actorIp: args.actorIp,
        });
        return { sessionId: res.sessionId, expiresAt: isoReq(res.expiresAt) };
      });
    },

    async elevateSession(args: ElevateSupportSessionArgs) {
      return inPlatformCtx("platform-ops elevate support session", async (tx) => {
        const res = await elevateSupportSession(supportDeps(tx), {
          organizationId: args.organizationId,
          supportSessionId: args.supportSessionId,
          actorMembershipId: args.actorMembershipId,
          actorIp: args.actorIp,
        });
        return { elevationExpiresAt: isoReq(res.elevationExpiresAt) };
      });
    },

    async closeSession(args: CloseSupportSessionArgs) {
      return inPlatformCtx("platform-ops close support session", async (tx) => {
        const repo = new SupportRepository(tx);
        const session = await repo.findSessionById(args.supportSessionId);
        if (!session) throw new NotFoundError("support session");
        const now = deps.supportSessionPorts.now();
        await repo.closeSession(session.id, { closedAt: now, closeReason: "manual" });
        await repo.appendSessionEvent({
          organizationId: args.organizationId,
          supportSessionId: session.id,
          eventKind: "session.close",
          occurredAt: now,
          actorIp: args.actorIp,
        });
        return { sessionId: session.id, closeReason: "manual" };
      });
    },

    // ── signup intents (§4.1; F02 / ADR-0010 — org-less, withPlatformContext) ──
    async listSignupIntents(filter, cursor, limit): Promise<CursorPage<SignupIntentView>> {
      return inPlatformCtx("platform-ops list signup intents", async (tx) => {
        const rows = await new SignupIntentRepository(tx).listIntents();
        const views = rows
          .filter((i) => (filter.status ? i.intentStatus === filter.status : true))
          .filter((i) => (filter.source ? i.source === filter.source : true))
          .map((i) => ({
            id: i.id,
            contactEmail: i.contactEmail,
            legalBusinessName: i.legalBusinessName,
            intendedFirstAdminEmail: i.intendedFirstAdminEmail,
            intentStatus: i.intentStatus,
            source: i.source,
            rejectionReason: i.rejectionReason ?? null,
            receivedAt: isoReq(i.receivedAt),
            processedAt: iso(i.processedAt),
            tenantAccountId: i.tenantAccountId ?? null,
            createdAt: isoReq(i.receivedAt),
          }));
        const p = paginate(views, cursor, limit);
        return { ...p, items: p.items.map(({ createdAt: _c, ...v }) => v) };
      });
    },

    async qualifyIntent(intentId, actorMembershipId, args) {
      return inPlatformCtx("platform-ops qualify signup intent", async (tx) => {
        const repo = new SignupIntentRepository(tx);
        const intent = await repo.findIntentById(intentId);
        if (!intent) throw new NotFoundError("signup intent");
        if (intent.intentStatus !== "new") {
          throw new WardenXError(
            "ILLEGAL_INTENT_TRANSITION",
            `intent cannot qualify from '${intent.intentStatus}'`,
            409,
          );
        }
        const tenantAccountId = intentId;
        const organizationId = intentId;
        await deps.organizations.ensure({
          organizationId,
          tenantAccountId,
          legalBusinessName: intent.legalBusinessName,
        });
        await new TenantAccountRepository(tx).create({
          id: tenantAccountId,
          organizationId,
          status: "provisioning",
          planLabel: args.planLabel,
          legalBusinessName: intent.legalBusinessName,
          billingContactEmail: intent.contactEmail,
          breachNotificationEmail: intent.contactEmail,
          createdByMembershipId: actorMembershipId,
        });
        await new TenantAccountRepository(tx).appendStatusEvent({
          tenantAccountId,
          organizationId,
          fromStatus: "signup_intent",
          toStatus: "provisioning",
          transitionReason: "platform operator qualified signup intent",
          actorMembershipId,
          actorKind: "platform_ops",
          sideEffectsRecorded: { queue: "tenant.provision" },
        });
        await repo.updateIntent(intentId, {
          intentStatus: "qualified",
          processedAt: deps.supportSessionPorts.now(),
          tenantAccountId,
        });
        const provisionJob = {
          tenantAccountId,
          organizationId,
          legalBusinessName: intent.legalBusinessName,
          billingContactEmail: intent.contactEmail,
          firstAdminEmail: intent.intendedFirstAdminEmail,
          firstAdminFullName: args.firstAdminFullName,
          actorMembershipId,
          transitionReason: "platform operator qualified signup intent",
        };
        const { jobId } = await deps.enqueue.enqueue("tenant.provision", intentId, provisionJob);
        await deps.outbox.publish(tx, {
          eventName: "m34.tenant.provision_started",
          organizationId,
          aggregateKind: "tenant_account",
          aggregateId: tenantAccountId,
          payload: provisionJob,
        });
        return { intentId, intentStatus: "qualified", jobId };
      });
    },

    async rejectIntent(intentId, actorUserId, args) {
      return inPlatformCtx("platform-ops reject signup intent", async (tx) => {
        const repo = new SignupIntentRepository(tx);
        const intent = await repo.findIntentById(intentId);
        if (!intent) throw new NotFoundError("signup intent");
        if (intent.intentStatus !== "new") {
          throw new WardenXError(
            "ILLEGAL_INTENT_TRANSITION",
            `intent cannot reject from '${intent.intentStatus}'`,
            409,
          );
        }
        await repo.updateIntent(intentId, {
          intentStatus: "rejected",
          rejectionReason: args.rejectionReason,
          processedAt: deps.supportSessionPorts.now(),
        });
        void actorUserId;
        return { intentId, intentStatus: "rejected" };
      });
    },

    // ── platform-tenant BAA register (§3.8 / D11) ──
    async listBaaRecords(filter, cursor, limit): Promise<CursorPage<BaaRecordView>> {
      return inPlatformCtx("platform-ops list BAA records", async (tx) => {
        const rows = await tx.select().from(BAA).orderBy(desc(BAA.executedOn), desc(BAA.id));
        const views: BaaRecordView[] = rows
          .filter((b) =>
            filter.tenantAccountId ? b.tenantAccountId === filter.tenantAccountId : true,
          )
          .filter((b) => (filter.status ? b.baaStatus === filter.status : true))
          .map(baaView);
        const withCursor = views.map((v) => ({
          ...v,
          createdAt: v.executedOn ?? v.effectiveOn ?? "0000-00-00",
        }));
        const p = paginate(withCursor, cursor, limit);
        return { ...p, items: p.items.map(({ createdAt: _c, ...v }) => v) };
      });
    },

    async createBaaRecord(actorUserId, args: CreateBaaRecordArgs): Promise<BaaRecordView> {
      return inPlatformCtx("platform-ops create BAA record", async (tx) => {
        const repo = new BaaRegisterRepository(tx);
        const existing = await repo.listByTenantAccountId(args.tenantAccountId);
        if (existing.some((b) => b.addendumVersion === args.addendumVersion)) {
          throw new WardenXError(
            "DUPLICATE_BAA_RECORD",
            "a BAA record for this addendum version exists",
            409,
          );
        }
        // organizationId is resolved from the tenant_account spine.
        const account = await new TenantAccountRepository(tx).findById(args.tenantAccountId);
        if (!account) throw new NotFoundError("tenant account");
        const row = await repo.create({
          organizationId: account.organizationId,
          tenantAccountId: args.tenantAccountId,
          addendumVersion: args.addendumVersion,
          baaStatus: args.baaStatus as schema.PlatformTenantBaaRecord["baaStatus"],
          executedOn: args.executedOn,
          effectiveOn: args.effectiveOn,
          expiresOn: args.expiresOn,
          breachNotificationContactEmail: args.breachNotificationContactEmail,
          breachNotificationContactPhone: args.breachNotificationContactPhone,
        });
        void actorUserId;
        return baaView(row);
      });
    },

    async updateBaaRecord(baaId, actorUserId, args: UpdateBaaRecordArgs): Promise<BaaRecordView> {
      return inPlatformCtx("platform-ops update BAA record", async (tx) => {
        const repo = new BaaRegisterRepository(tx);
        const existing = await repo.findById(baaId);
        if (!existing) throw new NotFoundError("platform-tenant BAA record");
        const row = await repo.update(baaId, {
          baaStatus: args.baaStatus as schema.PlatformTenantBaaRecord["baaStatus"] | undefined,
          executedOn: args.executedOn,
          effectiveOn: args.effectiveOn,
          expiresOn: args.expiresOn,
          breachNotificationContactEmail: args.breachNotificationContactEmail,
          breachNotificationContactPhone: args.breachNotificationContactPhone,
          documentId: args.documentId,
        });
        void actorUserId;
        return baaView(row);
      });
    },

    // ── tenant export: SEC-052 oversized-hold release (§3.7; GAP-097) ──
    // ── tenant export: the cross-tenant platform-ops list (§4.1; GAP-098) ──
    //
    // Unlike the sibling lists on this surface, this one paginates IN SQL (`listPlatformPage`'s keyset)
    // rather than fetching every row and slicing in memory. `tenant_export_job` grows without bound
    // across every tenant, and the `held` filter's predicate is a correlated EXISTS over the partitioned
    // ledger — running that over the whole table to then throw most of it away is the one place on this
    // surface where the in-memory-paginate shortcut would actually hurt. The cursor CODEC is the shared
    // one, so the wire shape matches every other platform list.
    async listTenantExportJobs(filter, cursor, limit): Promise<CursorPage<TenantExportJobView>> {
      return inPlatformCtx("platform-ops list tenant export jobs", async (tx) => {
        const repo = new TenantExportRepository(tx);
        const size = pageSizeOf(limit);
        const keyset = cursor ? decodeCursor(cursor) : undefined;
        // limit + 1 so `hasMore` is answered by the read itself, never by a second count query.
        const rows = await repo.listPlatformPage({
          organizationId: filter.organizationId,
          status: filter.status as schema.TenantExportJob["status"] | undefined,
          heldOnly: filter.held === true,
          cursor: keyset ? { requestedAt: new Date(keyset.createdAt), id: keyset.id } : undefined,
          limit: size + 1,
        });
        const hasMore = rows.length > size;
        const page = hasMore ? rows.slice(0, size) : rows;
        const holds = await repo.holdStateForJobs(page.map((r) => r.id));

        const items: TenantExportJobView[] = page.map((job) => {
          const event = holds.get(job.id);
          // The FLAG and the `held` FILTER must agree — both halves, same as the repo predicate.
          const held = event !== undefined && job.status === "generating";
          const receipt = (held ? (event?.shardReceipt ?? {}) : {}) as {
            bundleSizeBytes?: number;
            recordCount?: number;
          };
          return {
            id: job.id,
            organizationId: job.organizationId,
            requestedPurpose: job.requestedPurpose,
            status: job.status,
            requestedAt: job.requestedAt.toISOString(),
            fulfilledAt: job.fulfilledAt?.toISOString() ?? null,
            heldForOversizedApproval: held,
            // Stringified, not narrowed to a JS number: an oversized bundle is past 2^31 by definition
            // and the column is bigint-as-text for exactly that reason (GAP-097 / migration 0195).
            heldBundleSizeBytes:
              typeof receipt.bundleSizeBytes === "number" ? String(receipt.bundleSizeBytes) : null,
            heldRecordCount: typeof receipt.recordCount === "number" ? receipt.recordCount : null,
            heldAt: held ? (event?.occurredAt.toISOString() ?? null) : null,
            bundleSizeBytes: job.bundleSizeBytes,
            bundleDownloadedAt: job.bundleDownloadedAt?.toISOString() ?? null,
          };
        });
        const last = page[page.length - 1];
        return {
          items,
          nextCursor:
            hasMore && last
              ? encodeCursor({ createdAt: last.requestedAt.toISOString(), id: last.id })
              : null,
          hasMore,
        };
      });
    },

    async approveOversizedExport(jobId, actorMembershipId, args) {
      return inPlatformCtx("platform-ops approve oversized tenant export", async (tx) => {
        const repo = new TenantExportRepository(tx);
        const job = await repo.findById(jobId);
        if (!job) throw new NotFoundError("tenant export job");
        // The newest ledger event must be GAP-094's `oversized_hold` row — the same check confirms
        // the job hasn't already been approved (approval appends a newer `oversized_approved` event
        // and flips status off `generating`, so a re-approve attempt fails this the same way an
        // unheld job does).
        const [latest] = await repo.listEvents(jobId, { limit: 1 });
        if (job.status !== "generating" || latest?.eventKind !== "oversized_hold") {
          throw new WardenXError(
            "TENANT_EXPORT_NOT_HELD",
            "the bundle is not awaiting oversized-hold approval",
            409,
          );
        }
        const receipt = (latest.shardReceipt ?? {}) as {
          bundleMinioObjectKey?: string;
          bundleSha256?: string;
          bundleSizeBytes?: number;
        };
        if (
          !receipt.bundleMinioObjectKey ||
          !receipt.bundleSha256 ||
          typeof receipt.bundleSizeBytes !== "number"
        ) {
          throw new WardenXError(
            "TENANT_EXPORT_HOLD_INCOMPLETE",
            "the hold event is missing its bundle artifact handles",
            409,
          );
        }
        const now = deps.supportSessionPorts.now();
        await repo.update(jobId, {
          status: "fulfilled",
          fulfilledAt: now,
          bundleMinioObjectKey: receipt.bundleMinioObjectKey,
          bundleSha256: receipt.bundleSha256,
          bundleSizeBytes: String(receipt.bundleSizeBytes),
          bundlePresignedUrlExpiresAt: new Date(now.getTime() + TENANT_EXPORT_OBJECT_TTL_MS),
        });
        await repo.appendEvent({
          organizationId: job.organizationId,
          tenantExportJobId: jobId,
          eventKind: "oversized_approved",
          shardReceipt: {
            approvalReason: args.approvalReason,
            approvedByMembershipId: actorMembershipId,
          },
          occurredAt: now,
        });
        return { jobId, status: "fulfilled" };
      });
    },

    // ── feature-flag admin (§4.7 / D13 — delegates to M1's FeatureFlagAdmin seam) ──
    async listFeatureFlags(filter, cursor, limit): Promise<CursorPage<FeatureFlagView>> {
      const rows = await deps.featureFlags.list(filter.organizationId ?? null, filter.flagKind);
      const withCursor = rows.map((f) => ({ ...f, id: f.id, createdAt: f.updatedAt }));
      const sorted = [...withCursor].sort((a, b) =>
        a.createdAt === b.createdAt ? (a.id < b.id ? 1 : -1) : a.createdAt < b.createdAt ? 1 : -1,
      );
      const p = paginate(sorted, cursor, limit);
      return { ...p, items: p.items.map(({ createdAt: _c, ...v }) => v) };
    },

    async upsertFeatureFlag(actorUserId, args): Promise<FeatureFlagView> {
      return deps.featureFlags.upsert(actorUserId, args);
    },

    async setKillSwitch(actorUserId, args): Promise<FeatureFlagView> {
      return deps.featureFlags.setKillSwitch(actorUserId, args);
    },
  };

  return { service };
}

// ── projection + mapping helpers ─────────────────────────────────────────────────────────────────────

function baaView(b: schema.PlatformTenantBaaRecord): BaaRecordView {
  return {
    id: b.id,
    organizationId: b.organizationId,
    tenantAccountId: b.tenantAccountId,
    addendumVersion: b.addendumVersion,
    baaStatus: b.baaStatus,
    executedOn: dateOnly(b.executedOn),
    effectiveOn: dateOnly(b.effectiveOn),
    expiresOn: dateOnly(b.expiresOn),
    documentId: b.documentId ?? null,
    attestedAt: b.attestedAt ? b.attestedAt.toISOString() : null,
  };
}

function sessionView(
  s: schema.SupportSession,
  grant: schema.SupportConsentGrant,
  now: Date,
): SupportSessionView {
  const status: SupportSessionView["status"] =
    s.closedAt !== null ? "closed" : s.expiresAt <= now ? "expired" : "open";
  return {
    id: s.id,
    organizationId: s.organizationId,
    supportConsentGrantId: s.supportConsentGrantId,
    tenantAccountId: grant.tenantAccountId,
    actorMembershipId: s.actorMembershipId,
    startedAt: s.startedAt.toISOString(),
    expiresAt: s.expiresAt.toISOString(),
    closedAt: s.closedAt ? s.closedAt.toISOString() : null,
    closeReason: s.closeReason ?? null,
    status,
  };
}

/** `date`-typed columns round-trip as ISO `YYYY-MM-DD` strings (Drizzle `date` mode). */
function dateOnly(v: string | Date | null): string | null {
  if (v === null) return null;
  return typeof v === "string" ? v : v.toISOString().slice(0, 10);
}

/** Map a target lifecycle status to the §2.2 event that reaches it (the platform transition route). */
function lifecycleEventForStatus(toStatus: string, reason: string): LifecycleEvent {
  const k: LifecycleActorKind = "platform_ops";
  switch (toStatus) {
    case "suspended":
      return { type: "suspend", actorKind: k, transitionReason: reason };
    case "active":
      // reactivate is the only platform-ops path to `active` post-onboarding.
      return { type: "reactivate", actorKind: k, transitionReason: reason };
    case "at_risk":
      return { type: "flagAtRisk", actorKind: k, transitionReason: reason };
    default:
      throw new WardenXError(
        "ILLEGAL_TENANT_TRANSITION",
        `no platform-ops transition reaches status '${toStatus}'`,
        409,
      );
  }
}
