// apps/backend/src/modules/36-messaging/ack-escalation/escalation-service.ts - WP 4.4 (ADR-0070): what happens when a request's
// deadline passes with nobody having taken responsibility.
//
// THE DATABASE decides what is due; the BullMQ job and the sweeper only wake this service up. `processDue` is therefore safe to
// call any number of times, from a job, a retry, a second worker or the sweeper, in any order: the escalation is ONE guarded write
// (the row locked FOR UPDATE, re-checked, then updated WHERE version = the version it read), in the same transaction as its history
// row and its id-only outbox event. Whoever loses the race finds a changed version, tier or deadline and does nothing.
//
// Who owns the request is never re-derived from a clock afterwards (ADR-0057, the DST fall-back note): the resolved tier and
// assignee are written onto the request, and the next window is keyed on the request and its tier.
//
// With no router bound (today: the deny-stub), or when no tier answers, NOTHING is invented: the request stays open with its
// current assignee, a `route_unavailable` / `ladder_exhausted` history row and outbox event say so (with a growing backoff, 1 h to
// 24 h, and at most 8 per window), and the router is asked again on that schedule (daily once the cap is reached), so the moment a
// router is bound the request escalates. THE DATABASE decides what is due; the comparison "is it past its deadline" uses the application
// clock, and only the new window's start and the guard trigger use the database's now(). `failed_unreachable` is WP 4.5's and is never written here.
import {
  ESCALATION_SWEEP_BATCH,
  isEscalationDue,
  tierWindowMinutes,
  unroutedRetryDue,
  unroutedShouldRecord,
} from "@wardenx/messaging";
import {
  ACK_ESCALATION_REQUIRED_ROLE,
  ESCALATION_MAX_TIER,
  type EscalationRouter,
} from "@wardenx/types";
import {
  type AckEventFacts,
  M36_ACK_ESCALATED,
  M36_ACK_LADDER_EXHAUSTED,
  M36_ACK_ROUTE_UNAVAILABLE,
  publishAckEvent,
} from "../ack-requests/ack-events";
import { type AckRow, AckStaleError, type AckStore } from "../ack-requests/ack-types";
import type { HintOutboxPort } from "../message-hint-events";

export type NotRoutedReason = "route_unavailable" | "ladder_exhausted";

export type EscalationOutcome =
  /** The tenant's `messaging.escalation_timers` flag is off: the request is left exactly as it is. */
  | { readonly kind: "flag_off" }
  /** Nothing to do: unknown, not waiting any more, deadline not reached, or not the window the caller meant. */
  | { readonly kind: "not_due" }
  /** Another writer got there first (acknowledged, reassigned, cancelled or escalated in between). */
  | { readonly kind: "stale" }
  | {
      readonly kind: "escalated";
      readonly requestId: string;
      readonly tier: number;
      readonly assignedUserId: string;
      readonly deadlineAt: Date;
    }
  /** The request was recently found unroutable and its backoff has not elapsed: the router was not asked. */
  | { readonly kind: "backed_off" }
  /** No tier could be reached. `recorded` is false when the cap is reached or the backoff had not elapsed (a concurrent run). */
  | { readonly kind: "not_routed"; readonly reason: NotRoutedReason; readonly recorded: boolean };

export interface SweepSummary {
  readonly flagOff: boolean;
  readonly escalated: number;
  readonly notRouted: number;
  readonly skipped: number;
  readonly failed: number;
}

export interface EscalationDeps {
  readonly store: AckStore;
  /** `messaging.escalation_timers`: gates the ACTION. A throw propagates (the job retries; nothing is decided on a blip). */
  readonly isEnabled: (orgId: string) => Promise<boolean>;
  /** The org-checking wrapper around the seam (`guardEscalationRouter`). A throw propagates. */
  readonly router: EscalationRouter;
  /** Active, keys, Part 2 gate and able to see the channel. A clean false skips the candidate; a throw propagates. */
  readonly stillQualified: (orgId: string, userId: string, channelId: string) => Promise<boolean>;
  readonly outbox: HintOutboxPort | undefined;
  readonly now?: () => Date;
  /** Ids and a reason only. */
  readonly onError?: (
    context: { organizationId: string; requestId: string },
    error: unknown,
  ) => void;
}

