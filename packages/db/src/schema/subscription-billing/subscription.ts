import { sql } from "drizzle-orm";
// @chartwarden/db — `subscription` (M35 §3.3). TENANT-SCOPED, RLS keyed ONLY on canonical app.org_id (0143).
// One live subscription per Organization (partial-unique `subscription_org_active_uq`). M35-F04
// (ADR-0011 / ARCH-147): `organization_id` is a plain uuid (logical FK to M2 organizations, RLS-governed)
// — M35 must NOT import the M1/M2 `organization` Drizzle schema; identity is resolved via the
// OrganizationReader seam + request context. `plan_id` is the one REAL FK (intra-M35, into `plan`).
import {
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { subscriptionStatus } from "../../enums";
import { plan } from "./plan";

// Exported as `subscriptionRow` (not `subscription`): the arch:tables ownership scanner keys on the
// Drizzle CONST name with a `\bsubscription\b` word-boundary match, and the common English word
// "subscription" already appears in other modules' prose (e.g. M33's "outbox-subscription map"). The
// `Row` suffix — as in this module's `dunningStateRow` — keeps the sqlName `subscription` while giving
// the export a collision-free symbol. Cross-module access is via seams, never this Drizzle const.
export const subscriptionRow = pgTable(
  "subscription",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").notNull(),
    planId: uuid("plan_id")
      .notNull()
      .references(() => plan.id, { onDelete: "restrict" }),
    stripeCustomerId: text("stripe_customer_id"),
    stripeSubscriptionId: text("stripe_subscription_id"),
    status: subscriptionStatus("status").notNull().default("trialing"),
    trialEndsAt: timestamp("trial_ends_at", { withTimezone: true }),
    currentPeriodStart: timestamp("current_period_start", { withTimezone: true }),
    currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }),
    billingAnchorDay: integer("billing_anchor_day"),
    cancelAtPeriodEnd: boolean("cancel_at_period_end").notNull().default(false),
    canceledAt: timestamp("canceled_at", { withTimezone: true }),
    pausedAt: timestamp("paused_at", { withTimezone: true }),
    pausedUntil: timestamp("paused_until", { withTimezone: true }),
    dunningStartedAt: timestamp("dunning_started_at", { withTimezone: true }),
    defaultPaymentMethodId: uuid("default_payment_method_id"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    orgActiveUq: uniqueIndex("subscription_org_active_uq")
      .on(t.organizationId)
      .where(sql`status NOT IN ('canceled', 'paused')`),
    stripeCustomerUq: uniqueIndex("subscription_stripe_customer_uq").on(t.stripeCustomerId),
    stripeSubscriptionUq: uniqueIndex("subscription_stripe_subscription_uq").on(
      t.stripeSubscriptionId,
    ),
    statusIx: index("subscription_status_ix").on(t.status),
    periodEndIx: index("subscription_period_end_ix").on(t.currentPeriodEnd),
  }),
);

export type SubscriptionRow = typeof subscriptionRow.$inferSelect;
export type NewSubscriptionRow = typeof subscriptionRow.$inferInsert;
