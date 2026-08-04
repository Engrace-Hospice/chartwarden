// @wardenx/db — `volunteer_assignment` (M15 §3.3). The many-to-many between a volunteer_plan and the
// volunteers serving it (§2.2.5): a patient may have several volunteers, a volunteer several patients.
// `activities` carries the assignment's activity subset (validated against the closed CoP 418.78
// out-of-scope list in @wardenx/discipline-plans, M15-T01).
//
// §7.5: when any blocking compliance gate expires the watcher stamps `inactivated_at` +
// `inactivation_reason='gate_expired:<gate_kind>'` on every open row and emits
// `m15.volunteer.assignment_inactivated` (M17 refuses new bookings). Re-activation after renewal is a
// deliberate coordinator action — never automatic.
//
// Tenancy (M15-F05): patient-bearing (via the plan) → organization_id + provider_entity_id + location_id
// NOT NULL. FKs: M1 core + the intra-module plan parent; both membership ids are LOGICAL uuid (M2).
import { sql } from "drizzle-orm";
import {
  bigint,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { locations } from "../locations";
import { organizations } from "../organizations";
import { providerEntities } from "../provider-entities";
import { disciplineCarePlan } from "./discipline-care-plans";

export const volunteerAssignment = pgTable(
  "volunteer_assignment",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    providerEntityId: uuid("provider_entity_id")
      .notNull()
      .references(() => providerEntities.id, { onDelete: "restrict" }),
    locationId: uuid("location_id")
      .notNull()
      .references(() => locations.id, { onDelete: "restrict" }),
    planId: uuid("plan_id")
      .notNull()
      .references(() => disciplineCarePlan.id, { onDelete: "restrict" }),

    volunteerMembershipId: uuid("volunteer_membership_id").notNull(), // logical FK → M2 membership
    coordinatorMembershipId: uuid("coordinator_membership_id").notNull(), // logical FK → M2 membership

    activities: jsonb("activities").notNull().default(sql`'[]'::jsonb`),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }),
    coordinatorAcknowledgedAt: timestamp("coordinator_acknowledged_at", { withTimezone: true }),

    inactivatedAt: timestamp("inactivated_at", { withTimezone: true }),
    inactivationReason: text("inactivation_reason"), // audit-denylisted (§3.6)

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    version: bigint("version", { mode: "number" }).notNull().default(0), // §2.5 If-Match
  },
  (t) => ({
    planVolunteerActiveUq: uniqueIndex("volunteer_assignment_plan_volunteer_active_uq")
      .on(t.organizationId, t.planId, t.volunteerMembershipId)
      .where(sql`inactivated_at IS NULL`),
    // Hot path: the gate watcher's "every open assignment for this volunteer" sweep (§7.5).
    volunteerOpenIdx: index("volunteer_assignment_volunteer_open_idx")
      .on(t.organizationId, t.volunteerMembershipId)
      .where(sql`inactivated_at IS NULL`),
    volunteerIdx: index("volunteer_assignment_volunteer_idx").on(t.volunteerMembershipId),
  }),
);

export type VolunteerAssignment = typeof volunteerAssignment.$inferSelect;
export type NewVolunteerAssignment = typeof volunteerAssignment.$inferInsert;
