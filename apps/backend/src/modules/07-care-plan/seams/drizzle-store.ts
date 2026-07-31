// apps/backend/src/modules/07-care-plan/seams/drizzle-store.ts — the Drizzle overlay on M7's seam store.
//
// Overlays the ONE read that needs real data today: the org-level 15-day review-cycle tally M30's
// `care_plan_15_day_adherence` measure consumes. The M8 / M11 `drizzle-store.ts` files are the precedent —
// spread the in-memory store, override the live method, leave everything else on its slice default.
//
// SELF-SCOPES on `organizationId` via `withOrgContext` (its own pooled connection carries no ambient RLS
// context), with the explicit `organization_id` predicate as the second wall.
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { and, eq, gte, lt, sql } from "drizzle-orm";
import { type CarePlanReaderStore, createInMemoryCarePlanReaderStore } from "./store";

const CP = schema.carePlans;
const CPV = schema.carePlanVersions;

/** The actor id the read's withOrgContext envelope carries — an aggregate read has no acting user. */
const CARE_PLAN_READER_SYSTEM_USER_ID = "";

/**
 * Build the production-overlay {@link CarePlanReaderStore}.
 *
 * `fifteenDayCycleCountsForOrg` counts care plans whose `next_review_due_at` fell inside `[from, to)` —
 * the review cycles that came DUE in the window — and, of those, the ones with a signed version by the
 * due date.
 *
 * ★ INTERPRETATION (flagged): "updated within 15 days" is read as "a signed care-plan version exists with
 *   `signed_at <= next_review_due_at`", i.e. the review happened by the date the 15-day clock set. The
 *   alternative reading — a grace period AFTER the due date — would score a late review as adherent, which
 *   is the opposite of what a CoP 418.56(d) adherence measure is for. Revisit if the HQRP spec disagrees.
 *
 * Returns the PAIR, never a rate: an empty window (0/0) must SUPPRESS rather than score perfect adherence.
 */
export function createDrizzleCarePlanReaderStore(db: DbClient): CarePlanReaderStore {
  const fallback = createInMemoryCarePlanReaderStore().store;
  return {
    ...fallback,
    fifteenDayCycleCountsForOrg(organizationId, window) {
      return withOrgContext(
        db,
        { organizationId, userId: CARE_PLAN_READER_SYSTEM_USER_ID },
        async (tx) => {
          const [row] = await tx
            .select({
              denominator: sql<number>`count(*)::int`,
              numerator: sql<number>`count(*) filter (where exists (
                select 1 from ${CPV}
                where ${CPV.carePlanId} = ${CP.id}
                  and ${CPV.status} = 'signed'
                  and ${CPV.signedAt} is not null
                  and ${CPV.signedAt} <= ${CP.nextReviewDueAt}
              ))::int`,
            })
            .from(CP)
            .where(
              and(
                eq(CP.organizationId, organizationId),
                gte(CP.nextReviewDueAt, new Date(window.from)),
                lt(CP.nextReviewDueAt, new Date(window.to)),
              ),
            );
          return {
            numerator: Number(row?.numerator) || 0,
            denominator: Number(row?.denominator) || 0,
          };
        },
      );
    },
  };
}
