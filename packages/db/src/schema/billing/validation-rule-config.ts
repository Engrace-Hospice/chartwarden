import { sql } from "drizzle-orm";
// @wardenx/db — `validation_rule_config` (M23 Billing-Medicare §3.3, D5; non-partitioned; retention
// class `operational`). The PER-TENANT overlay on the platform's billing-rule registry. The 18 default
// rules are CODE-side (the §11.A registry in `@wardenx/billing`); only the tenant overlay (enable/
// disable, severity, override-role, parameters, and any tenant-custom rule) is persisted here.
// ORG-SCOPED: organization_id NOT NULL — there are NO platform-default rows in this table (unlike the
// M27 cost_report_validation_rule), so the canonical app.org_id RLS predicate applies directly.
//
// D5 PLATFORM-FLOOR PROTECTION: `regulatory_required_snapshot` is read from the code-side registry at
// write time and frozen here; the CHECK constraint forbids an overlay row for a regulatory-required
// rule, so a tenant can never disable a CMS-mandated billing rule.
//
// CROSS-MODULE FK POLICY (architecture WINS): only organization_id (core) gets a real `.references`.
// set_by_membership_id is a LOGICAL FK (plain uuid; mirrors the M27 precedent). No PHI (D18).
import {
  boolean,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { organizations } from "../organizations";
import { m23OverrideRoleRequired, m23ValidationSeverity } from "./types";
import type { ValidationRuleParameters, ValidationRulePredicateDsl } from "./types";

export const validationRuleConfig = pgTable(
  "validation_rule_config",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),

    ruleKey: text("rule_key").notNull(), // e.g. 'noe_timeliness_5d', or 'tenant_custom_xyz'
    ruleVersion: integer("rule_version").notNull().default(1),
    isCustom: boolean("is_custom").notNull().default(false), // true if tenant-added; false if overlay on a platform rule

    enabled: boolean("enabled").notNull().default(true),
    severity: m23ValidationSeverity("severity").notNull(),
    overrideRoleRequired: m23OverrideRoleRequired("override_role_required")
      .notNull()
      .default("billing_manager"),

    // Tenant parameter overlay (typed by rule kind; validated by the rule registry):
    parameters: jsonb("parameters")
      .$type<ValidationRuleParameters>()
      .notNull()
      .default(sql`'{}'::jsonb`),

    // Platform-locked indicator — read from the code-side registry at write-time and snapshot here (D5):
    regulatoryRequiredSnapshot: boolean("regulatory_required_snapshot").notNull().default(false),

    // Custom-rule predicate (JSON-DSL or TypeScript ref id — populated only when is_custom=true):
    predicateDsl: jsonb("predicate_dsl").$type<ValidationRulePredicateDsl>(),

    setByMembershipId: uuid("set_by_membership_id").notNull(), // logical FK → memberships
    setReason: text("set_reason"), // ≥20 chars when overlay disables a non-regulatory rule

    version: integer("version").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniqueByRule: uniqueIndex("validation_rule_config_org_rule_uq").on(t.organizationId, t.ruleKey),
    nonRegulatoryOnly: sql`CHECK (regulatory_required_snapshot IS DISTINCT FROM true)`, // D5 platform-floor protection
    disableReasonFloor: sql`CHECK (enabled OR length(coalesce(set_reason,'')) >= 20)`,
  }),
);

export type ValidationRuleConfig = typeof validationRuleConfig.$inferSelect;
export type NewValidationRuleConfig = typeof validationRuleConfig.$inferInsert;
