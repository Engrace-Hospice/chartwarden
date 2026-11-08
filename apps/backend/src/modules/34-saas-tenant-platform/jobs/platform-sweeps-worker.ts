// apps/backend/src/modules/34-saas-tenant-platform/jobs/platform-sweeps-worker.ts — GAP-163.
//
// The three remaining §4.3 consumers (the bundle reaper is in ./bundle-expiry-worker.ts):
//   • tenant.baa_expiry_sweep          — daily BAA renewal radar (§7.5 step 4); PLATFORM-scoped (cross-tenant read)
//   • tenant.support_session_close_sweep — every 5 min, closes support sessions past their TTL (§7.4 step 6); PLATFORM-scoped
//   • tenant.onboarding_advance        — per-tenant advance pass + a daily fan-out over `onboarding` tenants; ORG-scoped
//
// The package services (`runBaaExpirySweep`, `closeExpiredSupportSessions`, `runOnboardingAdvance`) hold the logic;
// this file binds their ports. Platform sweeps run inside ONE audited `withPlatformContext` transaction and publish
// their outbox events in that same transaction (the event commits atomically with the write). The pure `run*`
// functions take plain dependency bags so they are unit-testable without a database.
import { randomUUID } from "node:crypto";
import { auditPlatformEvent } from "@chartwarden/audit";
import { type DbClient, schema } from "@chartwarden/db";
import {
  type BaaExpirySweepResult,
  BaaRegisterRepository,
  type ExpiredSessionCandidate,
  type OnboardingAdvanceReport,
  OnboardingRepository,
  SupportRepository,
  type SupportSessionServiceDeps,
  type SupportSessionSweepResult,
  closeExpiredSupportSessions,
  runBaaExpirySweep,
  runOnboardingAdvance,
} from "@chartwarden/saas-tenant-platform";
import {
  type PlatformBypassAuditor,
  withOrgContext,
  withPlatformContext,
} from "@chartwarden/tenancy";
import { type ConnectionOptions, Queue, Worker } from "bullmq";
import { and, desc, eq, inArray, isNull, lte } from "drizzle-orm";
import { pickGoverningBaa } from "../routes/platform/activation-guards";
import { M34_JOB_SCHEDULES, M34_QUEUES } from "./index";

/**
 * The M36 alert event the stuck-activation rule is keyed on (alert-rules.ts). Retained as the seeded rule's name only:
 * nothing raises it since go-live became a two-party approval (the sweep no longer attempts to activate anything).
 * Follow-up: retire the rule and the refusal-streak helpers together.
 */
export const M34_ACTIVATION_STUCK_EVENT = "m34.tenant.onboarding_activation_stuck";

const PLATFORM_JOB_ID = "m34.platform_ops";
const SYSTEM_USER_ID = "";

/** The outbox publisher shape both platform sweeps and onboarding use (tx-scoped, catalog-validated). */
export interface M34SweepOutbox {
  publish(
    tx: DbClient,
    input: {
      readonly eventName: string;
      readonly payload: Record<string, unknown>;
      readonly organizationId: string;
      readonly aggregateKind: string;
      readonly aggregateId: string;
    },
  ): Promise<void>;
}

/** The M36 emitter slice the sweeps raise alerts through. */
export interface M34SweepAlerts {
  emit(
    orgId: string,
    input: {
      eventType: string;
      payload: Record<string, unknown>;
      severity: "info" | "warn" | "critical";
      correlationId: string;
    },
  ): Promise<unknown>;
}

// ── BAA expiry sweep ─────────────────────────────────────────────────────────────────────────────────

type BaaRecordLike = Awaited<ReturnType<BaaRegisterRepository["listByExpiry"]>>[number];

export interface BaaSweepDeps {
  readonly listRecords: () => Promise<readonly BaaRecordLike[]>;
  /** Publish one `m34.baa.platform_tenant_expiring` for the record's org. */
  readonly publish: (organizationId: string, payload: Record<string, unknown>) => Promise<void>;
  readonly now: () => Date;
}

