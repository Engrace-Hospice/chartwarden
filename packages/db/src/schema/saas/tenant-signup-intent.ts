// @chartwarden/db — `tenant_signup_intent` (M34 §3.9). The Phase-3 self-serve / platform-ops-manual
// pre-provision intake row: a prospective tenant's "signup intent" before any `tenant_account`
// or `organization` exists. M34-F02 / ADR-0010: this table is DELIBERATELY org-less — it is
// genuinely PRE-ORGANIZATION (the org/tenant_account does not exist until the intent is
// provisioned), the one legitimate org-less exemption (§3.10): NOT tenant-scoped, so the canonical
// `app.org_id` RLS predicate does not apply. RLS denies `chartwarden_app` SELECT entirely; only
// `tenant_platform_writer` reads it. On provisioning, the resulting `tenant_account.organization_id`
// is bridged via `tenant_account_id` (cross-module, app-validated — M34 never imports the
// tenant_account schema across this org-less boundary; plain uuid, no SQL FK). RLS + grants land
// in 0052; the write-audit trigger (retention class `operational`, §3.10) lands in 0053.
import { pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const tenantSignupIntentStatus = pgEnum("tenant_signup_intent_status", [
  "new",
  "qualified",
  "provisioned",
  "abandoned",
  "rejected",
]);

export const tenantSignupIntentSource = pgEnum("tenant_signup_intent_source", [
  "self_serve_form",
  "platform_ops_manual",
  "partner_referral",
]);

export const tenantSignupIntent = pgTable("tenant_signup_intent", {
  id: uuid("id").primaryKey().defaultRandom(),
  contactEmail: text("contact_email").notNull(),
  legalBusinessName: text("legal_business_name").notNull(),
  intendedFirstAdminEmail: text("intended_first_admin_email").notNull(),
  intentStatus: tenantSignupIntentStatus("intent_status").notNull().default("new"),
  source: tenantSignupIntentSource("source").notNull(),
  rejectionReason: text("rejection_reason"),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  processedAt: timestamp("processed_at", { withTimezone: true }),
  // Bridge to the now-org-scoped world; set only when intent_status='provisioned'. Cross-module
  // (M34 tenant_account, which is itself org-scoped) — app-validated, plain uuid, NO SQL FK across
  // the org-less boundary (matches mdm/evv cross-module ref convention).
  tenantAccountId: uuid("tenant_account_id"),
});

export type TenantSignupIntent = typeof tenantSignupIntent.$inferSelect;
export type NewTenantSignupIntent = typeof tenantSignupIntent.$inferInsert;
