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
    revenueCode: text("revenue_code"),
    hcpcsCode: text("hcpcs_code"),
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
    identityUnique: unique("medicaid_hospice_billing_evidence_identity_uq")
      .on(
        t.organizationId,
        t.providerEntityId,
        t.patientId,
        t.admissionId,
        t.canonicalPayerId,
        t.programKind,
        t.serviceState,
        t.serviceCategory,
        t.effectiveFrom,
        t.supersedesId,
      )
      .nullsNotDistinct(),
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
      sql`program_kind = 'managed_care' AND service_state = 'OR' AND service_category IN ('RHC', 'CHC')`,
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
      sql`locality_code <> '' AND billed_charge_cents_per_unit > 0 AND coding_profile = 'local_draft_only' AND
          ((service_category = 'RHC' AND quantity_policy = 'active_rhc_loc_calendar_day' AND
            quantity_evidence_owner = 'm6_level_of_care_period' AND billing_unit = 'daily' AND
            revenue_code = '0651' AND hcpcs_code IN ('Q5001', 'Q5002')) OR
           (service_category = 'CHC' AND quantity_policy = 'm6_symptom_crisis_plus_signed_m8_rn_intervals_v1' AND
            quantity_evidence_owner = 'm6_loc_m8_encounter' AND billing_unit = 'hourly' AND
            revenue_code IS NULL AND hcpcs_code IS NULL))`,
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
type MedicaidRhcPricingSnapshotCommon = Record<string, unknown> & {
  readonly postingAuthorized: false;
  readonly organizationId: string;
  readonly providerEntityId: string;
  readonly patientId: string;
  readonly admissionId: string;
  readonly admissionVersion: number;
  readonly canonicalPayerId: string;
  readonly programKind: "managed_care";
  readonly serviceState: string;
  readonly serviceFrom: string;
  readonly serviceTo: string;
  readonly levelOfCare: "RHC";
  readonly locPeriodId: string;
  readonly locPeriodVersion: number;
  readonly quantity: {
    readonly basis: "per_day";
    readonly units: number;
    readonly source: "M6_active_RHC_calendar_days";
  };
  readonly locality: {
    readonly code: string;
    readonly evidenceReference: string;
    readonly evidenceVersion: number;
  };
  readonly qualityReporting: {
    readonly applicability: string;
    readonly status: string;
    readonly evidenceReference: string;
    readonly evidenceVersion: number;
  };
  readonly billingEvidenceId: string;
  readonly billingEvidenceVersion: number;
  readonly rateCents: number;
  readonly rateVersion: number;
  readonly payerRatePolicyId: string;
  readonly rateSourceKind: string;
  readonly methodologyVersion: number;
  readonly reimbursementEstimateCents: number;
  readonly baseReimbursementCents: number;
  readonly billedChargeCentsPerUnit: number;
  readonly billedChargeCents: number;
  readonly revenueCode: "0651";
  readonly codingProfile: "local_draft_only";
  readonly codingEvidenceReference: string;
  readonly codingEvidenceVersion: number;
  readonly medicaidClaimId: string;
  readonly claimLineId: string;
  readonly assessmentTimestamp: string;
};

type MedicaidRhcHomeLocationSnapshot = {
  readonly patientAddressId: string;
  readonly kind: "home";
  readonly facilityId: null;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
};

type MedicaidRhcAssistedLivingLocationSnapshot = {
  readonly patientAddressId: string;
  readonly kind: "facility";
  readonly facilityId: string;
  readonly facilityKind: "alf";
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
};

/** Explicit persisted local-draft profiles; new clinical or billing profiles require a reviewed version. */
export type MedicaidClaimLinePricingSnapshotPayload =
  | (MedicaidRhcPricingSnapshotCommon & {
      readonly schemaVersion: 1;
      readonly hcpcsCode: "Q5001";
      readonly serviceLocation: MedicaidRhcHomeLocationSnapshot;
      readonly localBillingProfile?: never;
    })
  | (MedicaidRhcPricingSnapshotCommon & {
      readonly schemaVersion: 2;
      readonly hcpcsCode: "Q5002";
      readonly serviceLocation: MedicaidRhcAssistedLivingLocationSnapshot;
      readonly localBillingProfile: "rhc_assisted_living_q5002_daily_v1";
    });

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
    snapshot: jsonb("snapshot").$type<MedicaidClaimLinePricingSnapshotPayload>().notNull(),
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
      sql`fingerprint ~ '^[0-9a-f]{64}$' AND snapshot_schema_version IN (1, 2)`,
    ),
    snapshotShape: check(
      "medicaid_claim_line_pricing_snapshot_shape_valid",
      sql`jsonb_typeof(snapshot) = 'object' AND
          snapshot ->> 'schemaVersion' = snapshot_schema_version::text AND
          snapshot ->> 'postingAuthorized' = 'false' AND snapshot ? 'assessmentTimestamp' AND
          ((snapshot_schema_version = 1 AND snapshot ->> 'hcpcsCode' = 'Q5001' AND
            snapshot #>> '{serviceLocation,kind}' = 'home' AND
            snapshot #>> '{serviceLocation,facilityId}' IS NULL AND
            NOT (snapshot ? 'localBillingProfile')) OR
           (snapshot_schema_version = 2 AND snapshot ->> 'hcpcsCode' = 'Q5002' AND
            snapshot ->> 'localBillingProfile' = 'rhc_assisted_living_q5002_daily_v1' AND
            snapshot #>> '{serviceLocation,kind}' = 'facility' AND
            snapshot #>> '{serviceLocation,facilityKind}' = 'alf' AND
            snapshot #>> '{serviceLocation,facilityId}' IS NOT NULL))`,
    ),
  }),
);

