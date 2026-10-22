// M36 WP 5.6 (ADR-0086, PROPOSED) - one row per RESERVED destruction batch (migration 1159): the planned message ids (ids only), so a reservation
// stranded by a crash between the delete and the settle can be reconciled (ids already gone count as destroyed, the rest are refunded).
// Written ONLY by the destruction_certificate_reserve / _settle definer functions (the app role can only read it). No FK to the certificate (M4 owns it; the seam is the id).
import { sql } from "drizzle-orm";
import { check, index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { organizations } from "../organizations";

export const messageDestructionBatches = pgTable(
  "message_destruction_batch",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    certificateId: uuid("certificate_id").notNull(),
    plannedMessageIds: uuid("planned_message_ids").array().notNull(),
    plannedCount: integer("planned_count").notNull(),
    /** reserved | settled | reconciled */
    state: text("state").notNull().default("reserved"),
    reservedAt: timestamp("reserved_at", { withTimezone: true }).notNull().defaultNow(),
    settledAt: timestamp("settled_at", { withTimezone: true }),
    destroyedCount: integer("destroyed_count"),
  },
  (t) => ({
    byCertificate: index("message_destruction_batch_cert_idx").on(
      t.organizationId,
      t.certificateId,
      t.state,
    ),
    stranded: index("message_destruction_batch_stranded_idx")
      .on(t.organizationId, t.reservedAt)
      .where(sql`${t.state} = 'reserved'`),
    reservedIds: index("message_destruction_batch_reserved_ids_idx")
      .using("gin", t.plannedMessageIds)
      .where(sql`${t.state} = 'reserved'`),
    state: check(
      "message_destruction_batch_state",
      sql`${t.state} IN ('reserved', 'settled', 'reconciled')`,
    ),
    planned: check(
      "message_destruction_batch_planned",
      sql`${t.plannedCount} > 0 AND ${t.plannedCount} = cardinality(${t.plannedMessageIds})`,
    ),
  }),
);

export type MessageDestructionBatchRow = typeof messageDestructionBatches.$inferSelect;