/** Run one BAA sweep over injected ports (the org of each event is carried by the record it came from). */
export async function runBaaExpiryCron(deps: BaaSweepDeps): Promise<BaaExpirySweepResult> {
  const orgByTenant = new Map<string, string>();
  return runBaaExpirySweep({
    baaRegister: {
      listByExpiry: async () => {
        const records = await deps.listRecords();
        for (const r of records) orgByTenant.set(r.tenantAccountId, r.organizationId);
        return records;
      },
    },
    outbox: {
      publishBaaExpiring: async (payload) => {
        const organizationId = orgByTenant.get(payload.tenantAccountId);
        if (!organizationId) throw new Error("baa sweep: no organization for tenant account");
        await deps.publish(organizationId, { ...payload });
      },
    },
    now: deps.now,
  });
}

// ── support-session close sweep ──────────────────────────────────────────────────────────────────────

export interface SupportCloseDeps {
  readonly candidates: readonly ExpiredSessionCandidate[];
  readonly serviceDeps: (orgBySession: ReadonlyMap<string, string>) => SupportSessionServiceDeps;
}

/** Run one close sweep over a pre-loaded candidate set. */
export async function runSupportSessionCloseCron(
  deps: SupportCloseDeps,
): Promise<SupportSessionSweepResult> {
  const orgBySession = new Map(deps.candidates.map((c) => [c.sessionId, c.organizationId]));
  return closeExpiredSupportSessions(deps.serviceDeps(orgBySession), deps.candidates);
}

async function loadExpiredSessionCandidates(
  tx: DbClient,
  now: Date,
): Promise<readonly ExpiredSessionCandidate[]> {
  const S = schema.supportSession;
  const G = schema.supportConsentGrant;
  const rows = await tx
    .select({
      sessionId: S.id,
      organizationId: S.organizationId,
      supportConsentGrantId: S.supportConsentGrantId,
      tenantAccountId: G.tenantAccountId,
      grantorMembershipId: G.grantorMembershipId,
      actorMembershipId: S.actorMembershipId,
      expiresAt: S.expiresAt,
    })
    .from(S)
    .innerJoin(G, eq(G.id, S.supportConsentGrantId))
    .where(and(isNull(S.closedAt), lte(S.expiresAt, now)));
  return rows;
}

// ── onboarding advance ───────────────────────────────────────────────────────────────────────────────

export interface OnboardingFactReaders {
  /** M1/M2 spine facts (`bootstrap/org-spine-facts.ts`): provider entities + CCNs and the location count. */
  readonly orgSeed?: (orgId: string) => Promise<{
    readonly providerEntities: readonly {
      readonly providerEntityId: string;
      readonly ccn: string;
    }[];
    readonly locationCount: number;
  }>;
  /** Active `org_admin` memberships in the org. */
  readonly orgAdminCount?: (orgId: string) => Promise<number>;
  /** M29/M27/M12 attestation facts with no M34-reachable table; absent ⇒ false (the step stays blocked, honestly). */
  readonly macFeedConfigured?: (orgId: string) => Promise<boolean>;
  /** M23 (ADR-0053 amendment 2026-11-06): the org's clearinghouse choice is settled (`outside`, or a vendor in `active` status). */
  readonly clearinghouseSettled?: (orgId: string) => Promise<boolean>;
  readonly dosespotKickoffRecorded?: (orgId: string) => Promise<boolean>;
  readonly xeroConnected?: (orgId: string) => Promise<boolean>;
  readonly gustoConnected?: (orgId: string) => Promise<boolean>;
}

