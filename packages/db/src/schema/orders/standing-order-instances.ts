// @chartwarden/db — `standing_order_instance` (M11 §3.3 / §2.4 D5). The spawn-history join: one row per
// concrete `order_record` a `standing_order` template produced (system cadence spawn or clinician PRN
// spawn). PHI-bearing → the three-column tenancy rule. Non-partitioned. The FK to `standing_order` is an
// intra-module FK; `order_record_id` is a plain uuid with NO SQL FK because `order_record` is RANGE
// partitioned on `created_at` (composite PK), so a single-column FK cannot reference it (M10
// hope_submission_item precedent) — the unique index still guards one-instance-per-spawned-order. Actor
// refs go to M1 `membership`. RLS + grants + M4 write-audit trigger (spawn_context_note denylisted, §8.1)
// land in the RLS migration.
import { sql } from "drizzle-orm";
import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { standingOrderSpawnedBy } from "../../enums";
import { locations } from "../locations";
import { memberships } from "../memberships";
import { organizations } from "../organizations";
import { providerEntities } from "../provider-entities";
import { standingOrders } from "./standing-orders";

export const standingOrderInstances = pgTable(
  "standing_order_instance",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    // NOT NULL relaxed in mig 0131 (M11L): denormalized siting backfills from the spawning template.
    providerEntityId: uuid("provider_entity_id").references(() => providerEntities.id, {
      onDelete: "restrict",
    }),
    locationId: uuid("location_id").references(() => locations.id, { onDelete: "restrict" }),
    standingOrderId: uuid("standing_order_id")
      .notNull()
      .references(() => standingOrders.id, { onDelete: "restrict" }),
    orderRecordId: uuid("order_record_id").notNull(), // order_record is partitioned → no single-col SQL FK
    spawnedAt: timestamp("spawned_at", { withTimezone: true }).notNull().defaultNow(),
    /** Scheduled occurrence identity: copied from the template's locked `next_spawn_at`; NULL for PRN. */
    scheduledFor: timestamp("scheduled_for", { withTimezone: true }),
    spawnedBy: standingOrderSpawnedBy("spawned_by").notNull(),
    spawnedByMembershipId: uuid("spawned_by_membership_id").references(() => memberships.id, {
      onDelete: "restrict",
    }),
    spawnContextNote: text("spawn_context_note"), // denylisted
  },
  (t) => ({
    byStanding: index("standing_order_instance_parent_idx").on(
      t.organizationId,
      t.standingOrderId,
      t.spawnedAt,
    ),
    byOrder: uniqueIndex("standing_order_instance_order_uq").on(t.orderRecordId),
    scheduledOccurrence: uniqueIndex("standing_order_instance_scheduled_occurrence_uq")
      .on(t.standingOrderId, t.scheduledFor)
      .where(sql`scheduled_for IS NOT NULL`),
  }),
);

export type StandingOrderInstance = typeof standingOrderInstances.$inferSelect;
export type NewStandingOrderInstance = typeof standingOrderInstances.$inferInsert;
