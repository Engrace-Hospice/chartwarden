// M40 canonical, source-backed Medicaid payer/program classifications. Records are platform-wide,
// effective-dated reference evidence; an absent or conflicting row is unresolved by design.
import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  check,
  date,
  index,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { payers } from "./payers";

export const medicaidPayerProgramClassification = pgTable(
  "mdm_medicaid_payer_program_classification",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    canonicalPayerId: uuid("canonical_payer_id")
      .notNull()
      .references(() => payers.id, { onDelete: "restrict" }),
    stateCode: text("state_code").notNull(),
    classification: text("classification").notNull(),
    effectiveFrom: date("effective_from").notNull(),
    effectiveTo: date("effective_to"),
    verificationStatus: text("verification_status").notNull().default("unverified"),
    sourceKind: text("source_kind").notNull(),
    sourceReference: text("source_reference"),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    verifiedBy: text("verified_by"),
    supersedesId: uuid("supersedes_id").references(
      (): AnyPgColumn => medicaidPayerProgramClassification.id,
      { onDelete: "restrict" },
    ),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byPayerPeriod: index("mdm_medicaid_payer_program_classification_lookup_ix").on(
      t.canonicalPayerId,
      t.stateCode,
      t.effectiveFrom,
      t.effectiveTo,
      t.verificationStatus,
    ),
    supersedes: index("mdm_medicaid_payer_program_classification_supersedes_ix").on(t.supersedesId),
    stateShape: check(
      "mdm_medicaid_payer_program_classification_state_ck",
      sql`length(${t.stateCode}) = 2`,
    ),
    classShape: check(
      "mdm_medicaid_payer_program_classification_class_ck",
      sql`${t.classification} IN ('oregon_ffs', 'medicaid_cco', 'other_managed_care', 'unsupported')`,
    ),
    oregonFfsState: check(
      "mdm_medicaid_payer_program_classification_oregon_ffs_state_ck",
      sql`${t.classification} <> 'oregon_ffs' OR ${t.stateCode} = 'OR'`,
    ),
    statusShape: check(
      "mdm_medicaid_payer_program_classification_status_ck",
      sql`${t.verificationStatus} IN ('unverified', 'verified', 'rejected', 'revoked', 'superseded')`,
    ),
    sourceShape: check(
      "mdm_medicaid_payer_program_classification_source_ck",
      sql`${t.sourceKind} IN ('state_registry', 'state_contract', 'payer_confirmation', 'other_authoritative')`,
    ),
    periodShape: check(
      "mdm_medicaid_payer_program_classification_period_ck",
      sql`${t.effectiveTo} IS NULL OR ${t.effectiveFrom} <= ${t.effectiveTo}`,
    ),
    verifiedEvidence: check(
      "mdm_medicaid_payer_program_classification_verified_evidence_ck",
      sql`${t.verificationStatus} <> 'verified' OR (${t.sourceReference} IS NOT NULL AND ${t.verifiedAt} IS NOT NULL AND ${t.verifiedBy} IS NOT NULL)`,
    ),
  }),
);

export type MedicaidPayerProgramClassification =
  typeof medicaidPayerProgramClassification.$inferSelect;
