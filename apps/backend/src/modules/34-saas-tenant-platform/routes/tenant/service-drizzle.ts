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
import { type DbClient, schema } from "@chartwarden/db";
import {
  BaaRegisterRepository,
  type DsarExportJobInput,
  DsarExportRepository,
  type LinkedHelpRequestPort,
  type SupportGrantOperations,
  SupportRepository,
  TenantAccountRepository,
  TenantExportRepository,
  issueSupportConsentGrant,
} from "@chartwarden/saas-tenant-platform";
import { getRequestContext, withOrgContext } from "@chartwarden/tenancy";
import { ChartWardenError, NotFoundError, type OrgId } from "@chartwarden/types";
import { eq } from "drizzle-orm";
import {
  assertPageCursor,
  decodeKeyset,
  encodeKeyset,
  pageSizeOf,
  paginate,
} from "../keyset-page";
import type {
  BaaRecordView,
  DownloadUrlView,
  DsarExportJobView,
  EnqueuePort,
  RequestDsarArgs,
  SupportConsentGrantView,
  TenantExportJobView,
  TenantRouteService,
  TenantSupportSessionEventView,
  TenantSupportSessionView,
} from "./service";

/** The structural org-context transaction handle the repos write through. */
export type TenantTx = DbClient;

/** A 24h presigned-download minting port (SEC-052). Binds to the MinIO/S3 signer; off the request thread. */
export interface PresignDownloadPort {
  presign(
    organizationId: string,
    objectKey: string,
    ttlSeconds: number,
  ): Promise<{ url: string; expiresAt: Date }>;
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
  /**
   * The support-grant operations bound to the shared ports (audit / outbox / alerts, `createSupportGrantOperationsOver`): a grant's
   * issue and its revoke cascade run on the tenant's own transaction through them. REQUIRED: a revoke that cannot close the
   * sessions it covers must not pretend to have revoked the consent.
   */
  readonly supportOps: SupportGrantOperations;
  /**
   * The help request linked to a grant, resolved in the revoke's own transaction (piece 7B's table; absent until it is wired:
   * the cascade then closes sessions only).
   */
  readonly linkedHelpRequestsFor?: (tx: TenantTx) => LinkedHelpRequestPort;
}

