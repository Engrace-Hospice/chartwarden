// @chartwarden/db — M24 Billing — Medicaid §3.3 — per-attempt submission records + the 999/277CA-equivalent
// acknowledgment rows. Both NON-partitioned (not in the §3.2 partition set). Simple PK (id).
//
// CROSS-MODULE FK POLICY: organization_id / provider_entity_id (M1 core) get real FKs; medicaid_submission_id
// → medicaid_submission (intra-M24, non-partitioned) is a real FK on the ack. medicaid_claim_id is LOGICAL
// (medicaid_claim is partitioned). vendor_payload_cipher / raw_payload_cipher are KMS-wrapped (audit-denylisted §3.6).
import {
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
import { m24AcknowledgmentKind, m24AcknowledgmentOutcome, m24SubmissionResult } from "./enums";

export const medicaidSubmission = pgTable(
  "medicaid_submission",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    medicaidClaimId: uuid("medicaid_claim_id").notNull(), // logical FK → medicaid_claim (partitioned)
    providerEntityId: uuid("provider_entity_id")
      .notNull()
      .references(() => providerEntities.id, { onDelete: "restrict" }),

    serviceState: varchar("service_state", { length: 2 }).notNull(),
    channel: varchar("channel", { length: 32 }).notNull(),
    mcoIdSnapshot: uuid("mco_id_snapshot"), // null = FFS

    medicaidClaimControlNumber: varchar("medicaid_claim_control_number", { length: 32 }).notNull(),
    attemptIndex: integer("attempt_index").notNull().default(0),

    adapterVendor: varchar("adapter_vendor", { length: 64 }).notNull(),
    adapterVersion: varchar("adapter_version", { length: 16 }).notNull(),

    result: m24SubmissionResult("result").notNull().default("pending"),
    vendorTransactionId: varchar("vendor_transaction_id", { length: 64 }),
    vendorPayloadCipher: text("vendor_payload_cipher"), // KMS-wrapped (denylisted)
    vendorPayloadHash: varchar("vendor_payload_hash", { length: 64 }),
    errorMessage: text("error_message"),
    errorCode: varchar("error_code", { length: 64 }),
    nextPollAt: timestamp("next_poll_at", { withTimezone: true }),

    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    terminalAt: timestamp("terminal_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdByMembershipId: uuid("created_by_membership_id"), // null on retry-worker
  },
  (t) => ({
    uniqueAttempt: index("medicaid_submission_unique_attempt").on(
      t.providerEntityId,
      t.serviceState,
      t.medicaidClaimControlNumber,
      t.attemptIndex,
    ),
    byClaimCreated: index("medicaid_submission_by_claim_created").on(
      t.medicaidClaimId,
      t.createdAt,
    ),
    byNextPoll: index("medicaid_submission_by_next_poll").on(t.nextPollAt),
  }),
);

export const medicaidAcknowledgment = pgTable(
  "medicaid_acknowledgment",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    medicaidClaimId: uuid("medicaid_claim_id").notNull(), // logical FK → medicaid_claim (partitioned)
    medicaidSubmissionId: uuid("medicaid_submission_id")
      .notNull()
      .references(() => medicaidSubmission.id, { onDelete: "restrict" }),

    kind: m24AcknowledgmentKind("kind").notNull(),
    outcome: m24AcknowledgmentOutcome("outcome").notNull(),
    payerClaimControlNumber: varchar("payer_claim_control_number", { length: 32 }),
    acceptedLineNumbers: jsonb("accepted_line_numbers"),
    rejectedLineNumbers: jsonb("rejected_line_numbers"),
    errorCodes: jsonb("error_codes"),

    rawPayloadCipher: text("raw_payload_cipher"), // KMS-wrapped (denylisted)
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    bySubmissionReceived: index("medicaid_acknowledgment_by_submission_received").on(
      t.medicaidSubmissionId,
      t.receivedAt,
    ),
    byClaimReceived: index("medicaid_acknowledgment_by_claim_received").on(
      t.medicaidClaimId,
      t.receivedAt,
    ),
  }),
);
