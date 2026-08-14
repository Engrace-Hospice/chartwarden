// apps/backend/src/modules/33-reporting/routes/write-service.ts — the M33WriteRouteService + an
// in-memory slice (§4.1/§4.2 MUTATING surface: definitions / views / shares / schedules, #8–#31).
//
// The report-definition (D9 immutable version chain), saved-view + sharing (D17), and scheduled-delivery
// (D7) command routes all compose over this service. Mirrors the M22 routes/service.ts + M34
// routes/.../service.ts precedent EXACTLY:
//   - the in-memory slice holds a deterministic dataset (route/acceptance tests mount one group over a
//     fresh backend); PRODUCTION injects the Drizzle-backed service (write-service-drizzle.ts) whose
//     WRITES run inside ONE `withOrgContext(db, {organizationId, userId}, …)` transaction so Postgres RLS
//     scopes every statement to `app.org_id` (the authoring/management CRUD reads co-locate on the primary
//     under the same `withOrgContext` for read-your-write consistency — the heavier replica-routed tile /
//     dashboard / catalog reads live in the read-service).
//   - the §2.3 domain rules (BASE_NOT_ACTIVE, CRON_TOO_FREQUENT, RECIPIENT_NOT_IN_ORG,
//     PDF_ROW_LIMIT_EXCEEDED) + the D9 immutable-version-chain (editing a definition appends a NEW version;
//     publish promotes one to `latest` and supersedes the prior) are enforced HERE, in the shared service,
//     so both backends refuse the same illegal mutations identically. The pure assertion helpers below are
//     the single home for each rule.
//   - org/actor/owner binding is ALWAYS the server-assembled {@link M33WriteActor} (context, never body).
import type { DbClient } from "@wardenx/db";
import { ConflictError, NotFoundError, WardenXError } from "@wardenx/types";
import type { M33WriteActor } from "./actor";
import { type CursorPage, paginate } from "./concurrency";

// ── §4.2 builder spec shape (mirrors the package-owned ReportDefinitionSpec; jsonb-stored) ────────────
export interface ReportSpec {
  readonly dimensions: readonly { dimensionKey: string; alias?: string }[];
  readonly measures: readonly { measureKey: string; alias?: string }[];
  readonly filters: readonly Record<string, unknown>[];
  readonly sort?: readonly { by: string; direction: "asc" | "desc" }[];
  readonly rowLimit?: number;
  readonly chartHint?: string;
}

// ── route DTOs (in-memory; the Drizzle adapter projects rows to the SAME shapes) ──────────────────────

export interface DefinitionView {
  readonly id: string;
  readonly organizationId: string;
  readonly authorship: "system" | "tenant";
  readonly baseKey: string;
  readonly ownerMembershipId: string | null;
  readonly displayName: string;
  readonly description: string | null;
  readonly latestVersionId: string | null;
  readonly versionSeq: number;
  readonly status: "draft" | "published" | "archived";
  readonly createdAt: string;
  readonly archivedAt: string | null;
}

export interface DefinitionVersionView {
  readonly id: string;
  readonly definitionId: string;
  readonly organizationId: string;
  readonly versionNumber: number;
  readonly spec: ReportSpec;
  readonly status: "draft" | "published" | "superseded";
  readonly publishedAt: string | null;
  readonly supersededAt: string | null;
  readonly createdAt: string;
}

export interface ViewView {
  readonly id: string;
  readonly organizationId: string;
  readonly definitionVersionId: string;
  readonly ownerMembershipId: string;
  readonly displayName: string;
  readonly pinnedFilters: readonly Record<string, unknown>[];
  readonly shareScope: "private" | "role" | "org";
  readonly shareRoleKeys: readonly string[] | null;
  readonly isOrgDefault: boolean;
  readonly status: "active" | "archived";
  readonly createdAt: string;
}

export interface ShareView {
  readonly id: string;
  readonly organizationId: string;
  readonly reportViewId: string;
  readonly sharedWithMembershipId: string | null;
  readonly sharedWithRoleKey: string | null;
  readonly status: "active" | "revoked";
  readonly createdAt: string;
  readonly revokedAt: string | null;
}

