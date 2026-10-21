// apps/backend/src/modules/35-subscription/events-by-m35.ts — Module 35's outbox-event contributions
// (spec §4.11 Outbox Event Catalog). The full `m35.*` taxonomy keyed on M35's own resources, under the
// `m35.` namespace (M01 D8 outbox_event_catalog / M03 D9 / M04 D9). check-fitness-gaps.ts scans this file
// for naming (`mN.<resource>.<verb>`), ownership (moduleOwner='m35'), and valid declared consumers (real
// module ids). The composition root merges this into the platform event catalog at boot (the M27/M30/M33
// events-by-mN precedent); the dispatcher validates each `m35.*` publish against the TypeBox `payloadSchema`
// inside the same transaction as the mutation (transactional outbox).
//
// M35 carries NO PHI (§8.4/§8.5) — every payload is IDs (uuid / stripe id / membership id) + aggregate
// financial facts (INTEGER CENTS) + enum lifecycle codes. The names + payload shapes MIRROR the leaf
// `@chartwarden/types` `M35_EVENT_NAMES` / `M35EventPayloadMap` (the compile-time contract the dispatcher
// enforces); the cross-module fan-outs target M29 (Xero AR sync on paid/executed), M33 (dashboards),
// M34 (tenant billing gate), and M36 (alerts).
import { Type } from "@sinclair/typebox";
import type { ModuleEventContribution } from "@chartwarden/types";

const id = Type.String({ minLength: 1 });
const nullableId = Type.Union([id, Type.Null()]);
const isoInstant = Type.String({ minLength: 1 });
const nullableInstant = Type.Union([isoInstant, Type.Null()]);
const cents = Type.Integer();
const count = Type.Integer();
const flag = Type.Boolean();

