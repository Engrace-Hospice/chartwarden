// apps/backend/src/modules/13-emar/seams/drizzle-store.ts — the Drizzle overlay on M13's seam store.
//
// Overlays the ONE read that needs real data today: the org-level missed-dose tally M30's
// `missed_dose_rate` measure consumes. The M8 / M11 / M7 `drizzle-store.ts` files are the precedent —
// spread the in-memory store, override the live method, leave everything else on its slice default.
//
// The SIBLING measure, `prn_effectiveness_documented_rate`, is now bound WITHOUT a schema change:
// `prnReassessmentObligationsForOrg` returns each PRN administration whose reassessment falls due in the
// window with its recommended scale, and the PROVIDER (providers.ts) joins each obligation against M9's
// ScaleSeriesProvider to decide whether a reassessment was actually captured — only the aggregate count
// crosses the M1 seam (D6). "Documented" is thus derived from the M9 assessment, not a slice-only flag.
//
// SELF-SCOPES on `organizationId` via `withOrgContext` (its own pooled connection carries no ambient RLS
// context), with the explicit `organization_id` predicate as the second wall.
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import type { PatientId, ScaleType } from "@wardenx/types";
import { and, eq, gte, isNotNull, lt, sql } from "drizzle-orm";
import { type EmarSeamStore, createInMemoryEmarSeamStore } from "./store";

const SD = schema.scheduledDoses;
const MD = schema.missedDoses;
const PRN = schema.prnAdministrations;

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
    prnReassessmentObligationsForOrg(organizationId, window) {
      return withOrgContext(db, { organizationId, userId: EMAR_READER_SYSTEM_USER_ID }, async (tx) => {
        const rows = await tx
          .select({
            patientId: PRN.patientId,
            scaleType: PRN.recommendedReassessmentScale,
            administeredAt: PRN.createdAt,
            reassessmentDueAt: PRN.reassessmentDueAt,
          })
          .from(PRN)
          .where(
            and(
              eq(PRN.organizationId, organizationId),
              // Only administrations that carry a reassessment obligation (a recommended scale).
              isNotNull(PRN.recommendedReassessmentScale),
              // Obligation window keys on the reassessment-due instant (the population, not when actioned).
              gte(PRN.reassessmentDueAt, new Date(window.from)),
              lt(PRN.reassessmentDueAt, new Date(window.to)),
            ),
          );
        return rows.map((r) => ({
          patientId: r.patientId as PatientId,
          scaleType: r.scaleType as ScaleType,
          administeredAt: iso(r.administeredAt),
          reassessmentDueAt: iso(r.reassessmentDueAt),
        }));
      });
    },
  };
}

/** ISO instant for a timestamptz column (Drizzle returns a Date). */
const iso = (d: Date): string => d.toISOString();
