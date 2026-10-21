// @chartwarden/subscription-billing — §2 lifecycle-service PORTS + outbox intents (M35-T03).
//
// The T03 lifecycle services (subscription / invoice / usage-metering / revenue / platform-retention) are
// PURE over these injected ports — exactly the M28-T03/T04 idiom (cores IO-free; the routes/workers in
// M35-T06 own the Drizzle store impls, the `SELECT ... FOR UPDATE` row locks of §2.5, the `withOrgContext`
// RLS, the M4 `audit()` calls, and the actual outbox publication). Keeping the ports here means the §2.2
// transition graphs + the §2.3 penny-exact invariants are testable with an in-memory fake, no DB.
//
// The store ports carry LEAN record shapes — only the fields the domain logic reads/writes — deliberately
// NOT the full Drizzle row (the T02 schema owns the column truth). A store impl maps its row onto/off these.
//
// PHI/secrets boundary: no port shape here carries a raw `patient_id` / `membership_id`, a card PAN, or a
// Stripe secret. Usage active-period ports accept a pre-computed {@link BillingPseudonym} only (D6/§8.4).

import type {
  BillingCadence,
  BillingPseudonym,
  BillingYearMonth,
  DunningStage,
  InvoiceLineKind,
  InvoiceStatus,
  M35EventName,
  M35EventPayloadMap,
  OrgId,
  PlanId,
  PlanTier,
  SubscriptionId,
  SubscriptionStatus,
  UsageEventInput,
  UsageEventSourceModule,
  UsageEventType,
} from "@chartwarden/types";

// ── Outbox intent — the deferred publication a lifecycle service RETURNS (T06 drains it into M1's outbox) ─

/** One typed `(eventName, payload)` a service asks its caller to publish. `eventName` keys the payload type
 *  off {@link M35EventPayloadMap}, so a wrong payload for an event is a compile error (the dispatcher's
 *  compile-time contract, surfaced up here). */
export interface OutboxIntent<E extends M35EventName = M35EventName> {
  readonly eventName: E;
  readonly payload: M35EventPayloadMap[E];
}

/** Helper: build a strongly-typed {@link OutboxIntent} (narrows the payload to the event's shape). */
export function outboxIntent<E extends M35EventName>(
  eventName: E,
  payload: M35EventPayloadMap[E],
): OutboxIntent<E> {
  return { eventName, payload };
}

// ── Subscription store port (§2.2 subscription + §2.5 row-lock semantics owned by the impl) ─────────────

/** The lean subscription row the §2.2 lifecycle reads/writes (a subset of the T02 `subscription` table). */
export interface SubscriptionRecord {
  readonly id: SubscriptionId;
  readonly organizationId: OrgId;
  readonly planId: PlanId;
  readonly planSlug: string;
  readonly planTier: PlanTier;
  readonly status: SubscriptionStatus;
  readonly cadence: BillingCadence;
  readonly basePriceCents: number;
  readonly cancelAtPeriodEnd: boolean;
}

/** The append-only `subscription_state_history` row a transition writes (§2.2). */
export interface SubscriptionStateHistoryInsert {
  readonly subscriptionId: SubscriptionId;
  readonly organizationId: OrgId;
  readonly fromStatus: SubscriptionStatus | null;
  readonly toStatus: SubscriptionStatus;
  readonly transitionedAt: Date;
  readonly actorMembershipId: string | null;
  readonly reasonCode: string;
  readonly stripeEventId: string | null;
}

/** Eligibility facts about a plan a new/changed subscription references (§2.3 grandfathering rule). */
export interface PlanEligibilityFacts {
  readonly planId: PlanId;
  readonly slug: string;
  readonly tier: PlanTier;
  readonly cadence: BillingCadence;
  readonly basePriceCents: number;
  readonly trialPeriodDays: number;
  readonly isActive: boolean;
  readonly isDeprecated: boolean;
}

export interface SubscriptionStore {
  /** Load the subscription under the §2.5 `SELECT ... FOR UPDATE` lock (the impl owns the lock). */
  loadForUpdate(subscriptionId: SubscriptionId): Promise<SubscriptionRecord | null>;
  /** The active (non-canceled/paused) subscription for an org, if any (partial-unique-index domain). */
  activeForOrg(organizationId: OrgId): Promise<SubscriptionRecord | null>;
  /** Resolve the eligibility facts for a plan the caller wants to reference. */
  planEligibility(planId: PlanId): Promise<PlanEligibilityFacts | null>;
  /** Insert the initial subscription row (returns the persisted record). */
  insertSubscription(input: {
    organizationId: OrgId;
    plan: PlanEligibilityFacts;
    status: SubscriptionStatus;
  }): Promise<SubscriptionRecord>;
  /** Update `status` (+ `cancel_at_period_end` when a cancel is scheduled). */
  updateStatus(input: {
    subscriptionId: SubscriptionId;
    toStatus: SubscriptionStatus;
    cancelAtPeriodEnd?: boolean;
  }): Promise<void>;
  /** Update `plan_id` (+ mirror plan header fields) on a plan change. */
  updatePlan(input: { subscriptionId: SubscriptionId; plan: PlanEligibilityFacts }): Promise<void>;
  /** Append a `subscription_state_history` row. */
  appendStateHistory(row: SubscriptionStateHistoryInsert): Promise<void>;
}

