// @wardenx/db — `tenant_account` (M34 §3.3). The platform's per-tenant control record: 1:1 with the
// M1 organization (the `tenant_account_org_unique` UNIQUE enforces D1; multi-CCN tenants reference
// multiple provider_entity rows under this one organization, D20). Carries the lifecycle `status`
// (signup_intent → … → destroyed), the plan label (M35 owns entitlement enforcement; M34 carries the
// label only), legal/contact identity, the default retention class for tenant-emitted artifacts, and
// the lifecycle timestamps. ORG-SCOPED: it carries `organization_id` NOT NULL from day one (it IS the
// tenant spine row). Cross-module references (compliance_officer_membership_id, created_by_membership_id
// → M2 membership) are plain uuid app-validated; only the M1 organization spine carries a SQL FK.
// Standard app.org_id RLS + the M4 write-audit trigger land in 0052/0053.
import { sql } from "drizzle-orm";
import {
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { organizations } from "../organizations";

export const tenantAccountStatus = pgEnum("tenant_account_status", [
  "signup_intent",
  "provisioning",
  "onboarding",
  "active",
  "suspended",
  "at_risk",
  "offboarding_initiated",
  "final_export_pending",
  "retained",
  "destruction_pending",
  "destroyed",
]);

export const retentionClassDefault = pgEnum("retention_class_default", [
  "compliance",
  "clinical_record",
  "operational",
  "bereavement",
  "intake_artifact",
]);

export const tenantAccount = pgTable(
  "tenant_account",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // 1:1 with M1 organization. UNIQUE constraint enforces D1.
    // Multi-CCN tenants reference multiple provider_entity rows under this one organization (D20).
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    status: tenantAccountStatus("status").notNull().default("signup_intent"),
    // M35 owns enforcement of plan entitlements; M34 carries label only.
    planLabel: text("plan_label").notNull().default("engrace_internal"),
    legalBusinessName: text("legal_business_name").notNull(),
    dbaName: text("dba_name"),
    billingContactEmail: text("billing_contact_email").notNull(),
    breachNotificationEmail: text("breach_notification_email").notNull(),
    // Tenant's compliance officer membership — used by ABAC predicate tenant_platform_baa_compliance_officer
    // and as the M36 alert routing target (M2 membership; app-validated, no SQL FK).
    complianceOfficerMembershipId: uuid("compliance_officer_membership_id"),
    // Default retention class for tenant-emitted artifacts that don't carry one.
    retentionClassDefault: retentionClassDefault("retention_class_default")
      .notNull()
      .default("compliance"),
    provisionedAt: timestamp("provisioned_at", { withTimezone: true }),
    activatedAt: timestamp("activated_at", { withTimezone: true }),
    suspendedAt: timestamp("suspended_at", { withTimezone: true }),
    offboardingInitiatedAt: timestamp("offboarding_initiated_at", { withTimezone: true }),
    finalExportCompletedAt: timestamp("final_export_completed_at", { withTimezone: true }),
    // Computed at offboarding_initiated → retained transition; null otherwise.
    retentionEndsAt: timestamp("retention_ends_at", { withTimezone: true }),
    destroyedAt: timestamp("destroyed_at", { withTimezone: true }),
    metadata: jsonb("metadata").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdByMembershipId: uuid("created_by_membership_id"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    organizationUnique: uniqueIndex("tenant_account_org_unique").on(t.organizationId),
    statusIdx: index("tenant_account_status_idx").on(t.status),
    retentionEndsIdx: index("tenant_account_retention_ends_idx")
      .on(t.retentionEndsAt)
      .where(sql`retention_ends_at IS NOT NULL`),
    // Required-when checks: destroyed_at IS NOT NULL ⇒ status='destroyed'
    destroyedConsistency: sql`CONSTRAINT tenant_account_destroyed_consistency CHECK (
			(status = 'destroyed') = (destroyed_at IS NOT NULL)
		)`,
  }),
);

export type TenantAccount = typeof tenantAccount.$inferSelect;
export type NewTenantAccount = typeof tenantAccount.$inferInsert;