/** Gather the §2.3 context: spine facts through injected readers (arch:tables), the M34 BAA register + task rows here. */
export async function gatherOnboardingContext(
  tx: DbClient,
  input: { tenantAccountId: string; orgId: string },
  readers: OnboardingFactReaders,
  repo: OnboardingRepository,
) {
  const { orgId, tenantAccountId } = input;
  const seed = readers.orgSeed
    ? await readers.orgSeed(orgId)
    : { providerEntities: [], locationCount: 0 };
  const adminCount = readers.orgAdminCount ? await readers.orgAdminCount(orgId) : 0;
  // The governing BAA (not rows[0]: the register lists `executed_on DESC`, which puts an undated pending renewal first).
  const latestBaa = pickGoverningBaa(
    await new BaaRegisterRepository(tx).listByTenantAccountId(tenantAccountId),
  );
  const [account] = await tx
    .select({ officer: schema.tenantAccount.complianceOfficerMembershipId })
    .from(schema.tenantAccount)
    .where(eq(schema.tenantAccount.id, tenantAccountId))
    .limit(1);
  const templates = await repo.listTemplates();
  const tasks = await repo.listTasksByTenant(tenantAccountId);
  const canonical = templates.filter((t) => t.isCanonical && !t.isOptional);
  const settled = new Set(
    tasks.filter((t) => t.status === "done" || t.status === "skipped").map((t) => t.templateKey),
  );
  const read = (fn?: (o: string) => Promise<boolean>) => (fn ? fn(orgId) : Promise.resolve(false));
  return {
    providerEntityCount: seed.providerEntities.length,
    locationCount: seed.locationCount,
    providerEntities: seed.providerEntities,
    // `location` carries no primary flag in the M2 schema; "at least one location" is the strongest fact.
    primaryLocationExists: seed.locationCount > 0,
    orgAdminAcceptedMembershipCount: adminCount,
    macFeedConfigured: await read(readers.macFeedConfigured),
    clearinghouseSettled: await read(readers.clearinghouseSettled),
    dosespotKickoffRecorded: await read(readers.dosespotKickoffRecorded),
    xeroConnected: await read(readers.xeroConnected),
    gustoConnected: await read(readers.gustoConnected),
    complianceOfficerAssigned: Boolean(account?.officer),
    baaExecuted: latestBaa?.baaStatus === "executed",
    allCanonicalTasksDoneOrSkipped: canonical.every((t) => settled.has(t.key)),
  };
}

export interface OnboardingFanOutDeps {
  readonly listOnboardingTenants: () => Promise<
    readonly { readonly tenantAccountId: string; readonly orgId: string }[]
  >;
  readonly advance: (input: {
    tenantAccountId: string;
    orgId: string;
  }) => Promise<OnboardingAdvanceReport>;
  readonly warn?: (message: string, context: Record<string, unknown>) => void;
}

/** The daily sweep: one advance pass per `onboarding` tenant; a failing tenant never stops the rest. */
export async function runOnboardingFanOut(
  deps: OnboardingFanOutDeps,
): Promise<{ tenants: number; failed: number }> {
  const tenants = await deps.listOnboardingTenants();
  let failed = 0;
  for (const t of tenants) {
    try {
      await deps.advance(t);
    } catch (error) {
      failed += 1;
      deps.warn?.("m34.onboarding_advance: tenant pass failed", {
        tenantAccountId: t.tenantAccountId,
        err: error,
      });
    }
  }
  return { tenants: tenants.length, failed };
}

// ── organization activation reconcile ────────────────────────────────────────────────────────────────

/** A tenant that went live (an approved go-live attestation) whose M2 organization is still `created`. */
export interface PendingOrganizationActivation {
  readonly organizationId: string;
  readonly tenantAccountId: string;
  /** The operator who approved the go-live: the reconcile completes THEIR approval, so it is attributed to them. */
  readonly approvedByUserId: string;
  readonly approvedByMembershipId: string;
}

export interface OrganizationActivationReconcileDeps {
  readonly listPending: () => Promise<readonly PendingOrganizationActivation[]>;
  /** M2's lifecycle activation through a port (M34 does not import M2); a no-op on an organization that is already open. */
  readonly activate: (input: {
    organizationId: string;
    operatorUserId: string;
    operatorMembershipId: string;
    reason: string;
  }) => Promise<void>;
  /** The system-job audit entry for one organization this pass opened. */
  readonly recordReconciled: (entry: PendingOrganizationActivation) => Promise<void>;
  readonly warn?: (message: string, context: Record<string, unknown>) => void;
}

const RECONCILE_REASON =
  "go-live approved earlier; completing the organization activation (daily onboarding reconcile)";

/**
 * Approval flips the tenant to `active` and then, in a separate M2 transaction, opens the organization. If that second step
 * fails the tenant is live but its organization stays on the onboarding allowlist; repeating the approval fixes it by hand,
 * and this pass fixes it without anyone noticing. One failing organization never stops the rest.
 */
export async function runOrganizationActivationReconcile(
  deps: OrganizationActivationReconcileDeps,
): Promise<{ pending: number; activated: number; failed: number }> {
  const pending = await deps.listPending();
  let activated = 0;
  let failed = 0;
  for (const entry of pending) {
    try {
      await deps.activate({
        organizationId: entry.organizationId,
        operatorUserId: entry.approvedByUserId,
        operatorMembershipId: entry.approvedByMembershipId,
        reason: RECONCILE_REASON,
      });
      await deps.recordReconciled(entry);
      activated += 1;
    } catch (error) {
      failed += 1;
      deps.warn?.("m34.onboarding_advance: organization activation reconcile failed", {
        tenantAccountId: entry.tenantAccountId,
        organizationId: entry.organizationId,
        err: error,
      });
    }
  }
  return { pending: pending.length, activated, failed };
}

