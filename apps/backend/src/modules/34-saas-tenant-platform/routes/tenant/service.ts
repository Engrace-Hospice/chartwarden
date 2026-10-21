// apps/backend/src/modules/34-saas-tenant-platform/routes/tenant/service.ts — M34 the TenantRouteService
// + an in-memory slice (§4.1 "Tenant-scoped routes").
//
// The TENANT-scoped route handlers (support-consent-grants / dsar-export-jobs / tenant-export-jobs /
// onboarding / baa) compose over this interface; production injects a Drizzle-backed service whose READ
// methods run under `withOrgContext` (so RLS scopes by `app.org_id`) over the §3 repositories
// (`SupportRepository` / `DsarExportRepository` / `TenantExportRepository` / `OnboardingRepository` /
// `BaaRegisterRepository`). COMMAND methods that trigger a worker enqueue to a named BullMQ queue via the
// injected {@link EnqueuePort} (the live worker construction is Phase 2D — see the typed TODO below) and
// emit their m34.* outbox in the same tx. Mirrors the M22 routes/service.ts precedent: pure-ish (only an
// injected `now()` so timestamps are deterministic in tests), org-scoped reads (a missing/cross-tenant id
// is a non-leaking 404 — the way RLS behaves in prod), cursor pagination on every list.
import type { OrgId } from "@chartwarden/types";
import { NotFoundError, ChartWardenError } from "@chartwarden/types";
import { type CursorPage, paginate } from "./concurrency";

// ── enqueue port (Phase 2D worker-trigger seam) ───────────────────────────────────────────────────

/** The named BullMQ queues the tenant command routes enqueue onto (§4.3). */
export type M34TenantQueueName = "tenant.dsar_export" | "tenant.export";

/**
 * Thin worker-trigger port the command routes enqueue onto. A command route enqueues at least `{ jobId }`
 * (per the §4.3 idempotency key: `${queue}:${payload.jobId}`) — GAP-048's `tenant.dsar_export` payload
 * carries the full `DsarExportJobInput` shape (`orgId`/`tenantAccountId`/`patientId` too) since the
 * worker's own `withOrgContext` needs `orgId` before it can read anything under RLS. The slice records
 * whatever payload it's given.
 */
export interface EnqueuePort {
  enqueue(
    queue: M34TenantQueueName,
    payload: { jobId: string } & Record<string, unknown>,
  ): Promise<void>;
}

// ── route DTOs (in-memory; the Drizzle adapter projects rows to the SAME shapes) ──────────────────────

export interface SupportConsentGrantView {
  readonly id: string;
  readonly tenantAccountId: string;
  readonly scope: "organization_scoped" | "patient_scoped";
  readonly grantReason: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly revokedAt: string | null;
  readonly active: boolean;
  readonly createdAt: string;
}

export interface IssueGrantArgs {
  readonly scope: "organization_scoped" | "patient_scoped";
  readonly patientIdsInScope: readonly string[] | null;
  readonly grantReason: string;
  readonly expiresAtIsoOffsetHours: number;
}

export interface DsarExportJobView {
  readonly id: string;
  readonly patientId: string;
  readonly requestSource:
    | "patient"
    | "caregiver"
    | "legal_representative"
    | "authorized_third_party";
  readonly status:
    | "requested"
    | "generating"
    | "review_pending"
    | "fulfilled"
    | "denied"
    | "extended";
  readonly requestedAt: string;
  readonly slaDueAt: string;
  readonly extendedUntil: string | null;
  readonly fulfilledAt: string | null;
  readonly deniedReason: string | null;
  readonly createdAt: string;
}

export interface RequestDsarArgs {
  readonly patientId: string;
  readonly requestSource: DsarExportJobView["requestSource"];
  readonly requestorIdentityVerificationEvidence: string;
}

export interface TenantExportJobView {
  readonly id: string;
  readonly requestedPurpose:
    | "migration"
    | "baa_termination"
    | "compliance_audit"
    | "surveyor_request";
  readonly status: "requested" | "generating" | "fulfilled" | "expired" | "cancelled";
  readonly requestedAt: string;
  readonly fulfilledAt: string | null;
  readonly bundleSizeBytes: number | null;
  readonly createdAt: string;
}