export interface ScheduleView {
  readonly id: string;
  readonly organizationId: string;
  readonly reportViewId: string;
  readonly ownerMembershipId: string;
  readonly cronExpression: string;
  readonly tenantTimezone: string;
  readonly format: "pdf" | "xlsx" | "csv";
  readonly recipientMembershipIds: readonly string[];
  readonly deliveryChannel: "in_app";
  readonly nextRunAt: string | null;
  readonly status: "active" | "paused" | "cancelled";
  readonly createdAt: string;
  readonly cancelledAt: string | null;
}

export interface ScheduleRunView {
  readonly id: string;
  readonly scheduleId: string;
  readonly organizationId: string;
  readonly scheduledFor: string;
  readonly status:
    | "queued"
    | "running"
    | "rendered_pending"
    | "rendered_complete"
    | "delivered"
    | "failed";
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly documentId: string | null;
  readonly failureReason: string | null;
  readonly rowCount: number | null;
}

// ── request args (the route layer maps the parsed TypeBox body to these) ──────────────────────────────

export interface CreateDefinitionArgs {
  readonly baseKey: string;
  readonly displayName: string;
  readonly description?: string;
  readonly spec: ReportSpec;
}
export interface CreateVersionArgs {
  readonly spec: ReportSpec;
  readonly displayName?: string;
  readonly description?: string;
}
export interface CreateViewArgs {
  readonly definitionVersionId: string;
  readonly displayName: string;
  readonly pinnedFilters?: readonly Record<string, unknown>[];
  readonly shareScope?: "private" | "role" | "org";
  readonly shareRoleKeys?: readonly string[];
}
export interface UpdateViewArgs {
  readonly displayName?: string;
  readonly pinnedFilters?: readonly Record<string, unknown>[];
  readonly shareScope?: "private" | "role" | "org";
  readonly shareRoleKeys?: readonly string[];
}
export interface ShareViewArgs {
  readonly shareScope: "private" | "role" | "org";
  readonly shareRoleKeys?: readonly string[];
  readonly sharedWithMembershipId?: string;
}
export interface CreateScheduleArgs {
  readonly reportViewId: string;
  readonly cronExpression: string;
  readonly tenantTimezone: string;
  readonly format: "pdf" | "xlsx" | "csv";
  readonly recipientMembershipIds: readonly string[];
}
export interface UpdateScheduleArgs {
  readonly cronExpression?: string;
  readonly tenantTimezone?: string;
  readonly format?: "pdf" | "xlsx" | "csv";
  readonly recipientMembershipIds?: readonly string[];
}

// ── §2.3 domain-rule errors + pure assertion helpers (single home; both backends call these) ──────────

/** §2.3 — a tenant definition must reference an `active` report_base_catalog row. */
export class BaseNotActiveError extends WardenXError {
  constructor(baseKey: string) {
    super("BASE_NOT_ACTIVE", `report base '${baseKey}' is not active`, 422);
    this.name = "BaseNotActiveError";
  }
}
/** §2.3 — a schedule's recipients must all be active memberships in the same org. */
export class RecipientNotInOrgError extends WardenXError {
  constructor(ids: readonly string[]) {
    super("RECIPIENT_NOT_IN_ORG", `recipients not active in this org: ${ids.join(", ")}`, 422);
    this.name = "RecipientNotInOrgError";
  }
}
/** §2.3 — the cron must leave ≥ 5 min between consecutive evaluations. */
export class CronTooFrequentError extends WardenXError {
  constructor() {
    super("CRON_TOO_FREQUENT", "the cron must leave at least 5 minutes between runs", 422);
    this.name = "CronTooFrequentError";
  }
}
/**
 * §2.3 — the schedule's `cron_expression` / `tenant_timezone` pair cannot be evaluated (GAP-050).
 *
 * A bad cadence is the caller's input error, so it is a 422, not the 5xx the unbound {@link CronPort}
 * raised for every caller before the adapter was bound. Covers three distinct refusals the adapter makes:
 * an expression `cron-parser` rejects outright; an expression it accepts but that has NO future
 * occurrence (`0 9 30 2 *` — February 30th); and a `tenantTimezone` `Intl` does not recognize, which
 * `cron-parser` reports only as an opaque `CronDate: unhandled timestamp` deep inside its own evaluator.
 */
