// @wardenx/db — `account` (M1 Foundation §3.8, Better Auth table). Per-provider
// credential record owned by a user (password hash / OAuth tokens). Cross-org and
// NON_ORG_SCOPED in check-tenancy.ts. Secret material is stored encrypted at rest.
import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { users } from "./users";

export const accounts = pgTable(
  "account",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    providerId: text("provider_id").notNull(),
    accountId: text("account_id").notNull(),
    passwordHash: text("password_hash"),
    accessTokenEncrypted: text("access_token_encrypted"),
    refreshTokenEncrypted: text("refresh_token_encrypted"),
    // AUTH-T06 (ADR-0033): Better Auth account-model columns (used by OAuth providers; null for the
    // credential provider, but the adapter model includes them).
    idToken: text("id_token"),
    scope: text("scope"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userProviderIdx: index("account_user_provider_idx").on(t.userId, t.providerId),
  }),
);

export type Account = typeof accounts.$inferSelect;
export type NewAccount = typeof accounts.$inferInsert;
