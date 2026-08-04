// @wardenx/db — `dashboard_tile_cache` (M33 §3.3). A transient, non-partitioned cache of computed
// tile results keyed by a sha256 over (orgId, mvKey, scope_envelope_hash, filters_hash), with a
// freshness stamp and TTL. ORG-SCOPED: carries organization_id NOT NULL → standard app.org_id RLS
// (retention class `operational`). UNIQUE (organization_id, cache_key). RLS + grants + the M4
// write-audit trigger land in the M33 RLS migration.
import { sql } from "drizzle-orm";
import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const dashboardTileCache = pgTable(
  "dashboard_tile_cache",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").notNull(),
    cacheKey: text("cache_key").notNull(), // sha256 over (orgId, mvKey, scope_envelope_hash, filters_hash)
    resultJson: jsonb("result_json").notNull(),
    computedAt: timestamp("computed_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    freshnessSecondsAtCompute: integer("freshness_seconds_at_compute").notNull(),
  },
  (t) => ({
    // §3.4 / §3.3: UNIQUE (organization_id, cache_key).
    orgCacheKey: uniqueIndex("dashboard_tile_cache_org_cache_key_uidx").on(
      t.organizationId,
      t.cacheKey,
    ),
    // §3.4: the expiration sweeper (partial WHERE expires_at > now()).
    expiresAt: index("dashboard_tile_cache_expires_at_idx")
      .on(t.expiresAt)
      .where(sql`${t.expiresAt} > now()`),
  }),
);

export type DashboardTileCache = typeof dashboardTileCache.$inferSelect;
export type NewDashboardTileCache = typeof dashboardTileCache.$inferInsert;
