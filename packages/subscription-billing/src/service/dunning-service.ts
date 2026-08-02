// @wardenx/subscription-billing — §4.15 dunning state machine (D7) service (pure over ports, M35-T05).
//
// Walks a subscription-in-dunning along the D7 ladder (`none → day_1 → day_7 → day_14 → day_21 →
// day_28_suspend → day_60_cancel`, with `resolved` reachable from any active stage on a successful payment).
// The pure ORDERING (the ladder, the per-stage advance intervals, the retry cadence, the terminal
// suspend/cancel stages) lives in `../domain/dunning-lifecycle`; this service adds the DB-facing obligations
// the ordering alone cannot express: the open-row-per-subscription invariant (`exited_at IS NULL`), the
// time-based advance decision (`enteredAt + advance-days ≤ now`), and the §4.11 outbox mapping.
//
// PURE (the M35-T03 idiom): the {@link DunningStore} owns the §2.5 open-row lock + the RLS session; this
// service is deterministic given (store, now, input). The M35-T06 cron/webhook handlers supply the real
// Drizzle store, publish the returned {@link OutboxIntent}s, and — on a `suspend`/`cancel` side effect —
// drive the matching `SubscriptionLifecycleService.transition` (which owns the subscription-status edge +
// the `m35.tenant.billing_blocked` emit). This service NEVER transitions the subscription itself and NEVER
// calls Stripe: it owns only the `dunning_state` row and the dunning outbox events.

import type { IsoInstant, MembershipId, OrgId, SubscriptionId } from "@wardenx/types";
import {
  DUNNING_ADVANCE_AFTER_DAYS,
  DUNNING_CANCEL_STAGE,
  DUNNING_SUSPEND_STAGE,
  dunningRetryDelayDays,
  isResolvableDunningStage,
  nextDunningStage,
} from "../domain/dunning-lifecycle";
import {
  outboxIntent,
  type DunningStateRecord,
  type DunningStore,
  type OutboxIntent,
} from "./ports";

const MS_PER_DAY = 24 * 3600 * 1000;

/** Add `days` to `from` (whole-day arithmetic in UTC ms; `null` days → null, i.e. "no retry scheduled"). */
function addDays(from: Date, days: number | null): Date | null {
  return days === null ? null : new Date(from.getTime() + days * MS_PER_DAY);
}

/** The subscription-facing side effect the caller (M35-T06) must drive after a dunning transition. */
export type DunningSideEffect = "none" | "suspend" | "cancel";

/** The reason a dunning action was refused (surfaced as a typed error, not a thrown string). */
export class DunningActionError extends Error {
  constructor(
    readonly code: "no_open_dunning" | "terminal_stage",
    message: string,
  ) {
    super(message);
    this.name = "DunningActionError";
  }
}

export interface DunningActionResult {
  /** The stage the subscription was in before this action (`null` when dunning had not yet started). */
  readonly from: DunningStateRecord["stage"] | null;
  /** The stage after this action (`null` when the action closed dunning — resolved / reset). */
  readonly to: DunningStateRecord["stage"] | null;
  /** The new open dunning row, or `null` when the action closed dunning. */
  readonly record: DunningStateRecord | null;
  /** What the caller must do to the SUBSCRIPTION as a result (this service never touches it). */
  readonly sideEffect: DunningSideEffect;
  readonly outbox: OutboxIntent[];
}

export class DunningStateMachineService {
  constructor(private readonly store: DunningStore) {}

