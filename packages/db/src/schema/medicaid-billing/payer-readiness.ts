// M24-owned, organization/provider-entity scoped payer identity and qualification evidence.
// Patient payer coverage remains M5-owned; these rows attach dated Medicaid program responsibility
// to an M5 coverage row without changing M5 data or treating eligibility as enrollment evidence.
import { sql } from "drizzle-orm";
import {
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { locations } from "../locations";
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
    locationId: uuid("location_id").references(() => locations.id, { onDelete: "restrict" }), // nullable siting
    serviceState: varchar("service_state", { length: 2 }).notNull(),
    programKind: m24MedicaidProgramKind("program_kind").notNull(),
    canonicalPayerId: uuid("canonical_payer_id"), // logical M40 reference
    canonicalPayerClassificationId: uuid("canonical_payer_classification_id"), // logical M40 evidence record
    payerSnapshot: jsonb("payer_snapshot"), // stable identity label/identifier, no patient data
    status: m24ProgramAssignmentStatus("status").notNull().default("candidate"),
    effectiveFrom: date("effective_from", { mode: "string" }).notNull(), // calendar date (1535 creates `date`)
    effectiveTo: date("effective_to", { mode: "string" }),
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
    verifierIsNotRecorder: check(
      "medicaid_program_assignment_four_eyes",
      sql`status <> 'verified' OR verified_by_membership_id <> recorded_by_membership_id`,
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
    verifiedHasConcreteProgram: check(
      "medicaid_program_assignment_verified_program_kind",
      sql`status <> 'verified' OR program_kind NOT IN ('unresolved', 'ambiguous')`,
    ),
    orgIdUnique: unique("medicaid_program_assignment_org_id_uq").on(t.organizationId, t.id),
    supersedesSameOrg: foreignKey({
      name: "medicaid_program_assignment_supersedes_org_fk",
      columns: [t.organizationId, t.supersedesId],
      foreignColumns: [t.organizationId, t.id],
    }).onDelete("restrict"),
    supersedes: index("medicaid_program_assignment_supersedes_ix").on(
      t.organizationId,
      t.supersedesId,
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
    // Non-secret external account identity. This is not a credential and is populated only when
    // independently verified ERA enrollment evidence names the vendor account.
    vendorAccountRef: varchar("vendor_account_ref", { length: 128 }),
    sourceEnvironment: varchar("source_environment", { length: 16 }),
    vendorPayerId: varchar("vendor_payer_id", { length: 80 }), // candidate/verified vendor-specific mapping
    transactionType: varchar("transaction_type", { length: 8 }),
    evidenceKind: m24EnrollmentEvidenceKind("evidence_kind").notNull(),
    status: m24EnrollmentEvidenceStatus("status").notNull().default("pending"),
    effectiveFrom: date("effective_from", { mode: "string" }).notNull(), // calendar date (1535 creates `date`)
    effectiveTo: date("effective_to", { mode: "string" }),
    evidenceFreshUntil: date("evidence_fresh_until", { mode: "string" }),
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
    verifierIsNotRecorder: check(
      "medicaid_enrollment_evidence_four_eyes",
      sql`status <> 'verified' OR verified_by_membership_id <> recorded_by_membership_id`,
    ),
    verifiedPayerRouteIsMapped: check(
      "medicaid_enrollment_verified_payer_route_is_mapped",
      sql`evidence_kind <> 'clearinghouse_payer_route' OR status <> 'verified' OR (clearinghouse IS NOT NULL AND canonical_payer_id IS NOT NULL AND vendor_payer_id IS NOT NULL AND transaction_type IS NOT NULL)`,
    ),
    verifiedEraSourceIsScoped: check(
      "medicaid_enrollment_835_source_identity_ck",
      sql`evidence_kind <> '835_era_enrollment' OR status <> 'verified' OR
        (clearinghouse IN ('claimmd', 'stedi') AND vendor_account_ref IS NOT NULL AND
         source_environment IN ('test', 'production') AND canonical_payer_id IS NOT NULL AND
         vendor_payer_id IS NOT NULL AND program_kind IS NOT NULL AND transaction_type = '835' AND
         effective_to IS NOT NULL AND evidence_fresh_until IS NOT NULL)`,
    ),
    sourceEnvironmentValid: check(
      "medicaid_enrollment_source_environment_ck",
      sql`source_environment IS NULL OR source_environment IN ('test', 'production')`,
    ),
    vendorAccountRefShape: check(
      "medicaid_enrollment_vendor_account_ref_ck",
      sql`vendor_account_ref IS NULL OR vendor_account_ref ~ '^[A-Za-z0-9._:-]{1,128}$'`,
    ),
    eraEvidenceFreshnessRange: check(
      "medicaid_enrollment_evidence_freshness_ck",
      sql`evidence_fresh_until IS NULL OR effective_from <= evidence_fresh_until`,
    ),
    evidenceReferenceShape: check(
      "medicaid_enrollment_evidence_reference_shape",
      sql`evidence_reference IS NULL OR evidence_reference ~ '^(doc|registry|approval|ticket):[A-Za-z0-9._/-]{1,190}$'`,
    ),
    revocationReasonCode: check(
      "medicaid_enrollment_evidence_revocation_reason",
      sql`revocation_reason IS NULL OR revocation_reason IN ('source_corrected', 'payer_withdrawal', 'coverage_changed', 'other')`,
    ),
    verifiedHasConcreteProgram: check(
      "medicaid_enrollment_verified_program_kind",
      sql`status <> 'verified' OR program_kind IS NULL OR program_kind NOT IN ('unresolved', 'ambiguous')`,
    ),
    orgIdUnique: unique("medicaid_enrollment_evidence_org_id_uq").on(t.organizationId, t.id),
    supersedesSameOrg: foreignKey({
      name: "medicaid_enrollment_evidence_supersedes_org_fk",
      columns: [t.organizationId, t.supersedesId],
      foreignColumns: [t.organizationId, t.id],
    }).onDelete("restrict"),
    supersedes: index("medicaid_enrollment_supersedes_ix").on(t.organizationId, t.supersedesId),
    eraAccountLookup: index("medicaid_enrollment_era_account_lookup_ix")
      .on(
        t.organizationId,
        t.providerEntityId,
        t.clearinghouse,
        t.vendorAccountRef,
        t.sourceEnvironment,
        t.canonicalPayerId,
        t.effectiveFrom,
        t.effectiveTo,
      )
      .where(sql`evidence_kind = '835_era_enrollment' AND status = 'verified'`),
  }),
);