export interface OnboardingTaskView {
  readonly id: string;
  readonly templateKey: string;
  readonly status: "pending" | "in_progress" | "done" | "skipped" | "blocked";
  readonly assignedToMembershipId: string | null;
  readonly dueAt: string | null;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly blockerReason: string | null;
  readonly createdAt: string;
}

export interface BaaRecordView {
  readonly id: string;
  readonly tenantAccountId: string;
  readonly addendumVersion: string;
  readonly baaStatus: "executed" | "pending" | "terminated" | "missing";
  readonly executedOn: string | null;
  readonly effectiveOn: string | null;
  readonly expiresOn: string | null;
  readonly attestedAt: string | null;
  readonly createdAt: string;
}

/** A 24h presigned download URL (SEC-052); records the download stamp on first call. */
export interface DownloadUrlView {
  readonly url: string;
  readonly expiresAt: string;
}

/** The §4.1 tenant-scoped route service the handlers compose over. Every method is org-scoped (RLS in prod). */
export interface TenantRouteService {
  // --- support consent grants ---
  listConsentGrants(
    organizationId: OrgId,
    cursor: string | undefined,
    limit: number | undefined,
  ): Promise<CursorPage<SupportConsentGrantView>>;
  issueConsentGrant(
    organizationId: OrgId,
    actorMembershipId: string,
    args: IssueGrantArgs,
  ): Promise<SupportConsentGrantView>;
  revokeConsentGrant(
    organizationId: OrgId,
    grantId: string,
    actorMembershipId: string,
    reason: string,
  ): Promise<SupportConsentGrantView>;
  // --- DSAR export jobs (§164.524) ---
  requestDsarExport(
    organizationId: OrgId,
    actorMembershipId: string,
    args: RequestDsarArgs,
  ): Promise<DsarExportJobView>;
  listDsarExports(
    organizationId: OrgId,
    filter: { patientId?: string; status?: string },
    cursor: string | undefined,
    limit: number | undefined,
  ): Promise<CursorPage<DsarExportJobView>>;
  getDsarExport(organizationId: OrgId, jobId: string): Promise<DsarExportJobView>;
  fulfillDsarExport(organizationId: OrgId, jobId: string): Promise<DsarExportJobView>;
  extendDsarExport(organizationId: OrgId, jobId: string): Promise<DsarExportJobView>;
  denyDsarExport(
    organizationId: OrgId,
    jobId: string,
    args: { deniedReason: string; narrative: string },
  ): Promise<DsarExportJobView>;
  dsarDownloadUrl(
    organizationId: OrgId,
    jobId: string,
    actorMembershipId: string,
  ): Promise<DownloadUrlView>;
  // --- tenant export jobs ---
  requestTenantExport(
    organizationId: OrgId,
    actorMembershipId: string,
    args: { requestedPurpose: TenantExportJobView["requestedPurpose"]; justification: string },
  ): Promise<TenantExportJobView>;
  listTenantExports(
    organizationId: OrgId,
    filter: { status?: string },
    cursor: string | undefined,
    limit: number | undefined,
  ): Promise<CursorPage<TenantExportJobView>>;
  tenantExportDownloadUrl(
    organizationId: OrgId,
    jobId: string,
    actorMembershipId: string,
  ): Promise<DownloadUrlView>;
  // --- onboarding ---
  listOnboarding(
    organizationId: OrgId,
    cursor: string | undefined,
    limit: number | undefined,
  ): Promise<CursorPage<OnboardingTaskView>>;
  startOnboardingTask(organizationId: OrgId, taskId: string): Promise<OnboardingTaskView>;
  completeOnboardingTask(
    organizationId: OrgId,
    taskId: string,
    completionEvidence: Record<string, unknown> | null,
  ): Promise<OnboardingTaskView>;
  blockOnboardingTask(
    organizationId: OrgId,
    taskId: string,
    blockerReason: string,
  ): Promise<OnboardingTaskView>;
  // --- BAA ---
  listBaa(
    organizationId: OrgId,
    cursor: string | undefined,
    limit: number | undefined,
  ): Promise<CursorPage<BaaRecordView>>;
  attestBaa(
    organizationId: OrgId,
    baaId: string,
    actorMembershipId: string,
  ): Promise<BaaRecordView>;
}

// ── in-memory records + slice ─────────────────────────────────────────────────────────────────────────

