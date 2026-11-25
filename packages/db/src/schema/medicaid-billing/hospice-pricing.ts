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
} from "drizzle-orm/pg-core";
import { organizations } from "../organizations";
import { providerEntities } from "../provider-entities";

/**
 * Verified, effective-dated nonclinical billing evidence for an admission. Clinical service-day
 * quantities remain owned by M6's LOC records. This profile is a source-qualified locality, code and
 * billed-charge contract; it is not an operator-authored clinical fact or an 837I qualification.
 */
export const medicaidHospiceBillingEvidence = pgTable(
  "medicaid_hospice_billing_evidence",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    providerEntityId: uuid("provider_entity_id")
      .notNull()
      .references(() => providerEntities.id, { onDelete: "restrict" }),
    patientId: uuid("patient_id").notNull(), // logical M5 identity; minimum needed to bind this evidence to an admission
    admissionId: uuid("admission_id").notNull(), // logical M6 identity
    admissionVersion: integer("admission_version").notNull(),
    canonicalPayerId: uuid("canonical_payer_id").notNull(), // logical M40 identity
    programKind: text("program_kind").notNull(),
    serviceState: text("service_state").notNull(),
    localityCode: text("locality_code").notNull(),
    localityEvidenceReference: text("locality_evidence_reference").notNull(),
    localityEvidenceVersion: integer("locality_evidence_version").notNull(),
    qualityReportingApplicability: text("quality_reporting_applicability").notNull(),
    qualityReportingStatus: text("quality_reporting_status").notNull(),
    qualityEvidenceReference: text("quality_evidence_reference").notNull(),
    qualityEvidenceVersion: integer("quality_evidence_version").notNull(),
    serviceCategory: text("service_category").notNull(),
    quantityPolicy: text("quantity_policy").notNull(),
    quantityEvidenceOwner: text("quantity_evidence_owner").notNull(),
    billingUnit: text("billing_unit").notNull(),
    revenueCode: text("revenue_code").notNull(),
    hcpcsCode: text("hcpcs_code").notNull(),
    codingProfile: text("coding_profile").notNull(),
    codingEvidenceReference: text("coding_evidence_reference").notNull(),
    codingEvidenceVersion: integer("coding_evidence_version").notNull(),
    billedChargeCentsPerUnit: integer("billed_charge_cents_per_unit").notNull(),
    chargeEvidenceReference: text("charge_evidence_reference").notNull(),
    chargeEvidenceVersion: integer("charge_evidence_version").notNull(),
    verificationStatus: text("verification_status").notNull().default("unverified"),
    effectiveFrom: date("effective_from", { mode: "string" }).notNull(),
    effectiveTo: date("effective_to", { mode: "string" }),
    sourceDocumentReference: text("source_document_reference").notNull(),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    verifiedByMembershipId: uuid("verified_by_membership_id"),
    recordedByMembershipId: uuid("recorded_by_membership_id").notNull(),
    supersedesId: uuid("supersedes_id"),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    orgIdUnique: unique("medicaid_hospice_billing_evidence_org_id_uq").on(t.organizationId, t.id),
    supersedesSameOrg: foreignKey({
      name: "medicaid_hospice_billing_evidence_supersedes_org_fk",
      columns: [t.organizationId, t.supersedesId],
      foreignColumns: [t.organizationId, t.id],
    }).onDelete("restrict"),
    lookup: index("medicaid_hospice_billing_evidence_lookup_ix").on(
      t.organizationId,
      t.providerEntityId,
      t.admissionId,
      t.canonicalPayerId,
      t.effectiveFrom,
      t.effectiveTo,
    ),
    supersedes: index("medicaid_hospice_billing_evidence_supersedes_ix").on(
      t.organizationId,
      t.supersedesId,
    ),
    identityValid: check(
      "medicaid_hospice_billing_evidence_identity_valid",
      sql`program_kind IN ('managed_care') AND service_state = 'OR' AND service_category = 'RHC'`,
    ),
    rangeValid: check(
      "medicaid_hospice_billing_evidence_range_valid",
      sql`effective_to IS NULL OR effective_from <= effective_to`,
    ),
    versionValid: check(
      "medicaid_hospice_billing_evidence_version_valid",
      sql`version > 0 AND admission_version >= 0 AND locality_evidence_version > 0 AND
          quality_evidence_version > 0 AND coding_evidence_version > 0 AND charge_evidence_version > 0`,
    ),
    pricingFactsValid: check(
      "medicaid_hospice_billing_evidence_pricing_facts_valid",
      sql`locality_code <> '' AND billed_charge_cents_per_unit > 0 AND
          quantity_policy = 'active_rhc_loc_calendar_day' AND
          quantity_evidence_owner = 'm6_level_of_care_period' AND billing_unit = 'daily' AND
          revenue_code = '0651' AND hcpcs_code = 'Q5001' AND coding_profile = 'local_draft_only'`,
    ),
    qualityFactsValid: check(
      "medicaid_hospice_billing_evidence_quality_valid",
      sql`(quality_reporting_applicability = 'not_required' AND quality_reporting_status = 'not_applicable') OR
          (quality_reporting_applicability = 'required' AND quality_reporting_status IN ('meets', 'does_not_meet'))`,
    ),
    statusValid: check(
      "medicaid_hospice_billing_evidence_status_valid",
      sql`verification_status IN ('unverified', 'pending', 'verified', 'revoked', 'superseded')`,
    ),
    verifiedProvenance: check(
      "medicaid_hospice_billing_evidence_verified_provenance",
      sql`verification_status <> 'verified' OR
          (verified_at IS NOT NULL AND verified_by_membership_id IS NOT NULL AND
           verified_by_membership_id <> recorded_by_membership_id)`,
    ),
    referencesValid: check(
      "medicaid_hospice_billing_evidence_references_valid",
      sql`locality_evidence_reference ~ '^(doc|evidence):[A-Za-z0-9._/-]{1,190}$' AND
          quality_evidence_reference ~ '^(doc|evidence):[A-Za-z0-9._/-]{1,190}$' AND
          coding_evidence_reference ~ '^(doc|evidence):[A-Za-z0-9._/-]{1,190}$' AND
          charge_evidence_reference ~ '^(doc|evidence):[A-Za-z0-9._/-]{1,190}$' AND
          source_document_reference ~ '^(doc|evidence):[A-Za-z0-9._/-]{1,190}$'`,
    ),
  }),
);