export class CronExpressionInvalidError extends WardenXError {
  constructor(reason: string) {
    super("CRON_EXPRESSION_INVALID", `the schedule's cron cannot be evaluated: ${reason}`, 422);
    this.name = "CronExpressionInvalidError";
  }
}
/** §2.3 — a `pdf` schedule may not render a view whose definition `row_limit > 5000`. */
export class PdfRowLimitExceededError extends WardenXError {
  constructor(rowLimit: number) {
    super("PDF_ROW_LIMIT_EXCEEDED", `pdf export row_limit ${rowLimit} exceeds 5000`, 422);
    this.name = "PdfRowLimitExceededError";
  }
}

/** The minimum legal gap (ms) between two consecutive schedule fires (§2.3). */
export const MIN_SCHEDULE_GAP_MS = 5 * 60_000;
/** The Puppeteer-render practical row ceiling for a `pdf` schedule (§2.3). */
export const PDF_MAX_ROW_LIMIT = 5000;

/** §2.3 BASE_NOT_ACTIVE — refuse a definition mutation against an absent/non-active base. */
export function assertBaseActive(baseKey: string, baseStatus: string | null): void {
  if (baseStatus !== "active") throw new BaseNotActiveError(baseKey);
}

/** §2.3 PDF_ROW_LIMIT_EXCEEDED — refuse a `pdf` schedule over a view whose spec row_limit > 5000. */
export function assertPdfRowLimit(
  format: "pdf" | "xlsx" | "csv",
  rowLimit: number | undefined,
): void {
  if (format === "pdf" && (rowLimit ?? 1000) > PDF_MAX_ROW_LIMIT) {
    throw new PdfRowLimitExceededError(rowLimit ?? 1000);
  }
}

/**
 * §2.3 CRON_TOO_FREQUENT — given the next two fires the cron produces, refuse a cadence under the 5-min
 * floor. PURE; the cron parsing is the injected {@link CronPort} (boot binds `cron-parser`).
 */
export function assertCronCadence(firstFire: Date, secondFire: Date): void {
  if (secondFire.getTime() - firstFire.getTime() < MIN_SCHEDULE_GAP_MS) {
    throw new CronTooFrequentError();
  }
}

// ── injected ports (deny-stub-safe; keep the route + service free of cron/membership imports) ─────────

/**
 * The cron port both backends compute `next_run_at` + the §2.3 cadence guard with. PRODUCTION binds
 * `cron-parser` over the tenant timezone (P2C); the in-memory slice ships a deterministic stub.
 */
export interface CronPort {
  /** The next fire at/after `after`, evaluated in `tenantTimezone`. */
  nextRunAfter(cronExpression: string, tenantTimezone: string, after: Date): Date;
}

/**
 * The recipient-validation port backing §2.3 RECIPIENT_NOT_IN_ORG — returns the subset of
 * `membershipIds` that are NOT active memberships of `organizationId` (empty ⇒ all valid). The real
 * binding reaches the M2/M40 membership reader OPAQUELY (no import edge); when unbound the deny-stub
 * accepts (the tenant's own org is RLS-scoped already), so the create route is not bricked pre-binding.
 */
export interface RecipientReaderPort {
  findForeignOrInactive(
    organizationId: string,
    membershipIds: readonly string[],
  ): Promise<readonly string[]>;
}

/** The accept-all deny-stub recipient reader (used until the real M2/M40 membership reader binds). */
export const acceptAllRecipientReader: RecipientReaderPort = {
  async findForeignOrInactive() {
    return [];
  },
};

/**
 * The structural org-context transaction handle the §4.10 outbox row is inserted through: the SAME
 * `withOrgContext` tx the mutation already opened (transactional outbox — the event row commits atomically
 * with the write). Pinned to `DbClient` to MIRROR the bootstrap `OutboxTx`
 * (apps/backend/src/bootstrap/outbox-persister.ts) the composition root binds; `WriteTx`
 * (write-service-drizzle.ts) is also `DbClient`, so the tx the service passes satisfies this exactly.
 */
export type WriteOutboxTx = DbClient;

