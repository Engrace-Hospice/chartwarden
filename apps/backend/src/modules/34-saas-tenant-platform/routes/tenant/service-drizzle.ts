// apps/backend/src/modules/34-saas-tenant-platform/routes/tenant/service-drizzle.ts — M34 Phase 2D.
//
// The PRODUCTION `TenantRouteService` (§4.1 tenant-scoped surface: support-consent-grants / dsar-export-
// jobs / tenant-export-jobs / onboarding-tasks / baa). It implements the SAME interface the in-memory slice
// does (routes/tenant/service.ts), so the five tenant route plugins are UNCHANGED. The slice stays for the
// route tests; this adapter is what `mountTenantPlatformRoutes` injects when a DB client is present.
//
// EXECUTION MODEL:
//   - EVERY method runs inside ONE `withOrgContext(db, {organizationId, userId}, …)` transaction so Postgres
//     RLS scopes every statement to `app.org_id` (the tenant's OWN org). A missing/cross-tenant id is a
//     non-leaking 404 (the way RLS behaves). The `organizationId` is the explicit one the route binds
//     server-side (request.context, never the body); `userId` (audit attribution `app.user_id`) is read
//     from the ambient request context.
//   - SAFETY (F09): the DSAR adapter runs under the requesting tenant's OWN `withOrgContext`, NEVER a
//     platform bypass — a tenant's data-subject export is scoped to the tenant, by construction.
//   - READ/LIST methods project the §3 repository rows to the SAME DTO shapes the slice returns.
//   - COMMAND methods that drive a worker (requestDsarExport / requestTenantExport) write the job row,
//     enqueue the §4.3 queue job through the injected {@link EnqueuePort}, and return the projected view —
//     all in the one org-context tx. The pure 2B export/DSAR workers are NOT rewritten here; the adapter
//     only enqueues the named queue (the live BullMQ worker binds its ports separately).
import { type DbClient, schema } from "@wardenx/db";
import {
  BaaRegisterRepository,
  DsarExportRepository,
  OnboardingRepository,
  SupportRepository,
  TenantExportRepository,
} from "@wardenx/saas-tenant-platform";
import { getRequestContext, withOrgContext } from "@wardenx/tenancy";
import { NotFoundError, type OrgId, WardenXError } from "@wardenx/types";
import { eq } from "drizzle-orm";
import { paginate } from "./concurrency";
import type {
  BaaRecordView,
  DownloadUrlView,
  DsarExportJobView,
  EnqueuePort,
  IssueGrantArgs,
  OnboardingTaskView,
  RequestDsarArgs,
  SupportConsentGrantView,
  TenantExportJobView,
  TenantRouteService,
} from "./service";

/** The structural org-context transaction handle the repos write through. */
export type TenantTx = DbClient;

/** A 24h presigned-download minting port (SEC-052). Binds to the MinIO/S3 signer; off the request thread. */
export interface PresignDownloadPort {
  presign(objectKey: string, ttlSeconds: number): Promise<{ url: string; expiresAt: Date }>;
}

/** The dependencies the production tenant route service binds (the Integration agent supplies these). */
export interface DrizzleTenantRouteDeps {
  /** The tenant-pooled Drizzle client (RLS-enforced; the org-context tx runs on this). */
  readonly db: DbClient;
  /** The §4.3 tenant-queue worker-trigger port (BullMQ producer in prod). */
  readonly enqueue: EnqueuePort;
  /** 24h presigned-download minting (SEC-052) for fulfilled DSAR / tenant-export bundles. */
  readonly presign: PresignDownloadPort;
  /** Injected clock (deterministic timestamps in tests). */
  readonly now: () => Date;
}

const SCG = schema.supportConsentGrant;
const ONB = schema.onboardingTask;
const BAA = schema.platformTenantBaaRecord;

const PRESIGN_TTL_SECONDS = 24 * 60 * 60;

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);
const isoReq = (d: Date): string => d.toISOString();

