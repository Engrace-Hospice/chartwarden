// @chartwarden/db - M23 / #749 (migration 1267): the clearinghouse acknowledgment poll position per (provider entity,
// vendor, usage, stage). Opaque vendor token: no PHI. `usage` / `kind` are text + CHECK; `version` is the CAS counter.
import { bigint, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { organizations } from "../organizations";

export const clearinghouseAckCursor = pgTable(
  "clearinghouse_ack_cursor",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    providerEntityId: uuid("provider_entity_id").notNull(),
    vendor: text("vendor").notNull(),
    usage: text("usage").notNull(),
    kind: text("kind").notNull(),
    cursor: text("cursor"),
    version: bigint("version", { mode: "number" }).notNull().default(1),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("clearinghouse_ack_cursor_key").on(
      t.organizationId,
      t.providerEntityId,
      t.vendor,
      t.usage,
      t.kind,
    ),
  ],
);