// ── Invoice store port (§2.2 invoice mirror + §2.3 reconciler invariants owned by the impl) ─────────────

export interface InvoiceMirrorRecord {
  readonly id: string;
  readonly organizationId: OrgId;
  readonly stripeInvoiceId: string;
  readonly status: InvoiceStatus;
  readonly subtotalCents: number;
  readonly taxCents: number;
  readonly totalCents: number;
  readonly amountPaidCents: number;
}

export interface InvoiceLineMirrorInput {
  readonly stripeLineId: string;
  readonly kind: InvoiceLineKind;
  readonly description: string;
  readonly quantity: number;
  readonly unitAmountCents: number;
  readonly totalCents: number;
}

export interface InvoiceStore {
  invoiceByStripeId(stripeInvoiceId: string): Promise<InvoiceMirrorRecord | null>;
  upsertInvoice(input: {
    organizationId: OrgId;
    stripeInvoiceId: string;
    status: InvoiceStatus;
    subtotalCents: number;
    taxCents: number;
    totalCents: number;
    amountPaidCents: number;
    periodStart: Date | null;
    periodEnd: Date | null;
    paidAt: Date | null;
  }): Promise<InvoiceMirrorRecord>;
  replaceInvoiceLines(input: {
    invoiceId: string;
    lines: readonly InvoiceLineMirrorInput[];
  }): Promise<void>;
}

// ── Usage store port (§2.2 append-only ledger + §2.6 three-level idempotency owned by the impl) ─────────

export interface UsageEventStore {
  /** True iff `(organizationId, sourceModule, sourceEventId)` was already ingested (§2.6 idempotency). */
  usageEventExists(input: {
    organizationId: OrgId;
    sourceModule: UsageEventSourceModule;
    sourceEventId: string;
  }): Promise<boolean>;
  /** Append one `usage_event` row (partitioned-by-month insert; the impl routes the partition). */
  insertUsageEvent(input: {
    organizationId: OrgId;
    eventType: UsageEventType;
    quantity: number;
    sourceModule: UsageEventSourceModule;
    sourceEventId: string | null;
    recordedAt: Date;
  }): Promise<void>;
}

/** The active-period upsert (§2.6 idempotent on `(organizationId, pseudonym, periodYearMonth)`). */
export interface ActivePeriodStore {
  /** Upsert a `patient_active_period` row; `false` if the (org, pseudonym, month) row already existed. */
  upsertPatientActivePeriod(input: {
    organizationId: OrgId;
    patientPseudonym: BillingPseudonym;
    pseudonymKeyEpoch: string;
    periodYearMonth: BillingYearMonth;
    becameActiveAt: Date;
  }): Promise<{ inserted: boolean }>;
  /** Upsert a `user_active_period` row; `false` if the (org, pseudonym, month) row already existed. */
  upsertUserActivePeriod(input: {
    organizationId: OrgId;
    membershipPseudonym: BillingPseudonym;
    pseudonymKeyEpoch: string;
    periodYearMonth: BillingYearMonth;
    becameActiveAt: Date;
  }): Promise<{ inserted: boolean }>;
}

/** The M35-private active pseudonym key (T06 reads `patient_pseudonym_key` + KMS-decrypts the material). */
export interface PseudonymKeyProvider {
  activeKey(): Promise<{ keyEpoch: string; keyMaterial: string }>;
}

// ── Revenue store port (§D18 monthly MRR/ARR snapshot) ─────────────────────────────────────────────────

/** One subscription's contribution to a month's MRR (the normalized monthly cents + its status bucket). */
export interface RevenueContribution {
  readonly subscriptionId: SubscriptionId;
  readonly status: SubscriptionStatus;
  readonly monthlyCents: number;
}

export interface RevenueSnapshotRecord {
  readonly id: string;
  readonly snapshotMonth: BillingYearMonth;
  readonly mrrCents: number;
  readonly arrCents: number;
  readonly activeSubscriptions: number;
  readonly computedAt: Date;
}

