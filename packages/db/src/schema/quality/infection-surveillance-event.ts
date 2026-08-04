// @wardenx/db — `infection_surveillance_event` (M30 §3.3; PARTITIONED monthly by `observed_at`;
// retention class `phi`). Per-event infection/exposure surveillance feeding outbreak detection.
// Registers a §3.7 eraser (null patient_id + exposure_source → <erased>; retain categorical pathogen
// surveillance for public health). ORG-SCOPED: organization_id NOT NULL (canonical app.org_id RLS).
//
// THREE-COLUMN RULE (ARCH-011): carries a bare `patient_id` (PHI signal), so it carries
// `provider_entity_id` + `location_id` (architecture wins over the §3.3 column list, which omits
// location_id). patient_id + location_id are nullable (staff-exposure events are not patient-scoped).
// `exposure_source` (free-text identifying) is audit-denylisted (§3.6); the categorical pathogen /
// body_site / transmission_context are not.
//
// PARTITION BY RANGE (observed_at) monthly: the Drizzle definition is the LOGICAL shape (composite PK
// incl. the partition key); the PARTITION BY + monthly children + DEFAULT catch-all land in the
// tables/RLS migration. The outbreak-lookup index INCLUDES observed_at and is non-unique, so it is
// valid on the partitioned parent.
import { sql } from "drizzle-orm";
import { index, jsonb, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { organizations } from "../organizations";

export const infectionSurveillanceEvent = pgTable(
  "infection_surveillance_event",
  {
    id: uuid("id").notNull().defaultRandom(), // composite PK with observed_at (partition key)
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    providerEntityId: uuid("provider_entity_id").notNull(), // logical FK to M40 (ARCH-011)
    // ARCH-011 three-column rule: location_id present (nullable — staff-exposure events are not
    // location-scoped). Logical FK to M1 location (app-validated).
    locationId: uuid("location_id"),
    patientId: uuid("patient_id"), // nullable for staff exposure
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull(), // partition key
    pathogen: text("pathogen").notNull(), // V-17
    pathogenConfidence: text("pathogen_confidence").notNull().default("confirmed"),
    bodySite: text("body_site").notNull(), // V-17
    transmissionContext: text("transmission_context").notNull(),
    exposureSource: text("exposure_source"), // free-text identifying; DENYLISTED (§3.6)
    precautionsInstituted: jsonb("precautions_instituted")
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    outcome: text("outcome"),
    filedByMembershipId: uuid("filed_by_membership_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.id, t.observedAt] }), // partition key must be in the PK
    outbreakLookup: index("idx_infection_outbreak_lookup").on(
      t.providerEntityId,
      t.pathogen,
      t.bodySite,
      t.observedAt,
    ),
  }),
);

export type InfectionSurveillanceEvent = typeof infectionSurveillanceEvent.$inferSelect;
export type NewInfectionSurveillanceEvent = typeof infectionSurveillanceEvent.$inferInsert;
