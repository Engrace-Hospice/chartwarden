import { sql } from "drizzle-orm";
// @chartwarden/db — `wound_observation` (M9 longitudinal wounds, migration 1529). One dated look at a wound; the visit note
// (M8) states the ones recorded at its encounter through the WoundProvider seam. `source_encounter_id` is a logical uuid
// (M9 may not import M8: no FK). Everything is coded or numeric: no free text, so nothing to seal.
//
// APPEND-ONLY, by the M9 convention (clinical_assessment): a correction INSERTs a new row naming the one it corrects
// (`corrects_observation_id` + a coded `correction_reason`) and the database flips the target to `superseded`, version + 1.
// The application role holds no UPDATE on any value column; a BEFORE UPDATE trigger refuses every change but that flip.
// Lengths are centimetres, numeric(5,1) (returned as strings by the driver). PHI-bearing → the three-column tenancy rule
// (provider_entity_id / location_id nullable, unset for now). RLS + grants + triggers are in migration 1529.
import {
  boolean,
  index,
  integer,
  numeric,
  pgTable,
  smallint,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { locations } from "../locations";
import { memberships } from "../memberships";
import { organizations } from "../organizations";
import { providerEntities } from "../provider-entities";

export const woundObservations = pgTable(
  "wound_observation",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    providerEntityId: uuid("provider_entity_id").references(() => providerEntities.id, {
      onDelete: "restrict",
    }),
    locationId: uuid("location_id").references(() => locations.id, { onDelete: "restrict" }),
    /** FK is composite (wound_id, organization_id, patient_id) → wound; declared in the migration. */
    woundId: uuid("wound_id").notNull(),
    patientId: uuid("patient_id").notNull(), // denormalised from the wound for RLS-scoped reads
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
    observedByMembershipId: uuid("observed_by_membership_id")
      .notNull()
      .references(() => memberships.id, { onDelete: "restrict" }),
    sourceEncounterId: uuid("source_encounter_id"), // M8 encounter (logical; no cross-module FK)
    stage: text("stage"), // pressure injuries only (NPIAP); enforced by trigger
    lengthCm: numeric("length_cm", { precision: 5, scale: 1 }),
    widthCm: numeric("width_cm", { precision: 5, scale: 1 }),
    depthCm: numeric("depth_cm", { precision: 5, scale: 1 }),
    undermining: boolean("undermining"),
    woundBed: text("wound_bed").array().notNull().default(sql`'{}'::text[]`),
    exudateAmount: text("exudate_amount"),
    exudateType: text("exudate_type"),
    odor: text("odor"),
    periwound: text("periwound").array().notNull().default(sql`'{}'::text[]`),
    painScore: smallint("pain_score"),
    dressing: text("dressing"),
    dressingChanged: boolean("dressing_changed"),
    infectionSigns: boolean("infection_signs"),
    trend: text("trend"),
    /** `active` | `superseded` (a correction supersedes the observation it corrects). */
    status: text("status").notNull().default("active"),
    correctsObservationId: uuid("corrects_observation_id"), // self-FK, declared in the migration
    /** Coded (`WOUND_CORRECTION_REASONS`), never free text. */
    correctionReason: text("correction_reason"),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    woundIdx: index("wound_observation_wound_idx").on(
      t.woundId,
      t.organizationId,
      t.patientId,
      t.observedAt.desc(),
      t.id,
    ),
    patientIdx: index("wound_observation_patient_idx").on(
      t.organizationId,
      t.patientId,
      t.observedAt.desc(),
    ),
    encounterIdx: index("wound_observation_encounter_idx")
      .on(t.organizationId, t.sourceEncounterId, t.observedAt, t.id)
      .where(sql`source_encounter_id IS NOT NULL AND status = 'active'`),
    correctsIdx: index("wound_observation_corrects_idx")
      .on(t.correctsObservationId)
      .where(sql`corrects_observation_id IS NOT NULL`),
  }),
);

export type WoundObservation = typeof woundObservations.$inferSelect;
export type NewWoundObservation = typeof woundObservations.$inferInsert;
