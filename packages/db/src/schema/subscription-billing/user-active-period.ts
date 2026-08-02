// @wardenx/db — `user_active_period` (M35 §3.3). TENANT-SCOPED, RLS on app.org_id (0143). Pseudonymized —
// NEVER holds a raw membership_id, only a 32-hex HMAC-SHA256 `membership_pseudonym`. §3.6 requests full
// audit exclusion (append-only). `organization_id` is a logical uuid (M35-F04).
import { boolean, check, index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const userActivePeriod = pgTable(
  "user_active_period",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").notNull(),
    membershipPseudonym: text("membership_pseudonym").notNull(),
    pseudonymKeyEpoch: text("pseudonym_key_epoch").notNull(),
    periodYearMonth: text("period_year_month").notNull(),
    wasActive: boolean("was_active").notNull().default(false),
    firstSessionAt: timestamp("first_session_at", { withTimezone: true }),
    lastSessionAt: timestamp("last_session_at", { withTimezone: true }),
    computedAt: timestamp("computed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pseudoUq: uniqueIndex("user_active_period_uq").on(
      t.organizationId,
      t.membershipPseudonym,
      t.periodYearMonth,
    ),
    orgPeriodIx: index("user_active_period_org_period_ix").on(t.organizationId, t.periodYearMonth),
    pseudonymFormatCk: check(
      "user_active_period_pseudonym_format_ck",
      sql`membership_pseudonym ~ '^[a-f0-9]{32}$'`,
    ),
  }),
);

export type UserActivePeriodRow = typeof userActivePeriod.$inferSelect;
export type NewUserActivePeriodRow = typeof userActivePeriod.$inferInsert;