const SCG = schema.supportConsentGrant;
const ORG = schema.organizations;
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
      // judged before the org transaction is opened: a bad cursor reaches no database
      assertPageCursor(organizationId, cursor);
      return inOrgCtx(organizationId, async (tx) => {
        const rows = await tx.select().from(SCG); // RLS scopes to app.org_id
        const now = deps.now();
        const views = rows.map((g) => grantView(g, now)).sort(byCreatedDesc);
        return paginate(organizationId, views, cursor, limit);
      });
    },

    async issueConsentGrant(organizationId, actor, args) {
      return inOrgCtx(organizationId, async (tx) => {
        // The tenant_account_id is resolved from the org spine (1:1 with organization).
        const account = await tx
          .select()
          .from(schema.tenantAccount)
          .where(eq(schema.tenantAccount.organizationId, organizationId))
          .limit(1);
        const tenantAccountId = account[0]?.id;
        if (!tenantAccountId) throw new NotFoundError("tenant account");
        // An organization that is not active (created, suspended, closed) is confined: it may issue only the non-PHI assist scope.
        const [org] = await tx
          .select({ status: ORG.status })
          .from(ORG)
          .where(eq(ORG.id, organizationId))
          .limit(1);
        // The scope rule, the row, `m34.support_consent_grant.issued` and the operators' alert: one service, one transaction.
        const row = await issueSupportConsentGrant(deps.supportOps.depsFor(tx), {
          organizationId,
          tenantAccountId,
          grantorMembershipId: actor.membershipId,
          grantorRoles: actor.roles,
          scope: args.scope,
          patientIdsInScope: args.patientIdsInScope,
          hours: args.expiresAtIsoOffsetHours,
          reason: args.grantReason,
          organizationActive: org?.status === "active",
        });
        return grantView(row, deps.now());
      });
    },

    async revokeConsentGrant(organizationId, grantId, actor, reason) {
      const result = await inOrgCtx(organizationId, async (tx) => {
        // The security boundary commits first: revoke the grant and end every covered session atomically.
        await deps.supportOps.revokeGrantAndCloseSessions(
          deps.supportOps.depsFor(tx),
          {
            grantId,
            organizationId,
            revokedByMembershipId: actor.membershipId,
            reason,
            source: "tenant",
            closedByUserId: actor.userId,
          },
        );
        const row = await new SupportRepository(tx).findConsentGrantById(grantId);
        if (!row) throw new NotFoundError("support consent grant");
        return grantView(row, deps.now());
      });
      // Help-request bookkeeping is a collaborator, not part of the consent boundary. Run it after
      // the revoke commits so its failure can never roll consent back or leave a support window open.
      if (deps.linkedHelpRequestsFor) {
        try {
          await inOrgCtx(organizationId, (tx) =>
            deps.linkedHelpRequestsFor!(tx).resolveForRevokedGrant({
              grantId,
              organizationId,
              source: "tenant",
              closedByUserId: actor.userId,
              note: null,
            }),
          );
        } catch {
          // The linked request can be reconciled independently; consent revocation remains successful.
        }
      }
      return result;
    },

    // ── support sessions on this organization (read-only; RLS scopes them; never an operator id, name or address) ──
    async listSupportSessions(organizationId, cursor, limit) {
      // judged before the org transaction is opened: a bad cursor reaches no database
      assertPageCursor(organizationId, cursor);
      return inOrgCtx(organizationId, async (tx) => {
        const repo = new SupportRepository(tx);
        const size = pageSizeOf(limit);
        const anchor = decodeKeyset(organizationId, cursor);
        const sessions = await repo.listSessions({
          limit: size + 1,
          ...(anchor
            ? { cursor: { startedAt: new Date(anchor.createdAt), id: anchor.id } }
            : {}),
        });
        const pageRows = sessions.slice(0, size);
        const stats = await repo.opsWriteStats(pageRows.map((x) => x.id));
        const now = deps.now();
        const views = pageRows
          .map((x) => ({
            ...tenantSessionView(x, stats.get(x.id), now),
            createdAt: isoReq(x.startedAt),
          }))
          .sort(byCreatedDesc);
        const last = views.at(-1);
        const hasMore = sessions.length > size;
        return {
          items: views.map(({ createdAt: _c, ...v }) => v),
          hasMore,
          nextCursor: hasMore && last ? encodeKeyset(organizationId, last) : null,
        };
      });
    },

    async listSupportSessionEvents(organizationId, sessionId, cursor, limit) {
      // judged before the org transaction is opened: a bad cursor reaches no database
      assertPageCursor(organizationId, cursor);
      return inOrgCtx(organizationId, async (tx) => {
        const repo = new SupportRepository(tx);
        const session = await repo.findSessionById(sessionId);
        // RLS hides another organization's session: the same non-leaking 404 as a missing one.
        if (!session || session.organizationId !== organizationId) {
          throw new NotFoundError("support session");
        }
        const size = pageSizeOf(limit);
        const anchor = decodeKeyset(organizationId, cursor);
        const rows = await repo.listSessionEvents(sessionId, {
          limit: size + 1,
          organizationId,
          ...(anchor
            ? { cursor: { occurredAt: new Date(anchor.createdAt), id: anchor.id } }
            : {}),
        });
        const views = rows
          .slice(0, size)
          .map((e) => ({ ...tenantEventView(e), createdAt: isoReq(e.occurredAt) }))
          .sort(byCreatedDesc);
        const last = views.at(-1);
        const hasMore = rows.length > size;
        return {
          items: views.map(({ createdAt: _c, ...v }) => v),
          hasMore,
          nextCursor: hasMore && last ? encodeKeyset(organizationId, last) : null,
        };
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
        // GAP-048: the worker's own `withOrgContext` needs `orgId` BEFORE it can read anything under RLS,
        // so the job payload carries the full DsarExportJobInput shape rather than a bare jobId — resolved
        // here, inside the SAME already-open org-context tx (tenant_account is org-scoped, RLS-safe read).
        const tenantAccount = await new TenantAccountRepository(tx).findByOrganizationId(
          organizationId,
        );
        if (!tenantAccount) {
          throw new ChartWardenError(
            "TENANT_ACCOUNT_NOT_FOUND",
            "no tenant_account for this org",
            500,
          );
        }
        const jobInput: DsarExportJobInput = {
          jobId: row.id,
          orgId: organizationId,
          tenantAccountId: tenantAccount.id,
          patientId: args.patientId,
        };
        await deps.enqueue.enqueue("tenant.dsar_export", { ...jobInput });
        return dsarView(row);
      });
    },

    async listDsarExports(organizationId, filter, cursor, limit) {
      // judged before the org transaction is opened: a bad cursor reaches no database
      assertPageCursor(organizationId, cursor);
      return inOrgCtx(organizationId, async (tx) => {
        const rows = await tx.select().from(schema.dsarExportJob);
        const views = rows
          .map(dsarView)
          .filter((v) => (filter.patientId ? v.patientId === filter.patientId : true))
          .filter((v) => (filter.status ? v.status === filter.status : true))
          .sort(byCreatedDesc);
        return paginate(organizationId, views, cursor, limit);
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
          throw new ChartWardenError(
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
          throw new ChartWardenError(
            "DSAR_NOT_FULFILLED",
            "the bundle is not yet available for download",
            409,
          );
        }
        const { url, expiresAt } = await deps.presign.presign(
          organizationId,
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
        // GAP-094: the worker's job payload is `TenantExportJobBody` (`{jobId, orgId}`) — `orgId` must be
        // enqueued alongside `jobId` so the worker's `withOrgContext` can open before touching any row.
        await deps.enqueue.enqueue("tenant.export", { jobId: row.id, orgId: organizationId });
        return tenantExportView(row);
      });
    },

    async listTenantExports(organizationId, filter, cursor, limit) {
      // judged before the org transaction is opened: a bad cursor reaches no database
      assertPageCursor(organizationId, cursor);
      return inOrgCtx(organizationId, async (tx) => {
        const rows = await tx.select().from(schema.tenantExportJob);
        const views = rows
          .map(tenantExportView)
          .filter((v) => (filter.status ? v.status === filter.status : true))
          .sort(byCreatedDesc);
        return paginate(organizationId, views, cursor, limit);
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
          throw new ChartWardenError(
            "TENANT_EXPORT_NOT_FULFILLED",
            "the bundle is not yet available",
            409,
          );
        }
        const { url, expiresAt } = await deps.presign.presign(
          organizationId,
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

    // ── BAA (tenant-side read + attest) ──
    async listBaa(organizationId, cursor, limit) {
      // judged before the org transaction is opened: a bad cursor reaches no database
      assertPageCursor(organizationId, cursor);
      return inOrgCtx(organizationId, async (tx) => {
        const rows = await tx.select().from(BAA);
        const views = rows.map(baaTenantView).sort(byCreatedDesc);
        return paginate(organizationId, views, cursor, limit);
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

// ── projections to the slice's DTO shapes (each carries `createdAt` for keyset pagination) ─────────────

function grantView(g: schema.SupportConsentGrant, now: Date): SupportConsentGrantView {
  return {
    id: g.id,
    tenantAccountId: g.tenantAccountId,
    scope: g.scope,
    grantReason: g.grantReason,
    issuedAt: isoReq(g.issuedAt),
    expiresAt: isoReq(g.expiresAt),
    revokedAt: iso(g.revokedAt),
    // Unrevoked AND unexpired: the same meaning as the operators' view of the grant.
    active: g.revokedAt === null && g.expiresAt.getTime() > now.getTime(),
    createdAt: isoReq(g.issuedAt),
  };
}

/** A session as the TENANT sees it: when, how long and how it ended; never the operator (the row's actor column is not read). */
function tenantSessionView(
  s: schema.SupportSession,
  stats: { readonly count: number; readonly lastAt: Date | null } | undefined,
  now: Date,
): TenantSupportSessionView {
  return {
    id: s.id,
    supportConsentGrantId: s.supportConsentGrantId,
    state:
      s.closedAt !== null ? "closed" : s.expiresAt.getTime() <= now.getTime() ? "expired" : "open",
    startedAt: isoReq(s.startedAt),
    expiresAt: isoReq(s.expiresAt),
    closedAt: iso(s.closedAt),
    closeReason: (s.closeReason as TenantSupportSessionView["closeReason"]) ?? null,
    actionCount: stats?.count ?? 0,
    lastActionAt: iso(stats?.lastAt ?? null),
  };
}

/** One ledger row as the tenant sees it: an `ops.write` shows its route template, method and status; never an id, a body or an address. */
function tenantEventView(e: schema.SupportSessionEvent): TenantSupportSessionEventView {
  const context = (e.context ?? {}) as Record<string, unknown>;
  const detail =
    e.eventKind === "ops.write" &&
    typeof context.route === "string" &&
    typeof context.method === "string" &&
    typeof context.status === "number" &&
    Number.isInteger(context.status)
      ? { route: context.route, method: context.method, status: context.status }
      : null;
  return {
    id: e.id,
    supportSessionId: e.supportSessionId,
    eventKind: e.eventKind,
    occurredAt: isoReq(e.occurredAt),
    detail,
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
    bundleSizeBytes: j.bundleSizeBytes === null ? null : Number(j.bundleSizeBytes),
    createdAt: isoReq(j.requestedAt),
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