export function createDrizzleTenantBackend(deps: DrizzleTenantRouteDeps): {
  service: TenantRouteService;
} {
  /** Run `fn` inside the tenant's own org-context tx (RLS scopes to `app.org_id`; F09 — never bypass). */
  const inOrgCtx = <T>(organizationId: OrgId, fn: (tx: TenantTx) => Promise<T>): Promise<T> => {
    const userId = getRequestContext()?.userId ?? organizationId;
    return withOrgContext<TenantTx, T>(deps.db, { organizationId, userId }, fn);
  };

  const service: TenantRouteService = {
    // ── support consent grants ──
    async listConsentGrants(organizationId, cursor, limit) {
      return inOrgCtx(organizationId, async (tx) => {
        const rows = await tx.select().from(SCG); // RLS scopes to app.org_id
        const views = rows.map(grantView).sort(byCreatedDesc);
        return paginate(views, cursor, limit);
      });
    },

    async issueConsentGrant(organizationId, actorMembershipId, args: IssueGrantArgs) {
      return inOrgCtx(organizationId, async (tx) => {
        const repo = new SupportRepository(tx);
        const now = deps.now();
        // §4.2 — expires_at = NOW() + min(request, 72h platform-floor).
        const hours = Math.min(args.expiresAtIsoOffsetHours, 72);
        const expiresAt = new Date(now.getTime() + hours * 3_600_000);
        // The tenant_account_id is resolved from the org spine (1:1 with organization).
        const account = await tx
          .select()
          .from(schema.tenantAccount)
          .where(eq(schema.tenantAccount.organizationId, organizationId))
          .limit(1);
        const tenantAccountId = account[0]?.id;
        if (!tenantAccountId) throw new NotFoundError("tenant account");
        const row = await repo.createConsentGrant({
          organizationId,
          tenantAccountId,
          scope: args.scope,
          patientIdsInScope: args.patientIdsInScope ? [...args.patientIdsInScope] : null,
          grantReason: args.grantReason,
          grantorMembershipId: actorMembershipId,
          expiresAt,
        });
        return grantView(row);
      });
    },

    async revokeConsentGrant(organizationId, grantId, actorMembershipId, reason) {
      return inOrgCtx(organizationId, async (tx) => {
        const repo = new SupportRepository(tx);
        const existing = await repo.findConsentGrantById(grantId);
        if (!existing || existing.organizationId !== organizationId) {
          throw new NotFoundError("support consent grant");
        }
        const row = await repo.revokeConsentGrant(grantId, {
          revokedAt: deps.now(),
          revokedByMembershipId: actorMembershipId,
          revocationReason: reason,
        });
        return grantView(row);
      });
    },

    // ── DSAR export jobs (§164.524) — runs under the requesting tenant's own org-context (F09) ──
    async requestDsarExport(organizationId, actorMembershipId, args: RequestDsarArgs) {
      return inOrgCtx(organizationId, async (tx) => {
        const repo = new DsarExportRepository(tx);
        const now = deps.now();
        const row = await repo.create({
          organizationId,
          patientId: args.patientId,
          requestSource: args.requestSource,
          requestorIdentityVerificationEvidence: args.requestorIdentityVerificationEvidence,
          requestingMembershipId: actorMembershipId,
          status: "requested",
          requestedAt: now,
          slaDueAt: new Date(now.getTime() + 30 * 86_400_000),
        });
        await deps.enqueue.enqueue("tenant.dsar_export", { jobId: row.id });
        return dsarView(row);
      });
    },

    async listDsarExports(organizationId, filter, cursor, limit) {
      return inOrgCtx(organizationId, async (tx) => {
        const rows = await tx.select().from(schema.dsarExportJob);
        const views = rows
          .map(dsarView)
          .filter((v) => (filter.patientId ? v.patientId === filter.patientId : true))
          .filter((v) => (filter.status ? v.status === filter.status : true))
          .sort(byCreatedDesc);
        return paginate(views, cursor, limit);
      });
    },

    async getDsarExport(organizationId, jobId) {
      return inOrgCtx(organizationId, async (tx) =>
        dsarView(await loadDsar(tx, organizationId, jobId)),
      );
    },

    async fulfillDsarExport(organizationId, jobId) {
      return inOrgCtx(organizationId, async (tx) => {
        const repo = new DsarExportRepository(tx);
        await loadDsar(tx, organizationId, jobId);
        const row = await repo.update(jobId, { status: "fulfilled", fulfilledAt: deps.now() });
        return dsarView(row);
      });
    },

    async extendDsarExport(organizationId, jobId) {
      return inOrgCtx(organizationId, async (tx) => {
        const repo = new DsarExportRepository(tx);
        const existing = await loadDsar(tx, organizationId, jobId);
        if (existing.extendedUntil) {
          throw new WardenXError(
            "DSAR_ALREADY_EXTENDED",
            "the §164.524 30-day extension is one-time",
            409,
          );
        }
        const row = await repo.update(jobId, {
          status: "extended",
          extendedUntil: new Date(existing.slaDueAt.getTime() + 30 * 86_400_000),
        });
        return dsarView(row);
      });
    },

    async denyDsarExport(organizationId, jobId, args) {
      return inOrgCtx(organizationId, async (tx) => {
        const repo = new DsarExportRepository(tx);
        await loadDsar(tx, organizationId, jobId);
        const row = await repo.update(jobId, { status: "denied", deniedReason: args.deniedReason });
        await repo.appendEvent({
          organizationId,
          dsarExportJobId: jobId,
          eventKind: "denied",
          toStatus: "denied",
          occurredAt: deps.now(),
          shardReceipt: { narrative: args.narrative },
        });
        return dsarView(row);
      });
    },

    async dsarDownloadUrl(organizationId, jobId, actorMembershipId): Promise<DownloadUrlView> {
      return inOrgCtx(organizationId, async (tx) => {
        const repo = new DsarExportRepository(tx);
        const row = await loadDsar(tx, organizationId, jobId);
        if (row.status !== "fulfilled" || !row.bundleMinioObjectKey) {
          throw new WardenXError(
            "DSAR_NOT_FULFILLED",
            "the bundle is not yet available for download",
            409,
          );
        }
        const { url, expiresAt } = await deps.presign.presign(
          row.bundleMinioObjectKey,
          PRESIGN_TTL_SECONDS,
        );
        await repo.update(jobId, {
          bundlePresignedUrlExpiresAt: expiresAt,
          bundleDownloadedAt: deps.now(),
        });
        return { url, expiresAt: isoReq(expiresAt) };
      });
    },

    // ── tenant export jobs ──
    async requestTenantExport(organizationId, actorMembershipId, args) {
      return inOrgCtx(organizationId, async (tx) => {
        const repo = new TenantExportRepository(tx);
        const now = deps.now();
        const row = await repo.create({
          organizationId,
          requestedPurpose: args.requestedPurpose,
          requestingMembershipId: actorMembershipId,
          status: "requested",
          requestedAt: now,
        });
        await repo.appendEvent({
          organizationId,
          tenantExportJobId: row.id,
          eventKind: "requested",
          occurredAt: now,
          shardReceipt: { justification: args.justification },
        });
        await deps.enqueue.enqueue("tenant.export", { jobId: row.id });
        return tenantExportView(row);
      });
    },

    async listTenantExports(organizationId, filter, cursor, limit) {
      return inOrgCtx(organizationId, async (tx) => {
        const rows = await tx.select().from(schema.tenantExportJob);
        const views = rows
          .map(tenantExportView)
          .filter((v) => (filter.status ? v.status === filter.status : true))
          .sort(byCreatedDesc);
        return paginate(views, cursor, limit);
      });
    },

    async tenantExportDownloadUrl(
      organizationId,
      jobId,
      actorMembershipId,
    ): Promise<DownloadUrlView> {
      return inOrgCtx(organizationId, async (tx) => {
        const repo = new TenantExportRepository(tx);
        const row = await loadTenantExport(tx, organizationId, jobId);
        if (row.status !== "fulfilled" || !row.bundleMinioObjectKey) {
          throw new WardenXError(
            "TENANT_EXPORT_NOT_FULFILLED",
            "the bundle is not yet available",
            409,
          );
        }
        const { url, expiresAt } = await deps.presign.presign(
          row.bundleMinioObjectKey,
          PRESIGN_TTL_SECONDS,
        );
        await repo.update(jobId, {
          bundlePresignedUrlExpiresAt: expiresAt,
          bundleDownloadedAt: deps.now(),
        });
        return { url, expiresAt: isoReq(expiresAt) };
      });
    },

    // ── onboarding ──
    async listOnboarding(organizationId, cursor, limit) {
      return inOrgCtx(organizationId, async (tx) => {
        const rows = await tx.select().from(ONB);
        const views = rows.map(onboardingView).sort(byCreatedDesc);
        return paginate(views, cursor, limit);
      });
    },

    async startOnboardingTask(organizationId, taskId) {
      return inOrgCtx(organizationId, async (tx) => {
        const repo = new OnboardingRepository(tx);
        await loadOnboarding(tx, organizationId, taskId);
        const row = await repo.updateTaskStatus(taskId, {
          status: "in_progress",
          startedAt: deps.now(),
        });
        return onboardingView(row);
      });
    },

    async completeOnboardingTask(organizationId, taskId, completionEvidence) {
      return inOrgCtx(organizationId, async (tx) => {
        const repo = new OnboardingRepository(tx);
        await loadOnboarding(tx, organizationId, taskId);
        const row = await repo.updateTaskStatus(taskId, {
          status: "done",
          completedAt: deps.now(),
          completionEvidence: completionEvidence ?? undefined,
        });
        return onboardingView(row);
      });
    },

    async blockOnboardingTask(organizationId, taskId, blockerReason) {
      return inOrgCtx(organizationId, async (tx) => {
        const repo = new OnboardingRepository(tx);
        await loadOnboarding(tx, organizationId, taskId);
        const row = await repo.updateTaskStatus(taskId, { status: "blocked", blockerReason });
        return onboardingView(row);
      });
    },

    // ── BAA (tenant-side read + attest) ──
    async listBaa(organizationId, cursor, limit) {
      return inOrgCtx(organizationId, async (tx) => {
        const rows = await tx.select().from(BAA);
        const views = rows.map(baaTenantView).sort(byCreatedDesc);
        return paginate(views, cursor, limit);
      });
    },

    async attestBaa(organizationId, baaId, actorMembershipId) {
      return inOrgCtx(organizationId, async (tx) => {
        const repo = new BaaRegisterRepository(tx);
        const existing = await repo.findById(baaId);
        if (!existing || existing.organizationId !== organizationId) {
          throw new NotFoundError("baa record");
        }
        const row = await repo.update(baaId, {
          complianceOfficerAttestationMembershipId: actorMembershipId,
          attestedAt: deps.now(),
        });
        return baaTenantView(row);
      });
    },
  };

  return { service };
}