/**
 * The transactional-outbox emit port. M33 is OUTBOX-ONLY across module boundaries (D6); the command
 * routes emit the §4.10 `m33.*` events through this port in the SAME unit of work as the mutation.
 *
 * Mirrors the bootstrap `OutboxPublishPort`'s `publish(tx, input)` shape (the M34 precedent): the caller
 * hands its open `tx` plus the catalog-routing fields (`organizationId` — the non-null tenant uuid the
 * `outbox_event` row is keyed on, `aggregateKind`/`aggregateId` — the non-null aggregate uuid) and the
 * `payload`. `callerModule` is fixed to `m33` by the composition-root adapter that binds this to
 * `buildTxOutboxPublisher`, so callers pass only the fields below. A non-conformant payload THROWS in the
 * dispatcher and rolls the mutation's tx back. The port is optional + best-effort here (the runtime
 * dispatcher binds at boot); when unbound the mutation still lands (zero regression).
 */
export interface WriteOutboxPort {
  publish(
    tx: WriteOutboxTx,
    input: {
      readonly eventName: string;
      readonly payload: Record<string, unknown>;
      readonly organizationId: string;
      readonly aggregateKind: string;
      readonly aggregateId: string;
    },
  ): Promise<void>;
}

// ── the route service the handlers compose over ───────────────────────────────────────────────────────
export interface M33WriteRouteService {
  // definitions (§4.1 #8–#14)
  createDefinition(actor: M33WriteActor, args: CreateDefinitionArgs): Promise<DefinitionView>;
  listDefinitions(
    actor: M33WriteActor,
    filter: { status?: string; authorship?: string },
    cursor: string | undefined,
    limit: number | undefined,
  ): Promise<CursorPage<DefinitionView>>;
  getDefinition(actor: M33WriteActor, id: string): Promise<DefinitionView>;
  listVersions(
    actor: M33WriteActor,
    definitionId: string,
    cursor: string | undefined,
    limit: number | undefined,
  ): Promise<CursorPage<DefinitionVersionView>>;
  createVersion(
    actor: M33WriteActor,
    definitionId: string,
    args: CreateVersionArgs,
  ): Promise<DefinitionVersionView>;
  publishVersion(
    actor: M33WriteActor,
    definitionId: string,
    versionId: string,
  ): Promise<{ definition: DefinitionView; version: DefinitionVersionView }>;
  archiveDefinition(actor: M33WriteActor, id: string): Promise<DefinitionView>;

  // saved views + sharing (§4.1 #15–#21)
  listViews(
    actor: M33WriteActor,
    filter: { scope?: "mine" | "org" },
    cursor: string | undefined,
    limit: number | undefined,
  ): Promise<CursorPage<ViewView>>;
  createView(actor: M33WriteActor, args: CreateViewArgs): Promise<ViewView>;
  getView(actor: M33WriteActor, id: string): Promise<ViewView>;
  updateView(actor: M33WriteActor, id: string, args: UpdateViewArgs): Promise<ViewView>;
  shareView(
    actor: M33WriteActor,
    id: string,
    args: ShareViewArgs,
    canShareOrg: boolean,
  ): Promise<{ view: ViewView; share: ShareView | null }>;
  setOrgDefault(actor: M33WriteActor, id: string): Promise<ViewView>;
  archiveView(actor: M33WriteActor, id: string): Promise<ViewView>;

  // scheduled reports (§4.1 #22–#31)
  listSchedules(
    actor: M33WriteActor,
    filter: { status?: string },
    cursor: string | undefined,
    limit: number | undefined,
  ): Promise<CursorPage<ScheduleView>>;
  createSchedule(actor: M33WriteActor, args: CreateScheduleArgs): Promise<ScheduleView>;
  getSchedule(actor: M33WriteActor, id: string): Promise<ScheduleView>;
  updateSchedule(actor: M33WriteActor, id: string, args: UpdateScheduleArgs): Promise<ScheduleView>;
  pauseSchedule(actor: M33WriteActor, id: string): Promise<ScheduleView>;
  resumeSchedule(actor: M33WriteActor, id: string): Promise<ScheduleView>;
  cancelSchedule(actor: M33WriteActor, id: string): Promise<ScheduleView>;
  deleteAllRuns(actor: M33WriteActor, id: string): Promise<{ scheduleId: string; deleted: number }>;
  listScheduleRuns(
    actor: M33WriteActor,
    scheduleId: string,
    cursor: string | undefined,
    limit: number | undefined,
  ): Promise<CursorPage<ScheduleRunView>>;
  getScheduleRun(actor: M33WriteActor, runId: string): Promise<ScheduleRunView>;
}

