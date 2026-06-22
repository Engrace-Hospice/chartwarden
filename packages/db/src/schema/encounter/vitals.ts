// @wardenx/db — `vitals` (M8 §3.3). A captured vital-signs set for an encounter, with explicit units and
// per-field LOINC for FHIR mapping. PHI-bearing → three-column tenancy rule (denormalized from the
// parent encounter). Numeric measurements stored as text to preserve units/precision; range CHECKs guard
// physiologic plausibility. RLS + the M4 write-audit trigger land in migration 0031 (M8-T03).
import { sql } from "drizzle-orm";
import { check, index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { painScale, vitalUnit } from "../../enums";
import { locations } from "../locations";
import { organizations } from "../organizations";
import { providerEntities } from "../provider-entities";
import { encounters } from "./encounters";

export const vitals = pgTable(
  "vitals",
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
    encounterId: uuid("encounter_id")
      .notNull()
      .references(() => encounters.id, { onDelete: "cascade" }),

    capturedAt: timestamp("captured_at", { withTimezone: true }).notNull(),
    bpSystolic: integer("bp_systolic"),
    bpDiastolic: integer("bp_diastolic"),
    heartRate: integer("heart_rate"),
    respiratoryRate: integer("respiratory_rate"),
    temperature: text("temperature"), // numeric stored as text to preserve unit explicitly
    temperatureUnit: vitalUnit("temperature_unit"),
    spo2: integer("spo2"),
    painScore: integer("pain_score"),
    painScale: painScale("pain_scale"),
    weight: text("weight"),
    weightUnit: vitalUnit("weight_unit"),
    height: text("height"),
    heightUnit: vitalUnit("height_unit"),
    bmi: text("bmi"),
    bloodGlucose: integer("blood_glucose"),
    bloodGlucoseUnit: vitalUnit("blood_glucose_unit"),

    clinicallyNotIndicatedFields: text("clinically_not_indicated_fields").array(),
    clinicallyNotIndicatedReason: text("clinically_not_indicated_reason"),

    loincReferences: jsonb("loinc_references").notNull().default({}), // per-field LOINC for FHIR mapping

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    encounterIdx: index("vitals_encounter_idx").on(t.encounterId, t.capturedAt),
    bpRange: check(
      "vitals_bp_range",
      sql`(bp_systolic IS NULL OR (bp_systolic BETWEEN 40 AND 260))
          AND (bp_diastolic IS NULL OR (bp_diastolic BETWEEN 20 AND 180))`,
    ),
    spo2Range: check("vitals_spo2_range", sql`spo2 IS NULL OR (spo2 BETWEEN 50 AND 100)`),
    painRange: check("vitals_pain_range", sql`pain_score IS NULL OR (pain_score BETWEEN 0 AND 10)`),
    cniReasonRequired: check(
      "vitals_cni_reason_required",
      sql`(clinically_not_indicated_fields IS NULL OR cardinality(clinically_not_indicated_fields) = 0)
          OR (clinically_not_indicated_reason IS NOT NULL AND char_length(clinically_not_indicated_reason) >= 20)`,
    ),
  }),
);

export type Vitals = typeof vitals.$inferSelect;
export type NewVitals = typeof vitals.$inferInsert;
