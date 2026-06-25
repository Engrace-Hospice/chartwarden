// @wardenx/db — `onboarding_task` (M34 SaaS Tenant Platform §3.4). The per-tenant RUNTIME
// onboarding task rows (one per template key per tenant_account), driven through the
// `onboarding_task_status` state machine (pending → in_progress → done | skipped | blocked).
// Tenancy (§3.10 M34-F02 / ADR-0010): ORG-SCOPED — carries its own `organization_id` NOT NULL so
// the canonical app.org_id RLS predicate applies directly. `tenant_account_id` is the intra-M34
// parent (plain uuid logical FK; the SQL FK to tenant_account lands in the migration). `template_key`
// references the platform-shared onboarding_task_template catalog (text key; app-validated, SQL FK in
// migration). `assigned_to_membership_id` is an M2 ref (app-validated). The org spine carries a SQL FK.
// RLS + grants + M4 write-audit trigger land in the RLS/audit migrations (0052/0053).
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

export const onboardingTaskStatus = pgEnum("onboarding_task_status", [
  "pending",
  "in_progress",
  "done",
  "skipped",
  "blocked",
]);

export const onboardingTask = pgTable(
  "onboarding_task",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // M34-F02 / ADR-0010: tenant-scoping key (canonical app.org_id RLS).
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    // Intra-M34 parent (tenant_account); SQL FK ON DELETE RESTRICT lands in the migration.
    tenantAccountId: uuid("tenant_account_id").notNull(),
    // Platform-shared catalog key (onboarding_task_template.key); SQL FK in the migration.
    templateKey: text("template_key").notNull(),
    status: onboardingTaskStatus("status").notNull().default("pending"),
    assignedToMembershipId: uuid("assigned_to_membership_id"), // M2 membership (app-validated)
    dueAt: timestamp("due_at", { withTimezone: true }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    blockerReason: text("blocker_reason"),
    completionEvidence: jsonb("completion_evidence").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantTemplateUnique: uniqueIndex("onboarding_task_tenant_template_unique").on(
      t.tenantAccountId,
      t.templateKey,
    ),
    tenantStatusIdx: index("onboarding_task_tenant_status_idx").on(t.tenantAccountId, t.status),
    dueIdx: index("onboarding_task_due_idx")
      .on(t.dueAt)
      .where(sql`status IN ('pending','in_progress','blocked')`),
  }),
);

export type OnboardingTask = typeof onboardingTask.$inferSelect;
export type NewOnboardingTask = typeof onboardingTask.$inferInsert;