export const M35_OUTBOX_EVENTS: ModuleEventContribution = [
  // ── subscription lifecycle (§2.2 / §4.11) ────────────────────────────────────────────────────────
  {
    eventName: "m35.subscription.created",
    moduleOwner: "m35",
    description: "A subscription was created for a tenant (plan selected; trialing or active).",
    payloadSchema: Type.Object({
      subscriptionId: id,
      organizationId: id,
      planSlug: id,
      startedAt: isoInstant,
    }),
    // F-132 (#248) — m34 REMOVED: M34's own spec quantifies its M35 consumption precisely — "The four
    // seams M34 publishes plus the ONE M34 consumes from M35 (deny-stub today)" — naming
    // `TenantSubscriptionEntitlementReader` as that one thing. A quantified "ONE" directly contradicts
    // nine separate outbox subscriptions; M35's own repeated "M34 (when locked) consumes" phrasing across
    // its spec is the aspirational producing-side guess the F-101 rule exists to override with the
    // consuming module's own (more specific, more authoritative) accounting.
    declaredConsumers: [],
    seamConsumers: ["m33", "m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m35.subscription.activated",
    moduleOwner: "m35",
    description: "A subscription transitioned from trialing to active.",
    payloadSchema: Type.Object({ subscriptionId: id, organizationId: id, activatedAt: isoInstant }),
    // F-132 (#248) — m34 REMOVED: same reasoning as `m35.subscription.created` above.
    declaredConsumers: [],
    seamConsumers: ["m33", "m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m35.subscription.status_changed",
    moduleOwner: "m35",
    description: "Every subscription status transition (from/to + reason code).",
    payloadSchema: Type.Object({
      subscriptionId: id,
      organizationId: id,
      fromStatus: id,
      toStatus: id,
      transitionedAt: isoInstant,
      reasonCode: id,
    }),
    // F-132 (#248) — m34 REMOVED: same reasoning as `m35.subscription.created` above.
    declaredConsumers: [],
    seamConsumers: ["m33", "m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m35.subscription.plan_changed",
    moduleOwner: "m35",
    description: "A subscription changed plans (upgrade/downgrade) with a proration behavior.",
    payloadSchema: Type.Object({
      subscriptionId: id,
      organizationId: id,
      fromPlanSlug: id,
      toPlanSlug: id,
      prorationBehavior: id,
      effectiveAt: isoInstant,
    }),
    // F-132 (#248) — m34 REMOVED: same reasoning as `m35.subscription.created` above.
    declaredConsumers: [],
    seamConsumers: ["m33", "m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m35.subscription.canceled",
    moduleOwner: "m35",
    description: "A subscription was canceled (at period end or immediately).",
    payloadSchema: Type.Object({
      subscriptionId: id,
      organizationId: id,
      canceledAt: isoInstant,
      reasonCode: id,
      atPeriodEnd: flag,
    }),
    // F-132 (#248) — m34 REMOVED: same reasoning as `m35.subscription.created` above.
    declaredConsumers: [],
    seamConsumers: ["m33", "m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m35.subscription.paused",
    moduleOwner: "m35",
    description: "A subscription was paused (optionally until a resume date).",
    payloadSchema: Type.Object({
      subscriptionId: id,
      organizationId: id,
      pausedAt: isoInstant,
      pausedUntil: nullableInstant,
    }),
    // F-132 (#248) — m34 REMOVED: same reasoning as `m35.subscription.created` above.
    declaredConsumers: [],
    seamConsumers: ["m33", "m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m35.subscription.resumed",
    moduleOwner: "m35",
    description: "A subscription resumed from paused.",
    payloadSchema: Type.Object({ subscriptionId: id, organizationId: id, resumedAt: isoInstant }),
    // F-132 (#248) — m34 REMOVED: same reasoning as `m35.subscription.created` above.
    declaredConsumers: [],
    seamConsumers: ["m33", "m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m35.subscription.suspended",
    moduleOwner: "m35",
    description: "A subscription was suspended at dunning day-28 (billing blocked).",
    payloadSchema: Type.Object({
      subscriptionId: id,
      organizationId: id,
      suspendedAt: isoInstant,
      reasonCode: id,
      lastSuccessfulPaymentAt: nullableInstant,
    }),
    // F-132 (#248) — m34 REMOVED: same reasoning as `m35.subscription.created` above.
    declaredConsumers: [],
    seamConsumers: ["m33", "m36"],
    isOutboxOnly: true,
  },
  // ── dunning (§4.15 / §4.11) ──────────────────────────────────────────────────────────────────────
  {
    eventName: "m35.dunning.entered_stage",
    moduleOwner: "m35",
    description: "The dunning state machine advanced to a new stage.",
    payloadSchema: Type.Object({
      subscriptionId: id,
      organizationId: id,
      fromStage: id,
      toStage: id,
      enteredAt: isoInstant,
      nextAttemptAt: nullableInstant,
    }),
    declaredConsumers: [],
    seamConsumers: ["m33", "m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m35.dunning.resolved",
    moduleOwner: "m35",
    description: "Dunning exited to resolved (payment succeeded / admin reset).",
    payloadSchema: Type.Object({
      subscriptionId: id,
      organizationId: id,
      resolvedAt: isoInstant,
      lastStage: id,
    }),
    declaredConsumers: [],
    seamConsumers: ["m33", "m36"],
    isOutboxOnly: true,
  },
  // ── invoice mirror (§2.2 / §4.11) ────────────────────────────────────────────────────────────────
  {
    eventName: "m35.invoice.created",
    moduleOwner: "m35",
    description: "A Stripe invoice was mirrored (webhook invoice.created).",
    payloadSchema: Type.Object({
      invoiceId: id,
      organizationId: id,
      stripeInvoiceId: id,
      totalCents: cents,
      periodStart: nullableInstant,
      periodEnd: nullableInstant,
    }),
    declaredConsumers: [],
    seamConsumers: ["m33", "m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m35.invoice.paid",
    moduleOwner: "m35",
    description: "An invoice was paid (webhook invoice.paid).",
    payloadSchema: Type.Object({
      invoiceId: id,
      organizationId: id,
      paidAt: isoInstant,
      amountPaidCents: cents,
    }),
    // F-141 (#248) — m29 dropped: no support anywhere in M29's spec; the real M29↔M35 relationship
    // runs the opposite direction and is a seam, not a push — M29 publishes
    // `ExternalInterfaceMetricsProvider.feedHealthForOrg` for M35's own Phase-2 quota metering.
    declaredConsumers: [],
    seamConsumers: ["m33", "m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m35.invoice.payment_failed",
    moduleOwner: "m35",
    description: "An invoice payment failed (webhook invoice.payment_failed).",
    payloadSchema: Type.Object({
      invoiceId: id,
      organizationId: id,
      failureCode: id,
      attemptCount: count,
      nextAttemptAt: nullableInstant,
    }),
    declaredConsumers: [],
    seamConsumers: ["m33", "m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m35.invoice.voided",
    moduleOwner: "m35",
    description: "An invoice was voided (webhook invoice.voided).",
    payloadSchema: Type.Object({
      invoiceId: id,
      organizationId: id,
      voidedAt: isoInstant,
      voidedByMembershipId: nullableId,
    }),
    declaredConsumers: [],
    seamConsumers: ["m33", "m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m35.invoice.uncollectible",
    moduleOwner: "m35",
    description: "An invoice was marked uncollectible (webhook invoice.marked_uncollectible).",
    payloadSchema: Type.Object({ invoiceId: id, organizationId: id, markedAt: isoInstant }),
    declaredConsumers: [],
    seamConsumers: ["m33", "m36"],
    isOutboxOnly: true,
  },
  // ── payment method (§4.11) ───────────────────────────────────────────────────────────────────────
  {
    eventName: "m35.payment_method.added",
    moduleOwner: "m35",
    description: "A payment method was attached to the org.",
    payloadSchema: Type.Object({
      paymentMethodId: id,
      organizationId: id,
      kind: id,
      isDefault: flag,
    }),
    declaredConsumers: [],
    seamConsumers: ["m33", "m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m35.payment_method.expiring_soon",
    moduleOwner: "m35",
    description: "A payment method is expiring within the watch window.",
    payloadSchema: Type.Object({
      paymentMethodId: id,
      organizationId: id,
      expiresAt: isoInstant,
      daysUntilExpiry: count,
    }),
    declaredConsumers: [],
    seamConsumers: ["m33", "m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m35.payment_method.expired",
    moduleOwner: "m35",
    description: "A payment method's expiry date passed.",
    payloadSchema: Type.Object({ paymentMethodId: id, organizationId: id, expiredAt: isoInstant }),
    declaredConsumers: [],
    seamConsumers: ["m33", "m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m35.payment_method.removed",
    moduleOwner: "m35",
    description: "A payment method was detached (soft-deleted).",
    payloadSchema: Type.Object({
      paymentMethodId: id,
      organizationId: id,
      deactivatedAt: isoInstant,
    }),
    declaredConsumers: [],
    seamConsumers: ["m33", "m36"],
    isOutboxOnly: true,
  },
  // ── usage metering (§4.11) ───────────────────────────────────────────────────────────────────────
  {
    eventName: "m35.usage.period_closed",
    moduleOwner: "m35",
    description: "A usage period closed; per-meter totals attached.",
    payloadSchema: Type.Object({
      subscriptionId: id,
      organizationId: id,
      periodStart: isoInstant,
      periodEnd: isoInstant,
      meterTotals: Type.Array(Type.Object({ eventType: id, totalQuantity: count })),
    }),
    declaredConsumers: [],
    seamConsumers: ["m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m35.usage.overage_threshold_warning",
    moduleOwner: "m35",
    description: "A meter crossed 80% of its inclusive quantity.",
    payloadSchema: Type.Object({
      subscriptionId: id,
      organizationId: id,
      eventType: id,
      totalQuantity: count,
      inclusiveQuantity: count,
      projectedOverageCents: cents,
    }),
    declaredConsumers: [],
    seamConsumers: ["m33", "m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m35.usage.overage_threshold_breached",
    moduleOwner: "m35",
    description: "A meter crossed 100% of its inclusive quantity (overage billing begins).",
    payloadSchema: Type.Object({
      subscriptionId: id,
      organizationId: id,
      eventType: id,
      totalQuantity: count,
      inclusiveQuantity: count,
    }),
    declaredConsumers: [],
    seamConsumers: ["m33", "m36"],
    isOutboxOnly: true,
  },
  // ── refund four-stage workflow (§D16 / §4.11) ────────────────────────────────────────────────────
  {
    eventName: "m35.refund.requested",
    moduleOwner: "m35",
    description: "A refund was requested against an invoice.",
    payloadSchema: Type.Object({
      refundId: id,
      organizationId: id,
      invoiceId: id,
      amountCents: cents,
      requestedByMembershipId: id,
      reasonCode: id,
    }),
    declaredConsumers: [],
    seamConsumers: ["m33", "m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m35.refund.approved",
    moduleOwner: "m35",
    description: "A refund was approved (step-up + four-eyes).",
    payloadSchema: Type.Object({
      refundId: id,
      organizationId: id,
      approvedByMembershipId: id,
      approvedAt: isoInstant,
    }),
    declaredConsumers: [],
    seamConsumers: ["m33", "m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m35.refund.executed",
    moduleOwner: "m35",
    description: "A refund executed successfully at Stripe.",
    payloadSchema: Type.Object({
      refundId: id,
      organizationId: id,
      executedAt: isoInstant,
      amountCents: cents,
      stripeRefundId: id,
    }),
    // F-141 (#248) — m29 dropped: same reasoning as `invoice.paid` above.
    declaredConsumers: [],
    seamConsumers: ["m33", "m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m35.refund.failed",
    moduleOwner: "m35",
    description: "A refund failed to execute at Stripe.",
    payloadSchema: Type.Object({
      refundId: id,
      organizationId: id,
      failedAt: isoInstant,
      stripeFailureCode: id,
    }),
    declaredConsumers: [],
    seamConsumers: ["m33", "m36"],
    isOutboxOnly: true,
  },
  // ── promo (§4.11) ────────────────────────────────────────────────────────────────────────────────
  {
    eventName: "m35.promo.applied",
    moduleOwner: "m35",
    description: "A promo code was applied to a subscription.",
    payloadSchema: Type.Object({
      applicationId: id,
      organizationId: id,
      subscriptionId: id,
      promoCode: id,
      appliedByMembershipId: id,
    }),
    declaredConsumers: [],
    seamConsumers: ["m33", "m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m35.promo.expired",
    moduleOwner: "m35",
    description: "A promo application reached the end of its duration.",
    payloadSchema: Type.Object({ applicationId: id, organizationId: id, expiredAt: isoInstant }),
    declaredConsumers: [],
    seamConsumers: ["m33"],
    isOutboxOnly: true,
  },
  // ── stripe adapter internal + failure (§4.13/§4.14 / §4.11) ──────────────────────────────────────
  {
    eventName: "m35.stripe.webhook_received",
    moduleOwner: "m35",
    description: "A verified, non-duplicate Stripe webhook was received (internal handler signal).",
    payloadSchema: Type.Object({
      stripeEventId: id,
      eventType: id,
      receivedAt: isoInstant,
      derivedOrganizationId: nullableId,
    }),
    declaredConsumers: [],
    isOutboxOnly: true,
  },
  {
    eventName: "m35.stripe.api_call_failed",
    moduleOwner: "m35",
    description: "An outbound Stripe API call failed permanently (DLQ + alert).",
    payloadSchema: Type.Object({
      apiCallAuditId: id,
      operation: id,
      organizationId: nullableId,
      attemptIndex: count,
      errorText: id,
    }),
    declaredConsumers: [],
    seamConsumers: ["m33", "m36"],
    isOutboxOnly: true,
  },
  // ── tenant billing gate + revenue (§4.11) ────────────────────────────────────────────────────────
  {
    eventName: "m35.tenant.billing_blocked",
    moduleOwner: "m35",
    description:
      "A tenant was billing-blocked at dunning day-28 suspension (M34 consumes the gate).",
    payloadSchema: Type.Object({
      organizationId: id,
      subscriptionId: id,
      blockedAt: isoInstant,
      dunningStage: id,
    }),
    // F-132 (#248) — m34 REMOVED: same reasoning as `m35.subscription.created` above — M34's own spec
    // counts its whole M35 consumption as "the ONE" (the entitlement-reader seam), which this isn't.
    declaredConsumers: [],
    seamConsumers: ["m33", "m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m35.revenue.monthly_snapshot_computed",
    moduleOwner: "m35",
    description: "The monthly MRR/ARR snapshot was computed (platform-ops dashboard).",
    payloadSchema: Type.Object({
      snapshotId: id,
      snapshotMonth: id,
      mrrCents: cents,
      arrCents: cents,
      activeSubscriptions: count,
    }),
    declaredConsumers: [],
    seamConsumers: ["m33"],
    isOutboxOnly: true,
  },
];
