// @wardenx/db — `order_discontinuation` (M11 §3.3 / §6.x). One row per discontinuation of an active /
// pending / verbal order — clinician-initiated (clinical_judgement / patient_request / adverse_event /
// replaced_by_corrected_order …) or a system cascade (admission_discharged / level_of_care_change /
// standing_order_discontinued, where `actor_membership_id` is NULL and `source_outbox_event_id` captures
// the originating event). PHI-bearing → the three-column tenancy rule. Non-partitioned. `order_record_id`
// is a plain uuid with NO SQL FK (order_record is partitioned; see standing_order_instance). Actor refs go
// to M1 `membership`. RLS + grants + M4 write-audit trigger (notes denylisted, §8.1) land in the RLS
// migration.
import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { orderDiscontinuationReason } from "../../enums";
import { organizations } from "../organizations";
import { providerEntities } from "../provider-entities";
import { locations } from "../locations";
import { memberships } from "../memberships";

export const orderDiscontinuations = pgTable(
  "order_discontinuation",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    // NOT NULL relaxed in mig 0131 (M11L): the supersede trigger + discontinue route source PE/location
    // from the (now-nullable) order_record, so this ledger's siting must relax with it.
    providerEntityId: uuid("provider_entity_id").references(() => providerEntities.id, {
      onDelete: "restrict",
    }),
    locationId: uuid("location_id").references(() => locations.id, { onDelete: "restrict" }),
    orderRecordId: uuid("order_record_id").notNull(), // order_record is partitioned → no single-col SQL FK

    actorMembershipId: uuid("actor_membership_id").references(() => memberships.id, {
      onDelete: "restrict",
    }), // NULL for system-actor cascades; the audit row captures the source event

    reason: orderDiscontinuationReason("reason").notNull(),
    notes: text("notes"), // denylisted
    effectiveAt: timestamp("effective_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),

    sourceOutboxEventId: uuid("source_outbox_event_id"),
  },
  (t) => ({
    byOrder: index("order_discontinuation_order_idx").on(t.orderRecordId),
    byActor: index("order_discontinuation_actor_idx").on(
      t.organizationId,
      t.actorMembershipId,
      t.createdAt,
    ),
  }),
);

export type OrderDiscontinuation = typeof orderDiscontinuations.$inferSelect;
export type NewOrderDiscontinuation = typeof orderDiscontinuations.$inferInsert;
