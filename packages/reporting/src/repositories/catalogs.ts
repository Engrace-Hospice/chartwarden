// @chartwarden/reporting · repositories — the platform-global catalog aggregate: `report_base_catalog`
// (report bases → MV + dimension/measure catalog + drilldown template), `report_metric_catalog` (the
// metric registry), and `materialized_view_metadata` (the `report_mv.*` MV registry + refresh
// telemetry) (M33 §3.3–§3.4). All three are PLATFORM-scoped (NO organization_id; on the check-tenancy
// NON_ORG_SCOPED allowlist): tenants READ them under `withOrgContext` (the GRANT is org-readable), but
// WRITES are platform-ops / migration only (`withPlatformContext`). The translator's spec-validator
// reads the base catalog to whitelist dimensions/measures (D4); the MV-refresh worker stamps the
// telemetry.
import { schema } from "@chartwarden/db";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { ReportingDb } from "./db";

const BASE = schema.reportBaseCatalog;
const METRIC = schema.reportMetricCatalog;
const MV = schema.materializedViewMetadata;

/**
 * One raw row back from `report_writer_update_platform_mv_metadata` (`SELECT * FROM fn(...)` unnests
 * the composite `materialized_view_metadata` return type into its own columns).
 *
 * `last_refreshed_at` comes back as a STRING, not a `Date`: `db.execute(sql\`...\`)` is a raw/untyped
 * query, so Drizzle's `PgTimestamp.mapFromDriverValue` conversion (which normal typed `.select()`/
 * `.update()` calls get automatically) never runs. `fromPlatformMvRow` does the conversion explicitly.
 */
interface RawPlatformMvMetadataRow {
  id: string;
  mv_key: string;
  schema_name: string;
  refresh_strategy: schema.MaterializedViewMetadata["refreshStrategy"];
  debounce_window_seconds: number;
  depends_on_mv_keys: string[];
  outbox_topics_subscribed: string[];
  expected_freshness_seconds: number;
  status: schema.MaterializedViewMetadata["status"];
  last_refreshed_at: string | null;
  last_refresh_duration_ms: number | null;
  refresh_failure_count: number;
}

function fromPlatformMvRow(row: RawPlatformMvMetadataRow): schema.MaterializedViewMetadata {
  return {
    id: row.id,
    mvKey: row.mv_key,
    schemaName: row.schema_name,
    refreshStrategy: row.refresh_strategy,
    debounceWindowSeconds: row.debounce_window_seconds,
    dependsOnMvKeys: row.depends_on_mv_keys,
    outboxTopicsSubscribed: row.outbox_topics_subscribed,
    expectedFreshnessSeconds: row.expected_freshness_seconds,
    status: row.status,
    lastRefreshedAt: row.last_refreshed_at === null ? null : new Date(row.last_refreshed_at),
    lastRefreshDurationMs: row.last_refresh_duration_ms,
    refreshFailureCount: row.refresh_failure_count,
  };
}

/** Data port for the three platform-global reporting catalogs. */
export class ReportCatalogRepository {
  constructor(private readonly db: ReportingDb) {}

  // ── report_base_catalog ──────────────────────────────────────────────────────────────────────

  /** List report bases, optionally filtered by status (the base-picker UI). */
  async listBases(
    status?: schema.ReportBaseCatalog["status"],
  ): Promise<readonly schema.ReportBaseCatalog[]> {
    const where = status ? eq(BASE.status, status) : undefined;
    return this.db.select().from(BASE).where(where).orderBy(asc(BASE.baseKey));
  }

  /** Fetch a base by its unique `base_key` (the translator's whitelist source, D4), or `null`. */
  async findBaseByKey(baseKey: string): Promise<schema.ReportBaseCatalog | null> {
    const [row] = await this.db.select().from(BASE).where(eq(BASE.baseKey, baseKey)).limit(1);
    return row ?? null;
  }

  /** Insert a base (platform-ops / seed). Returns the inserted row. */
  async createBase(values: schema.NewReportBaseCatalog): Promise<schema.ReportBaseCatalog> {
    const [row] = await this.db.insert(BASE).values(values).returning();
    if (!row) throw new Error("report_base_catalog insert returned no row");
    return row;
  }

  /** Transition a base's lifecycle status (seeded → active → deprecated → retired). */
  async updateBaseStatus(
    baseKey: string,
    status: schema.ReportBaseCatalog["status"],
    deprecatedAt?: Date,
  ): Promise<schema.ReportBaseCatalog> {
    const [row] = await this.db
      .update(BASE)
      .set({ status, ...(deprecatedAt ? { deprecatedAt } : {}) })
      .where(eq(BASE.baseKey, baseKey))
      .returning();
    if (!row) throw new Error(`report_base_catalog ${baseKey} not found for status update`);
    return row;
  }

  // ── report_metric_catalog ────────────────────────────────────────────────────────────────────

