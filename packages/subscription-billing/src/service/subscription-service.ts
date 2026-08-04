// @wardenx/subscription-billing — §2.2 subscription lifecycle service (pure over ports, M35-T03).
//
// Walks a `subscription` row through the D7 status graph. The pure transition legality lives in
// `../domain/subscription-lifecycle` (`canTransitionSubscription`); this service adds the DB-facing
// obligations the FSM alone cannot express: the §2.2 "trialing-if-trial-days-else-active" initial state,
// the §2.3 grandfathering rule on the referenced plan (`isPlanReferenceEligible`), the append-only
// `subscription_state_history` write on every edge, and the §2.4 side-effect table's outbox mapping.
//
// The store owns the §2.5 `SELECT ... FOR UPDATE` lock + the RLS session; this service is deterministic
// given (store, now, input) — the routes/cron/webhook handlers in T06 supply the real Drizzle store and
// publish the returned {@link OutboxIntent}s. NOTHING here calls Stripe (that is the T04 dispatcher) or
// registers a seam (T05).

import type { IsoInstant, MembershipId, OrgId, PlanId, SubscriptionStatus } from "@wardenx/types";
import {
  canTransitionSubscription,
  isTerminalSubscriptionStatus,
} from "../domain/subscription-lifecycle";
import { isPlanReferenceEligible } from "../domain/validation";
import {
  type DunningContext,
  type OutboxIntent,
  type SubscriptionRecord,
  type SubscriptionStore,
  outboxIntent,
} from "./ports";

/** The reason a transition attempt was refused (surfaced as a typed error, not a thrown string). */
export class SubscriptionTransitionError extends Error {
  constructor(
    readonly code: "not_found" | "terminal_status" | "illegal_transition" | "plan_not_eligible",
    message: string,
  ) {
    super(message);
    this.name = "SubscriptionTransitionError";
  }
}

export interface CreateSubscriptionInput {
  readonly organizationId: OrgId;
  readonly planId: PlanId;
  readonly actorMembershipId: MembershipId | null;
  readonly now: Date;
}

export interface CreateSubscriptionResult {
  readonly subscription: SubscriptionRecord;
  readonly outbox: OutboxIntent[];
}

export interface TransitionInput {
  readonly subscriptionId: string;
  readonly toStatus: SubscriptionStatus;
  readonly actorMembershipId: MembershipId | null;
  readonly reasonCode: string;
  readonly stripeEventId: string | null;
  /** `true` when a cancel is scheduled at period end rather than immediate (§2.4). */
  readonly cancelAtPeriodEnd?: boolean;
  /** The current dunning stage (folded into `m35.tenant.billing_blocked` on a `suspended` edge). */
  readonly dunning?: DunningContext;
  readonly now: Date;
}

export interface TransitionResult {
  readonly from: SubscriptionStatus;
  readonly to: SubscriptionStatus;
  readonly outbox: OutboxIntent[];
}

export class SubscriptionLifecycleService {
  constructor(private readonly store: SubscriptionStore) {}

  /**
   * §2.2 create — Initial state is `trialing` iff the plan has `trial_period_days > 0` (D12), else `active`.
   * Grandfathering (§2.3): a NEW subscription may only reference an `active` plan, never a `deprecated` one.
   */
  async createSubscription(input: CreateSubscriptionInput): Promise<CreateSubscriptionResult> {
    const plan = await this.store.planEligibility(input.planId);
    if (
      !plan ||
      !isPlanReferenceEligible({
        planIsActive: plan.isActive,
        planIsDeprecated: plan.isDeprecated,
        isNewSubscription: true,
      })
    ) {
      throw new SubscriptionTransitionError(
        "plan_not_eligible",
        `plan ${input.planId} is not eligible for a new subscription (must be active)`,
      );
    }

    const status: SubscriptionStatus = plan.trialPeriodDays > 0 ? "trialing" : "active";
    const subscription = await this.store.insertSubscription({
      organizationId: input.organizationId,
      plan,
      status,
    });

    await this.store.appendStateHistory({
      subscriptionId: subscription.id,
      organizationId: input.organizationId,
      fromStatus: null,
      toStatus: status,
      transitionedAt: input.now,
      actorMembershipId: input.actorMembershipId,
      reasonCode: "subscription_created",
      stripeEventId: null,
    });

    const iso = input.now.toISOString() as IsoInstant;
    const outbox: OutboxIntent[] = [
      outboxIntent("m35.subscription.created", {
        subscriptionId: subscription.id,
        organizationId: input.organizationId,
        planSlug: plan.slug,
        startedAt: iso,
      }),
    ];

    return { subscription, outbox };
  }