// ── live construction ────────────────────────────────────────────────────────────────────────────────

export interface PlatformSweepWorkerDeps {
  readonly connection: ConnectionOptions;
  /** Tenant-pool client (org-scoped onboarding work). */
  readonly db: DbClient;
  /** The audited platform-credential client for the cross-tenant sweeps. */
  readonly platformDb: DbClient;
  readonly auditBypass: PlatformBypassAuditor<DbClient>;
  readonly outbox: M34SweepOutbox;
  readonly alerts: M34SweepAlerts;
  readonly facts?: OnboardingFactReaders;
  /**
   * M2's activation of a `created` organization (the M2 lifecycle writer behind a port; M34 does not import M2). Bound, the
   * daily onboarding sweep also opens any organization whose tenant went live but whose organization was never activated.
   */
  readonly activateOrganization?: OrganizationActivationReconcileDeps["activate"];
  readonly now?: () => Date;
  readonly warn?: (message: string, context: Record<string, unknown>) => void;
  readonly info?: (message: string, context: Record<string, string>) => void;
}

function platformTx<T>(
  deps: Pick<PlatformSweepWorkerDeps, "platformDb" | "auditBypass">,
  reason: string,
  fn: (tx: DbClient) => Promise<T>,
): Promise<T> {
  return withPlatformContext(
    deps.platformDb,
    { jobId: PLATFORM_JOB_ID, reason, crossTenant: true },
    deps.auditBypass,
    (tx) => fn(tx as unknown as DbClient),
  );
}

/** Construct the `tenant.baa_expiry_sweep` Worker. */
export function registerM34BaaExpiryWorker(deps: PlatformSweepWorkerDeps): Worker {
  const now = deps.now ?? (() => new Date());
  return new Worker(
    M34_QUEUES.baaExpirySweep,
    () =>
      platformTx(deps, "m34 BAA expiry sweep", (tx) =>
        runBaaExpiryCron({
          listRecords: () => new BaaRegisterRepository(tx).listByExpiry(),
          publish: (organizationId, payload) =>
            deps.outbox.publish(tx, {
              eventName: "m34.baa.platform_tenant_expiring",
              payload,
              organizationId,
              aggregateKind: "platform_tenant_baa_record",
              aggregateId: String(payload.tenantAccountId),
            }),
          now,
        }),
      ),
    { connection: deps.connection, concurrency: 1 },
  );
}

/** Construct the `tenant.support_session_close_sweep` Worker. */
export function registerM34SupportSessionCloseWorker(deps: PlatformSweepWorkerDeps): Worker {
  const now = deps.now ?? (() => new Date());
  return new Worker(
    M34_QUEUES.supportSessionCloseSweep,
    () =>
      platformTx(deps, "m34 support-session close sweep", async (tx) =>
        runSupportSessionCloseCron({
          candidates: await loadExpiredSessionCandidates(tx, now()),
          serviceDeps: (orgBySession) => ({
            repo: new SupportRepository(tx),
            now,
            audit: {
              emitCriticalAudit: async (event) => {
                await auditPlatformEvent(tx, {
                  eventType: event.action,
                  resourceKind: "support_session",
                  resourceId: event.supportSessionId,
                  outcome: "success",
                  severity: "critical",
                  correlationId: `m34-support-close-${event.supportSessionId}`,
                  context: {
                    organizationId: event.organizationId,
                    actorMembershipId: event.actorMembershipId,
                    actorKind: event.actorKind,
                    ...(event.context ?? {}),
                  },
                });
              },
            },
            outbox: {
              publish: async (eventName, payload) => {
                const sessionId = String(payload.sessionId);
                const organizationId = orgBySession.get(sessionId);
                if (!organizationId) throw new Error("support close: no organization for session");
                await deps.outbox.publish(tx, {
                  eventName,
                  payload,
                  organizationId,
                  aggregateKind: "support_session",
                  aggregateId: sessionId,
                });
              },
            },
            alerts: {
              emitAlert: async (alert) => {
                // The grantor alert must never undo the close itself: a failed emit is logged, not thrown.
                try {
                  await deps.alerts.emit(alert.organizationId, {
                    eventType: alert.alertKey,
                    payload: { tenantAccountId: alert.tenantAccountId, ...(alert.context ?? {}) },
                    severity: "warn",
                    correlationId: `m34-support-close-${String(alert.context?.sessionId)}`,
                  });
                } catch (error) {
                  deps.warn?.("m34.support_session_close: grantor alert failed", {
                    organizationId: alert.organizationId,
                    err: error,
                  });
                }
              },
            },
          }),
        }),
      ),
    { connection: deps.connection, concurrency: 1 },
  );
}

