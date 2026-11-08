import {
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { organizations } from "../organizations";

/** Typed, immutable send-time evidence for notice attempts. Notice UUIDs are never stored as claim IDs/PCNs. */
export const claimmdNoticeSubmissionEvidence = pgTable(
  "claimmd_notice_submission_evidence",
  {
    id: uuid("id").primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    providerEntityId: uuid("provider_entity_id").notNull(),
    locationId: uuid("location_id"),
    noticeId: uuid("notice_id").notNull(),
    noticeKind: text("notice_kind").$type<"noe" | "notr" | "transfer_notice">().notNull(),
    submissionId: uuid("submission_id").notNull(),
    attemptIndex: integer("attempt_index").notNull(),
    vendor: text("vendor").notNull().default("claimmd"),
    accountReference: text("account_reference").notNull(),
    usage: text("usage").$type<"test" | "production">().notNull(),
    billingNpi: text("billing_npi").notNull(),
    billingTinCiphertext: text("billing_tin_ciphertext").notNull(),
    payerId: text("payer_id").notNull(),
    interchangeSenderId: text("interchange_sender_id").notNull(),
    interchangeReceiverId: text("interchange_receiver_id").notNull(),
    functionalSenderId: text("functional_sender_id").notNull(),
    functionalReceiverId: text("functional_receiver_id").notNull(),
    transactionSet: text("transaction_set").notNull(),
    noticeControlNumber: text("notice_control_number").notNull(),
    outboundBusinessControlNumber: text("outbound_business_control_number"),
    isa13: text("isa13").notNull(),
    gs06: text("gs06").notNull(),
    st02: text("st02").notNull(),
    payloadSha256: text("payload_sha256").notNull(),
    outboundReference: text("outbound_reference").notNull(),
    reservedAt: timestamp("reserved_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("claimmd_notice_evidence_attempt_uq").on(t.organizationId, t.submissionId),
    uniqueIndex("claimmd_notice_evidence_identity_uq").on(
      t.id,
      t.organizationId,
      t.accountReference,
      t.usage,
    ),
    index("claimmd_notice_evidence_notice_ix").on(
      t.organizationId,
      t.noticeKind,
      t.noticeId,
      t.createdAt,
    ),
    index("claimmd_notice_evidence_external_ix").on(
      t.accountReference,
      t.usage,
      t.isa13,
      t.gs06,
      t.st02,
    ),
  ],
);

export const claimmdNoticeReceiptObservations = pgTable(
  "claimmd_notice_receipt_observation",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    evidenceId: uuid("evidence_id").notNull(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    accountReference: text("account_reference").notNull(),
    usage: text("usage").$type<"test" | "production">().notNull(),
    sourceField: text("source_field").notNull(),
    identifierNamespace: text("identifier_namespace").notNull(),
    externalValue: text("external_value").notNull(),
    observationSource: text("observation_source").notNull(),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
    sourceReference: text("source_reference").notNull(),
  },
  (t) => [
    uniqueIndex("claimmd_notice_receipt_replay_uq").on(
      t.evidenceId,
      t.sourceField,
      t.externalValue,
      t.observationSource,
    ),
    index("claimmd_notice_receipt_external_ix").on(
      t.accountReference,
      t.usage,
      t.identifierNamespace,
      t.externalValue,
    ),
    foreignKey({
      columns: [t.evidenceId, t.organizationId, t.accountReference, t.usage],
      foreignColumns: [
        claimmdNoticeSubmissionEvidence.id,
        claimmdNoticeSubmissionEvidence.organizationId,
        claimmdNoticeSubmissionEvidence.accountReference,
        claimmdNoticeSubmissionEvidence.usage,
      ],
      name: "claimmd_notice_receipt_scope_fk",
    }).onDelete("restrict"),
  ],
);
