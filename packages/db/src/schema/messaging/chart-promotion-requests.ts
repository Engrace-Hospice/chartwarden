// M36 WP 3.7 - chart promotion: a thin request that a secure message belongs in the chart (ADR-0063). Ids, enums, instants
// and a SHA-256 of the body at request time; no text. message_id, channel_id and patient_id are logical pointers (no FK, like
// clinical_link), so nothing cascades from a message or a patient. The CHECK/index names match migration 1102 (pinned by a
// test). The patient id and the body hash are scrubbed from the audit log by the bespoke trigger.
import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { organizations } from "../organizations";

export const chartPromotionRequests = pgTable(
  "chart_promotion_request",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    messageId: uuid("message_id").notNull(),
    channelId: uuid("channel_id").notNull(),
    /** Logical pointer; scrubbed from the audit log. */
    patientId: uuid("patient_id").notNull(),
    targetModule: text("target_module").notNull(),
    targetKind: text("target_kind").notNull(),
    /** m14 only: a suggested idg_meeting id (WP 3.6). */
    suggestedTargetRef: uuid("suggested_target_ref"),
    status: text("status").notNull().default("proposed"),
    requestedByUserId: uuid("requested_by_user_id").notNull(),
    requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
    sourceAuthorUserId: uuid("source_author_user_id").notNull(),
    sourceSentAt: timestamp("source_sent_at", { withTimezone: true }).notNull(),
    /** SHA-256 of the message body at request time; scrubbed from the audit log. */
    sourceBodySha256: text("source_body_sha256").notNull(),
    /** Set ONLY by the outcome consumer: the addendum or agenda item the owning module created. */
    resultRef: uuid("result_ref"),
    decidedByUserId: uuid("decided_by_user_id"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    reasonCode: text("reason_code"),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    version: integer("version").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    orgIdUnique: unique("chart_promotion_request_org_id_uq").on(t.organizationId, t.id),
    oneProposed: uniqueIndex("chart_promotion_request_one_proposed")
      .on(t.organizationId, t.messageId, t.targetModule, t.targetKind)
      .where(sql`${t.status} = 'proposed'`),
    byMessage: index("chart_promotion_request_message_idx").on(t.organizationId, t.messageId),
    byPatient: index("chart_promotion_request_patient_idx").on(
      t.organizationId,
      t.patientId,
      t.targetModule,
      t.status,
    ),
    byRequester: index("chart_promotion_request_requester_idx").on(
      t.organizationId,
      t.requestedByUserId,
      t.status,
    ),
    target: check(
      "chart_promotion_request_target",
      sql`(${t.targetModule}, ${t.targetKind}) IN (('m8', 'encounter_addendum'), ('m14', 'idg_agenda_item'))`,
    ),
    suggestedRef: check(
      "chart_promotion_request_suggested_ref",
      sql`${t.suggestedTargetRef} IS NULL OR ${t.targetModule} = 'm14'`,
    ),
    statusShape: check(
      "chart_promotion_request_status_shape",
      sql`${t.status} IN ('proposed', 'accepted', 'rejected', 'superseded', 'withdrawn')`,
    ),
    shaShape: check(
      "chart_promotion_request_sha_shape",
      sql`${t.sourceBodySha256} ~ '^[0-9a-f]{64}$'`,
    ),
    acceptedShape: check(
      "chart_promotion_request_accepted_shape",
      sql`(${t.status} = 'accepted') = (${t.resultRef} IS NOT NULL)`,
    ),
    decidedShape: check(
      "chart_promotion_request_decided_shape",
      sql`(${t.status} IN ('accepted', 'rejected')) = (${t.decidedByUserId} IS NOT NULL AND ${t.decidedAt} IS NOT NULL)`,
    ),
    closedShape: check(
      "chart_promotion_request_closed_shape",
      sql`(${t.status} = 'proposed') = (${t.closedAt} IS NULL)`,
    ),
    reasonShape: check(
      "chart_promotion_request_reason_shape",
      sql`${t.reasonCode} IS NULL OR ${t.reasonCode} IN ('not_clinically_relevant', 'already_documented', 'duplicate', 'wrong_patient', 'other', 'requester', 'superseded')`,
    ),
    reasonByStatus: check(
      "chart_promotion_request_reason_by_status",
      sql`CASE ${t.status} WHEN 'proposed' THEN ${t.reasonCode} IS NULL WHEN 'accepted' THEN ${t.reasonCode} IS NULL WHEN 'superseded' THEN ${t.reasonCode} = 'superseded' WHEN 'withdrawn' THEN ${t.reasonCode} = 'requester' ELSE ${t.reasonCode} IS NOT NULL AND ${t.reasonCode} NOT IN ('requester', 'superseded') END`,
    ),
  }),
);

export type ChartPromotionRequestRow = typeof chartPromotionRequests.$inferSelect;
