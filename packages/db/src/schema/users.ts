// @chartwarden/db — `user` (M1 Foundation §3.6, Better Auth compatible). Cross-org
// identity: a user is NOT scoped to a single organization (org membership lives in
// `membership`), so `user` is NON_ORG_SCOPED in check-tenancy.ts. Better Auth reads
// this table directly (M2-T01 vendor-adapter).
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { credentialState, userStatus } from "../enums";

export const users = pgTable(
  "user",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Legacy identities may remain email-only; directly provisioned identities may be username-only.
    email: text("email"),
    // Stored in canonical lowercase form. Legacy identities intentionally remain nullable.
    username: text("username"),
    // Better Auth's username plugin preserves the user's entered casing separately.
    displayUsername: text("display_username"),
    emailVerified: boolean("email_verified").notNull().default(false),
    name: text("name"),
    image: text("image"),
    status: userStatus("status").notNull().default("active"),
    credentialState: credentialState("credential_state").notNull().default("active"),
    credentialStateReason: text("credential_state_reason"),
    credentialVersion: integer("credential_version").notNull().default(0),
    passwordChangedAt: timestamp("password_changed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    // AUTH-T06 (ADR-0033): Better Auth twoFactor plugin flag (whether the user has 2FA enrolled).
    twoFactorEnabled: boolean("two_factor_enabled").notNull().default(false),
  },
  (t) => ({
    emailUniqueIdx: uniqueIndex("user_email_idx").on(t.email),
    usernameUniqueIdx: uniqueIndex("user_username_idx").on(t.username),
    statusIdx: index("user_status_idx").on(t.status),
    usernameShape: check(
      "user_username_shape",
      sql`${t.username} IS NULL OR (${t.username} = lower(${t.username}) AND ${t.username} ~ '^[a-z0-9_.-]{3,32}$' AND ${t.username} !~ '@')`,
    ),
    usernameReserved: check(
      "user_username_not_reserved",
      sql`${t.username} IS NULL OR ${t.username} NOT IN ('admin', 'administrator', 'root', 'security', 'support', 'system', 'wardenx')`,
    ),
  }),
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
