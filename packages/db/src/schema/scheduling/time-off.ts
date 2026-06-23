// @wardenx/db — `time_off` (M17 §3.3 / D7). The negative-overlay PTO model: a row withdraws a window from a
// clinician's availability. The requested → approved | denied | cancelled | consumed lifecycle is a discrete
// workflow; approval emits `m17.reassignment_needed` for affected published visits. Clinician-scoped
// (membership_id) — NOT patient-bearing → org-scoped; the M17-F01 tenancy columns are carried (nullable —
// PTO is not bound to a care location). `request_note` and `denial_reason` are DENYLISTED (§3.6). A GiST
// EXCLUDE backstop (one approved window per clinician cannot overlap) lands in the SQL migration (M17-T02).
// Not partitioned (O(clinicians), D14). RLS + grants + the M4 write-audit trigger land in M17-T02.
import { index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { timeOffKind, timeOffState } from "../../enums";
import { organizations } from "../organizations";
import { providerEntities } from "../provider-entities";
import { locations } from "../locations";
import { memberships } from "../memberships";

export const timeOff = pgTable(
  "time_off",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    // M17-F01: tenancy columns present; nullable (clinician-scoped PTO, not bound to a care location).
    providerEntityId: uuid("provider_entity_id").references(() => providerEntities.id, {
      onDelete: "restrict",
    }),
    locationId: uuid("location_id").references(() => locations.id, { onDelete: "restrict" }),
    membershipId: uuid("membership_id")
      .notNull()
      .references(() => memberships.id, { onDelete: "cascade" }),

    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    kind: timeOffKind("kind").notNull(),

    approvalState: timeOffState("approval_state").notNull().default("requested"),
    requestNote: text("request_note"), // DENYLISTED (§3.6)
    approvedByMembershipId: uuid("approved_by_membership_id"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    deniedByMembershipId: uuid("denied_by_membership_id"),
    deniedAt: timestamp("denied_at", { withTimezone: true }),
    denialReason: text("denial_reason"), // DENYLISTED (§3.6)
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    cancelledBy: uuid("cancelled_by"),

    version: integer("version").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    orgMembershipState: index("to_org_mem_state_idx").on(
      t.organizationId,
      t.membershipId,
      t.approvalState,
    ),
    // D7 reassignment-scan + the EXCLUDE backstop (added via SQL, M17-T02):
    // EXCLUDE USING gist (membership_id WITH =, tstzrange(starts_at, ends_at) WITH &&)
    //   WHERE (approval_state = 'approved').
    membershipWindow: index("to_membership_window_idx").on(
      t.membershipId,
      t.startsAt,
      t.endsAt,
    ),
  }),
);

export type TimeOff = typeof timeOff.$inferSelect;
export type NewTimeOff = typeof timeOff.$inferInsert;
