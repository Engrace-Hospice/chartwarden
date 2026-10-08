import { sql } from "drizzle-orm";
// @wardenx/db — `auditor_baa_acceptance` (M2 Identity §7.7; migration 0540). The append-only evidence that an
// external auditor accepted the versioned BAA / engagement terms for ONE engagement: who (user + typed name),
// when, from where (ip + user agent), which terms (version + sha-256 of the exact text shown) and for which
// engagement. `engagement_id` is an opaque reference to M3's `auditor_engagement` (no FK: M2 does not depend
// on M3). Org-scoped, not PHI. The app role may SELECT and INSERT only.
import { check, index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { organizations } from "./organizations";
import { users } from "./users";

export const auditorBaaAcceptances = pgTable(
  "auditor_baa_acceptance",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    engagementId: uuid("engagement_id").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    termsVersion: text("terms_version").notNull(),
    termsSha256: text("terms_sha256").notNull(),
    acceptedName: text("accepted_name").notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }).notNull().defaultNow(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    sessionId: text("session_id"),
  },
  (t) => ({
    acceptanceUq: uniqueIndex("auditor_baa_acceptance_uq").on(
      t.organizationId,
      t.engagementId,
      t.userId,
      t.termsSha256,
    ),
    userIdx: index("auditor_baa_acceptance_user_idx").on(t.userId),
    hashChk: check("auditor_baa_acceptance_hash_chk", sql`${t.termsSha256} ~ '^[0-9a-f]{64}$'`),
    nameChk: check("auditor_baa_acceptance_name_chk", sql`length(btrim(${t.acceptedName})) >= 2`),
  }),
);

export type AuditorBaaAcceptance = typeof auditorBaaAcceptances.$inferSelect;
export type NewAuditorBaaAcceptance = typeof auditorBaaAcceptances.$inferInsert;
