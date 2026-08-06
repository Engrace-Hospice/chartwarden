// @wardenx/reporting · repositories — the platform-global catalog aggregate: `report_base_catalog`
// (report bases → MV + dimension/measure catalog + drilldown template), `report_metric_catalog` (the
// metric registry), and `materialized_view_metadata` (the `report_mv.*` MV registry + refresh
// telemetry) (M33 §3.3–§3.4). All three are PLATFORM-scoped (NO organization_id; on the check-tenancy
// NON_ORG_SCOPED allowlist): tenants READ them under `withOrgContext` (the GRANT is org-readable), but
// WRITES are platform-ops / migration only (`withPlatformContext`). The translator's spec-validator
// reads the base catalog to whitelist dimensions/measures (D4); the MV-refresh worker stamps the
// telemetry.
import { schema } from "@wardenx/db";
import { and, asc, desc, eq } from "drizzle-orm";
import type { ReportingDb } from "./db";

const BASE = schema.reportBaseCatalog;
const METRIC = schema.reportMetricCatalog;
const MV = schema.materializedViewMetadata;

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
    const [row] = await this.db.update(MV).set(patch).where(eq(MV.mvKey, mvKey)).returning();
    if (!row) throw new Error(`materialized_view_metadata ${mvKey} not found for telemetry update`);
    return row;
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