export interface ExpectedWindow {
  readonly tier: number;
  readonly deadlineAt: Date;
}

type Decision =
  | { readonly kind: "routed"; readonly tier: number; readonly userId: string }
  | { readonly kind: "none"; readonly reason: NotRoutedReason };

const NONE_UNAVAILABLE: Decision = { kind: "none", reason: "route_unavailable" };

export interface EscalationService {
  processDue(
    orgId: string,
    requestId: string,
    expected?: ExpectedWindow,
  ): Promise<EscalationOutcome>;
  sweep(orgId: string): Promise<SweepSummary>;
}

export function createEscalationService(deps: EscalationDeps): EscalationService {
  const now = deps.now ?? (() => new Date());

  /**
   * Walks the ladder from the next tier up. A tier with a gap, or whose people are all unusable (the sender, the assignee who did
   * not act, someone no longer qualified), is skipped to the router's `nextTier`; the end of the ladder is `ladder_exhausted` only
   * when the router says the tier does not exist. Lookup errors propagate.
   */
  async function decide(orgId: string, row: AckRow, asOf: string): Promise<Decision> {
    let tier = row.currentTier + 1;
    for (let hops = 0; hops < ESCALATION_MAX_TIER && tier <= ESCALATION_MAX_TIER; hops += 1) {
      const answer = await deps.router.resolveTier(orgId, {
        patientId: row.patientId,
        requiredRole: ACK_ESCALATION_REQUIRED_ROLE,
        tier,
        asOf,
      });
      if (answer.kind === "unavailable") {
        return answer.reason === "tier_not_configured"
          ? { kind: "none", reason: "ladder_exhausted" }
          : NONE_UNAVAILABLE;
      }
      if (answer.kind === "resolved") {
        for (const userId of answer.userIds) {
          if (userId === row.requesterUserId || userId === row.assignedUserId) continue;
          if (await deps.stillQualified(orgId, userId, row.channelId)) {
            return { kind: "routed", tier, userId };
          }
        }
        // The final tier exists but nobody on it can take the request: there is nothing further, which is the exhausted ladder.
        if (answer.nextTier === null) return { kind: "none", reason: "ladder_exhausted" };
      }
      if (answer.nextTier === null) return NONE_UNAVAILABLE;
      tier = answer.nextTier;
    }
    return NONE_UNAVAILABLE;
  }

  function factsFor(row: AckRow, extra: Partial<AckEventFacts>, at: Date): AckEventFacts {
    return {
      orgId: row.organizationId,
      requestId: row.id,
      messageId: row.messageId,
      channelId: row.channelId,
      ackClass: row.ackClass,
      assignedUserId: row.assignedUserId,
      actorUserId: null,
      version: row.version,
      at,
      ...extra,
    };
  }

  async function settle(
    orgId: string,
    requestId: string,
    read: AckRow,
    decision: Decision,
    at: Date,
  ): Promise<EscalationOutcome> {
    return deps.store.runAsSystem(orgId, async (tx, rawTx) => {
      const row = await tx.findById(requestId, true);
      if (
        !row ||
        row.version !== read.version ||
        !isEscalationDue(row.status, row.deadlineAt, at)
      ) {
        return { kind: "stale" };
      }
      if (decision.kind === "routed") {
        const next = await tx.escalate(row.id, row.version, {
          assignedUserId: decision.userId,
          tier: decision.tier,
          windowMinutes: tierWindowMinutes(row.ackClass, decision.tier),
          updatedAt: at,
        });
        await tx.insertEvent({
          organizationId: orgId,
          requestId: row.id,
          eventType: "escalated",
          actorUserId: null,
          fromStatus: row.status,
          toStatus: "escalated",
          assignedUserId: next.assignedUserId,
          previousAssignedUserId: row.assignedUserId,
          tier: next.currentTier,
          at,
        });
        await publishAckEvent(
          deps.outbox,
          rawTx,
          M36_ACK_ESCALATED,
          factsFor(
            next,
            {
              previousAssignedUserId: row.assignedUserId,
              tier: next.currentTier,
              deadlineAt: next.deadlineAt,
            },
            at,
          ),
        );
        return {
          kind: "escalated",
          requestId: row.id,
          tier: next.currentTier,
          assignedUserId: next.assignedUserId,
          deadlineAt: next.deadlineAt,
        };
      }
      const history = (await tx.unroutedSummary([row])).get(row.id);
      const count = history?.count ?? 0;
      if (history && !unroutedShouldRecord(count, history.lastAt.getTime(), at.getTime())) {
        return { kind: "not_routed", reason: decision.reason, recorded: false };
      }
      const tier = row.currentTier + 1;
      await tx.insertEvent({
        organizationId: orgId,
        requestId: row.id,
        eventType: decision.reason,
        actorUserId: null,
        fromStatus: row.status,
        toStatus: row.status,
        assignedUserId: row.assignedUserId,
        previousAssignedUserId: null,
        tier,
        at,
      });
      await publishAckEvent(
        deps.outbox,
        rawTx,
        decision.reason === "ladder_exhausted"
          ? M36_ACK_LADDER_EXHAUSTED
          : M36_ACK_ROUTE_UNAVAILABLE,
        factsFor(row, { tier, occurrence: count + 1 }, at),
      );
      return { kind: "not_routed", reason: decision.reason, recorded: true };
    });
  }

  async function processDue(
    orgId: string,
    requestId: string,
    expected?: ExpectedWindow,
  ): Promise<EscalationOutcome> {
    if (!(await deps.isEnabled(orgId))) return { kind: "flag_off" };
    const at = now();
    const row = await deps.store.readAsSystem(orgId, (tx) => tx.findById(requestId, false));
    if (!row || !isEscalationDue(row.status, row.deadlineAt, at)) return { kind: "not_due" };
    if (
      expected &&
      (row.currentTier !== expected.tier ||
        row.deadlineAt.getTime() !== expected.deadlineAt.getTime())
    ) {
      return { kind: "not_due" };
    }
    // A request found unroutable recently is not asked again until its backoff has elapsed (the sweep's query already leaves it out).
    const history = (await deps.store.readAsSystem(orgId, (tx) => tx.unroutedSummary([row]))).get(
      row.id,
    );
    if (history && !unroutedRetryDue(history.count, history.lastAt.getTime(), at.getTime())) {
      return { kind: "backed_off" };
    }
    const decision = await decide(orgId, row, at.toISOString());
    try {
      return await settle(orgId, requestId, row, decision, at);
    } catch (error) {
      if (error instanceof AckStaleError) return { kind: "stale" };
      throw error;
    }
  }

  async function sweep(orgId: string): Promise<SweepSummary> {
    if (!(await deps.isEnabled(orgId))) {
      return { flagOff: true, escalated: 0, notRouted: 0, skipped: 0, failed: 0 };
    }
    const due = await deps.store.readAsSystem(orgId, (tx) =>
      tx.listDue(now(), ESCALATION_SWEEP_BATCH),
    );
    const totals = { escalated: 0, notRouted: 0, skipped: 0, failed: 0 };
    for (const row of due) {
      try {
        const outcome = await processDue(orgId, row.id);
        if (outcome.kind === "escalated") totals.escalated += 1;
        else if (outcome.kind === "not_routed") totals.notRouted += 1;
        else totals.skipped += 1;
      } catch (error) {
        totals.failed += 1;
        deps.onError?.({ organizationId: orgId, requestId: row.id }, error);
      }
    }
    return { flagOff: false, ...totals };
  }

  return { processDue, sweep };
}