// ── in-memory slice ───────────────────────────────────────────────────────────────────────────────────

/** Deterministic, I/O-free seed for the in-memory write service (slice + acceptance tests). */
export interface M33WriteRouteSeed {
  /** Base keys the slice treats as `active` (a base not listed → BASE_NOT_ACTIVE). */
  readonly activeBaseKeys?: readonly string[];
  /** Override the stub cron's fixed gap (ms) between fires (default 1h; < 5min → CRON_TOO_FREQUENT). */
  readonly cronGapMs?: number;
  /** Pre-seeded views (so a schedule/share test has a target without first POSTing one). */
  readonly views?: readonly Partial<ViewView>[];
}

/** Pads `n` to a uuid-shaped id so created ids round-trip through uuid-validated bodies (M22 slice). */
function uuidFromCounter(prefixNibble: string, n: number): string {
  const hex = n.toString(16).padStart(12, "0");
  return `${prefixNibble}0000000-0000-4000-8000-${hex}`;
}

/** DESC by `(createdAt, id)` for keyset pagination. */
function desc<T extends { createdAt: string; id: string }>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) =>
    a.createdAt === b.createdAt ? (a.id < b.id ? 1 : -1) : a.createdAt < b.createdAt ? 1 : -1,
  );
}

/** Read-only inspection surface over the slice (the acceptance tests assert against it). */
export interface M33WriteBackendInspect {
  definitionCount(): number;
  versionCount(): number;
  viewCount(): number;
  scheduleCount(): number;
  emittedEvents(): ReadonlyArray<{ eventName: string }>;
}

