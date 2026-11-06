// @chartwarden/db — `subscription_contract` (M35, slice 2 — migration 1342). The signed terms of a subscription on a
// census_banded plan: the plan VERSION it signed (frozen once published, so the price cannot move under it), who signed
// and why. IMMUTABLE once signed (a trigger refuses any UPDATE). The billing service mode lives in its own append-only,
// effective-dated history (`subscription_contract_mode`). TENANT-SCOPED (organization_id, RLS on app.org_id) and
// SELECT-ONLY to the app role: a tenant reads its own contract and can never write what it is billed on. Written only by
// M35's platform runner.
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
    contractStartOn: date("contract_start_on", { mode: "string" }).notNull(),
    signedByMembershipId: uuid("signed_by_membership_id").notNull(),
    signedReason: text("signed_reason").notNull(),
    orderFormRef: text("order_form_ref"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    subscriptionUq: unique("subscription_contract_subscription_uq").on(t.subscriptionId),
    orgIx: index("subscription_contract_org_ix").on(t.organizationId),
    planIx: index("subscription_contract_plan_ix").on(t.planId),
  }),
);

export type SubscriptionContractRow = typeof subscriptionContract.$inferSelect;
export type NewSubscriptionContractRow = typeof subscriptionContract.$inferInsert;

// `subscription_contract_mode` (migration 1342): the billing service mode as an append-only, effective-dated history. The mode in
// force on a date is the row with the latest `effective_from` at or before it (the newest row wins a tie), so a pending change is
// superseded by another row for the same date. A change takes effect from the 1st of the NEXT month, immediately only while the
// tenant has no statement yet, and the database refuses a change dated inside a month whose statement is final.
export const subscriptionContractMode = pgTable(
  "subscription_contract_mode",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").notNull(),
    contractId: uuid("contract_id")
      .notNull()
      .references(() => subscriptionContract.id, { onDelete: "restrict" }),
    billingServiceMode: text("billing_service_mode").$type<BillingServiceModeValue>().notNull(),
    effectiveFrom: date("effective_from", { mode: "string" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    orgIx: index("subscription_contract_mode_org_ix").on(t.organizationId),
  }),
);

export type SubscriptionContractModeRow = typeof subscriptionContractMode.$inferSelect;
export type NewSubscriptionContractModeRow = typeof subscriptionContractMode.$inferInsert;
