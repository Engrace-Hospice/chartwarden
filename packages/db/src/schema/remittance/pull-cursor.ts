// @chartwarden/db - M25 / #717 (migration 1254): the clearinghouse 835 poll position per (provider entity, vendor, usage).
// The cursor is an opaque vendor token: no PHI, so no audit trigger. `usage` is text + CHECK ('test' | 'production').
import { pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { organizations } from "../organizations";

export const remittancePullCursor = pgTable(
  "remittance_pull_cursor",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    providerEntityId: uuid("provider_entity_id").notNull(),
    vendor: text("vendor").notNull(),
    usage: text("usage").notNull(),
    cursor: text("cursor").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    key: unique("remittance_pull_cursor_key").on(
      t.organizationId,
      t.providerEntityId,
      t.vendor,
      t.usage,
    ),
  }),
);
