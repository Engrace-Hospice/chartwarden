// @wardenx/db — `verbal_order` (M11 §3.3 / §2.3 D3). The verbal-order receipt + 48h authentication
// timer: an RN records the ordering physician's verbal order, which flips the linked `order_record` to
// `verbal_pending` (via the §3.4 set-target-pending trigger) and starts the deadline clock. PHI-bearing →
// the three-column tenancy rule. Non-partitioned, bounded by the active-pending queue depth (§3.7). The
// polymorphic `target_kind` mirrors `order_signature` (verbal orders can also target an M12
// `medication_order`); no SQL FK across the discriminator. Cross-module refs (M40 ordering physician) are
// plain uuid app-validated; actor refs go to M1 `membership`. Expiry is a BullMQ worker, NOT a trigger
// (§3.8 — time-based + separate 12h/2h M36 alerts). RLS + grants + M4 write-audit trigger
// (verbal_attestation denylisted, §8.1) land in the RLS migration.
import { sql } from "drizzle-orm";
import {
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  boolean
} from "drizzle-orm/pg-core";
import { orderSignatureTargetKind, verbalOrderStatus } from "../../enums";
import { locations } from "../locations";
import { memberships } from "../memberships";
import { organizations } from "../organizations";
import { providerEntities } from "../provider-entities";

export const verbalOrders = pgTable(
  "verbal_order",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    // NOT NULL relaxed in mig 0131 (M11L): denormalized siting backfills from the linked order/admission.
    providerEntityId: uuid("provider_entity_id").references(
      () => providerEntities.id,
      {
        onDelete: "restrict",
      },
    ),
    locationId: uuid("location_id").references(() => locations.id, {
      onDelete: "restrict",
    }),

    targetKind: orderSignatureTargetKind("target_kind").notNull(),
    targetId: uuid("target_id").notNull(),

    recordingMembershipId: uuid("recording_membership_id")
      .notNull()
      .references(() => memberships.id, { onDelete: "restrict" }),
    orderingPhysicianMdmId: uuid("ordering_physician_mdm_id").notNull(), // M40 (app-validated; no FK)
    verbalAttestation: text("verbal_attestation").notNull(), // 100-2000 chars; denylisted
    readBackVerified: boolean("read_back_verified").notNull().default(false),

    effectiveAt: timestamp("effective_at", {
      withTimezone: true,
    }).notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull(),
    deadlineAt: timestamp("deadline_at", { withTimezone: true }).notNull(),
    deadlinePolicyVersion: text("deadline_policy_version").notNull(),
    status: verbalOrderStatus("status").notNull().default("pending"),
    signedAt: timestamp("signed_at", { withTimezone: true }),
    expiredAt: timestamp("expired_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    targetUq: uniqueIndex("verbal_order_target_uq").on(
      t.targetKind,
      t.targetId,
    ),
    pendingByDeadline: index("verbal_order_pending_deadline_idx")
      .on(t.organizationId, t.deadlineAt)
      .where(sql`status = 'pending'`),
  }),
);

export type VerbalOrder = typeof verbalOrders.$inferSelect;
export type NewVerbalOrder = typeof verbalOrders.$inferInsert;