/** What the advance pass needs (the sweep worker and the wizard's post-change settle share it). */
export interface OnboardingAdvanceDeps {
  /** Tenant-pool client (org-scoped onboarding work). */
  readonly db: DbClient;
  readonly outbox: M34SweepOutbox;
  readonly alerts: M34SweepAlerts;
  readonly facts?: OnboardingFactReaders;
  readonly now?: () => Date;
}

/**
 * One advance pass for a tenant, inside its own org transaction: settle `auto`/`either` steps whose fact now holds,
 * block an unmet `auto` step, raise overdue alerts. It never activates a tenant.
 */
export function createOnboardingAdvancer(
  deps: OnboardingAdvanceDeps,
): (input: { tenantAccountId: string; orgId: string }) => Promise<OnboardingAdvanceReport> {
  const now = deps.now ?? (() => new Date());
  return (input) =>
    withOrgContext(deps.db, { organizationId: input.orgId, userId: SYSTEM_USER_ID }, (rawTx) => {
      const tx = rawTx as unknown as DbClient;
      const repo = new OnboardingRepository(tx);
      return runOnboardingAdvance(input, {
        repo,
        now,
        gatherContext: (i) => gatherOnboardingContext(tx, i, deps.facts ?? {}, repo),
        publishOutbox: async (payload) => {
          const { event, ...rest } = payload;
          await deps.outbox.publish(tx, {
            eventName: event,
            payload: rest,
            organizationId: input.orgId,
            aggregateKind: "tenant_account",
            aggregateId: payload.tenantAccountId,
          });
        },
        routeAlert: async (alert) => {
          await deps.alerts.emit(input.orgId, {
            eventType: alert.alertKey,
            payload: { tenantAccountId: alert.tenantAccountId, templateKey: alert.templateKey },
            severity: "warn",
            correlationId: `m34-onboarding-${alert.alertKey}-${alert.tenantAccountId}-${alert.templateKey ?? "all"}-${now()
              .toISOString()
              .slice(0, 10)}`,
          });
        },
      });
    });
}

/** Tenants that are `active` with an approved go-live whose organization is still `created` (platform credential, cross-tenant). */
export function listPendingOrganizationActivations(
  deps: Pick<PlatformSweepWorkerDeps, "platformDb" | "auditBypass">,
): Promise<readonly PendingOrganizationActivation[]> {
  return platformTx(deps, "m34 onboarding reconcile (organizations still created)", async (tx) => {
    const rows = await tx
      .selectDistinctOn([schema.tenantAccount.id], {
        organizationId: schema.tenantAccount.organizationId,
        tenantAccountId: schema.tenantAccount.id,
        approvedByUserId: schema.tenantGoLiveAttestation.approvedByUserId,
        approvedByMembershipId: schema.tenantGoLiveAttestation.approvedByMembershipId,
      })
      .from(schema.tenantAccount)
      .innerJoin(
        schema.tenantGoLiveAttestation,
        and(
          eq(schema.tenantGoLiveAttestation.tenantAccountId, schema.tenantAccount.id),
          eq(schema.tenantGoLiveAttestation.status, "approved"),
        ),
      )
      .innerJoin(
        schema.organizations,
        eq(schema.organizations.id, schema.tenantAccount.organizationId),
      )
      .where(
        and(eq(schema.tenantAccount.status, "active"), eq(schema.organizations.status, "created")),
      )
      .orderBy(schema.tenantAccount.id, desc(schema.tenantGoLiveAttestation.approvedAt));
    return rows.flatMap((r) =>
      r.approvedByUserId && r.approvedByMembershipId
        ? [
            {
              ...r,
              approvedByUserId: r.approvedByUserId,
              approvedByMembershipId: r.approvedByMembershipId,
            },
          ]
        : [],
    );
  });
}

