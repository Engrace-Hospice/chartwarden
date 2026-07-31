// apps/backend/src/modules/14-idg/seams/drizzle-store.ts — the Drizzle overlay on M14's seam store.
//
// Overlays the ONE read that needs real data today: the org-level IDG meeting-cadence tally M30's
// `idg_cadence_adherence` measure consumes. The M8 / M11 / M7 / M13 `drizzle-store.ts` files are the
// precedent — spread the in-memory store, override the live method, leave everything else on its slice
// default so no existing consumer regresses.
//
// SELF-SCOPES on `organizationId` via `withOrgContext` (its own pooled connection carries no ambient RLS
// context), with the explicit `organization_id` predicate as the second wall.
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { and, eq, gte, lt, sql } from "drizzle-orm";
import { type IdgSeamStore, createInMemoryIdgSeamStore } from "./store";

const M = schema.idgMeeting;

/** The actor id the read's withOrgContext envelope carries — an aggregate read has no acting user. */
const IDG_READER_SYSTEM_USER_ID = "";

/**
 * Build the production-overlay {@link IdgSeamStore}.
 *
 * `cadenceCountsForOrg` counts meetings SCHEDULED to start inside `[from, to)` — the cadence cycles that
 * came due — and, of those, the ones actually convened within their scheduled slot.
 *
 * ★ INTERPRETATION (flagged): "within cadence" is read as `actual_start IS NOT NULL AND actual_start <=
 *   scheduled_end`, i.e. the meeting happened inside the window it was scheduled for. Two alternatives were
 *   rejected: counting `status = 'completed'` alone would score a meeting convened days late as adherent,
 *   and allowing any `actual_start` would do the same. A cancelled or never-convened meeting stays in the
 *   DENOMINATOR — a cadence cycle that was skipped is exactly what this measure exists to catch, so it must
 *   not drop out of the population. Revisit if the CoP 418.56 IDG-cadence guidance is more specific.
 *
 * Returns the PAIR, never a rate: an empty window (0/0) must SUPPRESS rather than score perfect cadence.
 */
export function createDrizzleIdgSeamStore(db: DbClient): IdgSeamStore {
  const fallback = createInMemoryIdgSeamStore().store;
  return {
    ...fallback,
    cadenceCountsForOrg(organizationId, window) {
      return withOrgContext(db, { organizationId, userId: IDG_READER_SYSTEM_USER_ID }, async (tx) => {
        const [row] = await tx
          .select({
            denominator: sql<number>`count(*)::int`,
            numerator: sql<number>`count(*) filter (where ${M.actualStart} is not null and ${M.actualStart} <= ${M.scheduledEnd})::int`,
          })
          .from(M)
          .where(
            and(
              eq(M.organizationId, organizationId),
              gte(M.scheduledStart, new Date(window.from)),
              lt(M.scheduledStart, new Date(window.to)),
            ),
          );
        return {
          numerator: Number(row?.numerator) || 0,
          denominator: Number(row?.denominator) || 0,
        };
      });
    },
  };
}
