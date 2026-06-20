// @wardenx/db — `message_attachment` (M36 Secure Messaging §3.4). A document reference hung
// off a message. It carries NO organization_id by design — it is a pure child of `message`
// (ON DELETE cascade) and inherits tenancy through that parent FK, so it is opted out of the
// three-column rule via the check-tenancy NON_ORG_SCOPED allowlist (a reviewed change). RLS
// is applied via the parent-join in M36-T03. `document_ref` is an app-side FK to an M22
// document (M22 not built at Phase-1 start, so no DB constraint).
import { index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { messages } from "./messages";

export const messageAttachments = pgTable(
  "message_attachment",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    messageId: uuid("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    documentRef: uuid("document_ref").notNull(), // M22 doc id (FK app-side)
    mimeType: text("mime_type").notNull(),
    byteSize: integer("byte_size").notNull(),
    filename: text("filename").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byMessageIdx: index("message_attachment_message_idx").on(t.messageId),
  }),
);

export type MessageAttachment = typeof messageAttachments.$inferSelect;
export type NewMessageAttachment = typeof messageAttachments.$inferInsert;