export type MedicaidHospiceBillingEvidence = typeof medicaidHospiceBillingEvidence.$inferSelect;
export type NewMedicaidHospiceBillingEvidence = typeof medicaidHospiceBillingEvidence.$inferInsert;
export type MedicaidClaimLinePricingSnapshot = typeof medicaidClaimLinePricingSnapshot.$inferSelect;

/** A durable, non-claim local CHC pricing preparation. It is never an institutional claim line. */
export type MedicaidChcPricingPreparationSnapshot = {
  readonly schemaVersion: 1;
  readonly profile: "home_chc_hourly_local_v1";
  readonly preparationId: string;
  readonly preparationVersion: number;
  readonly organizationId: string;
  readonly providerEntityId: string;
  readonly patientId: string;
  readonly admissionId: string;
  readonly admissionVersion: number;
  readonly serviceDate: string;
  readonly serviceTimeZone: string;
  readonly canonicalPayerId: string;
  readonly programKind: "managed_care";
  readonly serviceState: "OR";
  readonly programAssignment: {
    readonly id: string;
    readonly version: number;
    readonly sourceKind: string;
    readonly verificationSource: string;
    readonly evidenceReference: string;
    readonly verifiedAt: string;
    readonly effectiveFrom: string;
    readonly effectiveTo: string | null;
  };
  readonly payerProgramClassification: {
    readonly id: string;
    readonly classification: "medicaid_cco";
    readonly sourceKind: string;
    readonly sourceReference: string;
    readonly verifiedAt: string;
    readonly effectiveFrom: string;
    readonly effectiveTo: string | null;
  };
  readonly residenceAddressId: string;
  readonly residenceKind: "home";
  readonly residenceEffectiveFrom: string;
  readonly residenceEffectiveTo: string | null;
  readonly locPeriodId: string;
  readonly locPeriodVersion: number;
  readonly locReason: "symptom_crisis";
  readonly clinicalMethod: string;
  readonly clinicalMethodReference: string;
  readonly clinicalMethodVersion: number;
  readonly encounterSources: readonly {
    readonly encounterId: string;
    readonly version: number;
    readonly startedAt: string;
    readonly endedAt: string;
    readonly signedAt: string;
    readonly cosignedAt: string | null;
    readonly timeSource: "evv" | "clinician";
    readonly discipline: "rn";
    readonly locationId: string;
  }[];
  readonly observedMinutes: number;
  readonly qualifiedMinutes: number;
  readonly quantityConversionMethod: "hourly_prorated_minutes" | "hourly_each_hour_or_part";
  readonly minimumClinicalMinutes: number | null;
  readonly maximumClinicalMinutes: number;
  readonly ratePolicyId: string;
  readonly ratePolicyVersion: number;
  readonly rateSourceReference: string;
  readonly rateCentsPerHour: number;
  readonly billingEvidenceId: string;
  readonly billingEvidenceVersion: number;
  readonly codingProfile: "local_draft_only";
  readonly codingEvidenceReference: string;
  readonly codingEvidenceVersion: number;
  readonly localityCode: string;
  readonly localityEvidenceReference: string;
  readonly localityEvidenceVersion: number;
  readonly qualityApplicability: string;
  readonly qualityStatus: string;
  readonly qualityEvidenceReference: string;
  readonly qualityEvidenceVersion: number;
  readonly billedChargeEvidenceReference: string;
  readonly billedChargeEvidenceVersion: number;
  readonly billedChargeCentsPerHour: number;
  readonly estimatedReimbursementCents: number;
  readonly baseReimbursementCents: number;
  readonly billedChargeCents: number;
  readonly reimbursementRoundingMode: string;
  readonly reimbursementRoundingBoundary: string;
  readonly appliedCeilings: readonly {
    readonly method: string;
    readonly amountCents: number;
    readonly boundary: string;
  }[];
  readonly institutionalUnits: "unqualified";
  readonly institutionalFormatQualified: false;
  readonly postingAuthorized: false;
  readonly assessedAt: string;
  readonly integrityFingerprint: string;
};

