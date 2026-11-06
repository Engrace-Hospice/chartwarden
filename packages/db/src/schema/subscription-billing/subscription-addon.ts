import { sql } from "drizzle-orm";
// @chartwarden/db — `subscription_addon` (M35, ADR-0108). Which tenant subscription holds which add-on, and since when.
// TENANT-SCOPED on organization_id (logical uuid, M35-F04; no PHI, so provider_entity_id/location_id do not attach).
// RLS ENABLE + FORCE with a SELECT-ONLY policy for chartwarden_app (migration 1321): grants and cancels are written only
// through M35's platform runner, so a tenant can never grant itself the add-on. At most one live (trialing/active)
// row per (organization, add-on). `subscription_id` / `addon_id` are REAL intra-M35 FKs.
import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { addonRow } from "./addon";
import { subscriptionRow } from "./subscription";

export const SUBSCRIPTION_ADDON_STATUSES = ["trialing", "active", "canceled"] as const;
export type SubscriptionAddonStatus = (typeof SUBSCRIPTION_ADDON_STATUSES)[number];

export const subscriptionAddon = pgTable(
  "subscription_addon",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").notNull(),
    subscriptionId: uuid("subscription_id")
      .notNull()
      .references(() => subscriptionRow.id, { onDelete: "restrict" }),
    addonId: uuid("addon_id")
      .notNull()
      .references(() => addonRow.id, { onDelete: "restrict" }),
    status: text("status").$type<SubscriptionAddonStatus>().notNull(),
    trialEndsAt: timestamp("trial_ends_at", { withTimezone: true }),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    endsAt: timestamp("ends_at", { withTimezone: true }),
    canceledAt: timestamp("canceled_at", { withTimezone: true }),
    /** The operator who canceled it (migration 1325); null when the system closed an expired row. */
    canceledByMembershipId: uuid("canceled_by_membership_id"),
    grantedByMembershipId: uuid("granted_by_membership_id"),
    grantReason: text("grant_reason").notNull(),
    stripeSubscriptionItemId: text("stripe_subscription_item_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    oneLiveUq: uniqueIndex("subscription_addon_one_live_uq")
      .on(t.organizationId, t.addonId)
      .where(sql`status IN ('trialing', 'active')`),
    orgIx: index("subscription_addon_org_ix").on(t.organizationId, t.addonId, t.startedAt),
    subscriptionIx: index("subscription_addon_subscription_ix").on(t.subscriptionId),
    addonIx: index("subscription_addon_addon_ix").on(t.addonId),
  }),
);

export type SubscriptionAddonRow = typeof subscriptionAddon.$inferSelect;