// Mutable structural mirrors of the (readonly) view DTOs — the slice transitions them in place; `strip`
// drops `organizationId` to project the readonly view the route returns.
type Mutable<T> = { -readonly [K in keyof T]: T[K] };
interface GrantRecord extends Mutable<SupportConsentGrantView> {
  organizationId: string;
}
interface DsarRecord extends Mutable<DsarExportJobView> {
  organizationId: string;
}
interface TenantExportRecord extends Mutable<TenantExportJobView> {
  organizationId: string;
}
interface OnboardingRecord extends Mutable<OnboardingTaskView> {
  organizationId: string;
}
interface BaaRecord extends Mutable<BaaRecordView> {
  organizationId: string;
}

/** Deterministic, I/O-free seed for the in-memory tenant route service (slice + smoke tests). */
export interface TenantRouteSeed {
  readonly grants?: ReadonlyArray<Partial<GrantRecord> & { id: string; organizationId: string }>;
  readonly dsarJobs?: ReadonlyArray<Partial<DsarRecord> & { id: string; organizationId: string }>;
  readonly tenantExportJobs?: ReadonlyArray<
    Partial<TenantExportRecord> & { id: string; organizationId: string }
  >;
  readonly onboardingTasks?: ReadonlyArray<
    Partial<OnboardingRecord> & { id: string; organizationId: string }
  >;
  readonly baaRecords?: ReadonlyArray<Partial<BaaRecord> & { id: string; organizationId: string }>;
}

/** Pads `n` to a uuid-shaped id so created ids round-trip through uuid-validated bodies (M22 slice). */
function uuidFromCounter(prefixNibble: string, n: number): string {
  const hex = n.toString(16).padStart(12, "0");
  return `${prefixNibble}0000000-0000-4000-8000-${hex}`;
}

/** Read-only inspection surface over the slice (the §7 route tests assert against it). */
export interface TenantBackendInspect {
  grantCount(organizationId: OrgId): number;
  enqueued(): ReadonlyArray<{ queue: M34TenantQueueName; jobId: string }>;
}

