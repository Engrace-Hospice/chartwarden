// @wardenx/db — `ai_tenant_opt_in_record` (M32 §3.2.6). W4: the tenant's own decision about one
// capability, with the disclosures its admin acknowledged at the moment they took it.
//
// TENANT-SCOPED: organization_id NOT NULL, RLS keyed ONLY on app.org_id (0116).
//
// THE DEFAULT IS `opted_out`, AND THAT IS THE DESIGN. The row's EXISTENCE is not consent — a row can be
// created by the opt-in workflow the moment an admin opens the page, and consent is the STATUS. A schema
// where the row means yes makes every partially-completed workflow an accidental authorization.
//
// `disclosure_acknowledgments` + `calibration_trade_off_acknowledged` are frozen EVIDENCE, not settings:
// they record what the admin was actually shown (§5.3's trade-off text is capability- and
// backend-specific and changes between versions), so "they agreed to today's wording" can never be
// substituted for "they agreed to the wording in force then". Both are §3.4-denylisted out of the audit
// capture — they can carry the tenant's own contract language.
//
// `routing_preference_snapshot` is likewise a SNAPSHOT of M2's `TenantConfiguration.ai_routing_preference`
// at opt-in time, not a live read: a tenant that later flips to `local_only` has not retroactively
// consented to a cloud route, and the invocation ledger must be able to show which posture was in force.
//
// `pilot_enrollment` is separate from `status` because §2.2's `pilot_tenants_only` posture needs BOTH —
// a plain active opt-in is deliberately not enough to reach a PILOT capability.
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { aiTenantOptInStatus } from "../../enums";
import { organizations } from "../organizations";
import { aiCapability } from "./ai-capabilities";

export const aiTenantOptInRecord = pgTable(
  "ai_tenant_opt_in_record",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    capabilityId: uuid("capability_id")
      .notNull()
      .references(() => aiCapability.id, { onDelete: "restrict" }),

    /** Consent is the STATUS, never the row's existence (see header). */
    status: aiTenantOptInStatus("status").notNull().default("opted_out"),
    /** Logical FK → M2 membership: the org admin who took the decision. */
    orgAdminMembershipId: uuid("org_admin_membership_id").notNull(),

    /** Typed DisclosureAck — frozen evidence of what was shown. §3.4-denylisted. */
    disclosureAcknowledgments: jsonb("disclosure_acknowledgments").notNull(),
    /** Snapshot of M2's tenant routing preference AT OPT-IN (see header). */
    routingPreferenceSnapshot: text("routing_preference_snapshot").notNull(),
    /** The §5.3 trade-off body as it read then. §3.4-denylisted. */
    calibrationTradeOffAcknowledged: text("calibration_trade_off_acknowledged"),

    pilotEnrollment: boolean("pilot_enrollment").notNull().default(false),

    optedInAt: timestamp("opted_in_at", { withTimezone: true }),
    pausedAt: timestamp("paused_at", { withTimezone: true }),
    pausedReason: text("paused_reason"),
    optedOutAt: timestamp("opted_out_at", { withTimezone: true }),
    optedOutReason: text("opted_out_reason"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    orgCapabilityIdx: uniqueIndex("ai_tenant_opt_in_org_cap_idx").on(
      t.organizationId,
      t.capabilityId,
    ),
    activeIdx: index("ai_tenant_opt_in_active_idx")
      .on(t.organizationId, t.status)
      .where(sql`status = 'active'`),

    routingPreferenceCheck: check(
      "ai_tenant_opt_in_routing_pref_check",
      sql`routing_preference_snapshot IN ('prefer_cloud','prefer_local','cloud_only','local_only')`,
    ),
    // `active` is the one status that authorizes an invocation, so it must carry the instant it was
    // granted — an active opt-in with no `opted_in_at` cannot be reconciled against the ledger.
    activeHasTimestamp: check(
      "ai_tenant_opt_in_active_has_timestamp",
      sql`status <> 'active' OR opted_in_at IS NOT NULL`,
    ),
  }),
);

export type AiTenantOptInRecordRow = typeof aiTenantOptInRecord.$inferSelect;
export type NewAiTenantOptInRecordRow = typeof aiTenantOptInRecord.$inferInsert;
