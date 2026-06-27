// @wardenx/reporting · repositories — the tile-cache aggregate: `dashboard_tile_cache` (a transient,
// non-partitioned cache of computed tile results keyed by sha256 over (orgId, mvKey,
// scope_envelope_hash, filters_hash), with a freshness stamp + TTL) (M33 §3.3–§3.4). ORG-SCOPED with a
// UNIQUE (organization_id, cache_key); the tile-compute path upserts on the cache key, the read path
// looks up by key, and a sweeper trims expired rows. The dashboard service wraps these in
// `withOrgContext`.
import { schema } from "@wardenx/db";
import { and, eq, lte } from "drizzle-orm";
import type { ReportingDb } from "./db";

const C = schema.dashboardTileCache;

/** Data port for `dashboard_tile_cache`. */
export class DashboardTileCacheRepository {
  constructor(private readonly db: ReportingDb) {}

  /**
   * Upsert a computed tile result on the UNIQUE (organization_id, cache_key): a fresh compute replaces
   * the prior result, freshness stamp, and TTL. Returns the upserted row.
   */
  async upsert(values: schema.NewDashboardTileCache): Promise<schema.DashboardTileCache> {
    const [row] = await this.db
      .insert(C)
      .values(values)
      .onConflictDoUpdate({
        target: [C.organizationId, C.cacheKey],
        set: {
          resultJson: values.resultJson,
          computedAt: values.computedAt ?? new Date(),
          expiresAt: values.expiresAt,
          freshnessSecondsAtCompute: values.freshnessSecondsAtCompute,
        },
      })
      .returning();
    if (!row) throw new Error("dashboard_tile_cache upsert returned no row");
    return row;
  }

  /**
   * Look up a cached tile result by (org, cache_key). Returns the row only when still live
   * (`expires_at > asOf`); an expired hit returns `null` so the caller recomputes.
   */
  async findFresh(
    organizationId: string,
    cacheKey: string,
    asOf: Date = new Date(),
  ): Promise<schema.DashboardTileCache | null> {
    const [row] = await this.db
      .select()
      .from(C)
      .where(and(eq(C.organizationId, organizationId), eq(C.cacheKey, cacheKey)))
      .limit(1);
    if (!row) return null;
    return row.expiresAt > asOf ? row : null;
  }

  /** Delete expired cache rows (the TTL sweeper). Returns the number of rows trimmed. */
  async deleteExpired(asOf: Date = new Date()): Promise<number> {
    const rows = await this.db.delete(C).where(lte(C.expiresAt, asOf)).returning();
    return rows.length;
  }

  /** Invalidate an org's entire tile cache (e.g. after an MV refresh). Returns rows deleted. */
  async deleteByOrg(organizationId: string): Promise<number> {
    const rows = await this.db.delete(C).where(eq(C.organizationId, organizationId)).returning();
    return rows.length;
  }
}
