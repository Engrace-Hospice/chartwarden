// @wardenx/db — `sia_calculation` (M23 Billing-Medicare §3.3; append-only, 0..1 with `claim`;
// non-partitioned; retention class `compliance`). Captures the Service Intensity Add-on math for the
// last-7-days-of-life window (`window_start` = deceased date − 6 days, inclusive): the qualifying RN/MSW
// visits, total qualifying minutes, and the computed add-on amount. ORG-SCOPED: organization_id NOT
// NULL (canonical app.org_id RLS).
//
// CROSS-MODULE FK POLICY (architecture WINS): only `organization_id` (core) + `claim_id` (intra-M23)
// get real `.references(...)`. The M8 encounter ids inside `qualifying_visits` are LOGICAL FKs. No
// MBI is ever stored here (D13, §8.7).
import { bigint, date, integer, jsonb, pgTable, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { organizations } from "../organizations";
import { claim } from "./claim";
import type { SiaCalculationQualifyingVisits } from "./types";

export const siaCalculation = pgTable(
  "sia_calculation",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    claimId: uuid("claim_id")
      .notNull()
      .references(() => claim.id, { onDelete: "restrict" }),

    patientDeceasedDate: date("patient_deceased_date").notNull(),
    windowStart: date("window_start").notNull(), // = deceasedDate - 6 days (inclusive 7-day window)

    // The qualifying visits (one row per visit captured here as a flat breakdown):
    qualifyingVisits: jsonb("qualifying_visits").$type<SiaCalculationQualifyingVisits>().notNull(), // [{ encounterId, visitDate, discipline, durationMinutes }]
    totalQualifyingMinutes: integer("total_qualifying_minutes").notNull(),
    siaAddOnCents: bigint("sia_add_on_cents", { mode: "number" }).notNull(),

    calculatedAt: timestamp("calculated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    oneToOne: uniqueIndex("sia_calculation_claim_uq").on(t.claimId),
  }),
);

export type SiaCalculation = typeof siaCalculation.$inferSelect;
export type NewSiaCalculation = typeof siaCalculation.$inferInsert;