  /**
   * §4.15 `payment_failed` — INITIATE dunning. A first failure moves `none → day_1` (retry scheduled +24h).
   * A failure while dunning is already open is idempotent: the ladder advances by TIME via {@link tick}, not
   * by each repeated failure, so this returns the existing row with no new stage and no duplicate outbox.
   */
  async onPaymentFailed(input: {
    subscriptionId: SubscriptionId;
    organizationId: OrgId;
    triggerInvoiceId: string | null;
    failureCode: string;
    now: Date;
  }): Promise<DunningActionResult> {
    const open = await this.store.openForSubscription(input.subscriptionId);
    if (open) {
      // Already in dunning — the retry ladder advances on the cron tick, not on each repeated failure.
      return { from: open.stage, to: open.stage, record: open, sideEffect: "none", outbox: [] };
    }
    return this.#enter({
      organizationId: input.organizationId,
      subscriptionId: input.subscriptionId,
      fromRowId: null,
      fromStage: "none",
      toStage: "day_1",
      attemptCount: 1,
      triggerInvoiceId: input.triggerInvoiceId,
      failureCode: input.failureCode,
      exitReason: null,
      now: input.now,
    });
  }

  /**
   * §4.15 scheduled tick — advance the open dunning row to the next stage IFF its per-stage unresolved
   * interval has elapsed (`enteredAt + DUNNING_ADVANCE_AFTER_DAYS[stage] ≤ now`). No open row, or not yet
   * due, is a no-op. Reaching `day_28_suspend`/`day_60_cancel` returns the matching side effect for the
   * caller to drive the subscription edge.
   */
  async tick(input: { subscriptionId: SubscriptionId; now: Date }): Promise<DunningActionResult> {
    const open = await this.store.openForSubscription(input.subscriptionId);
    if (!open) {
      return { from: null, to: null, record: null, sideEffect: "none", outbox: [] };
    }
    const advanceDays = DUNNING_ADVANCE_AFTER_DAYS[
      open.stage as keyof typeof DUNNING_ADVANCE_AFTER_DAYS
    ];
    const next = nextDunningStage(open.stage);
    // Terminal stage (`day_60_cancel`) or a stage with no advance rule (`resolved`) — nothing to advance to.
    if (next === null || advanceDays === undefined) {
      return { from: open.stage, to: open.stage, record: open, sideEffect: "none", outbox: [] };
    }
    const dueAt = open.enteredAt.getTime() + advanceDays * MS_PER_DAY;
    if (input.now.getTime() < dueAt) {
      return { from: open.stage, to: open.stage, record: open, sideEffect: "none", outbox: [] };
    }
    return this.#enter({
      organizationId: open.organizationId,
      subscriptionId: open.subscriptionId,
      fromRowId: open.id,
      fromStage: open.stage,
      toStage: next,
      attemptCount: open.attemptCount + 1,
      triggerInvoiceId: open.triggerInvoiceId,
      failureCode: null,
      exitReason: "advanced",
      now: input.now,
    });
  }

  /**
   * §4.15 successful payment — resolve dunning from ANY active stage. Closes the open row (`resolved`) and
   * emits `m35.dunning.resolved`; a no-op (no outbox) when the subscription is not in dunning. The caller
   * reactivates a suspended subscription separately (this service owns only the dunning row).
   */
  async resolve(input: {
    subscriptionId: SubscriptionId;
    now: Date;
  }): Promise<DunningActionResult> {
    const open = await this.store.openForSubscription(input.subscriptionId);
    if (!open || !isResolvableDunningStage(open.stage)) {
      return { from: open?.stage ?? null, to: null, record: null, sideEffect: "none", outbox: [] };
    }
    await this.store.closeOpen({ rowId: open.id, exitedAt: input.now, exitReason: "resolved" });
    return {
      from: open.stage,
      to: null,
      record: null,
      sideEffect: "none",
      outbox: [this.#resolvedIntent(open, input.now)],
    };
  }

  /**
   * §4.15 admin override `skip_stage` — force-advance the open dunning row one stage (the actor + audit
   * linkage the M35-T06 route records live on the closed row's `exit_reason`). Refuses when there is no
   * open dunning or the row is already terminal.
   */
  async skipStage(input: {
    subscriptionId: SubscriptionId;
    actorMembershipId: MembershipId;
    now: Date;
  }): Promise<DunningActionResult> {
    const open = await this.store.openForSubscription(input.subscriptionId);
    if (!open) {
      throw new DunningActionError("no_open_dunning", `subscription ${input.subscriptionId} is not in dunning`);
    }
    const next = nextDunningStage(open.stage);
    if (next === null) {
      throw new DunningActionError(
        "terminal_stage",
        `dunning stage ${open.stage} is terminal — cannot skip further`,
      );
    }
    return this.#enter({
      organizationId: open.organizationId,
      subscriptionId: open.subscriptionId,
      fromRowId: open.id,
      fromStage: open.stage,
      toStage: next,
      attemptCount: open.attemptCount + 1,
      triggerInvoiceId: open.triggerInvoiceId,
      failureCode: null,
      exitReason: `skipped_by:${input.actorMembershipId}`,
      now: input.now,
    });
  }

  /**
   * §4.15 admin override `reset` — clear dunning back to `current`. Closes the open row and emits
   * `m35.dunning.resolved` (the resolved event is the "dunning cleared" signal downstream reads). Refuses
   * when there is no open dunning.
   */
  async reset(input: {
    subscriptionId: SubscriptionId;
    actorMembershipId: MembershipId;
    now: Date;
  }): Promise<DunningActionResult> {
    const open = await this.store.openForSubscription(input.subscriptionId);
    if (!open) {
      throw new DunningActionError("no_open_dunning", `subscription ${input.subscriptionId} is not in dunning`);
    }
    await this.store.closeOpen({
      rowId: open.id,
      exitedAt: input.now,
      exitReason: `reset_by:${input.actorMembershipId}`,
    });
    return {
      from: open.stage,
      to: null,
      record: null,
      sideEffect: "none",
      outbox: [this.#resolvedIntent(open, input.now)],
    };
  }

  /** Shared "enter a stage" step: close the prior open row (if any), open the new one, map the outbox. */
  async #enter(input: {
    organizationId: OrgId;
    subscriptionId: SubscriptionId;
    fromRowId: string | null;
    fromStage: DunningStateRecord["stage"];
    toStage: DunningStateRecord["stage"];
    attemptCount: number;
    triggerInvoiceId: string | null;
    failureCode: string | null;
    exitReason: string | null;
    now: Date;
  }): Promise<DunningActionResult> {
    const nextAttemptAt = addDays(input.now, dunningRetryDelayDays(input.toStage));
    const record = await this.store.enterStage({
      organizationId: input.organizationId,
      subscriptionId: input.subscriptionId,
      fromRowId: input.fromRowId,
      toStage: input.toStage,
      enteredAt: input.now,
      nextAttemptAt,
      attemptCount: input.attemptCount,
      triggerInvoiceId: input.triggerInvoiceId,
      lastAttemptFailureCode: input.failureCode,
      exitReason: input.exitReason,
    });

    const sideEffect: DunningSideEffect =
      input.toStage === DUNNING_SUSPEND_STAGE
        ? "suspend"
        : input.toStage === DUNNING_CANCEL_STAGE
          ? "cancel"
          : "none";

    return {
      from: input.fromStage,
      to: input.toStage,
      record,
      sideEffect,
      outbox: [
        outboxIntent("m35.dunning.entered_stage", {
          subscriptionId: input.subscriptionId,
          organizationId: input.organizationId,
          fromStage: input.fromStage,
          toStage: input.toStage,
          enteredAt: input.now.toISOString() as IsoInstant,
          nextAttemptAt: (nextAttemptAt?.toISOString() ?? null) as IsoInstant | null,
        }),
      ],
    };
  }

  /** Build the `m35.dunning.resolved` intent for a closed dunning row. */
  #resolvedIntent(open: DunningStateRecord, now: Date): OutboxIntent {
    return outboxIntent("m35.dunning.resolved", {
      subscriptionId: open.subscriptionId,
      organizationId: open.organizationId,
      resolvedAt: now.toISOString() as IsoInstant,
      lastStage: open.stage,
    });
  }
}