  /**
   * §2.2 transition — validate the D7 edge, append `subscription_state_history`, and map the target status
   * onto the §2.4 outbox events. Rejects a leave-terminal (`canceled`) or FSM-illegal edge with a typed
   * {@link SubscriptionTransitionError}; a "reactivation" is a fresh `createSubscription`, never a
   * `canceled → …` edge.
   */
  async transition(input: TransitionInput): Promise<TransitionResult> {
    const current = await this.store.loadForUpdate(input.subscriptionId);
    if (!current) {
      throw new SubscriptionTransitionError(
        "not_found",
        `subscription ${input.subscriptionId} not found`,
      );
    }
    const from = current.status;

    if (isTerminalSubscriptionStatus(from)) {
      throw new SubscriptionTransitionError(
        "terminal_status",
        `subscription ${input.subscriptionId} is ${from} (terminal); reactivation creates a new subscription`,
      );
    }
    if (!canTransitionSubscription(from, input.toStatus)) {
      throw new SubscriptionTransitionError(
        "illegal_transition",
        `illegal subscription transition ${from} → ${input.toStatus}`,
      );
    }

    await this.store.updateStatus({
      subscriptionId: input.subscriptionId,
      toStatus: input.toStatus,
      cancelAtPeriodEnd: input.cancelAtPeriodEnd,
    });
    await this.store.appendStateHistory({
      subscriptionId: input.subscriptionId,
      organizationId: current.organizationId,
      fromStatus: from,
      toStatus: input.toStatus,
      transitionedAt: input.now,
      actorMembershipId: input.actorMembershipId,
      reasonCode: input.reasonCode,
      stripeEventId: input.stripeEventId,
    });

    return {
      from,
      to: input.toStatus,
      outbox: buildTransitionOutbox(from, input, current),
    };
  }

  /**
   * §2.2 plan change — validate the target plan (§2.3: an EXISTING subscription may move onto a
   * `deprecated` plan, a new one may not; both may use `active`), mirror the plan header, record the edge,
   * and emit `m35.subscription.plan_changed`.
   */
  async changePlan(input: {
    subscriptionId: string;
    toPlanId: PlanId;
    prorationBehavior: "create_prorations" | "none" | "always_invoice";
    actorMembershipId: MembershipId | null;
    now: Date;
  }): Promise<{ from: SubscriptionRecord; toPlanSlug: string; outbox: OutboxIntent[] }> {
    const current = await this.store.loadForUpdate(input.subscriptionId);
    if (!current) {
      throw new SubscriptionTransitionError(
        "not_found",
        `subscription ${input.subscriptionId} not found`,
      );
    }
    const plan = await this.store.planEligibility(input.toPlanId);
    if (
      !plan ||
      !isPlanReferenceEligible({
        planIsActive: plan.isActive,
        planIsDeprecated: plan.isDeprecated,
        isNewSubscription: false,
      })
    ) {
      throw new SubscriptionTransitionError(
        "plan_not_eligible",
        `plan ${input.toPlanId} is not eligible (must be active or deprecated)`,
      );
    }

    await this.store.updatePlan({ subscriptionId: input.subscriptionId, plan });
    await this.store.appendStateHistory({
      subscriptionId: input.subscriptionId,
      organizationId: current.organizationId,
      fromStatus: current.status,
      toStatus: current.status,
      transitionedAt: input.now,
      actorMembershipId: input.actorMembershipId,
      reasonCode: "plan_changed",
      stripeEventId: null,
    });

    return {
      from: current,
      toPlanSlug: plan.slug,
      outbox: [
        outboxIntent("m35.subscription.plan_changed", {
          subscriptionId: input.subscriptionId,
          organizationId: current.organizationId,
          fromPlanSlug: current.planSlug,
          toPlanSlug: plan.slug,
          prorationBehavior: input.prorationBehavior,
          effectiveAt: input.now.toISOString() as IsoInstant,
        }),
      ],
    };
  }
}

/** §2.4 the target-status → outbox mapping (pure; exported for the reconciler + webhook handler to reuse). */
export function buildTransitionOutbox(
  from: SubscriptionStatus,
  input: TransitionInput,
  subscription: SubscriptionRecord,
): OutboxIntent[] {
  const iso = input.now.toISOString() as IsoInstant;
  const orgId = subscription.organizationId;
  const subId = subscription.id;
  const out: OutboxIntent[] = [];

  switch (input.toStatus) {
    case "active":
      if (from === "trialing") {
        out.push(
          outboxIntent("m35.subscription.activated", {
            subscriptionId: subId,
            organizationId: orgId,
            activatedAt: iso,
          }),
        );
      } else if (from === "paused") {
        out.push(
          outboxIntent("m35.subscription.resumed", {
            subscriptionId: subId,
            organizationId: orgId,
            resumedAt: iso,
          }),
        );
      }
      break;
    case "paused":
      out.push(
        outboxIntent("m35.subscription.paused", {
          subscriptionId: subId,
          organizationId: orgId,
          pausedAt: iso,
          pausedUntil: null,
        }),
      );
      break;
    case "suspended":
      out.push(
        outboxIntent("m35.subscription.suspended", {
          subscriptionId: subId,
          organizationId: orgId,
          suspendedAt: iso,
          reasonCode: input.reasonCode,
          lastSuccessfulPaymentAt: null,
        }),
        outboxIntent("m35.tenant.billing_blocked", {
          organizationId: orgId,
          subscriptionId: subId,
          blockedAt: iso,
          dunningStage: input.dunning?.dunningStage ?? "day_28_suspend",
        }),
      );
      break;
    case "canceled":
      out.push(
        outboxIntent("m35.subscription.canceled", {
          subscriptionId: subId,
          organizationId: orgId,
          canceledAt: iso,
          reasonCode: input.reasonCode,
          atPeriodEnd: input.cancelAtPeriodEnd ?? false,
        }),
      );
      break;
    default:
      break;
  }

  // Every status change also emits the generic `status_changed` header (M33/M34 read this).
  out.push(
    outboxIntent("m35.subscription.status_changed", {
      subscriptionId: subId,
      organizationId: orgId,
      fromStatus: from,
      toStatus: input.toStatus,
      transitionedAt: iso,
      reasonCode: input.reasonCode,
    }),
  );
  return out;
}
