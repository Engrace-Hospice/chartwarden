// apps/backend/src/modules/13-emar/seams/drizzle-store.ts — the Drizzle overlay on M13's seam store.
//
// Overlays the ONE read that needs real data today: the org-level missed-dose tally M30's
// `missed_dose_rate` measure consumes. The M8 / M11 / M7 `drizzle-store.ts` files are the precedent —
// spread the in-memory store, override the live method, leave everything else on its slice default.
//
// NB the SIBLING measure, `prn_effectiveness_documented_rate`, is NOT bindable here: M13's schema records
// `prn_administration.reassessment_due_at` but nothing recording that a reassessment was actually DONE
// (the in-memory store's `hasReassessment` is a slice-only field with no column behind it). Computing it
// needs either a new M13 column or a join to the M9 assessment the reassessment was captured on — a
// schema change, not a seam widening. It stays suppressed rather than being approximated.
//
// SELF-SCOPES on `organizationId` via `withOrgContext` (its own pooled connection carries no ambient RLS
// context), with the explicit `organization_id` predicate as the second wall.
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { and, eq, gte, lt, sql } from "drizzle-orm";
import { type EmarSeamStore, createInMemoryEmarSeamStore } from "./store";

const SD = schema.scheduledDoses;
const MD = schema.missedDoses;

/** The actor id the read's withOrgContext envelope carries — an aggregate read has no acting user. */
const EMAR_READER_SYSTEM_USER_ID = "";

/**
 * Build the production-overlay {@link EmarSeamStore}.
 *
 * `missedDoseCountsForOrg` counts scheduled doses DUE inside `[from, to)` and, of those, the ones with a
 * `missed_dose` row against them. Keying the window on `due_at` (rather than on the missed-dose
 * `detected_at`) is what makes the denominator the real population: a dose that was due in the window and
 * simply never actioned still counts, instead of the window only ever seeing doses someone got around to
 * flagging.
 *
 * Returns the PAIR, never a rate: an empty window (0/0) must SUPPRESS rather than score zero missed doses.
 */
export function createDrizzleEmarSeamStore(db: DbClient): EmarSeamStore {
  const fallback = createInMemoryEmarSeamStore().store;
  return {
    ...fallback,
    missedDoseCountsForOrg(organizationId, window) {
      return withOrgContext(db, { organizationId, userId: EMAR_READER_SYSTEM_USER_ID }, async (tx) => {
        const [row] = await tx
          .select({
            denominator: sql<number>`count(*)::int`,
            numerator: sql<number>`count(*) filter (where exists (
              select 1 from ${MD}
              where ${MD.scheduledDoseId} = ${SD.id}
                and ${MD.organizationId} = ${SD.organizationId}
            ))::int`,
          })
          .from(SD)
          .where(
            and(
              eq(SD.organizationId, organizationId),
              gte(SD.dueAt, new Date(window.from)),
              lt(SD.dueAt, new Date(window.to)),
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
