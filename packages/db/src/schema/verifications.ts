// @wardenx/db — `verification` (M1 Foundation §3.8, Better Auth table). Short-lived
// verification tokens (email verify, password reset, etc.), keyed by an opaque
// identifier rather than a user FK. Cross-org and NON_ORG_SCOPED in check-tenancy.ts.
import { index, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const verifications = pgTable(
  "verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    // AUTH-T06 (ADR-0033): Better Auth verification-model column.
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    identifierIdx: index("verification_identifier_idx").on(t.identifier),
    expiresIdx: index("verification_expires_idx").on(t.expiresAt),
  }),
);

export type Verification = typeof verifications.$inferSelect;
export type NewVerification = typeof verifications.$inferInsert;
