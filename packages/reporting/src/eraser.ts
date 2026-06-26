// @wardenx/reporting — the M33 tenant-offboarding eraseFn (M4 destruction registry, §3.7 / D6 / §8.4).
//
// On tenant offboarding M33's eraseFn deletes the org's OPERATIONAL reporting rows (retention class
// `operational`, 13-month hot) in FK-safe order, REFUSES to destroy the `compliance`-class
// `report_drilldown_audit` (D9 survey-evidence — insert-only, destruction-blocked), and leaves the PLATFORM
// catalogs (`report_base_catalog` / `report_metric_catalog` / `materialized_view_metadata`) UNTOUCHED (they
// are shared reference data, migration-retired only — retiring them on one tenant's offboard would corrupt
// every other tenant). It emits `m33.tenant_eraser.complete` with per-table counts so M4 records them on the
// destruction certificate.
//
// §3.7 ordered sequence: report_schedule (FIRST — stops future runs) → report_schedule_run + report_run
// (run ledgers) → dashboard_tile_cache (transient) → report_view / report_share → report_definition /
// report_definition_version → report_drilldown_audit (REFUSED, compliance class) → catalogs (untouched).
//
// PURE port-injected orchestration (the M34 `eraseTenantSaasPlatform` precedent): the sequence is a total
// function over an injected {@link ReportingEraseStore}; the in-memory store backs the slice/tests and the
// composition root injects the Drizzle-backed store (each DELETE under the platform/org tenancy context) at
// P2C. No clock/RNG/Drizzle/`getSeam` import here.

/** The §3.7 ordered erase counts, keyed by table name (the M4 destruction-cert `tableCounts`). */
export type ReportingEraseTableCounts = Record<string, number>;

/** The destruction certificate fields the §3.7 co-sign gate reads (supplied once M4 cert-binding lands). */
export interface ReportingDecisionCert {
  /** The destruction scope; `org_offboarding` is the only scope that may reach compliance-class evidence. */
  readonly scope: string;
  /** The approver role keys on the certificate (the co-sign gate requires a `compliance_officer`). */
  readonly approverIds: readonly string[];
}

/** Options for one tenant-offboarding erase (the optional M4 destruction certificate driving the co-sign gate). */
export interface ReportingEraseOptions {
  readonly decisionCert?: ReportingDecisionCert;
}

/**
 * Raised when the §3.7 co-sign gate refuses the erase — an `org_offboarding` certificate that destroys
 * compliance-class survey evidence (`report_drilldown_audit`) MUST carry a `compliance_officer` approver.
 */
export class EraseRefused extends Error {
  constructor(public readonly code: string) {
    super(`reporting erase refused: ${code}`);
    this.name = "EraseRefused";
  }
}

/** The per-table delete + count surface the §3.7 sequence runs through (each DELETE scoped to the org). */
export interface ReportingEraseStore {
  /** report_schedule — deleted FIRST so no further run is scheduled. */
  deleteSchedules(organizationId: string): Promise<number>;
  /** report_schedule_run — the per-schedule run ledger. */
  deleteScheduleRuns(organizationId: string): Promise<number>;
  /** report_run — the (org-scoped subset of the) MV-refresh run ledger. */
  deleteRuns(organizationId: string): Promise<number>;
  /** dashboard_tile_cache — the transient sha256-keyed tile cache. */
  deleteTileCache(organizationId: string): Promise<number>;
  /** report_view — saved views. */
  deleteViews(organizationId: string): Promise<number>;
  /** report_share — view share grants. */
  deleteShares(organizationId: string): Promise<number>;
  /** report_definition — tenant report definitions. */
  deleteDefinitions(organizationId: string): Promise<number>;
  /** report_definition_version — the immutable version chain. */
  deleteDefinitionVersions(organizationId: string): Promise<number>;
  /** report_drilldown_audit — COUNT ONLY (compliance class, destruction-blocked — NOT deleted). */
  countDrilldownAudit(organizationId: string): Promise<number>;
  /** Emit `m33.tenant_eraser.complete` (best-effort; the slice records it, prod routes the outbox). */
  emitEraserComplete?(payload: {
    organizationId: string;
    tableCounts: ReportingEraseTableCounts;
    complianceClassRefused: number;
  }): Promise<void>;
}

/** What one tenant-offboarding erase reported (the M4 destruction-cert facts). */
export interface ReportingEraseResult {
  /** Total operational rows destroyed across the §3.7 tables (excludes the refused compliance class). */
  readonly erased: number;
  /** Per-table destruction counts (`report_drilldown_audit` is always 0 — refused). */
  readonly tableCounts: ReportingEraseTableCounts;
  /** The `report_drilldown_audit` rows REFUSED destruction under retention class `compliance` (§3.7). */
  readonly complianceClassRefused: number;
}

