// M36 PR4 — structured mentions and patient references. Text remains encrypted on `message`;
// this table stores only the authoritative entity pointer and UTF-16 code-unit range.
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
import { messages } from "./messages";

export const messageEntityReferences = pgTable(
  "message_entity_reference",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    messageId: uuid("message_id").notNull(),
    referenceKind: text("reference_kind").notNull(),
    entityId: uuid("entity_id").notNull(),
    startOffset: integer("start_offset").notNull(),
    endOffset: integer("end_offset").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byMessage: index("message_entity_reference_message_idx").on(t.organizationId, t.messageId),
    byEntity: index("message_entity_reference_entity_idx").on(
      t.organizationId,
      t.referenceKind,
      t.entityId,
      t.createdAt,
    ),
    uniqueRange: unique("message_entity_reference_unique_range").on(
      t.organizationId,
      t.messageId,
      t.referenceKind,
      t.entityId,
      t.startOffset,
      t.endOffset,
    ),
    messageOrgFk: foreignKey({
      name: "message_entity_reference_message_org_fk",
      columns: [t.organizationId, t.messageId],
      foreignColumns: [messages.organizationId, messages.id],
    }).onDelete("cascade"),
    kindShape: check(
      "message_entity_reference_kind_shape",
      sql`${t.referenceKind} IN ('staff', 'patient')`,
    ),
    rangeShape: check(
      "message_entity_reference_range_shape",
      sql`${t.startOffset} >= 0 AND ${t.endOffset} > ${t.startOffset}`,
    ),
  }),
);

export type MessageEntityReference = typeof messageEntityReferences.$inferSelect;
export type NewMessageEntityReference = typeof messageEntityReferences.$inferInsert;
