import { sql } from "drizzle-orm";
// @wardenx/db — `order_verbal_policy` (M11 §3.3 / §2.3 D3). The per-org (one row, `per_org_uq`) verbal-
// order policy: the authentication window (default 48h, business-hours toggle), the per-kind LPN/NP
// cosign-required matrices, and the platform-enforced floor (the service enforces tighten-only — an org
// may shorten the window below the platform default but never extend past the platform floor). Carries
// the three-column tenancy rule for ARCH-011 uniformity (org-level config, but PE/location NOT NULL per
// §3.3). Non-partitioned. Seeded per tenant at onboarding (packages/saas-tenant-platform). Actor refs go to M1
// `membership`. RLS + grants + M4 write-audit trigger (no free-text denylist) land in the RLS migration.
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
import { locations } from "../locations";
import { memberships } from "../memberships";
import { organizations } from "../organizations";
import { providerEntities } from "../provider-entities";

export const orderVerbalPolicies = pgTable(
  "order_verbal_policy",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    // NOT NULL relaxed in mig 0131 (M11L): org-level config; siting is nominal (ARCH-011 uniformity only).
    providerEntityId: uuid("provider_entity_id").references(() => providerEntities.id, {
      onDelete: "restrict",
    }),
    locationId: uuid("location_id").references(() => locations.id, { onDelete: "restrict" }),

    windowHours: integer("window_hours").notNull().default(48),
    businessHoursOnly: boolean("business_hours_only").notNull().default(false),

    lpnCosignRequiredKinds: jsonb("lpn_cosign_required_kinds")
      .notNull()
      .default(sql`'["lab","dme","comfort_kit","supply","ancillary_service"]'::jsonb`),
    npCosignRequiredKinds: jsonb("np_cosign_required_kinds").notNull().default(sql`'[]'::jsonb`),

    platformFloorWindowHours: integer("platform_floor_window_hours").notNull().default(48),
    policyVersion: text("policy_version").notNull().default("v1"),

    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    // NOT NULL relaxed in mig 0131 (M11L): `putVerbalPolicy(organizationId, args)` threads no actor.
    updatedByMembershipId: uuid("updated_by_membership_id").references(() => memberships.id, {
      onDelete: "restrict",
    }),
  },
  (t) => ({
    perOrgUq: uniqueIndex("order_verbal_policy_per_org_uq").on(t.organizationId),
  }),
);

export type OrderVerbalPolicy = typeof orderVerbalPolicies.$inferSelect;
export type NewOrderVerbalPolicy = typeof orderVerbalPolicies.$inferInsert;
