// apps/backend/src/bootstrap/system-status-store.ts — F-173 (#248, m1 group) — the Drizzle-backed
// `SystemStatusReader` over M1's `system_status` table (§3.10).
//
// THE FINDING THIS FIXES (F-156, #248, m1 group's own reason text, `scripts/outbox-deferred-consumers.ts`).
// `SystemStatusReader`'s interface (`routes/system.ts`) takes an `orgId` and is ORG-scoped by signature,
// but the real Drizzle `system_status` table (`packages/db/src/schema/system-status.ts`) has NO
// `organization_id` column at all — it is genuinely platform-global (NON_ORG_SCOPED, one row per
// component id, per that table's own header comment). No Drizzle-backed `SystemStatusReader`
// implementation existed anywhere in the repository; the composition root only ever constructed
// `createInMemorySystemStatusReader()`, a per-process `Map` that resets on every restart and cannot be
// shared across horizontally-scaled instances. `POST /admin/system/status`'s own mutation had therefore
// never once persisted to the real table, in any environment.
//
// THE FIX. `orgId` stays on `list`/`upsert` — the interface signature is UNCHANGED (matching the route
// file's own doc comment describing it as "the seam to M1's own `system_status` ... table") — but it is
// genuinely IGNORED for the row key here: the table has exactly one row per component `id` with no tenant
// dimension at all, so threading `orgId` into a WHERE/VALUES clause would be inventing a column that does
// not exist. This is the SAME NON_ORG_SCOPED, no-RLS, bare-`db`-handle shape `buildM1LagProbeStatusConsumer`
// (`outbox-consumers/m33-lag-probe.ts`, F-156) and `buildM1MacPortalHealthConsumer`
// (`outbox-consumers/m23-mac-portal-health.ts`, F-161) already use to write this exact table from the
// OUTBOX side — this file is the ADMIN-ROUTE side's twin of that same write path (`POST
// /admin/system/status`'s manual mutation), not a new mechanism. Both existing outbox consumers stay
// untouched; this store is a separate, independent write path into the same table.
//
// `updatedBy` (a real schema column, nullable, FK to `users`) is left NULL here: `SystemStatusComponent`
// (the interface this reader satisfies) carries no actor id field at all, and `registerSystemRoutes`'s own
// `POST /admin/system/status` handler never resolves one from `request.context` today — fabricating an
// actor id here would be inventing a fact the route does not have. A future pass that wants attribution
// needs to widen the route handler (and the `SystemStatusComponent` shape) to carry one through first, not
// this store.
import { type DbClient, schema } from "@chartwarden/db";
import type { SystemStatusComponent, SystemStatusReader } from "./routes/system";

/**
 * The production `SystemStatusReader`. Bare `db` handle, no `withOrgContext` envelope —
 * `system_status` carries no RLS policy at all (`packages/db/src/schema/system-status.ts`'s own header:
 * "Not tenant scoped"; no migration anywhere runs `ALTER TABLE system_status ENABLE ROW LEVEL SECURITY`),
 * so a tenant-scoped envelope would add nothing but the risk of an `app.org_id`-unset failure on a table
 * the GUC was never meant to gate — the identical reasoning the two existing outbox consumers already
 * state for the same table.
 */
export function createDrizzleSystemStatusReader(db: DbClient): SystemStatusReader {
  const T = schema.systemStatus;
  return {
    async list(_orgId: string): Promise<SystemStatusComponent[]> {
      // `orgId` deliberately unread — see file header. Every component is platform-global.
      const rows = await db.select().from(T);
      return rows.map((row) => ({
        id: row.id,
        status: row.status,
        headline: row.headline,
        details: row.details,
        updatedAt: row.updatedAt.toISOString(),
      }));
    },
    async upsert(_orgId, component): Promise<void> {
      const updatedAt = new Date(component.updatedAt);
      await db
        .insert(T)
        .values({
          id: component.id,
          status: component.status,
          headline: component.headline,
          details: component.details,
          updatedAt,
        })
        .onConflictDoUpdate({
          target: T.id,
          set: {
            status: component.status,
            headline: component.headline,
            details: component.details,
            updatedAt,
          },
        });
    },
  };
}
