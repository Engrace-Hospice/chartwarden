// @chartwarden/db — `auditor_magic_link` (M2 Identity, GAP-011). The durable, single-use, time-boxed token an
// external auditor consumes to start an `auditor`-class session for ONE engagement. Only the sha256 HASH of
// the token is stored (the `organization_invitation.token_hash` precedent). `engagement_id` is an opaque
// reference to M3's `auditor_engagement` (no FK: M2 does not depend on M3). Org-scoped, not PHI.
import { sql } from "drizzle-orm";
import { check, index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { organizations } from "./organizations";

export const auditorMagicLinks = pgTable(
  "auditor_magic_link",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    engagementId: uuid("engagement_id").notNull(),
    auditorEmail: text("auditor_email").notNull(),
    auditorName: text("auditor_name").notNull(),
    tokenHash: text("token_hash").notNull(),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tokenIdx: uniqueIndex("auditor_magic_link_token_idx").on(t.tokenHash),
    orgEngagementIdx: index("auditor_magic_link_org_engagement_idx").on(
      t.organizationId,
      t.engagementId,
    ),
    windowValid: check("auditor_magic_link_window_chk", sql`${t.windowStart} < ${t.expiresAt}`),
  }),
);

export type AuditorMagicLink = typeof auditorMagicLinks.$inferSelect;
export type NewAuditorMagicLink = typeof auditorMagicLinks.$inferInsert;
