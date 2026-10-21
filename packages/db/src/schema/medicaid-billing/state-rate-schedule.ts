// @chartwarden/db — `medicaid_state_rate_schedule` (M24 Billing-Medicaid §3.3/D8-adjacent; non-partitioned;
// retention class `reference`). Per-line rate resolution for the hospice-care-level lines
// (RHC/CHC/IRC/GIP) `medicaid_claim.state_rate_schedule_id_snapshot` snapshots at assembly. Same D8-spec-
// vs-actual-precedent posture as `medicaid_state_plan_code` (self-owned here, not routed through M40's
// physician/facility/payer entity-merge engine — see that file's deviation note; the reasoning is identical
// and not repeated per-field here).
//
// NF_RB IS DELIBERATELY EXCLUDED (audit finding M24-F02, BLOCKER): a Room & Board line prices off
// `rb_arrangement`'s facility-specific contracted per-diem (`rb_day.per_diem_cents_snapshot`), NOT a
// per-county state schedule — SSA §1902(a)(13)(B)/§1905(o) requires R&B payment be a NEGOTIATED rate with
// the nursing facility (≥95% of the NF's own Medicaid per-diem), not a state-published fee schedule figure.
// A schedule row with level_of_care='NF_RB' would be actively wrong to bill from, so the CHECK below forbids
// it outright rather than merely omitting seed data for it.
import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { m24ClaimLineLoc } from "./enums";

export const medicaidStateRateSchedule = pgTable(
  "medicaid_state_rate_schedule",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    stateCode: text("state_code").notNull(), // 2-char state postal code (matches medicaid_claim.service_state)
    levelOfCare: m24ClaimLineLoc("level_of_care").notNull(),
    countyCode: text("county_code"), // null = statewide default rate for this state+LOC+window

    rateCents: integer("rate_cents").notNull(),

    effectiveFrom: timestamp("effective_from", { withTimezone: true }).notNull(),
    effectiveTo: timestamp("effective_to", { withTimezone: true }), // null = still active

    loadSourceRef: text("load_source_ref").notNull(),
    loadedAt: timestamp("loaded_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniqueByStateLocCountyFrom: uniqueIndex("medicaid_state_rate_schedule_uq").on(
      t.stateCode,
      t.levelOfCare,
      t.countyCode,
      t.effectiveFrom,
    ),
    byStateLoc: index("medicaid_state_rate_schedule_state_loc_idx").on(t.stateCode, t.levelOfCare),
    ratePositive: check("medicaid_state_rate_schedule_rate_positive", sql`rate_cents > 0`),
    noRbSchedule: check("medicaid_state_rate_schedule_no_rb", sql`level_of_care <> 'NF_RB'`),
  }),
);

export type MedicaidStateRateSchedule = typeof medicaidStateRateSchedule.$inferSelect;
export type NewMedicaidStateRateSchedule = typeof medicaidStateRateSchedule.$inferInsert;