export const medicaidChcPricingPreparation = pgTable(
  "medicaid_chc_pricing_preparation",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    preparationId: uuid("preparation_id").notNull(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    providerEntityId: uuid("provider_entity_id")
      .notNull()
      .references(() => providerEntities.id, { onDelete: "restrict" }),
    patientId: uuid("patient_id").notNull(),
    admissionId: uuid("admission_id").notNull(),
    serviceDate: date("service_date", { mode: "string" }).notNull(),
    version: integer("version").notNull(),
    ratePolicyId: uuid("rate_policy_id").notNull(),
    billingEvidenceId: uuid("billing_evidence_id").notNull(),
    assessedAt: timestamp("assessed_at", { withTimezone: true }).notNull(),
    fingerprint: text("fingerprint").notNull(),
    snapshot: jsonb("snapshot").$type<MedicaidChcPricingPreparationSnapshot>().notNull(),
    createdByMembershipId: uuid("created_by_membership_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    scopedVersion: unique("medicaid_chc_pricing_preparation_scope_version_uq").on(
      t.organizationId,
      t.providerEntityId,
      t.patientId,
      t.admissionId,
      t.serviceDate,
      t.version,
    ),
    preparationVersion: unique("medicaid_chc_pricing_preparation_id_version_uq").on(
      t.preparationId,
      t.version,
    ),
    idOrg: unique("medicaid_chc_pricing_preparation_org_id_uq").on(t.organizationId, t.id),
    scopeLookup: index("medicaid_chc_pricing_preparation_scope_ix").on(
      t.organizationId,
      t.providerEntityId,
      t.patientId,
      t.admissionId,
      t.serviceDate,
    ),
    rateLookup: index("medicaid_chc_pricing_preparation_rate_ix").on(
      t.organizationId,
      t.ratePolicyId,
    ),
    evidenceLookup: index("medicaid_chc_pricing_preparation_evidence_ix").on(
      t.organizationId,
      t.billingEvidenceId,
    ),
    versionValid: check("medicaid_chc_pricing_preparation_version_valid", sql`version > 0`),
    fingerprintValid: check(
      "medicaid_chc_pricing_preparation_fingerprint_valid",
      sql`fingerprint ~ '^[0-9a-f]{64}$'`,
    ),
    snapshotShape: check(
      "medicaid_chc_pricing_preparation_snapshot_shape",
      sql`
      jsonb_typeof(snapshot) = 'object' AND snapshot ->> 'schemaVersion' = '1' AND
      snapshot ->> 'profile' = 'home_chc_hourly_local_v1' AND
      snapshot ->> 'postingAuthorized' = 'false' AND
      snapshot ->> 'institutionalFormatQualified' = 'false' AND
      snapshot ->> 'institutionalUnits' = 'unqualified' AND
      snapshot ->> 'serviceDate' = service_date::text AND
      snapshot ->> 'preparationId' = preparation_id::text AND
      (snapshot ->> 'preparationVersion')::integer = version AND
      snapshot ->> 'organizationId' = organization_id::text AND
      snapshot ->> 'providerEntityId' = provider_entity_id::text AND
      snapshot ->> 'patientId' = patient_id::text AND snapshot ->> 'admissionId' = admission_id::text AND
      snapshot ->> 'ratePolicyId' = rate_policy_id::text AND snapshot ->> 'billingEvidenceId' = billing_evidence_id::text AND
      snapshot ->> 'integrityFingerprint' = fingerprint AND
      (snapshot ->> 'observedMinutes')::integer > 0 AND
      (snapshot ->> 'qualifiedMinutes')::integer = (snapshot ->> 'observedMinutes')::integer AND
      (snapshot ->> 'qualifiedMinutes')::integer % 60 = 0 AND
      (snapshot ->> 'qualifiedMinutes')::integer <= (snapshot ->> 'maximumClinicalMinutes')::integer AND
      ((snapshot ->> 'minimumClinicalMinutes') IS NULL OR
        (snapshot ->> 'qualifiedMinutes')::integer >= (snapshot ->> 'minimumClinicalMinutes')::integer) AND
      (snapshot ->> 'rateCentsPerHour')::integer > 0 AND
      (snapshot ->> 'billedChargeCentsPerHour')::integer > 0 AND
      (snapshot ->> 'estimatedReimbursementCents')::integer >= 0 AND
      (snapshot ->> 'billedChargeCents')::integer > 0 AND
      (snapshot ->> 'billedChargeCents')::bigint =
        (snapshot ->> 'billedChargeCentsPerHour')::bigint *
        ((snapshot ->> 'qualifiedMinutes')::bigint / 60) AND
      snapshot ->> 'codingProfile' = 'local_draft_only' AND
      snapshot ->> 'programKind' = 'managed_care' AND snapshot ->> 'serviceState' = 'OR' AND
      jsonb_typeof(snapshot -> 'programAssignment') = 'object' AND
      jsonb_typeof(snapshot -> 'payerProgramClassification') = 'object' AND
      jsonb_typeof(snapshot -> 'encounterSources') = 'array' AND jsonb_array_length(snapshot -> 'encounterSources') > 0
    `,
    ),
  }),
);

export type MedicaidChcPricingPreparation = typeof medicaidChcPricingPreparation.$inferSelect;
