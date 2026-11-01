// @chartwarden/db — `order_result_review` (#909; migration 1296). One APPEND-ONLY row per (lab order, observation)
// reviewed by a clinician: the reviewing membership, the discipline they acted under, and the database-stamped
// `reviewed_at` (the app never supplies it). An amended result is a NEW observation, so it has no review row and the
// order re-enters the review queue. `order_record_id` / `observation_id` are plain uuids (partitioned parent / M29
// seam: no SQL FK). Grants are SELECT + INSERT only; a trigger rejects UPDATE/DELETE; RLS + FORCE + audit in the migration.
import { index, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { locations } from "../locations";
import { organizations } from "../organizations";
import { providerEntities } from "../provider-entities";

export const orderResultReviews = pgTable(
  "order_result_review",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    providerEntityId: uuid("provider_entity_id").references(() => providerEntities.id, {
      onDelete: "restrict",
    }),
    locationId: uuid("location_id").references(() => locations.id, { onDelete: "restrict" }),
    orderRecordId: uuid("order_record_id").notNull(),
    observationId: uuid("observation_id").notNull(),
    reviewerMembershipId: uuid("reviewer_membership_id").notNull(),
    reviewerDiscipline: text("reviewer_discipline").notNull(),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byOrder: index("order_result_review_order_idx").on(
      t.organizationId,
      t.orderRecordId,
      t.reviewedAt,
    ),
    oncePerObservation: unique("order_result_review_once_per_observation").on(
      t.organizationId,
      t.orderRecordId,
      t.observationId,
    ),
  }),
);

export type OrderResultReview = typeof orderResultReviews.$inferSelect;
export type NewOrderResultReview = typeof orderResultReviews.$inferInsert;
