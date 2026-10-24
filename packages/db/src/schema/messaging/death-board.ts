// M36 WP 6.9 (ADR-0098) - the death-event coordination board (migration 1201): one board per deceased patient, a fixed checklist of
// items each with ONE owner, and an append-only event history. Ids, enums and instants only. Names match the migration (pinned by a test);
// completed_at / updated_at are set by the database guard trigger, whatever the client sends.
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
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

export const deathBoards = pgTable(
  "death_board",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    patientId: uuid("patient_id").notNull(),
    templateVersion: integer("template_version").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    orgIdUnique: unique("death_board_org_id_uq").on(t.organizationId, t.id),
    onePerPatient: uniqueIndex("death_board_one_per_patient").on(t.organizationId, t.patientId),
    recent: index("death_board_recent_idx").on(t.organizationId, t.createdAt),
    templateVersion: check("death_board_template_version", sql`${t.templateVersion} >= 1`),
  }),
);

export const deathBoardItems = pgTable(
  "death_board_item",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    boardId: uuid("board_id").notNull(),
    patientId: uuid("patient_id").notNull(),
    itemKey: text("item_key").notNull(),
    ownerUserId: uuid("owner_user_id").notNull(),
    status: text("status").notNull().default("open"),
    needsOwner: boolean("needs_owner").notNull().default(false),
    dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    completedByUserId: uuid("completed_by_user_id"),
    version: integer("version").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    orgIdUnique: unique("death_board_item_org_id_uq").on(t.organizationId, t.id),
    boardFk: foreignKey({
      name: "death_board_item_board_fk",
      columns: [t.organizationId, t.boardId],
      foreignColumns: [deathBoards.organizationId, deathBoards.id],
    }).onDelete("cascade"),
    onePerKey: uniqueIndex("death_board_item_one_per_key").on(
      t.organizationId,
      t.boardId,
      t.itemKey,
    ),
    byBoard: index("death_board_item_board_idx").on(t.organizationId, t.boardId),
    byPatient: index("death_board_item_patient_idx").on(t.organizationId, t.patientId),
    byOwner: index("death_board_item_owner_idx").on(t.organizationId, t.ownerUserId, t.status),
    keyShape: check(
      "death_board_item_key_shape",
      sql`${t.itemKey} IN ('pronouncement', 'family_notification', 'dme_pickup', 'medication_disposal', 'm4_record_tasks', 'm22_document_tasks')`,
    ),
    statusShape: check("death_board_item_status_shape", sql`${t.status} IN ('open', 'done')`),
    doneShape: check(
      "death_board_item_done_shape",
      sql`(${t.status} = 'done') = (${t.completedAt} IS NOT NULL) AND (${t.status} = 'done') = (${t.completedByUserId} IS NOT NULL)`,
    ),
    doneUnflagged: check(
      "death_board_item_done_unflagged",
      sql`${t.status} = 'open' OR NOT ${t.needsOwner}`,
    ),
    completedByOwner: check(
      "death_board_item_completed_by_owner",
      sql`${t.completedByUserId} IS NULL OR ${t.completedByUserId} = ${t.ownerUserId}`,
    ),
  }),
);

export const deathBoardItemEvents = pgTable(
  "death_board_item_event",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    itemId: uuid("item_id").notNull(),
    eventType: text("event_type").notNull(),
    actorKind: text("actor_kind").notNull(),
    /** Null for the system actor (the consumer, the offboarding sweep). */
    actorUserId: uuid("actor_user_id"),
    fromOwnerUserId: uuid("from_owner_user_id"),
    toOwnerUserId: uuid("to_owner_user_id"),
    reasonCode: text("reason_code"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    itemFk: foreignKey({
      name: "death_board_item_event_item_fk",
      columns: [t.organizationId, t.itemId],
      foreignColumns: [deathBoardItems.organizationId, deathBoardItems.id],
    }).onDelete("cascade"),
    byItem: index("death_board_item_event_item_idx").on(t.organizationId, t.itemId, t.createdAt),
    byActor: index("death_board_item_event_actor_idx")
      .on(t.organizationId, t.actorUserId)
      .where(sql`${t.actorUserId} IS NOT NULL`),
    typeShape: check(
      "death_board_item_event_type_shape",
      sql`${t.eventType} IN ('created', 'reassigned', 'completed', 'needs_owner')`,
    ),
    actorShape: check(
      "death_board_item_event_actor_shape",
      sql`${t.actorKind} IN ('user', 'system') AND ((${t.actorKind} = 'system') = (${t.actorUserId} IS NULL))`,
    ),
    reasonShape: check(
      "death_board_item_event_reason_shape",
      sql`${t.reasonCode} IS NULL OR ${t.reasonCode} IN ('creation', 'manual', 'supervisor', 'offboarding')`,
    ),
  }),
);

export type DeathBoardRow = typeof deathBoards.$inferSelect;
export type DeathBoardItemRow = typeof deathBoardItems.$inferSelect;
export type DeathBoardItemEventRow = typeof deathBoardItemEvents.$inferSelect;
