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
import { organizations } from "../organizations";
import { providerEntities } from "../provider-entities";

/** Tenant/provider-owned evidence for a payer rate. This is not connected to claim pricing yet. */
export const medicaidPayerRatePolicy = pgTable(
  "medicaid_payer_rate_policy",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    providerEntityId: uuid("provider_entity_id")
      .notNull()
      .references(() => providerEntities.id),
    canonicalPayerId: uuid("canonical_payer_id").notNull(),
    programKind: text("program_kind").notNull(),
    serviceState: text("service_state").notNull(),
    localityCode: text("locality_code").notNull(),
    serviceCategory: text("service_category").notNull(),
    unitBasis: text("unit_basis").notNull(),
    bucketFrom: integer("bucket_from"),
    bucketTo: integer("bucket_to"),
    rateCents: integer("rate_cents").notNull(),
    chargeCeilingCents: integer("charge_ceiling_cents"),
    qualityReportingStatus: text("quality_reporting_status").notNull().default("unknown"),
    sourceKind: text("source_kind").notNull(),
    verificationStatus: text("verification_status").notNull().default("unverified"),
    effectiveFrom: date("effective_from", { mode: "string" }).notNull(),
    effectiveTo: date("effective_to", { mode: "string" }),
    sourceDocumentRef: text("source_document_ref"),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    verifiedByMembershipId: uuid("verified_by_membership_id"),
    recordedByMembershipId: uuid("recorded_by_membership_id").notNull(),
    supersedesId: uuid("supersedes_id"),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    orgIdUnique: unique("medicaid_payer_rate_policy_org_id_uq").on(t.organizationId, t.id),
    supersedesSameOrg: foreignKey({
      name: "medicaid_payer_rate_policy_supersedes_org_fk",
      columns: [t.organizationId, t.supersedesId],
      foreignColumns: [t.organizationId, t.id],
    }).onDelete("restrict"),
    identityUnique: unique("medicaid_payer_rate_policy_identity_uq")
      .on(
        t.organizationId,
        t.providerEntityId,
        t.canonicalPayerId,
        t.programKind,
        t.serviceState,
        t.localityCode,
        t.serviceCategory,
        t.unitBasis,
        t.bucketFrom,
        t.bucketTo,
        t.effectiveFrom,
      )
      .nullsNotDistinct(),
    lookup: index("medicaid_payer_rate_policy_lookup_ix").on(
      t.organizationId,
      t.providerEntityId,
      t.canonicalPayerId,
      t.serviceState,
      t.localityCode,
      t.serviceCategory,
      t.unitBasis,
      t.effectiveFrom,
      t.effectiveTo,
    ),
    programValid: check(
      "medicaid_payer_rate_policy_program_valid",
      sql`program_kind IN ('oregon_ffs', 'managed_care')`,
    ),
    stateValid: check("medicaid_payer_rate_policy_state_valid", sql`length(service_state) = 2`),
    localityValid: check(
      "medicaid_payer_rate_policy_locality_valid",
      sql`btrim(locality_code) <> ''`,
    ),
    serviceValid: check(
      "medicaid_payer_rate_policy_service_valid",
      sql`service_category IN ('RHC', 'CHC', 'IRC', 'GIP', 'IN_HOME_RESPITE')`,
    ),
    unitValid: check(
      "medicaid_payer_rate_policy_unit_valid",
      sql`unit_basis IN ('per_day', 'per_hour')`,
    ),
    bucketValid: check(
      "medicaid_payer_rate_policy_bucket_valid",
      sql`(bucket_from IS NULL AND bucket_to IS NULL) OR (bucket_from IS NOT NULL AND bucket_to IS NOT NULL AND bucket_from > 0 AND bucket_to >= bucket_from)`,
    ),
    amountValid: check(
      "medicaid_payer_rate_policy_amount_valid",
      sql`rate_cents > 0 AND (charge_ceiling_cents IS NULL OR charge_ceiling_cents > 0)`,
    ),
    qualityValid: check(
      "medicaid_payer_rate_policy_quality_valid",
      sql`quality_reporting_status IN ('unknown', 'not_applicable', 'meets', 'does_not_meet')`,
    ),
    sourceValid: check(
      "medicaid_payer_rate_policy_source_valid",
      sql`source_kind IN ('oha_ffs_schedule', 'cco_contract', 'other_payer_contract')`,
    ),
    statusValid: check(
      "medicaid_payer_rate_policy_status_valid",
      sql`verification_status IN ('unverified', 'pending', 'verified', 'rejected', 'expired', 'revoked', 'superseded')`,
    ),
    periodValid: check(
      "medicaid_payer_rate_policy_period_valid",
      sql`effective_to IS NULL OR effective_from <= effective_to`,
    ),
    versionValid: check("medicaid_payer_rate_policy_version_valid", sql`version > 0`),
    verifiedProvenance: check(
      "medicaid_payer_rate_policy_verified_provenance",
      sql`verification_status <> 'verified' OR (source_document_ref IS NOT NULL AND verified_at IS NOT NULL AND verified_by_membership_id IS NOT NULL AND verified_by_membership_id <> recorded_by_membership_id)`,
    ),
    documentRefShape: check(
      "medicaid_payer_rate_policy_document_ref_shape",
      sql`source_document_ref IS NULL OR source_document_ref ~ '^doc:[A-Za-z0-9._/-]{1,190}$'`,
    ),
    ffsScope: check(
      "medicaid_payer_rate_policy_ffs_scope",
      sql`source_kind <> 'oha_ffs_schedule' OR program_kind = 'oregon_ffs'`,
    ),
    contractScope: check(
      "medicaid_payer_rate_policy_contract_scope",
      sql`source_kind = 'oha_ffs_schedule' OR program_kind = 'managed_care'`,
    ),
  }),
);

export type MedicaidPayerRatePolicy = typeof medicaidPayerRatePolicy.$inferSelect;
