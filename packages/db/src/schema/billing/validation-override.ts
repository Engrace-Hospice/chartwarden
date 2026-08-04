import { sql } from "drizzle-orm";
// @wardenx/db — `validation_override` (M23 Billing-Medicare §3.3, D5; append-only; NON-partitioned;
// retention class `compliance`). One row per overridden failed validation result: a role-gated,
// reason-required, M4-audited override that lets a claim proceed past a non-regulatory failure. At most
// one override per result. ORG-SCOPED: organization_id NOT NULL (canonical app.org_id RLS).
//
// CROSS-MODULE FK POLICY (architecture WINS over the spec DDL): only `organization_id` (core) and
// intra-M23 parents (`result_id` → validation_result) get real `.references(...)`.
// `override_membership_id` (core memberships) and `m4_audit_event_id` (M4 audit_event) are LOGICAL FKs
// — plain uuid, validated at runtime (mirrors the M27 cost-report precedent). No PHI / MBI is ever
// stored here (D13, §8.7).
import { pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { organizations } from "../organizations";
import { m23OverrideRoleRequired } from "./types";
import { validationResult } from "./validation-result";

export const validationOverride = pgTable(
  "validation_override",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    resultId: uuid("result_id")
      .notNull()
      .references(() => validationResult.id, { onDelete: "restrict" }),

    overrideMembershipId: uuid("override_membership_id").notNull(), // logical FK → memberships
    overrideRoleApplied: m23OverrideRoleRequired("override_role_applied").notNull(),
    reason: text("reason").notNull(), // ≥40 chars

    // M4 audit reference (the audit_event row id captured in the same transaction):
    m4AuditEventId: uuid("m4_audit_event_id").notNull(), // logical FK → M4 audit_event

    appliedAt: timestamp("applied_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    resultUq: uniqueIndex("validation_override_result_uq").on(t.resultId), // at most one override per result
    reasonFloor: sql`CHECK (length(reason) >= 40)`,
  }),
);

export type ValidationOverride = typeof validationOverride.$inferSelect;
export type NewValidationOverride = typeof validationOverride.$inferInsert;