export function createInMemoryTenantBackend(
  seed: TenantRouteSeed = {},
  enqueuePort?: EnqueuePort,
): {
  service: TenantRouteService;
  inspect: TenantBackendInspect;
} {
  const grants = new Map<string, GrantRecord>();
  const dsar = new Map<string, DsarRecord>();
  const tenantExports = new Map<string, TenantExportRecord>();
  const onboarding = new Map<string, OnboardingRecord>();
  const baa = new Map<string, BaaRecord>();
  const enqueueLog: { queue: M34TenantQueueName; jobId: string }[] = [];
  let created = 0;
  const now = () => "2026-06-21T12:00:00.000Z";
  const plusDays = (iso: string, days: number) =>
    new Date(Date.parse(iso) + days * 86_400_000).toISOString();
  const plusHours = (iso: string, hours: number) =>
    new Date(Date.parse(iso) + hours * 3_600_000).toISOString();

  // The injected enqueue port (Phase 2D supplies the BullMQ-backed one). The slice default records calls.
  const enqueue: EnqueuePort = enqueuePort ?? {
    async enqueue(queue, payload) {
      enqueueLog.push({ queue, jobId: payload.jobId });
    },
  };

  for (const g of seed.grants ?? []) {
    grants.set(g.id, {
      tenantAccountId: uuidFromCounter("t", 1),
      scope: "organization_scoped",
      grantReason: "seed",
      issuedAt: now(),
      expiresAt: plusHours(now(), 24),
      revokedAt: null,
      active: true,
      createdAt: now(),
      ...g,
    } as GrantRecord);
  }
  for (const d of seed.dsarJobs ?? []) {
    dsar.set(d.id, {
      patientId: uuidFromCounter("p", 1),
      requestSource: "patient",
      status: "requested",
      requestedAt: now(),
      slaDueAt: plusDays(now(), 30),
      extendedUntil: null,
      fulfilledAt: null,
      deniedReason: null,
      createdAt: now(),
      ...d,
    } as DsarRecord);
  }
  for (const t of seed.tenantExportJobs ?? []) {
    tenantExports.set(t.id, {
      requestedPurpose: "migration",
      status: "requested",
      requestedAt: now(),
      fulfilledAt: null,
      bundleSizeBytes: null,
      createdAt: now(),
      ...t,
    } as TenantExportRecord);
  }
  for (const o of seed.onboardingTasks ?? []) {
    onboarding.set(o.id, {
      templateKey: "account_created",
      status: "pending",
      assignedToMembershipId: null,
      dueAt: null,
      startedAt: null,
      completedAt: null,
      blockerReason: null,
      createdAt: now(),
      ...o,
    } as OnboardingRecord);
  }
  for (const b of seed.baaRecords ?? []) {
    baa.set(b.id, {
      tenantAccountId: uuidFromCounter("t", 1),
      addendumVersion: "v1",
      baaStatus: "pending",
      executedOn: null,
      effectiveOn: null,
      expiresOn: null,
      attestedAt: null,
      createdAt: now(),
      ...b,
    } as BaaRecord);
  }

  const loadGrant = (organizationId: OrgId, id: string): GrantRecord => {
    const r = grants.get(id);
    if (!r || r.organizationId !== organizationId) throw new NotFoundError("support consent grant");
    return r;
  };
  const loadDsar = (organizationId: OrgId, id: string): DsarRecord => {
    const r = dsar.get(id);
    if (!r || r.organizationId !== organizationId) throw new NotFoundError("dsar export job");
    return r;
  };
  const loadTenantExport = (organizationId: OrgId, id: string): TenantExportRecord => {
    const r = tenantExports.get(id);
    if (!r || r.organizationId !== organizationId) throw new NotFoundError("tenant export job");
    return r;
  };
  const loadOnboarding = (organizationId: OrgId, id: string): OnboardingRecord => {
    const r = onboarding.get(id);
    if (!r || r.organizationId !== organizationId) throw new NotFoundError("onboarding task");
    return r;
  };
  const loadBaa = (organizationId: OrgId, id: string): BaaRecord => {
    const r = baa.get(id);
    if (!r || r.organizationId !== organizationId) throw new NotFoundError("baa record");
    return r;
  };

  /** Rows DESC-sorted by `(createdAt, id)` for keyset pagination. */
  const desc = <T extends { createdAt: string; id: string }>(rows: T[]): T[] =>
    [...rows].sort((a, b) =>
      a.createdAt === b.createdAt ? (a.id < b.id ? 1 : -1) : a.createdAt < b.createdAt ? 1 : -1,
    );
  const strip = <T extends { organizationId: string }>(r: T): Omit<T, "organizationId"> => {
    const { organizationId: _o, ...view } = r;
    return view;
  };

  const service: TenantRouteService = {
    // --- support consent grants ---
    async listConsentGrants(organizationId, cursor, limit) {
      const rows = desc(
        [...grants.values()].filter((r) => r.organizationId === organizationId).map(strip),
      );
      return paginate(rows, cursor, limit);
    },
    async issueConsentGrant(organizationId, _actorMembershipId, args) {
      const id = uuidFromCounter("c", ++created);
      // §4.2 — expires_at = NOW() + min(request, 72h platform-floor).
      const hours = Math.min(args.expiresAtIsoOffsetHours, 72);
      const rec: GrantRecord = {
        id,
        organizationId,
        tenantAccountId: uuidFromCounter("t", 1),
        scope: args.scope,
        grantReason: args.grantReason,
        issuedAt: now(),
        expiresAt: plusHours(now(), hours),
        revokedAt: null,
        active: true,
        createdAt: now(),
      };
      grants.set(id, rec);
      return strip(rec);
    },
    async revokeConsentGrant(organizationId, grantId, _actorMembershipId, _reason) {
      const r = loadGrant(organizationId, grantId);
      r.revokedAt = now();
      r.active = false;
      return strip(r);
    },
    // --- DSAR export jobs ---
    async requestDsarExport(organizationId, _actorMembershipId, args) {
      const id = uuidFromCounter("d", ++created);
      const rec: DsarRecord = {
        id,
        organizationId,
        patientId: args.patientId,
        requestSource: args.requestSource,
        status: "requested",
        requestedAt: now(),
        slaDueAt: plusDays(now(), 30),
        extendedUntil: null,
        fulfilledAt: null,
        deniedReason: null,
        createdAt: now(),
      };
      dsar.set(id, rec);
      await enqueue.enqueue("tenant.dsar_export", { jobId: id });
      return strip(rec);
    },
    async listDsarExports(organizationId, filter, cursor, limit) {
      const rows = desc(
        [...dsar.values()]
          .filter((r) => r.organizationId === organizationId)
          .filter((r) => (filter.patientId ? r.patientId === filter.patientId : true))
          .filter((r) => (filter.status ? r.status === filter.status : true))
          .map(strip),
      );
      return paginate(rows, cursor, limit);
    },
    async getDsarExport(organizationId, jobId) {
      return strip(loadDsar(organizationId, jobId));
    },
    async fulfillDsarExport(organizationId, jobId) {
      const r = loadDsar(organizationId, jobId);
      r.status = "fulfilled";
      r.fulfilledAt = now();
      return strip(r);
    },
    async extendDsarExport(organizationId, jobId) {
      const r = loadDsar(organizationId, jobId);
      if (r.extendedUntil) {
        throw new ChartWardenError(
          "DSAR_ALREADY_EXTENDED",
          "the §164.524 30-day extension is one-time",
          409,
        );
      }
      r.status = "extended";
      r.extendedUntil = plusDays(r.slaDueAt, 30);
      return strip(r);
    },
    async denyDsarExport(organizationId, jobId, args) {
      const r = loadDsar(organizationId, jobId);
      r.status = "denied";
      r.deniedReason = args.deniedReason;
      return strip(r);
    },
    async dsarDownloadUrl(organizationId, jobId, _actorMembershipId) {
      const r = loadDsar(organizationId, jobId);
      if (r.status !== "fulfilled") {
        throw new ChartWardenError(
          "DSAR_NOT_FULFILLED",
          "the bundle is not yet available for download",
          409,
        );
      }
      return { url: `https://minio.local/dsar/${r.id}`, expiresAt: plusDays(now(), 1) };
    },
    // --- tenant export jobs ---
    async requestTenantExport(organizationId, _actorMembershipId, args) {
      const id = uuidFromCounter("e", ++created);
      const rec: TenantExportRecord = {
        id,
        organizationId,
        requestedPurpose: args.requestedPurpose,
        status: "requested",
        requestedAt: now(),
        fulfilledAt: null,
        bundleSizeBytes: null,
        createdAt: now(),
      };
      tenantExports.set(id, rec);
      await enqueue.enqueue("tenant.export", { jobId: id });
      return strip(rec);
    },
    async listTenantExports(organizationId, filter, cursor, limit) {
      const rows = desc(
        [...tenantExports.values()]
          .filter((r) => r.organizationId === organizationId)
          .filter((r) => (filter.status ? r.status === filter.status : true))
          .map(strip),
      );
      return paginate(rows, cursor, limit);
    },
    async tenantExportDownloadUrl(organizationId, jobId, _actorMembershipId) {
      const r = loadTenantExport(organizationId, jobId);
      if (r.status !== "fulfilled") {
        throw new ChartWardenError(
          "TENANT_EXPORT_NOT_FULFILLED",
          "the bundle is not yet available",
          409,
        );
      }
      return { url: `https://minio.local/export/${r.id}`, expiresAt: plusDays(now(), 1) };
    },
    // --- onboarding ---
    async listOnboarding(organizationId, cursor, limit) {
      const rows = desc(
        [...onboarding.values()].filter((r) => r.organizationId === organizationId).map(strip),
      );
      return paginate(rows, cursor, limit);
    },
    async startOnboardingTask(organizationId, taskId) {
      const r = loadOnboarding(organizationId, taskId);
      r.status = "in_progress";
      r.startedAt = now();
      return strip(r);
    },
    async completeOnboardingTask(organizationId, taskId, _completionEvidence) {
      const r = loadOnboarding(organizationId, taskId);
      r.status = "done";
      r.completedAt = now();
      return strip(r);
    },
    async blockOnboardingTask(organizationId, taskId, blockerReason) {
      const r = loadOnboarding(organizationId, taskId);
      r.status = "blocked";
      r.blockerReason = blockerReason;
      return strip(r);
    },
    // --- BAA ---
    async listBaa(organizationId, cursor, limit) {
      const rows = desc(
        [...baa.values()].filter((r) => r.organizationId === organizationId).map(strip),
      );
      return paginate(rows, cursor, limit);
    },
    async attestBaa(organizationId, baaId, _actorMembershipId) {
      const r = loadBaa(organizationId, baaId);
      r.attestedAt = now();
      return strip(r);
    },
  };

  const inspect: TenantBackendInspect = {
    grantCount: (organizationId) =>
      [...grants.values()].filter((r) => r.organizationId === organizationId).length,
    enqueued: () => enqueueLog,
  };

  return { service, inspect };
}