// ── loaders (RLS scopes the read; cross-org row is a non-leaking 404) ─────────────────────────────────

async function loadDsar(
  tx: TenantTx,
  organizationId: OrgId,
  id: string,
): Promise<schema.DsarExportJob> {
  const r = await new DsarExportRepository(tx).findById(id);
  if (!r || r.organizationId !== organizationId) throw new NotFoundError("dsar export job");
  return r;
}

async function loadTenantExport(
  tx: TenantTx,
  organizationId: OrgId,
  id: string,
): Promise<schema.TenantExportJob> {
  const r = await new TenantExportRepository(tx).findById(id);
  if (!r || r.organizationId !== organizationId) throw new NotFoundError("tenant export job");
  return r;
}

async function loadOnboarding(
  tx: TenantTx,
  organizationId: OrgId,
  id: string,
): Promise<schema.OnboardingTask> {
  const r = await new OnboardingRepository(tx).findTaskById(id);
  if (!r || r.organizationId !== organizationId) throw new NotFoundError("onboarding task");
  return r;
}

// ── projections to the slice's DTO shapes (each carries `createdAt` for keyset pagination) ─────────────

function grantView(g: schema.SupportConsentGrant): SupportConsentGrantView {
  return {
    id: g.id,
    tenantAccountId: g.tenantAccountId,
    scope: g.scope,
    grantReason: g.grantReason,
    issuedAt: isoReq(g.issuedAt),
    expiresAt: isoReq(g.expiresAt),
    revokedAt: iso(g.revokedAt),
    active: g.revokedAt === null,
    createdAt: isoReq(g.issuedAt),
  };
}

