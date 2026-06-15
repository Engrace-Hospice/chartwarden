// @wardenx/db — `two_factor` (M2 Identity §3.3). A user's TOTP/SMS second-factor
// enrollment. Authentication factors are USER-level and shared across every
// organization that user belongs to (M02-F01: one identity, many memberships), so this
// table is user-owned and NON_ORG_SCOPED in check-tenancy.ts — protected by a
// user-ownership RLS predicate, not by `app.org_id`. The TOTP secret is envelope-
// encrypted with the platform KEK (never plaintext); backup codes are stored hashed.
import { boolean, index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { twoFactorMethod } from "../enums";
import { users } from "./users";

export const twoFactor = pgTable(
  "two_factor",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    method: twoFactorMethod("method").notNull().default("totp"),
    // TOTP secret is encrypted with the platform KEK (envelope), never plaintext.
    secretEncrypted: text("secret_encrypted").notNull(),
    // Backup codes: array of {hash, usedAt} — hashed (not encrypted) since one-way is enough.
    backupCodesEncrypted: jsonb("backup_codes_encrypted").notNull().default([]),
    verified: boolean("verified").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  },
  (t) => ({
    userIdx: index("two_factor_user_idx").on(t.userId),
  }),
);

export type TwoFactor = typeof twoFactor.$inferSelect;
export type NewTwoFactor = typeof twoFactor.$inferInsert;
