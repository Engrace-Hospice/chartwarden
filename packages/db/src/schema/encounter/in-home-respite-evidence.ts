import { sql } from "drizzle-orm";
import {
  check,
  date,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { locations } from "../locations";
import { memberships } from "../memberships";
import { organizations } from "../organizations";
import { providerEntities } from "../provider-entities";
import { encounters } from "./encounters";

/**
 * M8-owned, append-only evidence that a signed clinical encounter documented delivered in-home respite.
 * This is a clinical source record only; it carries no Medicaid quantity, code, rate or billing status.
 */
export const encounterInHomeRespiteEvidence = pgTable(
  "encounter_in_home_respite_evidence",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    serviceId: uuid("service_id").notNull(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    providerEntityId: uuid("provider_entity_id")
      .notNull()
      .references(() => providerEntities.id, { onDelete: "restrict" }),
    locationId: uuid("location_id")
      .notNull()
      .references(() => locations.id, { onDelete: "restrict" }),
    patientId: uuid("patient_id").notNull(), // logical M5 identity
    admissionId: uuid("admission_id").notNull(), // logical M6 identity
    sourceEncounterId: uuid("source_encounter_id")
      .notNull()
      .references(() => encounters.id, { onDelete: "restrict" }),
    sourceEncounterVersion: integer("source_encounter_version").notNull(),
    serviceDate: date("service_date", { mode: "string" }).notNull(),
    serviceStartedAt: timestamp("service_started_at", { withTimezone: true }).notNull(),
    serviceEndedAt: timestamp("service_ended_at", { withTimezone: true }).notNull(),
    observedDurationSeconds: integer("observed_duration_seconds").notNull(),
    timeSource: text("time_source").notNull(),
    version: integer("version").notNull(),
    supersedesId: uuid("supersedes_id"),
    recordedByMembershipId: uuid("recorded_by_membership_id")
      .notNull()
      .references(() => memberships.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    scopeVersionUq: unique("encounter_in_home_respite_scope_version_uq").on(
      t.organizationId,
      t.serviceId,
      t.version,
    ),
    orgIdUq: unique("encounter_in_home_respite_org_id_uq").on(t.organizationId, t.id),
    sourceEncounterUq: unique("encounter_in_home_respite_source_encounter_uq").on(
      t.organizationId,
      t.sourceEncounterId,
    ),
    initialVersionUq: uniqueIndex("encounter_in_home_respite_initial_version_uq")
      .on(t.organizationId, t.serviceId)
      .where(sql`supersedes_id IS NULL`),
    singleSuccessorUq: uniqueIndex("encounter_in_home_respite_single_successor_uq")
      .on(t.organizationId, t.supersedesId)
      .where(sql`supersedes_id IS NOT NULL`),
    supersedesOrgFk: foreignKey({
      name: "encounter_in_home_respite_supersedes_org_fk",
      columns: [t.organizationId, t.supersedesId],
      foreignColumns: [t.organizationId, t.id],
    }).onDelete("restrict"),
    serviceWindowIx: index("encounter_in_home_respite_service_window_ix").on(
      t.organizationId,
      t.providerEntityId,
      t.patientId,
      t.admissionId,
      t.serviceDate,
    ),
    versionHeadIx: index("encounter_in_home_respite_version_head_ix").on(
      t.organizationId,
      t.serviceId,
      t.version,
    ),
    factsValid: check(
      "encounter_in_home_respite_facts_valid",
      sql`version > 0 AND source_encounter_version >= 0 AND observed_duration_seconds > 0 AND
          service_started_at < service_ended_at AND time_source IN ('evv', 'clinician')`,
    ),
  }),
);

export type EncounterInHomeRespiteEvidence = typeof encounterInHomeRespiteEvidence.$inferSelect;
