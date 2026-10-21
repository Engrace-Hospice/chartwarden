// @chartwarden/db — `mileage` (M8 §3.3). Travel mileage captured for an encounter (payroll/reimbursement
// source feeding the M8 MileagePayrollReader seam). PHI-bearing → three-column tenancy rule (denormalized
// from the parent encounter). One mileage row per encounter (unique). RLS + the M4 write-audit trigger
// land in migration 0031 (M8-T03).
import { sql } from "drizzle-orm";
import { check, index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { locations } from "../locations";
import { organizations } from "../organizations";
import { providerEntities } from "../provider-entities";
import { encounters } from "./encounters";

export const mileage = pgTable(
  "mileage",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    // NOT NULL relaxed in mig 0128 (M8L-T02): denormalized siting backfills from the parent encounter.
    providerEntityId: uuid("provider_entity_id").references(() => providerEntities.id, {
      onDelete: "restrict",
    }),
    locationId: uuid("location_id").references(() => locations.id, { onDelete: "restrict" }),
    encounterId: uuid("encounter_id")
      .notNull()
      .references(() => encounters.id, { onDelete: "cascade" })
      .unique(),

    odometerStart: integer("odometer_start"),
    odometerEnd: integer("odometer_end"),
    milesDriven: text("miles_driven").notNull(), // numeric stored as text for precision
    milesDrivenSource: text("miles_driven_source").notNull(), // 'odometer' | 'route_calc' | 'manual_override'
    manualOverrideReason: text("manual_override_reason"),

    routeProposedMiles: text("route_proposed_miles"), // M17's proposal, if any

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    encounterIdx: index("mileage_encounter_idx").on(t.encounterId),
    overrideReasonRequired: check(
      "mileage_override_reason_required",
      sql`(miles_driven_source <> 'manual_override')
          OR (manual_override_reason IS NOT NULL AND char_length(manual_override_reason) >= 20)`,
    ),
    odometerOrder: check(
      "mileage_odometer_order",
      sql`(odometer_start IS NULL OR odometer_end IS NULL) OR (odometer_end >= odometer_start)`,
    ),
  }),
);

export type Mileage = typeof mileage.$inferSelect;
export type NewMileage = typeof mileage.$inferInsert;
