// @chartwarden/db — `scale_policy` (M9 §3.3, D2). Per-tenant scale configuration: whether a scale is
// enabled, and tenant-tightened significant-change thresholds + reassessment cadence (the service
// enforces the floor — overrides may only TIGHTEN a platform default, never loosen it). Org-level
// policy config, NOT patient PHI → carries organization_id only (the ARCH-011 org-level carve-out).
// Actor ref goes to M1 `membership`. RLS + grants + the M4 write-audit trigger land in the RLS
// migration; one policy row per (org, scale) is a unique index.
import { sql } from "drizzle-orm";
import { boolean, jsonb, pgTable, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { scaleType } from "../../enums";
import { memberships } from "../memberships";
import { organizations } from "../organizations";

export const scalePolicies = pgTable(
  "scale_policy",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    scaleType: scaleType("scale_type").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    // tenant-tightened significant-change thresholds (must be at-least-as-strict as the platform floor)
    significantChangeOverrides: jsonb("significant_change_overrides")
      .notNull()
      .default(sql`'{}'::jsonb`),
    // tenant-tightened reassessment cadence (same floor-enforcement rule)
    reassessmentCadenceOverrides: jsonb("reassessment_cadence_overrides")
      .notNull()
      .default(sql`'{}'::jsonb`),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    // NOT NULL relaxed in mig 0129 (M9L): the policy-admin route threads no acting membership.
    updatedByMembershipId: uuid("updated_by_membership_id").references(() => memberships.id, {
      onDelete: "restrict",
    }),
  },
  (t) => ({
    perOrgScale: uniqueIndex("scale_policy_per_org_scale_uq").on(t.organizationId, t.scaleType),
  }),
);

export type ScalePolicy = typeof scalePolicies.$inferSelect;
export type NewScalePolicy = typeof scalePolicies.$inferInsert;
