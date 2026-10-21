// @chartwarden/db — M25 milestone 6a (migration 1124): the submission attempt. One row per filing made (or prepared) for an
// ADR response, an appeal / QIC request, a reopening request or a QIC escalation request. Statuses, purposes, channels
// and adapters are text + CHECK (closed sets mirrored in domain/submission.ts), so there is no new pgEnum. Exactly
// one of the three subject FKs is set (CHECK); retained proof (confirmation, receipt time, receipt document) is
// frozen once acknowledged and corrected only by appending to receipt_amendments. Free text is audit-scrubbed.
import { index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { organizations } from "../organizations";
import { adrCase } from "./adr";
import { appealCase } from "./appeal";
import { reopeningCase } from "./reopening";

export const submissionAttempt = pgTable(
  "submission_attempt",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    providerEntityId: uuid("provider_entity_id").notNull(), // logical FK -> M40/M2
    adrCaseId: uuid("adr_case_id").references(() => adrCase.id, { onDelete: "restrict" }),
    appealCaseId: uuid("appeal_case_id").references(() => appealCase.id, { onDelete: "restrict" }),
    reopeningCaseId: uuid("reopening_case_id").references(() => reopeningCase.id, {
      onDelete: "restrict",
    }),
    purpose: text("purpose").notNull(),
    attemptNo: integer("attempt_no").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    channel: text("channel"),
    adapter: text("adapter").notNull().default("manual"),
    status: text("status").notNull(),
    needsManualReason: text("needs_manual_reason"), // denylisted free text
    failureReason: text("failure_reason"), // denylisted free text
    destination: text("destination"), // denylisted (6b)
    preparedByMembershipId: uuid("prepared_by_membership_id"),
    approvedByMembershipId: uuid("approved_by_membership_id"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    confirmationRef: text("confirmation_ref"), // denylisted
    receiptAt: timestamp("receipt_at", { withTimezone: true }),
    receiptDocumentId: uuid("receipt_document_id"), // M22 logical FK
    receiptSource: text("receipt_source"),
    receiptAmendments: jsonb("receipt_amendments").notNull().default([]), // append-only, denylisted
    packetSha256: text("packet_sha256"),
    packetManifest: jsonb("packet_manifest"),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byOrg: index("submission_attempt_org_ix").on(t.organizationId, t.createdAt),
  }),
);
