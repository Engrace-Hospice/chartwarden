// @chartwarden/db — `onboarding_task_template` (M34 SaaS Tenant Platform §3.4 / §3.12 seed).
// The platform-SEEDED canonical floor of onboarding steps (`account_created`,
// `ccn_registered`, etc.). M34-F02 / ADR-0010 / SD-036 pattern-2 (platform-shared,
// read-only reference): this catalog is deliberately LEFT WITHOUT organization_id —
// every tenant reads the same template rows; no per-organization data lives here. RLS
// grants SELECT to all roles; writes are platform-ops/migration only. RLS + grants land
// in the RLS migration (0052).
import { boolean, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const onboardingTaskTemplate = pgTable("onboarding_task_template", {
  key: text("key").primaryKey(), // 'account_created', 'ccn_registered', etc.
  displayLabel: text("display_label").notNull(),
  description: text("description").notNull(),
  canonicalOrder: integer("canonical_order").notNull(), // 1..11 canonical; 100+ tenant-additions
  requiredRole: text("required_role").notNull(), // org_admin|compliance_officer|platform_ops
  preconditionDsl: text("precondition_dsl"),
  defaultDueDaysAfterProvisioning: integer("default_due_days_after_provisioning").notNull(),
  isCanonical: boolean("is_canonical").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type OnboardingTaskTemplate = typeof onboardingTaskTemplate.$inferSelect;
export type NewOnboardingTaskTemplate = typeof onboardingTaskTemplate.$inferInsert;
