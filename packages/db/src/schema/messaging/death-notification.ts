// M36 death-notification cascade (migration 1305): one row per (board, recipient_kind, recipient_ref). Ids, enums and instants only.
// Names match the migration. acked_at / updated_at are set by the database guard trigger, whatever the client sends.
import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { organizations } from "../organizations";
import { deathBoards } from "./death-board";

export const deathNotifications = pgTable(
  "death_notification",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    boardId: uuid("board_id").notNull(),
    patientId: uuid("patient_id").notNull(),
    recipientKind: text("recipient_kind").notNull(),
    recipientRef: text("recipient_ref").notNull(),
    state: text("state").notNull().default("pending"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    ackedAt: timestamp("acked_at", { withTimezone: true }),
    ackedBy: uuid("acked_by"),
    sentOutboxEventId: uuid("sent_outbox_event_id"),
    /** External funeral-home notices (migration 1306): the MDM entity, the minted M2 link and a salted hash of the recipient address (never the address). */
    funeralHomeEntityId: uuid("funeral_home_entity_id"),
    linkId: uuid("link_id"),
    recipientEmailHash: text("recipient_email_hash"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    orgIdUnique: unique("death_notification_org_id_uq").on(t.organizationId, t.id),
    boardFk: foreignKey({
      name: "death_notification_board_fk",
      columns: [t.organizationId, t.boardId],
      foreignColumns: [deathBoards.organizationId, deathBoards.id],
    }).onDelete("cascade"),
    onePerRecipient: uniqueIndex("death_notification_one_per_recipient").on(
      t.organizationId,
      t.boardId,
      t.recipientKind,
      t.recipientRef,
    ),
    byState: index("death_notification_state_idx").on(t.organizationId, t.state, t.createdAt),
    byPatient: index("death_notification_patient_idx").on(t.organizationId, t.patientId),
    kindShape: check(
      "death_notification_kind_shape",
      sql`${t.recipientKind} IN ('attending', 'medical_director', 'bereavement_coordinator', 'billing_lead', 'pharmacy_liaison', 'dme_liaison', 'funeral_home', 'pharmacy_vendor', 'dme_vendor')`,
    ),
    stateShape: check(
      "death_notification_state_shape",
      sql`${t.state} IN ('pending', 'sending', 'sent', 'acked', 'failed', 'blocked_no_baa', 'not_applicable')`,
    ),
    refShape: check("death_notification_ref_shape", sql`length(${t.recipientRef}) BETWEEN 1 AND 64`),
    ackedShape: check(
      "death_notification_acked_shape",
      sql`(${t.state} = 'acked') = (${t.ackedAt} IS NOT NULL) AND (${t.state} = 'acked') = (${t.ackedBy} IS NOT NULL)`,
    ),
  }),
);

export type DeathNotificationRow = typeof deathNotifications.$inferSelect;
