// @chartwarden/db — `subscription_contract` (M35, slice 2 — migration 1342). The signed terms of a subscription on a
// census_banded plan: the plan VERSION it signed (frozen once published, so the price cannot move under it), the billing
// service mode, who signed and why. TENANT-SCOPED (organization_id, RLS on app.org_id) and SELECT-ONLY to the app role:
// a tenant reads its own contract and can never write what it is billed on. Written only by M35's platform runner.
import { date, index, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { plan } from "./plan";
import { subscriptionRow } from "./subscription";

export const BILLING_SERVICE_MODES = ["none", "billing_software", "managed_billing"] as const;
/** Mirrors `BillingServiceMode` in `@chartwarden/types` (this package takes no edge to it). */
export type BillingServiceModeValue = (typeof BILLING_SERVICE_MODES)[number];

export const subscriptionContract = pgTable(
  "subscription_contract",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").notNull(),
    subscriptionId: uuid("subscription_id")
      .notNull()
      .references(() => subscriptionRow.id, { onDelete: "restrict" }),
    planId: uuid("plan_id")
      .notNull()
      .references(() => plan.id, { onDelete: "restrict" }),
    billingServiceMode: text("billing_service_mode")
      .$type<BillingServiceModeValue>()
      .notNull()
      .default("none"),
    contractStartOn: date("contract_start_on", { mode: "string" }).notNull(),
    signedByMembershipId: uuid("signed_by_membership_id").notNull(),
    signedReason: text("signed_reason").notNull(),
    orderFormRef: text("order_form_ref"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    subscriptionUq: unique("subscription_contract_subscription_uq").on(t.subscriptionId),
    orgIx: index("subscription_contract_org_ix").on(t.organizationId),
    planIx: index("subscription_contract_plan_ix").on(t.planId),
  }),
);

export type SubscriptionContractRow = typeof subscriptionContract.$inferSelect;
export type NewSubscriptionContractRow = typeof subscriptionContract.$inferInsert;