/** Immutable point-in-time calculation and evidence identity for a payer-rate-priced claim line. */
export const medicaidClaimLinePricingSnapshot = pgTable(
  "medicaid_claim_line_pricing_snapshot",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    providerEntityId: uuid("provider_entity_id")
      .notNull()
      .references(() => providerEntities.id, { onDelete: "restrict" }),
    medicaidClaimId: uuid("medicaid_claim_id").notNull(), // logical M24 claim identity
    medicaidClaimLineId: uuid("medicaid_claim_line_id").notNull(), // logical composite parent FK installed in SQL
    payerRatePolicyId: uuid("payer_rate_policy_id").notNull(), // M24-owned reference, composite FK installed in SQL
    billingEvidenceId: uuid("billing_evidence_id").notNull(),
    snapshotSchemaVersion: integer("snapshot_schema_version").notNull().default(1),
    assessedAt: timestamp("assessed_at", { withTimezone: true }).notNull(),
    fingerprint: text("fingerprint").notNull(),
    snapshot: jsonb("snapshot").$type<Record<string, unknown>>().notNull(),
    createdByMembershipId: uuid("created_by_membership_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    lineUnique: unique("medicaid_claim_line_pricing_snapshot_line_uq").on(
      t.providerEntityId,
      t.medicaidClaimLineId,
    ),
    claimLookup: index("medicaid_claim_line_pricing_snapshot_claim_ix").on(
      t.organizationId,
      t.providerEntityId,
      t.medicaidClaimId,
    ),
    fingerprintValid: check(
      "medicaid_claim_line_pricing_snapshot_fingerprint_valid",
      sql`fingerprint ~ '^[0-9a-f]{64}$' AND snapshot_schema_version = 1`,
    ),
    snapshotShape: check(
      "medicaid_claim_line_pricing_snapshot_shape_valid",
      sql`jsonb_typeof(snapshot) = 'object' AND snapshot ->> 'schemaVersion' = '1' AND
          snapshot ->> 'postingAuthorized' = 'false'`,
    ),
  }),
);

export type MedicaidHospiceBillingEvidence = typeof medicaidHospiceBillingEvidence.$inferSelect;
export type NewMedicaidHospiceBillingEvidence = typeof medicaidHospiceBillingEvidence.$inferInsert;
export type MedicaidClaimLinePricingSnapshot = typeof medicaidClaimLinePricingSnapshot.$inferSelect;
