// M36 WP 5.6 (ADR-0086, PROPOSED) - the append-only OVERLAY that records which messages an M4 legal hold holds (migration 1138; the
// ADR-0051 pattern). A row is "held" while its legal_hold.status = 'active'; releasing the hold is the one existing M4 UPDATE. No FK
// on legal_hold_id (M4 owns that table; the seam is the plain uuid). The message FK cascades, but a BEFORE DELETE trigger on `message`
// refuses a held row first. Ids and an instant only: no text, no patient column. Names match the migration (pinned by a test).
import { index, foreignKey, pgTable, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { organizations } from "../organizations";
import { messages } from "./messages";

export const legalHoldMessages = pgTable(
  "legal_hold_message",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    legalHoldId: uuid("legal_hold_id").notNull(),
    messageId: uuid("message_id").notNull(),
    heldAt: timestamp("held_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    messageFk: foreignKey({
      name: "legal_hold_message_message_fk",
      columns: [t.organizationId, t.messageId],
      foreignColumns: [messages.organizationId, messages.id],
    }).onDelete("cascade"),
    holdMessageUnique: unique("legal_hold_message_hold_message_unique").on(
      t.legalHoldId,
      t.messageId,
    ),
    byMessage: index("legal_hold_message_message_idx").on(t.organizationId, t.messageId),
  }),
);

export type LegalHoldMessageRow = typeof legalHoldMessages.$inferSelect;
export type NewLegalHoldMessageRow = typeof legalHoldMessages.$inferInsert;
