// @chartwarden/db - M23 / ADR-0053 D4 (migration 1280): the interchange control number (ISA13) one submission was
// rendered with, remembered under its idempotency key so a redelivered job renders the identical interchange. The number
// itself is drawn from the platform-wide per-usage sequence. Ours, not PHI. `usage` is text + CHECK.
import { bigint, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { organizations } from "../organizations";

export const clearinghouseInterchangeNumber = pgTable(
  "clearinghouse_interchange_number",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    scope: text("scope").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    usage: text("usage").notNull(),
    interchangeNumber: bigint("interchange_number", { mode: "number" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("clearinghouse_interchange_number_key").on(t.organizationId, t.scope, t.idempotencyKey),
    unique("clearinghouse_interchange_number_platform_uq").on(t.usage, t.interchangeNumber),
  ],
);
