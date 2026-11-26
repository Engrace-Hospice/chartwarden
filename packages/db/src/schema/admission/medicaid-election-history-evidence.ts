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
  uuid,
} from "drizzle-orm/pg-core";
import { locations } from "../locations";
import { organizations } from "../organizations";
import { providerEntities } from "../provider-entities";
import { admissions } from "./admissions";
import { electionPeriods } from "./election-periods";

/**
 * M6-owned, versioned determination that the locally available election history is complete for a
 * specified service window. The row contains source references and dispositions only; no patient
 * narrative or external-hospice details are copied here.
 */
export const medicaidElectionHistoryEvidence = pgTable(
  "medicaid_election_history_evidence",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    providerEntityId: uuid("provider_entity_id")
      .notNull()
      .references(() => providerEntities.id),
    locationId: uuid("location_id").references(() => locations.id),
    patientId: uuid("patient_id").notNull(), // logical M5 reference
    admissionId: uuid("admission_id")
      .notNull()
      .references(() => admissions.id),
    electionPeriodId: uuid("election_period_id")
      .notNull()
      .references(() => electionPeriods.id),
    coverageFrom: date("coverage_from", { mode: "string" }).notNull(),
    coverageThrough: date("coverage_through", { mode: "string" }).notNull(),
    completenessStatus: text("completeness_status").notNull(),
    priorHospiceStatus: text("prior_hospice_status").notNull(),
    transferStatus: text("transfer_status").notNull(),
    interruptionStatus: text("interruption_status").notNull(),
    sourceReference: text("source_reference").notNull(),
    sourceVersion: integer("source_version").notNull(),
    verificationStatus: text("verification_status").notNull(),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    verifiedByMembershipId: uuid("verified_by_membership_id"),
    recordedByMembershipId: uuid("recorded_by_membership_id").notNull(),
    version: integer("version").notNull(),
    supersedesId: uuid("supersedes_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    orgIdUnique: unique("medicaid_election_history_evidence_org_id_uq").on(t.organizationId, t.id),
    scopeVersion: unique("medicaid_election_history_evidence_scope_version_uq").on(
      t.organizationId,
      t.providerEntityId,
      t.patientId,
      t.admissionId,
      t.electionPeriodId,
      t.version,
    ),
    supersedesSameOrg: foreignKey({
      name: "medicaid_election_history_evidence_supersedes_org_fk",
      columns: [t.organizationId, t.supersedesId],
      foreignColumns: [t.organizationId, t.id],
    }).onDelete("restrict"),
    lookup: index("medicaid_election_history_evidence_scope_ix").on(
      t.organizationId,
      t.providerEntityId,
      t.patientId,
      t.admissionId,
      t.electionPeriodId,
      t.version,
    ),
    coverageValid: check(
      "medicaid_election_history_evidence_coverage_valid",
      sql`coverage_from <= coverage_through`,
    ),
    statusesValid: check(
      "medicaid_election_history_evidence_statuses_valid",
      sql`completeness_status IN ('complete', 'partial', 'unknown', 'conflicting') AND
          prior_hospice_status IN ('none_confirmed', 'documented', 'unknown') AND
          transfer_status IN ('none_confirmed', 'complete', 'unknown') AND
          interruption_status IN ('none_confirmed', 'complete', 'unknown') AND
          verification_status IN ('pending', 'verified', 'revoked', 'superseded')`,
    ),
    sourceValid: check(
      "medicaid_election_history_evidence_source_valid",
      sql`source_reference ~ '^(doc|evidence):[A-Za-z0-9._/-]{1,190}$' AND source_version > 0 AND version > 0`,
    ),
    verifiedProvenance: check(
      "medicaid_election_history_evidence_verified_provenance",
      sql`verification_status <> 'verified' OR
          (completeness_status = 'complete' AND verified_at IS NOT NULL AND
           verified_by_membership_id IS NOT NULL AND
           verified_by_membership_id <> recorded_by_membership_id)`,
    ),
  }),
);

export type MedicaidElectionHistoryEvidence = typeof medicaidElectionHistoryEvidence.$inferSelect;
