// @wardenx/db — `patient_address` (M5 §3.3, M5 D5). APPEND-ONLY address history: a change inserts a
// new row and closes the prior with `effective_to`; `effective_to IS NULL` is the current row.
// PHI-bearing → three-column tenancy rule. Geocode lat/lng are filled by the M5-T10 geocode job;
// `facility_id` resolves an M40 Facility when kind='facility'. One current primary per patient.
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  index,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { patientAddressKind } from "../../enums";
import { locations } from "../locations";
import { organizations } from "../organizations";
import { providerEntities } from "../provider-entities";
import { patients } from "./patients";

export const patientAddresses = pgTable(
  "patient_address",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    patientId: uuid("patient_id")
      .notNull()
      .references(() => patients.id, { onDelete: "restrict" }),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    providerEntityId: uuid("provider_entity_id").references(() => providerEntities.id, {
      onDelete: "restrict",
    }),
    locationId: uuid("location_id").references(() => locations.id, { onDelete: "restrict" }),
    kind: patientAddressKind("kind").notNull().default("home"),
    line1: text("line1").notNull(),
    line2: text("line2"),
    city: text("city").notNull(),
    state: text("state"), // 2-letter; required for country='US'
    postalCode: text("postal_code").notNull(),
    country: text("country").notNull().default("US"),
    county: text("county"),
    isPrimary: boolean("is_primary").notNull().default(false),
    effectiveFrom: date("effective_from").notNull(),
    effectiveTo: date("effective_to"), // null = current
    geocodeLat: numeric("geocode_lat", { precision: 9, scale: 6 }),
    geocodeLng: numeric("geocode_lng", { precision: 9, scale: 6 }),
    facilityId: uuid("facility_id"), // MDM Facility (M40) when kind='facility'
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    patientIdx: index("patient_address_patient_idx").on(t.patientId),
    primaryUnique: uniqueIndex("patient_address_primary_unique")
      .on(t.patientId)
      .where(sql`${t.isPrimary} = true AND ${t.effectiveTo} IS NULL`),
    usaStateRequired: check(
      "patient_address_us_state_required",
      sql`(${t.country} <> 'US') OR (${t.state} IS NOT NULL)`,
    ),
    fromBeforeTo: check(
      "patient_address_dates",
      sql`${t.effectiveTo} IS NULL OR ${t.effectiveTo} >= ${t.effectiveFrom}`,
    ),
  }),
);

export type PatientAddress = typeof patientAddresses.$inferSelect;
export type NewPatientAddress = typeof patientAddresses.$inferInsert;
