// @wardenx/db — `support_session` (M34 §3.6). An active platform-ops support window opened against a
// `support_consent_grant`. Tenancy (§3.10 M34-F02 / ADR-0010): ORG-SCOPED — carries its own
// `organization_id` NOT NULL so the canonical app.org_id RLS predicate applies directly.
// `actor_membership_id` is the platform-ops actor (must be distinct from the grant's grantor — enforced
// in the support-session service / route, ABAC, since the grantor lives in a different row and so cannot
// be a CHECK). `close_reason` records how the session ended (manual|expired|grant_revoked|forced_terminated).
// RLS + grants + the M4 write-audit trigger land in 0052/0053.
import { sql } from "drizzle-orm";
import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { organizations } from "../organizations";
import { supportConsentGrant } from "./support-consent-grant";

export const supportSession = pgTable(
  "support_session",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // M34-F02 / ADR-0010: tenant-scoping key (canonical app.org_id RLS).
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    supportConsentGrantId: uuid("support_consent_grant_id")
      .notNull()
      .references(() => supportConsentGrant.id, { onDelete: "restrict" }),
    actorMembershipId: uuid("actor_membership_id").notNull(), // platform-ops actor (M1 membership)
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    closeReason: text("close_reason"), // manual|expired|grant_revoked|forced_terminated
  },
  (t) => ({
    grantIdx: index("support_session_grant_idx").on(t.supportConsentGrantId),
    actorStartedIdx: index("support_session_actor_started_idx").on(
      t.actorMembershipId,
      t.startedAt,
    ),
    activeIdx: index("support_session_active_idx").on(t.expiresAt).where(sql`closed_at IS NULL`),
  }),
);

export type SupportSession = typeof supportSession.$inferSelect;
export type NewSupportSession = typeof supportSession.$inferInsert;