export function createInMemoryM33WriteBackend(seed: M33WriteRouteSeed = {}): {
  service: M33WriteRouteService;
  inspect: M33WriteBackendInspect;
} {
  let clock = Date.parse("2026-06-21T12:00:00.000Z");
  const nowIso = (): string => {
    clock += 1000; // strictly-increasing so keyset ordering is stable
    return new Date(clock).toISOString();
  };
  let seq = 0;
  const id = (p: string) => uuidFromCounter(p, ++seq);

  const activeBases = new Set(seed.activeBaseKeys ?? ["census_daily", "encounter_productivity"]);
  const cronGapMs = seed.cronGapMs ?? 60 * 60_000;

  const definitions = new Map<string, DefinitionView>();
  const versions = new Map<string, DefinitionVersionView>();
  const views = new Map<string, ViewView>();
  const shares = new Map<string, ShareView>();
  const schedules = new Map<string, ScheduleView>();
  const runs = new Map<string, ScheduleRunView>();
  const emitted: { eventName: string }[] = [];

  for (const v of seed.views ?? []) {
    const vid = v.id ?? id("c");
    views.set(vid, {
      id: vid,
      organizationId: v.organizationId ?? uuidFromCounter("e", 1),
      definitionVersionId: v.definitionVersionId ?? id("b"),
      ownerMembershipId: v.ownerMembershipId ?? uuidFromCounter("f", 1),
      displayName: v.displayName ?? "Seeded view",
      pinnedFilters: v.pinnedFilters ?? [],
      shareScope: v.shareScope ?? "private",
      shareRoleKeys: v.shareRoleKeys ?? null,
      isOrgDefault: v.isOrgDefault ?? false,
      status: v.status ?? "active",
      createdAt: v.createdAt ?? nowIso(),
    });
  }

  /** A deterministic stub cron: every fire is `cronGapMs` after the previous one. */
  const stubNextRun = (after: Date): Date => new Date(after.getTime() + cronGapMs);

  /** Resolve a view in the actor's org or throw a non-leaking 404 (RLS-hidden rows are 404 too). */
  const ownView = (actor: M33WriteActor, viewId: string): ViewView => {
    const v = views.get(viewId);
    if (!v || v.organizationId !== actor.organizationId) throw new NotFoundError("report view");
    return v;
  };
  const ownDefinition = (actor: M33WriteActor, defId: string): DefinitionView => {
    const d = definitions.get(defId);
    if (!d || d.organizationId !== actor.organizationId)
      throw new NotFoundError("report definition");
    return d;
  };
  const ownSchedule = (actor: M33WriteActor, schId: string): ScheduleView => {
    const s = schedules.get(schId);
    if (!s || s.organizationId !== actor.organizationId) throw new NotFoundError("report schedule");
    return s;
  };

  const service: M33WriteRouteService = {
    // ── definitions ──
    async createDefinition(actor, args) {
      assertBaseActive(args.baseKey, activeBases.has(args.baseKey) ? "active" : null);
      const defId = id("a");
      const versionId = id("b");
      const created = nowIso();
      const version: DefinitionVersionView = {
        id: versionId,
        definitionId: defId,
        organizationId: actor.organizationId,
        versionNumber: 1,
        spec: args.spec,
        status: "draft",
        publishedAt: null,
        supersededAt: null,
        createdAt: created,
      };
      versions.set(versionId, version);
      const def: DefinitionView = {
        id: defId,
        organizationId: actor.organizationId,
        authorship: "tenant",
        baseKey: args.baseKey,
        ownerMembershipId: actor.membershipId,
        displayName: args.displayName,
        description: args.description ?? null,
        latestVersionId: null, // a draft has no published latest yet (D9 — publish sets it)
        versionSeq: 0,
        status: "draft",
        createdAt: created,
        archivedAt: null,
      };
      definitions.set(defId, def);
      return def;
    },
    async listDefinitions(actor, filter, cursor, limit) {
      const rows = desc(
        [...definitions.values()]
          .filter((d) => d.organizationId === actor.organizationId)
          .filter((d) => (filter.status ? d.status === filter.status : true))
          .filter((d) => (filter.authorship ? d.authorship === filter.authorship : true)),
      );
      return paginate(rows, cursor, limit);
    },
    async getDefinition(actor, defId) {
      return ownDefinition(actor, defId);
    },
    async listVersions(actor, definitionId, cursor, limit) {
      ownDefinition(actor, definitionId);
      const rows = desc([...versions.values()].filter((v) => v.definitionId === definitionId));
      return paginate(rows, cursor, limit);
    },
    async createVersion(actor, definitionId, args) {
      const def = ownDefinition(actor, definitionId);
      assertBaseActive(def.baseKey, activeBases.has(def.baseKey) ? "active" : null);
      const existing = [...versions.values()].filter((v) => v.definitionId === definitionId);
      const nextNumber = existing.reduce((m, v) => Math.max(m, v.versionNumber), 0) + 1;
      const versionId = id("b");
      const version: DefinitionVersionView = {
        id: versionId,
        definitionId,
        organizationId: actor.organizationId,
        versionNumber: nextNumber,
        spec: args.spec,
        status: "draft", // D9 — a new edit is an unpublished draft until publish promotes it
        publishedAt: null,
        supersededAt: null,
        createdAt: nowIso(),
      };
      versions.set(versionId, version);
      if (args.displayName || args.description !== undefined) {
        definitions.set(definitionId, {
          ...def,
          displayName: args.displayName ?? def.displayName,
          description: args.description ?? def.description,
        });
      }
      return version;
    },
    async publishVersion(actor, definitionId, versionId) {
      const def = ownDefinition(actor, definitionId);
      const version = versions.get(versionId);
      if (!version || version.definitionId !== definitionId)
        throw new NotFoundError("report definition version");
      if (version.status === "superseded") {
        throw new ConflictError("a superseded version cannot be published");
      }
      const published = nowIso();
      // supersede the prior latest (D9).
      if (def.latestVersionId && def.latestVersionId !== versionId) {
        const prior = versions.get(def.latestVersionId);
        if (prior)
          versions.set(prior.id, { ...prior, status: "superseded", supersededAt: published });
      }
      const newVersion: DefinitionVersionView = {
        ...version,
        status: "published",
        publishedAt: version.publishedAt ?? published,
      };
      versions.set(versionId, newVersion);
      const newDef: DefinitionView = {
        ...def,
        status: "published",
        latestVersionId: versionId,
        versionSeq: def.versionSeq + 1,
      };
      definitions.set(definitionId, newDef);
      emitted.push({ eventName: "m33.report_definition.published" });
      return { definition: newDef, version: newVersion };
    },
    async archiveDefinition(actor, defId) {
      const def = ownDefinition(actor, defId);
      const archived: DefinitionView = {
        ...def,
        status: "archived",
        archivedAt: nowIso(),
        versionSeq: def.versionSeq + 1,
      };
      definitions.set(defId, archived);
      return archived;
    },

    // ── saved views + sharing ──
    async listViews(actor, filter, cursor, limit) {
      const rows = desc(
        [...views.values()]
          .filter((v) => v.organizationId === actor.organizationId)
          .filter((v) =>
            filter.scope === "org"
              ? v.shareScope === "org" && v.status === "active"
              : v.ownerMembershipId === actor.membershipId,
          ),
      );
      return paginate(rows, cursor, limit);
    },
    async createView(actor, args) {
      const viewId = id("c");
      const view: ViewView = {
        id: viewId,
        organizationId: actor.organizationId,
        definitionVersionId: args.definitionVersionId,
        ownerMembershipId: actor.membershipId,
        displayName: args.displayName,
        pinnedFilters: args.pinnedFilters ?? [],
        shareScope: args.shareScope ?? "private",
        shareRoleKeys: args.shareRoleKeys ?? null,
        isOrgDefault: false,
        status: "active",
        createdAt: nowIso(),
      };
      views.set(viewId, view);
      return view;
    },
    async getView(actor, viewId) {
      return ownView(actor, viewId);
    },
    async updateView(actor, viewId, args) {
      const v = ownView(actor, viewId);
      const updated: ViewView = {
        ...v,
        displayName: args.displayName ?? v.displayName,
        pinnedFilters: args.pinnedFilters ?? v.pinnedFilters,
        shareScope: args.shareScope ?? v.shareScope,
        shareRoleKeys: args.shareRoleKeys ?? v.shareRoleKeys,
      };
      views.set(viewId, updated);
      return updated;
    },
    async shareView(actor, viewId, args, canShareOrg) {
      const v = ownView(actor, viewId);
      if (args.shareScope === "org" && !canShareOrg) {
        // the route also gates report.share.org via RBAC; defence-in-depth refusal here.
        throw new ConflictError("org-scope sharing requires the report.share.org permission");
      }
      const updated: ViewView = {
        ...v,
        shareScope: args.shareScope,
        shareRoleKeys: args.shareRoleKeys ?? v.shareRoleKeys,
      };
      views.set(viewId, updated);
      let share: ShareView | null = null;
      if (
        args.shareScope === "role" &&
        (args.shareRoleKeys?.length || args.sharedWithMembershipId)
      ) {
        const shareId = id("d");
        share = {
          id: shareId,
          organizationId: actor.organizationId,
          reportViewId: viewId,
          sharedWithMembershipId: args.sharedWithMembershipId ?? null,
          sharedWithRoleKey: args.shareRoleKeys?.[0] ?? null,
          status: "active",
          createdAt: nowIso(),
          revokedAt: null,
        };
        shares.set(shareId, share);
      }
      if (args.shareScope === "org") emitted.push({ eventName: "m33.report_view.shared_org" });
      return { view: updated, share };
    },
    async setOrgDefault(actor, viewId) {
      const v = ownView(actor, viewId);
      // exactly-one-default invariant: clear any other default in the org.
      for (const [k, other] of views) {
        if (other.organizationId === actor.organizationId && other.isOrgDefault && k !== viewId) {
          views.set(k, { ...other, isOrgDefault: false });
        }
      }
      const updated: ViewView = { ...v, isOrgDefault: true, shareScope: "org" };
      views.set(viewId, updated);
      return updated;
    },
    async archiveView(actor, viewId) {
      const v = ownView(actor, viewId);
      const archived: ViewView = { ...v, status: "archived", isOrgDefault: false };
      views.set(viewId, archived);
      return archived;
    },

    // ── scheduled reports ──
    async listSchedules(actor, filter, cursor, limit) {
      const rows = desc(
        [...schedules.values()]
          .filter((s) => s.organizationId === actor.organizationId)
          .filter((s) => (filter.status ? s.status === filter.status : true)),
      );
      return paginate(rows, cursor, limit);
    },
    async createSchedule(actor, args) {
      ownView(actor, args.reportViewId); // the schedule targets the actor's own org view (404 otherwise)
      assertPdfRowLimit(args.format, undefined);
      const from = new Date(clock);
      const first = stubNextRun(from);
      const second = stubNextRun(first);
      assertCronCadence(first, second);
      const schId = id("9");
      const schedule: ScheduleView = {
        id: schId,
        organizationId: actor.organizationId,
        reportViewId: args.reportViewId,
        ownerMembershipId: actor.membershipId,
        cronExpression: args.cronExpression,
        tenantTimezone: args.tenantTimezone,
        format: args.format,
        recipientMembershipIds: [...args.recipientMembershipIds],
        deliveryChannel: "in_app",
        nextRunAt: first.toISOString(),
        status: "active",
        createdAt: nowIso(),
        cancelledAt: null,
      };
      schedules.set(schId, schedule);
      emitted.push({ eventName: "m33.report_schedule.created" });
      return schedule;
    },
    async getSchedule(actor, schId) {
      return ownSchedule(actor, schId);
    },
    async updateSchedule(actor, schId, args) {
      const s = ownSchedule(actor, schId);
      if (s.status === "cancelled")
        throw new ConflictError("a cancelled schedule cannot be edited");
      const format = args.format ?? s.format;
      assertPdfRowLimit(format, undefined);
      if (args.cronExpression) {
        const from = new Date(clock);
        const first = stubNextRun(from);
        const second = stubNextRun(first);
        assertCronCadence(first, second);
      }
      const updated: ScheduleView = {
        ...s,
        cronExpression: args.cronExpression ?? s.cronExpression,
        tenantTimezone: args.tenantTimezone ?? s.tenantTimezone,
        format,
        recipientMembershipIds: args.recipientMembershipIds
          ? [...args.recipientMembershipIds]
          : s.recipientMembershipIds,
      };
      schedules.set(schId, updated);
      return updated;
    },
    async pauseSchedule(actor, schId) {
      const s = ownSchedule(actor, schId);
      if (s.status === "cancelled")
        throw new ConflictError("a cancelled schedule cannot be paused");
      const updated: ScheduleView = { ...s, status: "paused", nextRunAt: null };
      schedules.set(schId, updated);
      return updated;
    },
    async resumeSchedule(actor, schId) {
      const s = ownSchedule(actor, schId);
      if (s.status === "cancelled")
        throw new ConflictError("a cancelled schedule cannot be resumed");
      const next = stubNextRun(new Date(clock)).toISOString();
      const updated: ScheduleView = { ...s, status: "active", nextRunAt: next };
      schedules.set(schId, updated);
      return updated;
    },
    async cancelSchedule(actor, schId) {
      const s = ownSchedule(actor, schId);
      const updated: ScheduleView = {
        ...s,
        status: "cancelled",
        nextRunAt: null,
        cancelledAt: nowIso(),
      };
      schedules.set(schId, updated);
      return updated;
    },
    async deleteAllRuns(actor, schId) {
      ownSchedule(actor, schId);
      let deleted = 0;
      for (const [k, run] of runs) {
        if (run.scheduleId === schId) {
          runs.delete(k);
          deleted += 1;
        }
      }
      return { scheduleId: schId, deleted };
    },
    async listScheduleRuns(actor, scheduleId, cursor, limit) {
      ownSchedule(actor, scheduleId);
      const rows = desc(
        [...runs.values()]
          .filter((r) => r.scheduleId === scheduleId)
          .map((r) => ({ ...r, createdAt: r.scheduledFor })),
      );
      const page = paginate(rows, cursor, limit);
      return { ...page, items: page.items.map(({ createdAt: _c, ...r }) => r) };
    },
    async getScheduleRun(actor, runId) {
      const run = runs.get(runId);
      if (!run || run.organizationId !== actor.organizationId) {
        throw new NotFoundError("report schedule run");
      }
      return run;
    },
  };

  const inspect: M33WriteBackendInspect = {
    definitionCount: () => definitions.size,
    versionCount: () => versions.size,
    viewCount: () => views.size,
    scheduleCount: () => schedules.size,
    emittedEvents: () => emitted,
  };

  return { service, inspect };
}
