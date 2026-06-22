// @wardenx/db — `idg_meeting` (M14 §3.3.1). One row per IDG meeting occurrence: the §2.2 lifecycle
// (scheduled → packets_building → packets_ready → live → adjourned, with cancelled/rescheduled branches),
// the per-meeting quorum snapshot (frozen at schedule time), and the coordinator. Org+location-scoped
// (NOT patient-bearing — a meeting is location-level → no three-column PHI rule). The only FKs are the
// tenancy spine (organization / location) + the intra-module recurring_policy parent; actor/self refs
// (coordinator_membership_id → M1 membership, rescheduled_from_meeting_id self) are plain uuid
// app-validated. RLS + grants + the M4 write-audit trigger land in the RLS migration (M14-T02).
import { boolean, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { index } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { idgMeetingStatus } from "../../enums";
import { organizations } from "../organizations";
import { locations } from "../locations";
import { idgRecurringPolicy } from "./idg-recurring-policies";

export const idgMeeting = pgTable(
  "idg_meeting",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    locationId: uuid("location_id")
      .notNull()
      .references(() => locations.id, { onDelete: "restrict" }),
    recurringPolicyId: uuid("recurring_policy_id").references(() => idgRecurringPolicy.id),
    scheduledStart: timestamp("scheduled_start", { withTimezone: true }).notNull(),
    scheduledEnd: timestamp("scheduled_end", { withTimezone: true }).notNull(),
    actualStart: timestamp("actual_start", { withTimezone: true }),
    actualEnd: timestamp("actual_end", { withTimezone: true }),
    status: idgMeetingStatus("status").notNull().default("scheduled"),
    coordinatorMembershipId: uuid("coordinator_membership_id").notNull(), // M1 membership (no cross-module FK)
    rescheduledFromMeetingId: uuid("rescheduled_from_meeting_id"), // self-ref (app-validated; no FK)
    cancellationReason: text("cancellation_reason"),
    layer2PolishOptOut: boolean("layer2_polish_opt_out").notNull().default(false),
    tenantQuorumSnapshot: jsonb("tenant_quorum_snapshot").notNull(), // RequiredQuorum, frozen at schedule
    version: integer("version").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // Hot path: "next scheduled meeting for location".
    locationScheduled: index("idg_meeting_location_scheduled_idx")
      .on(t.organizationId, t.locationId, t.scheduledStart)
      .where(sql`status IN ('scheduled', 'packets_building', 'packets_ready')`),
  }),
);

export type IdgMeeting = typeof idgMeeting.$inferSelect;
export type NewIdgMeeting = typeof idgMeeting.$inferInsert;