  /** List metrics, optionally filtered by status (the metric-catalog UI). */
  async listMetrics(
    status?: schema.ReportMetricCatalog["status"],
  ): Promise<readonly schema.ReportMetricCatalog[]> {
    const where = status ? eq(METRIC.status, status) : undefined;
    return this.db.select().from(METRIC).where(where).orderBy(asc(METRIC.metricKey));
  }

  /** Fetch a metric by its unique `metric_key`, or `null`. */
  async findMetricByKey(metricKey: string): Promise<schema.ReportMetricCatalog | null> {
    const [row] = await this.db
      .select()
      .from(METRIC)
      .where(eq(METRIC.metricKey, metricKey))
      .limit(1);
    return row ?? null;
  }

  /** Insert a metric (platform-ops / seed). Returns the inserted row. */
  async createMetric(values: schema.NewReportMetricCatalog): Promise<schema.ReportMetricCatalog> {
    const [row] = await this.db.insert(METRIC).values(values).returning();
    if (!row) throw new Error("report_metric_catalog insert returned no row");
    return row;
  }

  // ── materialized_view_metadata ───────────────────────────────────────────────────────────────

  /** List the registered MVs, optionally filtered by status (the platform MV-admin surface, §4.6). */
  async listMvMetadata(
    status?: schema.MaterializedViewMetadata["status"],
  ): Promise<readonly schema.MaterializedViewMetadata[]> {
    const where = status ? eq(MV.status, status) : undefined;
    return this.db.select().from(MV).where(where).orderBy(asc(MV.mvKey));
  }

  /** Fetch MV metadata by its unique `mv_key`, or `null`. */
  async findMvByKey(mvKey: string): Promise<schema.MaterializedViewMetadata | null> {
    const [row] = await this.db.select().from(MV).where(eq(MV.mvKey, mvKey)).limit(1);
    return row ?? null;
  }

  /** The ACTIVE MVs on a given refresh tier (the nightly/incremental orchestrator's work-set, §2.5). Backs
   *  {@link MvMetadataReadPort.listActiveByStrategy}. */
  async listActiveByStrategy(
    strategy: schema.MaterializedViewMetadata["refreshStrategy"],
  ): Promise<readonly schema.MaterializedViewMetadata[]> {
    return this.db
      .select()
      .from(MV)
      .where(and(eq(MV.refreshStrategy, strategy), eq(MV.status, "active")))
      .orderBy(asc(MV.mvKey));
  }

  /** Register an MV (platform-ops / migration). Returns the inserted row. */
  async createMvMetadata(
    values: schema.NewMaterializedViewMetadata,
  ): Promise<schema.MaterializedViewMetadata> {
    const [row] = await this.db.insert(MV).values(values).returning();
    if (!row) throw new Error("materialized_view_metadata insert returned no row");
    return row;
  }

  /**
   * Stamp MV-refresh telemetry after a refresh (last-refreshed timestamp + duration; the failure
   * counter is set absolutely so the worker can reset it to 0 on success or raise it on failure) and
   * optionally transition the MV's lifecycle status (e.g. → `suspended` after exhausted retries).
   *
   * `materialized_view_metadata` has NO `organization_id` column at all — every row is
   * platform-global — and `wardenx_app` holds SELECT only (migration 0058), no INSERT/UPDATE grant or
   * policy whatsoever. A plain Drizzle UPDATE therefore fails outright under real RLS (WX-PR-024,
   * "found adjacent" to the `report_run`/`audit_event` gap this pass fixed). This always calls the
   * SECURITY DEFINER `report_writer_update_platform_mv_metadata` function instead (migration 0188) —
   * owned by `report_writer`, EXECUTE granted directly to `wardenx_app`.
   */
  async updateMvRefreshTelemetry(
    mvKey: string,
    patch: Partial<
      Pick<
        schema.NewMaterializedViewMetadata,
        "lastRefreshedAt" | "lastRefreshDurationMs" | "refreshFailureCount" | "status"
      >
    >,
  ): Promise<schema.MaterializedViewMetadata> {
    const result = await this.db.execute(sql`
      SELECT * FROM report_writer_update_platform_mv_metadata(
        ${mvKey},
        ${JSON.stringify(patch)}::jsonb
      )
    `);
    const row = (result as unknown as { rows: RawPlatformMvMetadataRow[] }).rows[0];
    if (!row) throw new Error(`materialized_view_metadata ${mvKey} not found for telemetry update`);
    return fromPlatformMvRow(row);
  }

  /** The bases bound to a given MV (the "where used" admin surface for an MV). */
  async listBasesForMv(mvKey: string): Promise<readonly schema.ReportBaseCatalog[]> {
    return this.db
      .select()
      .from(BASE)
      .where(and(eq(BASE.mvKey, mvKey)))
      .orderBy(desc(BASE.createdAt));
  }
}