/**
 * Erase a tenant's OPERATIONAL reporting rows on offboarding (§3.7). Applies the co-sign gate FIRST (an
 * `org_offboarding` certificate without a `compliance_officer` approver is refused), deletes the operational
 * tables in FK-safe order, REFUSES `report_drilldown_audit` (compliance class — counted, never deleted), and
 * leaves the platform catalogs / MV registry untouched. Emits `m33.tenant_eraser.complete` with the counts.
 *
 * @throws {EraseRefused} the §3.7 co-sign gate denied the erase (`compliance_class_destruction_needs_co_sign`)
 */
export async function eraseTenantReporting(
  organizationId: string,
  store: ReportingEraseStore,
  options: ReportingEraseOptions = {},
): Promise<ReportingEraseResult> {
  // §3.7 step 1 — co-sign gate: destroying compliance-class survey evidence on offboarding needs co-sign.
  const cert = options.decisionCert;
  if (cert?.scope === "org_offboarding" && !cert.approverIds.includes("compliance_officer")) {
    throw new EraseRefused("compliance_class_destruction_needs_co_sign");
  }

  // §3.7 step 2 — ordered operational erase (schedules first → run ledgers → cache → views/shares → defs).
  const tableCounts: ReportingEraseTableCounts = {
    report_schedule: await store.deleteSchedules(organizationId),
    report_schedule_run: await store.deleteScheduleRuns(organizationId),
    report_run: await store.deleteRuns(organizationId),
    dashboard_tile_cache: await store.deleteTileCache(organizationId),
    report_view: await store.deleteViews(organizationId),
    report_share: await store.deleteShares(organizationId),
    report_definition: await store.deleteDefinitions(organizationId),
    report_definition_version: await store.deleteDefinitionVersions(organizationId),
  };

  // §3.7 step 3 — report_drilldown_audit is destruction-BLOCKED (compliance class): count, never delete.
  const complianceClassRefused = await store.countDrilldownAudit(organizationId);
  tableCounts.report_drilldown_audit = 0;

  // §3.7 step 4 — the platform catalogs + materialized_view_metadata are shared reference data (migration-
  // retired only); a single-tenant offboard NEVER touches them.

  const erased = Object.values(tableCounts).reduce((sum, n) => sum + n, 0);

  // §3.7 step 5 — emit `m33.tenant_eraser.complete` (M4 records the per-table counts on the cert).
  await store.emitEraserComplete?.({ organizationId, tableCounts, complianceClassRefused });

  return { erased, tableCounts, complianceClassRefused };
}

// ── in-memory store (slice + tests) ──────────────────────────────────────────────────────────────────────

/** A deterministic in-memory {@link ReportingEraseStore} seeded with per-org row counts (slice + tests). */
export interface ReportingEraseSeed {
  /** Per-org seeded counts keyed by table name (absent table ⇒ 0 rows). */
  readonly counts?: Readonly<Record<string, Partial<ReportingEraseTableCounts>>>;
}

/** Inspection surface over the in-memory erase store (the acceptance tests assert against it). */
export interface ReportingEraseStoreInspect {
  emittedCompletions(): ReadonlyArray<{
    organizationId: string;
    tableCounts: ReportingEraseTableCounts;
    complianceClassRefused: number;
  }>;
}

/**
 * Build a deterministic in-memory {@link ReportingEraseStore}. Each `delete*` returns its seeded count then
 * zeroes it (a second erase of the same org returns 0 — idempotent), `countDrilldownAudit` returns its seeded
 * count WITHOUT zeroing (it is never destroyed), and `emitEraserComplete` records the payload for assertions.
 */
export function createInMemoryReportingEraseStore(seed: ReportingEraseSeed = {}): {
  store: ReportingEraseStore;
  inspect: ReportingEraseStoreInspect;
} {
  const counts = new Map<string, Map<string, number>>();
  for (const [org, tables] of Object.entries(seed.counts ?? {})) {
    counts.set(org, new Map(Object.entries(tables).map(([t, n]) => [t, n ?? 0])));
  }
  const emitted: {
    organizationId: string;
    tableCounts: ReportingEraseTableCounts;
    complianceClassRefused: number;
  }[] = [];

  const take = (org: string, table: string): number => {
    const n = counts.get(org)?.get(table) ?? 0;
    counts.get(org)?.set(table, 0);
    return n;
  };
  const peek = (org: string, table: string): number => counts.get(org)?.get(table) ?? 0;

  const store: ReportingEraseStore = {
    deleteSchedules: async (org) => take(org, "report_schedule"),
    deleteScheduleRuns: async (org) => take(org, "report_schedule_run"),
    deleteRuns: async (org) => take(org, "report_run"),
    deleteTileCache: async (org) => take(org, "dashboard_tile_cache"),
    deleteViews: async (org) => take(org, "report_view"),
    deleteShares: async (org) => take(org, "report_share"),
    deleteDefinitions: async (org) => take(org, "report_definition"),
    deleteDefinitionVersions: async (org) => take(org, "report_definition_version"),
    countDrilldownAudit: async (org) => peek(org, "report_drilldown_audit"),
    emitEraserComplete: async (payload) => {
      emitted.push(payload);
    },
  };

  return { store, inspect: { emittedCompletions: () => emitted } };
}
