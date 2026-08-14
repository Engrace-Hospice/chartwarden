// apps/backend/src/modules/29-external-interfaces/nppes/stores-drizzle.ts — the two M29-OWNED Drizzle
// ports the M29-T07 `NppesSyncOrchestrator` runs over (GAP-045).
//
// Until this file the orchestrator was a fully-built engine with no fuel line: `ProviderCachePort` and
// `NppesSyncRunStorePort` existed only as interfaces with in-memory fakes in the unit tests, nothing in
// `apps/backend/src` constructed them, and `nppes_provider` / `nppes_sync_run` were therefore empty in
// every running deployment.
//
// PRIVILEGE (migration 0199). Both tables are platform-shared (no `organization_id`) and were SELECT-only
// to `wardenx_app`, with every write reserved to `wardenx_admin`. Reads here run directly on the pooled
// handle (the `USING (true)` read policy); every WRITE goes through a `nppes_writer_*` SECURITY DEFINER
// function owned by the dedicated `nppes_sync_writer` NOLOGIN role — the migration-0186 platform-outbox
// pattern. There is deliberately no `withPlatformContext` envelope: the function body, not the caller's
// session, carries the privilege (0186 states the same for its own functions), so the sync needs no
// separate platform credential and no cross-tenant session.
//
// THE THIRD PORT IS NOT HERE. `NppesNpiSourcePort` reads M40's `external_physician` canonical, and
// `arch:tables` refused that read from M29 code — correctly. It lives at its owner
// (`modules/40-mdm/nppes-npi-source.ts`) and the composition root adapts it into the port, so M29 receives
// a list of NPIs rather than reaching into another module's table.
import { type DbClient, schema } from "@wardenx/db";
import type { NppesSyncRunId } from "@wardenx/types";
import { eq, sql } from "drizzle-orm";
import {
  type CachedProviderView,
  type ProviderCachePort,
  buildProviderRow,
  decideCacheUpsert,
} from "./provider-cache";
import type { NppesSyncRunStorePort, SyncRunCounts } from "./sync-orchestrator";

const NPPES = schema.nppesProvider;

/** Project a cached `nppes_provider` row to the minimal view the pure §4.7.1 diff compares against. */
function toCachedView(row: typeof NPPES.$inferSelect): CachedProviderView {
  const basic = (row.basic ?? {}) as {
    firstName?: string;
    lastName?: string;
    credential?: string | null;
  };
  const taxonomies = (row.taxonomies ?? []) as ReadonlyArray<{
    code?: string;
    primary?: boolean;
  }>;
  const primary = taxonomies.find((t) => t.primary === true) ?? taxonomies[0];
  return {
    status: row.status,
    firstName: basic.firstName ?? "",
    lastName: basic.lastName ?? "",
    credential: basic.credential ?? null,
    specialtyTaxonomy: primary?.code ?? null,
    deactivationDate: row.deactivationDate,
    deactivationReason: row.deactivationReason,
  };
}

/**
 * The §4.7.1 cache upsert: read the current row (read-all policy), run the PURE `decideCacheUpsert` diff,
 * and write through the SECURITY DEFINER upsert. An `unchanged` decision still touches `fetched_at` — the
 * M5 D9 cert-eligibility rule reads that column against a 90-day freshness window, so "we asked NPPES and
 * nothing had changed" must be distinguishable from "nobody has asked in three months".
 */
export function createDrizzleNppesProviderCache(db: DbClient): ProviderCachePort {
  return {
    async upsert(provider, fetchedAt) {
      const [existing] = await db.select().from(NPPES).where(eq(NPPES.npi, provider.npi)).limit(1);
      const decision = decideCacheUpsert(existing ? toCachedView(existing) : null, provider);
      const row = buildProviderRow(provider, fetchedAt);
      await db.execute(sql`
        SELECT nppes_writer_upsert_provider(
          ${row.npi},
          ${row.enumerationType},
          ${row.status},
          ${row.deactivationDate}::date,
          ${row.deactivationReason},
          ${row.reactivationDate}::date,
          ${JSON.stringify(row.basic)}::jsonb,
          ${JSON.stringify(row.addresses ?? [])}::jsonb,
          ${JSON.stringify(row.taxonomies ?? [])}::jsonb,
          ${JSON.stringify(row.identifiers ?? [])}::jsonb,
          ${JSON.stringify(row.endpoints ?? [])}::jsonb,
          ${row.lastUpdatedInNppes}::date,
          ${fetchedAt}
        )
      `);
      return decision;
    },
  };
}

/** The `nppes_sync_run` orchestration log, written entirely through the SECURITY DEFINER functions. */
export function createDrizzleNppesSyncRunStore(db: DbClient): NppesSyncRunStorePort {
  const counts = (c: SyncRunCounts) => ({
    fetched: c.providersFetchedCount,
    updated: c.providersUpdatedCount,
    deactivated: c.providersDeactivatedCount,
    errors: c.errorsCount,
  });
  return {
    async open(run) {
      await db.execute(sql`
        SELECT nppes_writer_open_sync_run(
          ${run.id}::uuid,
          ${run.kind},
          ${run.triggeredBy},
          ${run.triggeredByMembershipId}::uuid,
          ${run.startedAt}
        )
      `);
    },
    async updateCounts(id: NppesSyncRunId, c: SyncRunCounts) {
      const n = counts(c);
      await db.execute(sql`
        SELECT nppes_writer_update_sync_run_counts(
          ${id}::uuid, ${n.fetched}, ${n.updated}, ${n.deactivated}, ${n.errors}
        )
      `);
    },
    async markComplete(id: NppesSyncRunId, c: SyncRunCounts, completedAt: Date) {
      const n = counts(c);
      await db.execute(sql`
        SELECT nppes_writer_complete_sync_run(
          ${id}::uuid, ${n.fetched}, ${n.updated}, ${n.deactivated}, ${n.errors}, ${completedAt}
        )
      `);
    },
    async markFailed(id: NppesSyncRunId, error: string, c: SyncRunCounts, completedAt: Date) {
      const n = counts(c);
      await db.execute(sql`
        SELECT nppes_writer_fail_sync_run(
          ${id}::uuid, ${error.slice(0, 2000)}, ${n.fetched}, ${n.updated}, ${n.deactivated},
          ${n.errors}, ${completedAt}
        )
      `);
    },
  };
}
