// @wardenx/db — `oncall_rotation_entry` (M17, GAP-029). The on-call rotation source behind
// `VisitAssignmentReader.tonightsOnCallRoster` (M17 spec §4.3) that M19's Direct-model roster sync reads: one
// row per (person × discipline × window). STAFF-scoped like `membership_credential` (organization_id +
// membership_id only; M19 fans a roster entry out per ProviderEntity). Cancelled, never deleted, so the sync
// can tell "dropped from the roster" from "never on it". Not partitioned (O(clinicians × nights)).
import { sql } from "drizzle-orm";
import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { memberships } from "../memberships";
import { organizations } from "../organizations";

export const oncallRotationEntry = pgTable(
  "oncall_rotation_entry",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    membershipId: uuid("membership_id")
      .notNull()
      .references(() => memberships.id, { onDelete: "cascade" }),
    /** M19's `oncall_shift_discipline` vocabulary minus `external` (CHECK in the migration). */
    discipline: text("discipline").notNull(),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    createdByMembershipId: uuid("created_by_membership_id").notNull(),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    cancelledByMembershipId: uuid("cancelled_by_membership_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    currentUq: uniqueIndex("oncall_rotation_entry_current_uq")
      .on(t.organizationId, t.membershipId, t.discipline, t.startsAt, t.endsAt)
      .where(sql`cancelled_at IS NULL`),
    rosterIdx: index("oncall_rotation_entry_roster_idx")
      .on(t.organizationId, t.endsAt)
      .where(sql`cancelled_at IS NULL`),
    membershipIdx: index("oncall_rotation_entry_membership_idx").on(t.membershipId),
  }),
);

export type OncallRotationEntry = typeof oncallRotationEntry.$inferSelect;
export type NewOncallRotationEntry = typeof oncallRotationEntry.$inferInsert;