/** The system job's own audit entry for an organization it opened (the M2 transition audits itself, naming the approver). */
export function recordOrganizationActivationReconciled(
  deps: Pick<PlatformSweepWorkerDeps, "platformDb" | "auditBypass">,
  entry: PendingOrganizationActivation,
): Promise<void> {
  return platformTx(deps, "m34 onboarding reconcile (audit)", (tx) =>
    auditPlatformEvent(tx, {
      eventType: "m34.onboarding.organization_activation_reconciled",
      resourceKind: "tenant_account",
      resourceId: entry.tenantAccountId,
      outcome: "success",
      severity: "warn",
      correlationId: `m34-onboarding-reconcile:${entry.tenantAccountId}:${randomUUID()}`,
      context: {
        organizationId: entry.organizationId,
        approvedByUserId: entry.approvedByUserId,
        approvedByMembershipId: entry.approvedByMembershipId,
        actor: "system",
      },
    }),
  );
}

/** Construct the `tenant.onboarding_advance` Worker: a job with a tenant advances it; an empty tick fans out. */
export function registerM34OnboardingAdvanceWorker(deps: PlatformSweepWorkerDeps): Worker {
  const advance = createOnboardingAdvancer(deps);
  return new Worker(
    M34_QUEUES.onboardingAdvance,
    async (job) => {
      const data = job.data as { tenantAccountId?: string; orgId?: string };
      if (data.tenantAccountId && data.orgId) {
        return advance({ tenantAccountId: data.tenantAccountId, orgId: data.orgId });
      }
      const fanOut = await runOnboardingFanOut({
        listOnboardingTenants: () =>
          platformTx(deps, "m34 onboarding sweep (tenant enumeration)", async (tx) => {
            const rows = await tx
              .select({
                tenantAccountId: schema.tenantAccount.id,
                orgId: schema.tenantAccount.organizationId,
              })
              .from(schema.tenantAccount)
              .where(inArray(schema.tenantAccount.status, ["onboarding"]));
            return rows;
          }),
        advance,
        warn: deps.warn,
      });
      const activateOrganization = deps.activateOrganization;
      if (!activateOrganization) return fanOut;
      const organizations = await runOrganizationActivationReconcile({
        listPending: () => listPendingOrganizationActivations(deps),
        activate: activateOrganization,
        recordReconciled: (entry) => recordOrganizationActivationReconciled(deps, entry),
        warn: deps.warn,
      });
      return { ...fanOut, organizations };
    },
    { connection: deps.connection, concurrency: 4 },
  );
}

/** Daily onboarding fan-out cadence (06:00, ahead of the 07:00 BAA radar). */
export const M34_ONBOARDING_SWEEP_SCHEDULE = "0 6 * * *";

/** The three scheduled sweeps and their cron patterns (logged at registration, used to schedule them). */
export function describeM34SweepSchedules(): readonly {
  readonly sweep: "baa_expiry" | "support_session_close" | "onboarding_advance";
  readonly queue: string;
  readonly cron: string;
}[] {
  return [
    {
      sweep: "baa_expiry",
      queue: M34_QUEUES.baaExpirySweep,
      cron: M34_JOB_SCHEDULES.baaExpirySweep,
    },
    {
      sweep: "support_session_close",
      queue: M34_QUEUES.supportSessionCloseSweep,
      cron: M34_JOB_SCHEDULES.supportSessionCloseSweep,
    },
    {
      sweep: "onboarding_advance",
      queue: M34_QUEUES.onboardingAdvance,
      cron: M34_ONBOARDING_SWEEP_SCHEDULE,
    },
  ];
}

/** Register the three repeatable ticks; returns the schedule queues for the composition root to close. */
export async function scheduleM34PlatformSweepJobs(
  connection: ConnectionOptions,
): Promise<readonly Queue[]> {
  const queues: Queue[] = [];
  for (const { queue: name, cron: pattern } of describeM34SweepSchedules()) {
    const queue = new Queue(name, { connection });
    await queue.add("scheduled", {}, { repeat: { pattern }, removeOnComplete: true });
    queues.push(queue);
  }
  return queues;
}
