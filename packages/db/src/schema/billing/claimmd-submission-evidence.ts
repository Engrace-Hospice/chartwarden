import {
  bigint,
  foreignKey,
  integer,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { organizations } from "../organizations";

/** Immutable per-Claim.MD claim attempt facts extracted from the exact outbound X12. */
export const claimmdSubmissionEvidence = pgTable(
  "claimmd_submission_evidence",
  {
    id: uuid("id").primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    providerEntityId: uuid("provider_entity_id").notNull(),
    locationId: uuid("location_id"),
    claimId: uuid("claim_id").notNull(),
    billingModule: text("billing_module").$type<"M23" | "M41">().notNull(),
    submissionId: uuid("submission_id").notNull(),
    attemptKey: text("attempt_key").notNull(),
    vendor: text("vendor").notNull().default("claimmd"),
    accountReference: text("account_reference").notNull(),
    usage: text("usage").$type<"test" | "production">().notNull(),
    billingNpi: text("billing_npi").notNull(),
    billingTinCiphertext: text("billing_tin_ciphertext").notNull(),
    payerId: text("payer_id").notNull(),
    claimType: text("claim_type").notNull(),
    pcn: text("pcn").notNull(),
    isa13: text("isa13").notNull(),
    gs06: text("gs06").notNull(),
    st02: text("st02").notNull(),
    serviceFrom: text("service_from"),
    serviceTo: text("service_to"),
    payloadSha256: text("payload_sha256").notNull(),
    payloadFormat: text("payload_format").notNull().default("x12"),
    outboundReference: text("outbound_reference").notNull(),
    reservedAt: timestamp("reserved_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("claimmd_submission_evidence_attempt_uq").on(
      t.organizationId,
      t.billingModule,
      t.attemptKey,
    ),
    uniqueIndex("claimmd_submission_evidence_identity_uq").on(
      t.id,
      t.organizationId,
      t.accountReference,
      t.usage,
    ),
    index("claimmd_submission_evidence_external_ix").on(t.accountReference, t.usage, t.pcn),
    index("claimmd_submission_evidence_claim_ix").on(t.organizationId, t.claimId, t.createdAt),
  ],
);

/** Attempt-specific facts for source claim lines, projected from the immutable outbound payload. */
export const claimmdSubmissionLineEvidence = pgTable(
  "claimmd_submission_line_evidence",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    evidenceId: uuid("evidence_id").notNull(),
    organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "restrict" }),
    providerEntityId: uuid("provider_entity_id").notNull(),
    claimId: uuid("claim_id").notNull(),
    submissionId: uuid("submission_id").notNull(),
    attemptKey: text("attempt_key").notNull(),
    internalClaimLineId: uuid("internal_claim_line_id").notNull(),
    linePosition: integer("line_position").notNull(),
    lineItemControlNumber: text("line_item_control_number"),
    revenueCode: text("revenue_code"),
    procedureCode: text("procedure_code"),
    serviceFrom: text("service_from"),
    serviceTo: text("service_to"),
    units: text("units"),
    chargeCents: bigint("charge_cents", { mode: "number" }),
    payloadSha256: text("payload_sha256").notNull(),
    accountReference: text("account_reference").notNull(),
    usage: text("usage").$type<"test" | "production">().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("claimmd_submission_line_evidence_pos_uq").on(t.evidenceId, t.linePosition),
    uniqueIndex("claimmd_submission_line_evidence_ref_uq").on(t.evidenceId, t.lineItemControlNumber),
    foreignKey({
      columns: [t.evidenceId, t.organizationId, t.accountReference, t.usage],
      foreignColumns: [claimmdSubmissionEvidence.id, claimmdSubmissionEvidence.organizationId, claimmdSubmissionEvidence.accountReference, claimmdSubmissionEvidence.usage],
      name: "claimmd_submission_line_evidence_scope_fk",
    }).onDelete("restrict"),
    index("claimmd_submission_line_evidence_claim_ix").on(t.organizationId, t.claimId, t.submissionId),
  ],
);

export const claimmdSubmissionReceiptObservations = pgTable(
  "claimmd_submission_receipt_observation",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    evidenceId: uuid("evidence_id").notNull(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    accountReference: text("account_reference").notNull(),
    usage: text("usage").$type<"test" | "production">().notNull(),
    vendor: text("vendor").notNull().default("claimmd"),
    sourceField: text("source_field").notNull(),
    identifierNamespace: text("identifier_namespace").notNull(),
    externalValue: text("external_value").notNull(),
    observationSource: text("observation_source").notNull(),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
    sourceReference: text("source_reference").notNull(),
  },
  (t) => [
    uniqueIndex("claimmd_receipt_observation_replay_uq").on(
      t.evidenceId,
      t.sourceField,
      t.externalValue,
      t.observationSource,
    ),
    index("claimmd_receipt_observation_external_ix").on(
      t.accountReference,
      t.usage,
      t.identifierNamespace,
      t.externalValue,
    ),
    index("claimmd_receipt_evidence_scope_ix").on(
      t.evidenceId,
      t.organizationId,
      t.accountReference,
      t.usage,
    ),
    foreignKey({
      columns: [t.evidenceId, t.organizationId, t.accountReference, t.usage],
      foreignColumns: [
        claimmdSubmissionEvidence.id,
        claimmdSubmissionEvidence.organizationId,
        claimmdSubmissionEvidence.accountReference,
        claimmdSubmissionEvidence.usage,
      ],
      name: "claimmd_receipt_evidence_scope_fk",
    }).onDelete("restrict"),
  ],
);
