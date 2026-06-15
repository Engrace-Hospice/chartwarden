// @wardenx/db — `user` (M1 Foundation §3.6, Better Auth compatible). Cross-org
// identity: a user is NOT scoped to a single organization (org membership lives in
// `membership`), so `user` is NON_ORG_SCOPED in check-tenancy.ts. Better Auth reads
// this table directly (M2-T01 vendor-adapter).
import { boolean, index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { userStatus } from "../enums";

export const users = pgTable(
  "user",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull(),
    emailVerified: boolean("email_verified").notNull().default(false),
    name: text("name"),
    image: text("image"),
    status: userStatus("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    emailUniqueIdx: uniqueIndex("user_email_idx").on(t.email),
    statusIdx: index("user_status_idx").on(t.status),
  }),
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
