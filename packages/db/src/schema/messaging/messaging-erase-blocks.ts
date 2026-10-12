// @wardenx/db — `messaging_erase_block` (M36 WP 1.5 hardening, migration 1076). One row per org whose messaging data is being
// erased: once it exists, attachment authorize/complete refuse. Insert-only for the app and destruction roles (nobody can
// clear it); RLS confines each role to its own org. No PHI.
import { pgTable, timestamp, uuid } from "drizzle-orm/pg-core";
import { organizations } from "../organizations";

export const messagingEraseBlocks = pgTable("messaging_erase_block", {
  organizationId: uuid("organization_id")
    .primaryKey()
    .references(() => organizations.id, { onDelete: "cascade" }),
  blockedAt: timestamp("blocked_at", { withTimezone: true }).notNull().defaultNow(),
});

export type MessagingEraseBlock = typeof messagingEraseBlocks.$inferSelect;
