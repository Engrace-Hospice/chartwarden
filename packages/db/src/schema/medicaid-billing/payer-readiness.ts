// M24-owned, organization/provider-entity scoped payer identity and qualification evidence.
// Patient payer coverage remains M5-owned; these rows attach dated Medicaid program responsibility
// to an M5 coverage row without changing M5 data or treating eligibility as enrollment evidence.
import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { organizations } from "../organizations";
import { providerEntities } from "../provider-entities";
import {
  m24EnrollmentEvidenceKind,
  m24EnrollmentEvidenceStatus,
  m24MedicaidProgramKind,
  m24ProgramAssignmentStatus,
} from "./enums";

export const medicaidProgramAssignment = pgTable(
  "medicaid_program_assignment",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    patientId: uuid("patient_id").notNull(), // logical M5 reference
    patientPayerId: uuid("patient_payer_id").notNull(), // logical M5 coverage reference
    admissionId: uuid("admission_id").notNull(), // logical M6 service context
    providerEntityId: uuid("provider_entity_id")
      .notNull()
      .references(() => providerEntities.id, { onDelete: "restrict" }),
    serviceState: varchar("service_state", { length: 2 }).notNull(),
    programKind: m24MedicaidProgramKind("program_kind").notNull(),
    canonicalPayerId: uuid("canonical_payer_id"), // logical M40 reference
    payerSnapshot: jsonb("payer_snapshot"), // stable identity label/identifier, no patient data
    status: m24ProgramAssignmentStatus("status").notNull().default("candidate"),
    effectiveFrom: timestamp("effective_from", { withTimezone: true, mode: "date" }).notNull(),
    effectiveTo: timestamp("effective_to", { withTimezone: true, mode: "date" }),
    sourceKind: varchar("source_kind", { length: 40 }).notNull(),
    verificationSource: varchar("verification_source", { length: 80 }),
    evidenceReference: text("evidence_reference"), // secured document pointer or opaque source id
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    verifiedByMembershipId: uuid("verified_by_membership_id"),
    revocationReason: varchar("revocation_reason", { length: 40 }),
    recordedByMembershipId: uuid("recorded_by_membership_id").notNull(),
    supersedesId: uuid("supersedes_id"),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    patientRange: index("medicaid_program_assignment_patient_range_ix").on(
      t.organizationId,
      t.patientId,
      t.patientPayerId,
      t.admissionId,
      t.providerEntityId,
      t.effectiveFrom,
      t.effectiveTo,
    ),
    effectiveRange: check(
      "medicaid_program_assignment_range_valid",
      sql`effective_to IS NULL OR effective_from <= effective_to`,
    ),
    verifiedHasProvenance: check(
      "medicaid_program_assignment_verified_provenance",
      sql`status <> 'verified' OR (verified_at IS NOT NULL AND verified_by_membership_id IS NOT NULL AND evidence_reference IS NOT NULL)`,
    ),
    ffsHasNoMco: check(
      "medicaid_program_assignment_ffs_identity",
      sql`program_kind <> 'ffs_open_card' OR canonical_payer_id IS NOT NULL`,
    ),
    evidenceReferenceShape: check(
      "medicaid_program_assignment_evidence_reference_shape",
      sql`evidence_reference IS NULL OR evidence_reference ~ '^(doc|registry|approval|ticket):[A-Za-z0-9._/-]{1,190}$'`,
    ),
    revocationReasonCode: check(
      "medicaid_program_assignment_revocation_reason",
      sql`revocation_reason IS NULL OR revocation_reason IN ('source_corrected', 'payer_withdrawal', 'coverage_changed', 'other')`,
    ),
  }),
);

export const medicaidEnrollmentEvidence = pgTable(
  "medicaid_enrollment_evidence",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    providerEntityId: uuid("provider_entity_id")
      .notNull()
      .references(() => providerEntities.id, { onDelete: "restrict" }),
    serviceState: varchar("service_state", { length: 2 }).notNull(),
    programKind: m24MedicaidProgramKind("program_kind"),
    canonicalPayerId: uuid("canonical_payer_id"), // logical M40 reference
    clearinghouse: varchar("clearinghouse", { length: 40 }),
    vendorPayerId: varchar("vendor_payer_id", { length: 80 }), // candidate/verified vendor-specific mapping
    transactionType: varchar("transaction_type", { length: 8 }),
    evidenceKind: m24EnrollmentEvidenceKind("evidence_kind").notNull(),
    status: m24EnrollmentEvidenceStatus("status").notNull().default("pending"),
    effectiveFrom: timestamp("effective_from", { withTimezone: true, mode: "date" }).notNull(),
    effectiveTo: timestamp("effective_to", { withTimezone: true, mode: "date" }),
    verificationSource: varchar("verification_source", { length: 80 }),
    evidenceReference: text("evidence_reference"), // secured document pointer; never a secret
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    verifiedByMembershipId: uuid("verified_by_membership_id"),
    revocationReason: varchar("revocation_reason", { length: 40 }),
    recordedByMembershipId: uuid("recorded_by_membership_id").notNull(),
    supersedesId: uuid("supersedes_id"),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    providerPayerRange: index("medicaid_enrollment_provider_payer_range_ix").on(
      t.organizationId,
      t.providerEntityId,
      t.serviceState,
      t.canonicalPayerId,
      t.evidenceKind,
      t.effectiveFrom,
      t.effectiveTo,
    ),
    effectiveRange: check(
      "medicaid_enrollment_evidence_range_valid",
      sql`effective_to IS NULL OR effective_from <= effective_to`,
    ),
    verifiedHasProvenance: check(
      "medicaid_enrollment_evidence_verified_provenance",
      sql`status <> 'verified' OR (verified_at IS NOT NULL AND verified_by_membership_id IS NOT NULL AND verification_source IS NOT NULL AND evidence_reference IS NOT NULL)`,
    ),
    transactionType: check(
      "medicaid_enrollment_evidence_transaction_type",
      sql`transaction_type IS NULL OR transaction_type IN ('837I', '835')`,
    ),
    verifiedPayerRouteIsMapped: check(
      "medicaid_enrollment_verified_payer_route_is_mapped",
      sql`evidence_kind <> 'clearinghouse_payer_route' OR status <> 'verified' OR (clearinghouse IS NOT NULL AND canonical_payer_id IS NOT NULL AND vendor_payer_id IS NOT NULL AND transaction_type IS NOT NULL)`,
    ),
    evidenceReferenceShape: check(
      "medicaid_enrollment_evidence_reference_shape",
      sql`evidence_reference IS NULL OR evidence_reference ~ '^(doc|registry|approval|ticket):[A-Za-z0-9._/-]{1,190}$'`,
    ),
    revocationReasonCode: check(
      "medicaid_enrollment_evidence_revocation_reason",
      sql`revocation_reason IS NULL OR revocation_reason IN ('source_corrected', 'payer_withdrawal', 'coverage_changed', 'other')`,
    ),
  }),
);