export interface RevenueStore {
  /** Every subscription's current monthly contribution (the impl reads `subscription` × `plan`). */
  currentContributions(): Promise<RevenueContribution[]>;
  /** The prior-month contribution map (`subscriptionId → monthlyCents`) for new/expansion/contraction/churn. */
  priorMonthContributions(priorYearMonth: BillingYearMonth): Promise<Map<SubscriptionId, number>>;
  /** Persist the computed snapshot (append-only; unique on `snapshot_month`). */
  insertSnapshot(input: {
    snapshotMonth: BillingYearMonth;
    mrrCents: number;
    arrCents: number;
    newMrrCents: number;
    expansionMrrCents: number;
    contractionMrrCents: number;
    churnMrrCents: number;
    activeSubscriptions: number;
    trialingSubscriptions: number;
    pastDueSubscriptions: number;
    computedAt: Date;
  }): Promise<RevenueSnapshotRecord>;
}

// ── Platform-retention store port (§3.7 / M35-F06 copy-then-delete transfer) ────────────────────────────

/** A tenant `invoice` + its `invoice_line` rows, read for transfer to the platform-retention tables. */
export interface RetainableInvoice {
  readonly id: string;
  readonly stripeInvoiceId: string;
  readonly invoiceNumber: string | null;
  readonly status: InvoiceStatus;
  readonly subtotalCents: number;
  readonly taxCents: number;
  readonly totalCents: number;
  readonly amountPaidCents: number;
  readonly currencyCode: string;
  readonly periodStart: Date | null;
  readonly periodEnd: Date | null;
  readonly issuedAt: Date | null;
  readonly paidAt: Date | null;
  readonly lines: readonly RetainableInvoiceLine[];
}

export interface RetainableInvoiceLine {
  readonly id: string;
  readonly stripeLineId: string;
  readonly kind: InvoiceLineKind;
  readonly description: string;
  readonly quantity: number;
  readonly unitAmountCents: number;
  readonly totalCents: number;
  readonly periodStart: Date | null;
  readonly periodEnd: Date | null;
  readonly meterEventType: UsageEventType | null;
}

export interface PlatformRetentionStore {
  /** All tenant invoices (with their lines) for an org, read prior to the copy-then-delete transfer. */
  tenantInvoicesForOrg(organizationId: OrgId): Promise<RetainableInvoice[]>;
  /** Copy one invoice into `platform_retained_invoice`, returning the new retained-invoice id. */
  insertRetainedInvoice(input: {
    originalInvoiceId: string;
    originalOrganizationId: OrgId;
    transferredAt: Date;
    retainUntil: Date;
    invoice: RetainableInvoice;
  }): Promise<{ retainedInvoiceId: string }>;
  /** Copy one invoice's lines into `platform_retained_invoice_line` under the retained-invoice parent. */
  insertRetainedInvoiceLines(input: {
    retainedInvoiceId: string;
    originalInvoiceId: string;
    originalOrganizationId: OrgId;
    transferredAt: Date;
    retainUntil: Date;
    lines: readonly RetainableInvoiceLine[];
  }): Promise<void>;
  /** Delete the source tenant `invoice_line` + `invoice` rows AFTER the copy has committed (FK order). */
  deleteTenantInvoice(input: { organizationId: OrgId; invoiceId: string }): Promise<void>;
}

// ── Dunning store port (§4.15 D7 dunning ladder; §2.5 open-row lock owned by the impl) ───────────────────

/** The lean open `dunning_state` row the §4.15 engine reads/writes (a subset of the T02 `dunning_state`
 *  table — the `exited_at IS NULL` open row per subscription). */
export interface DunningStateRecord {
  readonly id: string;
  readonly organizationId: OrgId;
  readonly subscriptionId: SubscriptionId;
  readonly stage: DunningStage;
  readonly attemptCount: number;
  readonly enteredAt: Date;
  readonly triggerInvoiceId: string | null;
}

export interface DunningStore {
  /** The OPEN (`exited_at IS NULL`) dunning row for a subscription under the §2.5 lock, or null if none. */
  openForSubscription(subscriptionId: SubscriptionId): Promise<DunningStateRecord | null>;
  /** Close the current open row (`exited_at = now`, `exit_reason`) AND insert the new-stage open row in one
   *  step (the impl owns the transaction). Returns the newly-inserted open row. */
  enterStage(input: {
    organizationId: OrgId;
    subscriptionId: SubscriptionId;
    fromRowId: string | null;
    toStage: DunningStage;
    enteredAt: Date;
    nextAttemptAt: Date | null;
    attemptCount: number;
    triggerInvoiceId: string | null;
    lastAttemptFailureCode: string | null;
    /** The reason stamped on the CLOSED prior row's `exit_reason` (`advanced`/`skipped`/`reset`). */
    exitReason: string | null;
  }): Promise<DunningStateRecord>;
  /** Close the open row without opening a new one (payment succeeded / admin reset). */
  closeOpen(input: { rowId: string; exitedAt: Date; exitReason: string }): Promise<void>;
}

// ── Re-export the leaf usage-input shape so the metering service's signature is a single import site ─────
export type { UsageEventInput };

/** The dunning-linked billing-block context a suspension transition folds into `m35.tenant.billing_blocked`. */
export interface DunningContext {
  readonly dunningStage: DunningStage;
}
