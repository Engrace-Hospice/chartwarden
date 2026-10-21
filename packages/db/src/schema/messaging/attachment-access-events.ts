// @chartwarden/db — `attachment_access_event` (M36 WP 1.5). Append-only: one row per attempt to open a message
// attachment, `open` (a signed URL was issued) or `denied` (an entitled reader was refused, with a reason code).
// The app role has SELECT + INSERT only (1075). Ids and a reason code only: no filename, no URL, no PHI.
import { foreignKey, index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { organizations } from "../organizations";
import { users } from "../users";
import { messageAttachments } from "./message-attachments";

export const ATTACHMENT_ACCESS_ACTIONS = ["open", "denied"] as const;
export type AttachmentAccessAction = (typeof ATTACHMENT_ACCESS_ACTIONS)[number];

export const attachmentAccessEvents = pgTable(
  "attachment_access_event",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    attachmentId: uuid("attachment_id").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    action: text("action").$type<AttachmentAccessAction>().notNull(),
    reason: text("reason"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    attachmentOrgFk: foreignKey({
      name: "attachment_access_event_attachment_org_fk",
      columns: [t.organizationId, t.attachmentId],
      foreignColumns: [messageAttachments.organizationId, messageAttachments.id],
    }).onDelete("cascade"),
    byAttachmentIdx: index("attachment_access_event_org_attachment_idx").on(
      t.organizationId,
      t.attachmentId,
      t.occurredAt,
    ),
    byUserIdx: index("attachment_access_event_user_idx").on(t.userId),
  }),
);

export type AttachmentAccessEvent = typeof attachmentAccessEvents.$inferSelect;
export type NewAttachmentAccessEvent = typeof attachmentAccessEvents.$inferInsert;
