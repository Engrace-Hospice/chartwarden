// @wardenx/db — `safety_policy` + `safety_policy_version` (M20 §3.3 / §2.2.4, D4). The per-tenant policy
// spine: one policy row per org, many version rows tracking the tenant's edits over time. Every other M20
// row PINS the version it was written under (`safety_policy_version_id`), so a policy edit in 2027 cannot
// retroactively change what cadence was in force during a 2025 incident.
//
// M20-F03 — THERE IS NO ORG-NULL PLATFORM ROW. §3.2 Phase E struck it: `organization_id` is NOT NULL, so
// the prior seed could never have inserted and would never have matched the tenant-scoped RLS anyway. The
// platform floor is the `SAFETY_POLICY_FLOOR` CODE CONSTANT in `@wardenx/types` (M18's geofence floor is
// the precedent) that the resolver merges under each tenant's row and the editor bounds every edit
// against. `is_system_locked` stays on the policy row because §3.3 declares it and it means something
// different — a policy platform ops have frozen for THIS tenant.
//
// TENANCY: organization_id NOT NULL and nothing else. Both tables are org-level CONFIGURATION with no
// person column at all (the M19 `tenant_oncall_policy` / M11 `order_verbal_policy` posture), so the
// three-column rule's PE + Location denormalization would invent a scope the row does not have.
//
// TIGHTEN-ONLY BOUNDS. The CHECKs below are the PLATFORM band from `SAFETY_POLICY_BOUNDS`, not the floor
// defaults. §2.2.4/D4's rule is a band per knob and not one comparison, because "tighter" runs in opposite
// directions: a SHORTER overdue threshold alerts the supervisor sooner (tighter) and a SHORTER mid-visit
// cadence makes the clinician check in more often (also tighter), while a LONGER cancel window gives more
// chance to undo an accidental press (tighter again). The band is what a tenant edit may not leave, and it
// is expressed here so a policy written by a future service — or by a repair script — cannot leave it
// either. The editor (M20-T03) re-checks the same bounds to return a 422 rather than a constraint error.
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { safetySubscriptionModel } from "../../enums";
import { memberships } from "../memberships";
import { organizations } from "../organizations";

export const safetyPolicy = pgTable(
  "safety_policy",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),

    /** Platform ops froze this tenant's policy (a compliance action). NOT the M20-F03 platform-floor
     *  discriminator — there is no platform row to discriminate. */
    isSystemLocked: boolean("is_system_locked").notNull().default(false),

    /** The version row currently in force. The FK is added by ALTER in the migration: the two tables
     *  reference each other, and `safety_policy_version` cannot exist before its parent. */
    currentVersionId: uuid("current_version_id"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    /** M2 owns `membership`; the `.references()` is the ORM's view and the migration emits a plain uuid. */
    createdByMembershipId: uuid("created_by_membership_id").references(() => memberships.id, {
      onDelete: "restrict",
    }),
  },
  (t) => ({
    orgUnique: uniqueIndex("safety_policy_org_unique").on(t.organizationId),
  }),
);

