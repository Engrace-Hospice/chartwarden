// @wardenx/db — `volunteer_hour_entry` (M15 §3.3). The append-only line items the ledger row aggregates
// (§2.2.7): one per volunteer-visit duration fed by the nightly aggregator from M8, one per typed
// administrative-hours entry, one per audited manual correction.
//
// M15-F04: `source` distinguishes the three. `volunteer_admin_hours` exists so administrative time stops
// being smuggled through the adjustment path; `manual_adjustment` survives as the AUDITED correction path
// behind the §4.4 `volunteer_compliance.adjust_hours` permission and is the only source that carries
// `adjustment_reason` + `adjusted_by_membership_id` (DB CHECK, not just a service guard).
//
// Tenancy: no patient reference — org-scoped, with the PE dimension inherited from the ledger parent.
// RLS keys on app.org_id. FKs: organization (M1 core) + the intra-module ledger parent; the M8 source
// reference and the volunteer membership are LOGICAL uuid.
import { sql } from "drizzle-orm";
import { bigint, check, index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { volunteerHourEntrySource } from "../../enums";
import { organizations } from "../organizations";
import { volunteerHourLedger } from "./volunteer-hour-ledger";

export const volunteerHourEntry = pgTable(
  "volunteer_hour_entry",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    ledgerId: uuid("ledger_id")
      .notNull()
      .references(() => volunteerHourLedger.id, { onDelete: "restrict" }),

    sourceEncounterId: uuid("source_encounter_id"), // logical FK → M8 volunteer_visit
    volunteerMembershipId: uuid("volunteer_membership_id").notNull(), // logical FK → M2 membership
    source: volunteerHourEntrySource("source").notNull(),
    durationMinutes: bigint("duration_minutes", { mode: "number" }).notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),

    adjustmentReason: text("adjustment_reason"), // audit-denylisted (§3.6)
    adjustedByMembershipId: uuid("adjusted_by_membership_id"), // logical FK → M2 membership

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    ledgerOccurredIdx: index("volunteer_hour_entry_ledger_occurred_idx").on(
      t.organizationId,
      t.ledgerId,
      t.occurredAt,
    ),
    volunteerIdx: index("volunteer_hour_entry_volunteer_idx").on(t.volunteerMembershipId),
    sourceRefIdx: index("volunteer_hour_entry_source_ref_idx").on(t.sourceEncounterId),
    adjustmentRequiresReason: check(
      "volunteer_hour_entry_adjustment_reason_ck",
      sql`source <> 'manual_adjustment'
          OR (adjustment_reason IS NOT NULL AND adjusted_by_membership_id IS NOT NULL)`,
    ),
    durationNonZero: check("volunteer_hour_entry_duration_ck", sql`duration_minutes <> 0`),
  }),
);

export type VolunteerHourEntry = typeof volunteerHourEntry.$inferSelect;
export type NewVolunteerHourEntry = typeof volunteerHourEntry.$inferInsert;
