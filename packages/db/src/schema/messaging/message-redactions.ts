// M36 WP 5.6 (ADR-0055 item 7 / ADR-0086, PROPOSED) - a redaction MASKS one message at the access layer (migration 1156). Two people: the
// requester and the approver differ (CHECK + guard trigger). The row never changes the message: cipher, hash and status stay, so a legal
// hold neither blocks a redaction nor is weakened by it. The reason is free text (10..1000 characters) and is kept out of the audit row.
// The only UPDATE is the approval (approved_by, approved_at), once. Names match the migration (pinned by a test).
import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { organizations } from "../organizations";
import { users } from "../users";
import { messages } from "./messages";

export const messageRedactions = pgTable(
  "message_redaction",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    messageId: uuid("message_id").notNull(),
    requestedBy: uuid("requested_by")
      .notNull()
      .references(() => users.id),
    reason: text("reason").notNull(),
    requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
    approvedBy: uuid("approved_by").references(() => users.id),
    // approved_at = FINAL (the mask applies from here). Migration 1165 (single-officer fallback, PROVISIONAL): a requester may approve their own
    // request when they are the tenant's only eligible officer; that sets self_approved_at and a 72 h deadline, masks nothing, and becomes
    // final only when a second role countersigns (then approved_by = requested_by and countersigned_by/at are set).
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    selfApprovedAt: timestamp("self_approved_at", { withTimezone: true }),
    countersignDeadlineAt: timestamp("countersign_deadline_at", { withTimezone: true }),
    countersignedBy: uuid("countersigned_by").references(() => users.id),
    countersignedAt: timestamp("countersigned_at", { withTimezone: true }),
  },
  (t) => ({
    messageFk: foreignKey({
      name: "message_redaction_message_fk",
      columns: [t.organizationId, t.messageId],
      foreignColumns: [messages.organizationId, messages.id],
    }).onDelete("cascade"),
    onePerMessage: unique("message_redaction_one_per_message").on(t.organizationId, t.messageId),
    byRequestedBy: index("message_redaction_requested_by_idx").on(t.requestedBy),
    byApprovedBy: index("message_redaction_approved_by_idx")
      .on(t.approvedBy)
      .where(sql`${t.approvedBy} IS NOT NULL`),
    byOrgRequested: index("message_redaction_org_requested_idx").on(
      t.organizationId,
      t.requestedAt,
    ),
    reasonLen: check(
      "message_redaction_reason_len",
      sql`char_length(btrim(${t.reason})) BETWEEN 10 AND 1000`,
    ),
    approvalPair: check(
      "message_redaction_approval_pair",
      sql`(${t.approvedBy} IS NULL) = (${t.approvedAt} IS NULL)`,
    ),
    twoPeople: check(
      "message_redaction_two_people",
      sql`${t.approvedBy} IS NULL OR ${t.approvedBy} <> ${t.requestedBy} OR ${t.selfApprovedAt} IS NOT NULL`,
    ),
    selfApprovalPair: check(
      "message_redaction_self_approval_pair",
      sql`(${t.selfApprovedAt} IS NULL) = (${t.countersignDeadlineAt} IS NULL)`,
    ),
    countersignPair: check(
      "message_redaction_countersign_pair",
      sql`(${t.countersignedBy} IS NULL) = (${t.countersignedAt} IS NULL)`,
    ),
    countersignNeedsSelfApproval: check(
      "message_redaction_countersign_needs_self_approval",
      sql`${t.countersignedBy} IS NULL OR ${t.selfApprovedAt} IS NOT NULL`,
    ),
    countersignerIsAnother: check(
      "message_redaction_countersigner_is_another",
      sql`${t.countersignedBy} IS NULL OR ${t.countersignedBy} <> ${t.requestedBy}`,
    ),
    selfFinalNeedsCountersign: check(
      "message_redaction_self_final_needs_countersign",
      sql`${t.approvedBy} IS NULL OR ${t.approvedBy} <> ${t.requestedBy} OR ${t.countersignedBy} IS NOT NULL`,
    ),
    byCountersignedBy: index("message_redaction_countersigned_by_idx")
      .on(t.countersignedBy)
      .where(sql`${t.countersignedBy} IS NOT NULL`),
  }),
);

export type MessageRedactionRow = typeof messageRedactions.$inferSelect;
export type NewMessageRedactionRow = typeof messageRedactions.$inferInsert;
