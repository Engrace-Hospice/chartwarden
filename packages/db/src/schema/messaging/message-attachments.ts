// @chartwarden/db — `message_attachment` (M36 Secure Messaging §3.4, WP 1.5). A file hung off a message.
//
// Lifecycle: authorize (row created, `completed_at` NULL, `message_id` NULL) -> complete (object verified in the
// tenant's M22 object store) -> scan (`scan_state` pending -> clean | quarantined, final) -> bound to a message on
// send. Nothing is delivered unless `scan_state = 'clean'`. Tenancy is organization_id + composite FKs (1075); the
// parent-join policy of 0017 is gone. `document_ref` is legacy and unused: the bytes live in the tenant bucket under
// an opaque `object_key`, and no M22 `document` row is created for a chat attachment.
import { sql } from "drizzle-orm";
import {
  check,
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
import { messages } from "./messages";

/** The verdicts `scan_state` may hold (mirrored by the CHECK in 1075). */
export const ATTACHMENT_SCAN_STATES = ["pending", "clean", "quarantined"] as const;
export type AttachmentScanState = (typeof ATTACHMENT_SCAN_STATES)[number];

export const messageAttachments = pgTable(
  "message_attachment",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    channelId: uuid("channel_id").notNull(),
    /** NULL until the attachment is bound to a message by a send. */
    messageId: uuid("message_id"),
    uploadedBy: uuid("uploaded_by").references(() => users.id),
    documentRef: uuid("document_ref"), // legacy; unused since 1075
    mimeType: text("mime_type").notNull(),
    byteSize: integer("byte_size").notNull(),
    filename: text("filename").notNull(),
    objectKey: text("object_key"),
    sha256Hex: text("sha256_hex"),
    scanState: text("scan_state").$type<AttachmentScanState>().notNull().default("pending"),
    scannedAt: timestamp("scanned_at", { withTimezone: true }),
    scanSignature: text("scan_signature"),
    uploadExpiresAt: timestamp("upload_expires_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    /** Scan-sweep bookkeeping: failed attempts so far and when the last one ran (least-recently-attempted first). */
    scanAttempts: integer("scan_attempts").notNull().default(0),
    lastScanAttemptAt: timestamp("last_scan_attempt_at", { withTimezone: true }),
    /** Consecutive "object not found" reads (reset by a successful read) and when the run began. */
    objectMissingCount: integer("object_missing_count").notNull().default(0),
    firstObjectMissingAt: timestamp("first_object_missing_at", { withTimezone: true }),
    /** Set (by the destruction credential only, migration 1077) once the retention reaper has destroyed the object. */
    objectDestroyedAt: timestamp("object_destroyed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    orgIdIdUnique: unique("message_attachment_org_id_id_unique").on(t.organizationId, t.id),
    messageOrgFk: foreignKey({
      name: "message_attachment_message_org_fk",
      columns: [t.organizationId, t.messageId],
      foreignColumns: [messages.organizationId, messages.id],
    }).onDelete("cascade"),
    channelOrgFk: foreignKey({
      name: "message_attachment_channel_org_fk",
      columns: [t.organizationId, t.channelId],
      foreignColumns: [channels.organizationId, channels.id],
    }).onDelete("cascade"),
    scanStateValid: check(
      "message_attachment_scan_state_valid",
      sql`${t.scanState} IN ('pending', 'clean', 'quarantined')`,
    ),
    byMessageIdx: index("message_attachment_message_idx").on(t.messageId),
    byOrgMessageIdx: index("message_attachment_org_message_idx")
      .on(t.organizationId, t.messageId)
      .where(sql`message_id IS NOT NULL`),
    byOrgChannelIdx: index("message_attachment_org_channel_idx").on(t.organizationId, t.channelId),
    byUploaderIdx: index("message_attachment_uploaded_by_idx").on(t.uploadedBy),
    unboundIdx: index("message_attachment_unbound_idx")
      .on(t.organizationId, t.createdAt)
      .where(sql`message_id IS NULL`),
    scanPendingIdx: index("message_attachment_scan_pending_idx")
      .on(sql`${t.lastScanAttemptAt} NULLS FIRST`, t.completedAt)
      .where(sql`scan_state = 'pending' AND completed_at IS NOT NULL`),
  }),
);

export type MessageAttachment = typeof messageAttachments.$inferSelect;
export type NewMessageAttachment = typeof messageAttachments.$inferInsert;
