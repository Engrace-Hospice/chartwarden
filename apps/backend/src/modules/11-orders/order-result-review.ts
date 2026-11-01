// apps/backend/src/modules/11-orders/order-result-review.ts — #909: the clinician REVIEW of a returned lab.
//
// Review is PER ORDER and APPEND-ONLY (`order_result_review`, migration 1296): one row per (order, observation) with
// the reviewing membership, the discipline they acted under and the database-stamped `reviewed_at`. A review covers the
// order's CURRENT observation (`last_lab_observation_attached_id`); an AMENDED result is a new observation, so the
// order has no review for it and re-enters the `resultsPendingReview` queue with no write at all (and a trigger
// re-stamps `results_last_received_at`, the 24 h SLA clock). Who may review: the route requires `orders.complete` and
// this requires a discipline eligible to sign a lab order, i.e. a prescriber (the ordering physician or any other).
import { type DbClient, schema } from "@chartwarden/db";
import { signerEligible } from "@chartwarden/orders";
import { withOrgContext } from "@chartwarden/tenancy";
import { ConflictError, ForbiddenError, NotFoundError } from "@chartwarden/types";
import { type SQL, and, eq, sql } from "drizzle-orm";

/** The slice of `OrderDetailActor` this needs (structural, so this file need not import `routes/service`). */
export interface ResultReviewActor {
  readonly membershipId: string;
  readonly userId?: string;
  readonly disciplines: readonly string[];
  readonly kind?: "user" | "system";
}

const OR = schema.orderRecords;
const RV = schema.orderResultReviews;

/** A returned lab unreviewed longer than this raises an alert (owner decision, #909). */
export const RESULT_REVIEW_SLA_HOURS = 24;

/** The alert type the unreviewed-results sweep raises (a seeded platform `alert_rule`). */
export const RESULTS_UNREVIEWED_ALERT_TYPE = "m11.order.results_unreviewed";

export interface ResultReviewView {
  readonly orderId: string;
  readonly observationId: string;
  readonly reviewerMembershipId: string;
  readonly reviewerDiscipline: string;
  readonly reviewedAt: string;
  /** True when this observation had already been reviewed (a repeat call changes nothing). */
  readonly alreadyReviewed: boolean;
}

/** SQL: the order's current observation has NO review row. Correlated on `order_record`. */
export function currentResultUnreviewed(): SQL {
  return sql`NOT EXISTS (
    SELECT 1 FROM ${RV}
     WHERE ${RV.organizationId} = ${OR.organizationId}
       AND ${RV.orderRecordId} = ${OR.id}
       AND ${RV.observationId} = ${OR.lastLabObservationAttachedId})`;
}

/** Prescribing disciplines: the lab signer matrix minus the RN case manager (signs under protocol, does not prescribe). */
const PRESCRIBER_DISCIPLINES: ReadonlySet<string> = new Set([
  "medical_director",
  "hospice_physician",
  "np",
  "pa",
]);

/** The first of the actor's disciplines that is a prescriber eligible to sign a lab order, or null. */
export function reviewerDisciplineOf(actor: ResultReviewActor): string | null {
  for (const d of actor.disciplines) {
    const key = d.trim().toLowerCase();
    if (PRESCRIBER_DISCIPLINES.has(key) && signerEligible(key, "lab")) return key;
  }
  return null;
}

export async function reviewLabResults(
  db: DbClient,
  organizationId: string,
  orderId: string,
  actor: ResultReviewActor,
  assertInScope: (patientId: string) => Promise<void>,
): Promise<ResultReviewView> {
  const discipline = reviewerDisciplineOf(actor);
  if (discipline === null || actor.kind === "system" || !actor.membershipId) {
    throw new ForbiddenError("only a prescriber may review lab results");
  }
  return withOrgContext(
    db,
    { organizationId, userId: actor.userId ?? "" },
    async (txRaw): Promise<ResultReviewView> => {
      const tx = txRaw as unknown as DbClient;
      // Lock the order so a result arriving mid-review cannot be marked reviewed unseen.
      const [order] = await tx
        .select({
          patientId: OR.patientId,
          kind: OR.kind,
          resultsStatus: OR.resultsStatus,
          observationId: OR.lastLabObservationAttachedId,
          providerEntityId: OR.providerEntityId,
          locationId: OR.locationId,
        })
        .from(OR)
        .where(and(eq(OR.id, orderId), eq(OR.organizationId, organizationId)))
        .for("update")
        .limit(1);
      if (!order) throw new NotFoundError(`order ${orderId} not found`);
      await assertInScope(order.patientId);
      if (
        order.kind !== "lab" ||
        order.resultsStatus !== "results_received" ||
        !order.observationId
      ) {
        throw new ConflictError("order has no returned lab result to review");
      }
      const inserted = await tx
        .insert(RV)
        .values({
          organizationId,
          providerEntityId: order.providerEntityId,
          locationId: order.locationId,
          orderRecordId: orderId,
          observationId: order.observationId,
          reviewerMembershipId: actor.membershipId,
          reviewerDiscipline: discipline,
        })
        .onConflictDoNothing()
        .returning();
      const alreadyReviewed = inserted.length === 0;
      const [row] = alreadyReviewed
        ? await tx
            .select()
            .from(RV)
            .where(
              and(
                eq(RV.organizationId, organizationId),
                eq(RV.orderRecordId, orderId),
                eq(RV.observationId, order.observationId),
              ),
            )
            .limit(1)
        : inserted;
      if (!row) throw new ConflictError("lab result review could not be recorded");
      return {
        orderId,
        observationId: row.observationId,
        reviewerMembershipId: row.reviewerMembershipId,
        reviewerDiscipline: row.reviewerDiscipline,
        reviewedAt: row.reviewedAt.toISOString(),
        alreadyReviewed,
      };
    },
  );
}
