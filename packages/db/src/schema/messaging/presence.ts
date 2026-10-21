// @chartwarden/db — `presence` (M36 Secure Messaging §3.5). One row per user, mutated on
// Socket.IO connect/disconnect. It is user-owned and tenant-agnostic (presence follows the
// human across tenants), so it carries NO organization_id and is opted out of the
// three-column rule via the check-tenancy NON_ORG_SCOPED allowlist (a reviewed change) —
// same posture as `session`/`delivery_endpoint`. RLS (user-ownership) lands in M36-T03.
import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { presenceStatus } from "../../enums";
import { users } from "../users";

export const presence = pgTable(
  "presence",
  {
    userId: uuid("user_id")
      .primaryKey()
      .references(() => users.id, { onDelete: "cascade" }),
    status: presenceStatus("status").notNull().default("offline"),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    source: text("source").notNull().default("socket"),
  },
  (t) => ({
    statusIdx: index("presence_status_idx").on(t.status),
  }),
);

export type Presence = typeof presence.$inferSelect;
export type NewPresence = typeof presence.$inferInsert;