export const safetyPolicyVersion = pgTable(
  "safety_policy_version",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    safetyPolicyId: uuid("safety_policy_id")
      .notNull()
      .references(() => safetyPolicy.id, { onDelete: "restrict" }),

    // ── Cadence (D3, D4) ──
    midVisitCadenceMinutes: integer("mid_visit_cadence_minutes").notNull(),
    midVisitMinVisitDurationMinutes: integer("mid_visit_min_visit_duration_minutes").notNull(),
    preVisitWindowMinutes: integer("pre_visit_window_minutes").notNull(),
    postVisitWindowMinutes: integer("post_visit_window_minutes").notNull(),

    // ── Overdue thresholds (D4) — minutes past `expected_at` ──
    gentleReminderMinutes: integer("gentle_reminder_minutes").notNull(),
    supervisorAlertMinutes: integer("supervisor_alert_minutes").notNull(),
    escalationMinutes: integer("escalation_minutes").notNull(),
    sosEquivalentMinutes: integer("sos_equivalent_minutes").notNull(),

    // ── SOS lifecycle (D5, D6, D7) ──
    sosCancelWindowSeconds: integer("sos_cancel_window_seconds").notNull(),
    sosCancelRequiresBiometric: boolean("sos_cancel_requires_biometric").notNull().default(true),
    sosContinuousLocationEnabled: boolean("sos_continuous_location_enabled")
      .notNull()
      .default(false),
    sosContinuousLocationSampleSeconds: integer("sos_continuous_location_sample_seconds")
      .notNull()
      .default(30),
    sosContinuousLocationMaxDurationHours: integer("sos_continuous_location_max_duration_hours")
      .notNull()
      .default(4),

    // ── SOS escalation SLA per tier (D7) — seconds from tier entry to the next tier ──
    sosTier1SlaSeconds: integer("sos_tier_1_sla_seconds").notNull().default(60),
    sosTier2SlaSeconds: integer("sos_tier_2_sla_seconds").notNull().default(120),
    sosTier3SlaSeconds: integer("sos_tier_3_sla_seconds").notNull().default(300),

    /** D8's tenant-wide DEFAULT generation model. The §3.3 block spells this `text // enum`; it is the
     *  declared §3.2 Phase-A type instead, for the reason M19 made `mandatory_escalation_tier` an enum —
     *  as text a typo'd model is accepted at configuration time and discovered when nobody gets paged. */
    subscriptionModel: safetySubscriptionModel("subscription_model")
      .notNull()
      .default("location_scoped"),

    /** Read from M19's `tenant_oncall_policy` default at boot; overridable here (§2.2.4). */
    afterHoursStartHour: integer("after_hours_start_hour").notNull().default(18),
    afterHoursEndHour: integer("after_hours_end_hour").notNull().default(8),

    /** D9 — the `safety_incident_category` values that default `osha_reportable` to true. */
    oshaReportableAutoFlagCategories: jsonb("osha_reportable_auto_flag_categories")
      .notNull()
      .default(sql`'[]'::jsonb`),

    effectiveFrom: timestamp("effective_from", { withTimezone: true }).notNull(),
    effectiveTo: timestamp("effective_to", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdByMembershipId: uuid("created_by_membership_id").references(() => memberships.id, {
      onDelete: "restrict",
    }),
    /** Free text — §3.6 audit-denylisted. The ≥30-char rule is the editor's (M20-T03). */
    editReason: text("edit_reason"),
  },
  (t) => ({
    orgEffectiveIdx: index("spv_org_effective_idx").on(
      t.organizationId,
      t.effectiveFrom,
      t.effectiveTo,
    ),
    currentPartial: index("spv_current_partial_idx")
      .on(t.organizationId)
      .where(sql`effective_to IS NULL`),

    // §2.2.4 — the version window is half-open and must be non-empty.
    windowIntegrity: check(
      "m20_spv_window",
      sql`"effective_to" IS NULL OR "effective_to" > "effective_from"`,
    ),
    // D4 tighten-only bands (SAFETY_POLICY_BOUNDS). Each is the PLATFORM band, not the floor default.
    cadenceBand: check(
      "m20_spv_cadence_band",
      sql`"mid_visit_cadence_minutes" BETWEEN 30 AND 120
          AND "mid_visit_min_visit_duration_minutes" BETWEEN 15 AND 240
          AND "pre_visit_window_minutes" BETWEEN 5 AND 60
          AND "post_visit_window_minutes" BETWEEN 1 AND 30`,
    ),
    overdueBand: check(
      "m20_spv_overdue_band",
      sql`"gentle_reminder_minutes" BETWEEN 1 AND 5
          AND "supervisor_alert_minutes" BETWEEN 1 AND 15
          AND "escalation_minutes" BETWEEN 1 AND 30
          AND "sos_equivalent_minutes" BETWEEN 1 AND 60`,
    ),
    // The four overdue tiers are a LADDER, not four independent knobs: a tenant that set
    // escalation < supervisor_alert would page the medical director before the supervisor.
    overdueLadder: check(
      "m20_spv_overdue_ladder",
      sql`"gentle_reminder_minutes" <= "supervisor_alert_minutes"
          AND "supervisor_alert_minutes" <= "escalation_minutes"
          AND "escalation_minutes" <= "sos_equivalent_minutes"`,
    ),
    sosBand: check(
      "m20_spv_sos_band",
      sql`"sos_cancel_window_seconds" BETWEEN 5 AND 30
          AND "sos_continuous_location_sample_seconds" BETWEEN 10 AND 300
          AND "sos_continuous_location_max_duration_hours" BETWEEN 1 AND 4
          AND "sos_tier_1_sla_seconds" BETWEEN 15 AND 60
          AND "sos_tier_2_sla_seconds" BETWEEN 30 AND 120
          AND "sos_tier_3_sla_seconds" BETWEEN 60 AND 300`,
    ),
    afterHoursBand: check(
      "m20_spv_after_hours",
      sql`"after_hours_start_hour" BETWEEN 0 AND 23 AND "after_hours_end_hour" BETWEEN 0 AND 23`,
    ),
    // D9's auto-flag list is a JSON ARRAY of category values; an object here would make the incident
    // opener's membership test silently false for every category.
    oshaListIsArray: check(
      "m20_spv_osha_list_array",
      sql`jsonb_typeof("osha_reportable_auto_flag_categories") = 'array'`,
    ),
  }),
);

export type SafetyPolicyRow = typeof safetyPolicy.$inferSelect;
export type NewSafetyPolicyRow = typeof safetyPolicy.$inferInsert;
export type SafetyPolicyVersionRow = typeof safetyPolicyVersion.$inferSelect;
export type NewSafetyPolicyVersionRow = typeof safetyPolicyVersion.$inferInsert;