function dsarView(j: schema.DsarExportJob): DsarExportJobView {
  return {
    id: j.id,
    patientId: j.patientId,
    requestSource: j.requestSource,
    status: j.status,
    requestedAt: isoReq(j.requestedAt),
    slaDueAt: isoReq(j.slaDueAt),
    extendedUntil: iso(j.extendedUntil),
    fulfilledAt: iso(j.fulfilledAt),
    deniedReason: j.deniedReason ?? null,
    createdAt: isoReq(j.requestedAt),
  };
}

function tenantExportView(j: schema.TenantExportJob): TenantExportJobView {
  return {
    id: j.id,
    requestedPurpose: j.requestedPurpose,
    status: j.status,
    requestedAt: isoReq(j.requestedAt),
    fulfilledAt: iso(j.fulfilledAt),
    bundleSizeBytes: j.bundleSizeBytes ?? null,
    createdAt: isoReq(j.requestedAt),
  };
}

function onboardingView(t: schema.OnboardingTask): OnboardingTaskView {
  return {
    id: t.id,
    templateKey: t.templateKey,
    status: t.status,
    assignedToMembershipId: t.assignedToMembershipId ?? null,
    dueAt: iso(t.dueAt),
    startedAt: iso(t.startedAt),
    completedAt: iso(t.completedAt),
    blockerReason: t.blockerReason ?? null,
    createdAt: isoReq(t.createdAt),
  };
}

function baaTenantView(b: schema.PlatformTenantBaaRecord): BaaRecordView {
  return {
    id: b.id,
    tenantAccountId: b.tenantAccountId,
    addendumVersion: b.addendumVersion,
    baaStatus: b.baaStatus,
    executedOn: dateOnly(b.executedOn),
    effectiveOn: dateOnly(b.effectiveOn),
    expiresOn: dateOnly(b.expiresOn),
    attestedAt: b.attestedAt ? b.attestedAt.toISOString() : null,
    createdAt: dateOnly(b.executedOn) ?? dateOnly(b.effectiveOn) ?? "0000-00-00",
  };
}

/** `date`-typed columns round-trip as ISO `YYYY-MM-DD` strings (Drizzle `date` mode). */
function dateOnly(v: string | Date | null): string | null {
  if (v === null) return null;
  return typeof v === "string" ? v : v.toISOString().slice(0, 10);
}

/** DESC keyset sort by `(createdAt, id)` — RLS scopes the rows; this orders them for the cursor. */
function byCreatedDesc<T extends { createdAt: string; id: string }>(a: T, b: T): number {
  return a.createdAt === b.createdAt ? (a.id < b.id ? 1 : -1) : a.createdAt < b.createdAt ? 1 : -1;
}
