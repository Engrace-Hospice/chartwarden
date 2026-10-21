// M36 WP 5.7 (ADR-0089, PROPOSED), slice S1 - restricted messaging export (migration 1147): a scoped export job that a second person approves,
// built into one encrypted, expiring artefact, plus an insert-only download trail. Names match the migration (pinned by a test); every instant
// is set from the database clock by the guard triggers. Ids, closed codes, counts and instants, plus the reviewer-only free text
// (justification, decision_note); never a message body. wrapped_dek is the artefact's data key wrapped by the tenant key; dropped at expiry.
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
import { users } from "../users";
import { channels } from "./channels";

export const messageExportJobs = pgTable(
  "message_export_job",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    requestedBy: uuid("requested_by")
      .notNull()
      .references(() => users.id),
    /** MESSAGE_EXPORT_SCOPE_KINDS in @chartwarden/types: exactly one of channel_id / patient_id is set. */
    scopeKind: text("scope_kind").notNull(),
    channelId: uuid("channel_id"),
    /** FK-less (like channel.subject_id): the patient whose care-team / clinical-linked channels are exported. */
    patientId: uuid("patient_id"),
    dateFrom: date("date_from", { mode: "string" }),
    dateTo: date("date_to", { mode: "string" }),
    /** 20..280 characters after trimming; approver-only, never copied into events, alerts, logs or audit. */
    justification: text("justification").notNull(),
    /** MESSAGE_EXPORT_STATUSES in @chartwarden/types; moves forward only (guard trigger). */
    status: text("status").notNull().default("pending_approval"),
    requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
    /** Never the requester (CHECK). NULL while pending_approval and after a cancel. */
    decidedBy: uuid("decided_by").references(() => users.id),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    /** At most 1000 characters; approver-only. */
    decisionNote: text("decision_note"),
    buildingAt: timestamp("building_at", { withTimezone: true }),
    readyAt: timestamp("ready_at", { withTimezone: true }),
    /** ready_at + 24 hours, set by the guard on the building -> ready transition (CHECK). */
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    artefactKey: text("artefact_key"),
    artefactSha256: text("artefact_sha256"),
    artefactBytes: integer("artefact_bytes"),
    wrappedDek: text("wrapped_dek"),
    messageCount: integer("message_count"),
    heldExcluded: integer("held_excluded"),
    part2Excluded: integer("part2_excluded"),
    failureCode: text("failure_code"),
    downloadCount: integer("download_count").notNull().default(0),
  },
  (t) => ({
    orgIdUnique: unique("message_export_job_org_id_unique").on(t.organizationId, t.id),
    channelFk: foreignKey({
      name: "message_export_job_channel_fk",
      columns: [t.organizationId, t.channelId],
      foreignColumns: [channels.organizationId, channels.id],
    }).onDelete("cascade"),
    byRequester: index("message_export_job_requester_idx").on(
      t.organizationId,
      t.requestedBy,
      t.requestedAt,
    ),
    byStatus: index("message_export_job_status_idx").on(t.organizationId, t.status, t.requestedAt),
    byExpiry: index("message_export_job_expiry_idx")
      .on(t.expiresAt)
      .where(sql`${t.status} = 'ready'`),
    byChannel: index("message_export_job_channel_idx")
      .on(t.organizationId, t.channelId)
      .where(sql`${t.channelId} IS NOT NULL`),
    byRequestedBy: index("message_export_job_requested_by_idx").on(t.requestedBy),
    byDecidedBy: index("message_export_job_decided_by_idx")
      .on(t.decidedBy)
      .where(sql`${t.decidedBy} IS NOT NULL`),
    scopeKind: check(
      "message_export_job_scope_kind",
      sql`${t.scopeKind} IN ('channel', 'patient')`,
    ),
    scope: check(
      "message_export_job_scope",
      sql`(${t.scopeKind} = 'channel' AND ${t.channelId} IS NOT NULL AND ${t.patientId} IS NULL) OR (${t.scopeKind} = 'patient' AND ${t.patientId} IS NOT NULL AND ${t.channelId} IS NULL)`,
    ),
    status: check(
      "message_export_job_status",
      sql`${t.status} IN ('pending_approval', 'approved', 'rejected', 'cancelled', 'building', 'ready', 'failed', 'expired')`,
    ),
    justification: check(
      "message_export_job_justification",
      sql`char_length(btrim(${t.justification})) BETWEEN 20 AND 280`,
    ),
    rangePair: check(
      "message_export_job_range_pair",
      sql`(${t.dateFrom} IS NULL) = (${t.dateTo} IS NULL)`,
    ),
    rangeOrder: check(
      "message_export_job_range_order",
      sql`${t.dateTo} IS NULL OR ${t.dateTo} >= ${t.dateFrom}`,
    ),
    rangeMax: check(
      "message_export_job_range_max",
      sql`${t.dateTo} IS NULL OR ${t.dateTo} - ${t.dateFrom} <= 366`,
    ),
    twoPeople: check(
      "message_export_job_two_people",
      sql`${t.decidedBy} IS NULL OR ${t.decidedBy} <> ${t.requestedBy}`,
    ),
    decisionNoteLen: check(
      "message_export_job_decision_note_len",
      sql`${t.decisionNote} IS NULL OR char_length(${t.decisionNote}) <= 1000`,
    ),
    decisionState: check(
      "message_export_job_decision_state",
      sql`(${t.status} IN ('pending_approval', 'cancelled') AND ${t.decidedBy} IS NULL) OR (${t.status} NOT IN ('pending_approval', 'cancelled') AND ${t.decidedBy} IS NOT NULL)`,
    ),
    expiryPair: check(
      "message_export_job_expiry_pair",
      sql`(${t.expiresAt} IS NULL) = (${t.readyAt} IS NULL)`,
    ),
    expiry24h: check(
      "message_export_job_expiry_24h",
      sql`${t.expiresAt} IS NULL OR ${t.expiresAt} = ${t.readyAt} + interval '24 hours'`,
    ),
    counts: check(
      "message_export_job_counts",
      sql`coalesce(${t.messageCount}, 0) >= 0 AND coalesce(${t.heldExcluded}, 0) >= 0 AND coalesce(${t.part2Excluded}, 0) >= 0 AND coalesce(${t.artefactBytes}, 0) >= 0 AND ${t.downloadCount} >= 0`,
    ),
  }),
);

export const messageExportDownloads = pgTable(
  "message_export_download",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    jobId: uuid("job_id").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    downloadedAt: timestamp("downloaded_at", { withTimezone: true }).notNull().defaultNow(),
    bytes: integer("bytes"),
  },
  (t) => ({
    jobFk: foreignKey({
      name: "message_export_download_job_fk",
      columns: [t.organizationId, t.jobId],
      foreignColumns: [messageExportJobs.organizationId, messageExportJobs.id],
    }).onDelete("cascade"),
    byJob: index("message_export_download_job_idx").on(t.organizationId, t.jobId, t.downloadedAt),
    byUser: index("message_export_download_user_idx").on(t.userId),
    bytes: check("message_export_download_bytes", sql`${t.bytes} IS NULL OR ${t.bytes} >= 0`),
  }),
);

export type MessageExportJobRow = typeof messageExportJobs.$inferSelect;
export type NewMessageExportJobRow = typeof messageExportJobs.$inferInsert;
export type MessageExportDownloadRow = typeof messageExportDownloads.$inferSelect;
