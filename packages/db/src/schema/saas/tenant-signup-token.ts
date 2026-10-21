// @chartwarden/db — `tenant_signup_token` (M34 §3.9). The single-use, time-bound token issued against a
// `tenant_signup_intent` (email-verification or first-admin-setup). Like its parent intent, it is
// DELIBERATELY org-less (M34-F02 / ADR-0010, §3.10): genuinely PRE-ORGANIZATION, the one legitimate
// org-less exemption — NOT tenant-scoped, so the canonical `app.org_id` RLS predicate does not
// apply. RLS denies `chartwarden_app` SELECT entirely; only `tenant_platform_writer` reads it. The
// parent `tenant_signup_intent_id` is an intra-M34 ref but is kept a plain uuid (app-validated, no
// SQL FK) to stay consistent with the org-less platform-private boundary. `token_hash` is the
// SHA256 of the issued token (the raw token is never stored) and is value-capture-denylisted in the
// audit projection (§3.10). The platform floor — `expires_at <= issued_at + interval '24 hours'` —
// is a CHECK constraint declared in the 0051 migration (CHECKs with interval arithmetic are written
// in raw SQL there, not emitted from this logical Drizzle shape). RLS + grants land in 0052; the
// write-audit trigger (retention class `operational`) lands in 0053.
import { pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

export const tenantSignupToken = pgTable(
  "tenant_signup_token",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantSignupIntentId: uuid("tenant_signup_intent_id").notNull(), // M34 parent (app-validated)
    tokenHash: text("token_hash").notNull(), // SHA256; DENYLISTED in audit projection (§3.10)
    tokenPurpose: text("token_purpose").notNull(), // email_verification | first_admin_setup
    issuedAt: timestamp("issued_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(), // platform floor 24h (CHECK in 0051)
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
  },
  (t) => ({
    tokenHashUnique: uniqueIndex("tenant_signup_token_hash_unique").on(t.tokenHash),
  }),
);

export type TenantSignupToken = typeof tenantSignupToken.$inferSelect;
export type NewTenantSignupToken = typeof tenantSignupToken.$inferInsert;
