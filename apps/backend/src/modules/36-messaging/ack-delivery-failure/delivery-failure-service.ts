// apps/backend/src/modules/36-messaging/ack-delivery-failure/delivery-failure-service.ts - WP 4.5 (ADR-0071): what happens when EVERY
// out-of-band route to the assignee of an open acknowledgment request has failed.
//
// Fan-out is additive and parallel (the in-app floor plus every channel the recipient's routing map asks for are created at once), so
// there is no "next channel" to try for the same person: when all of their out-of-band routes are terminally failed, the next route is
// the next TIER, tried NOW instead of at the deadline (ADR-0057 item 5). If no tier can be reached the request moves to
// `failed_unreachable`: still open, still acknowledgeable by a person, and loud (supervisor alert + ops notice, by consumers of the event).
//
// Both outcomes are ONE guarded write like WP 4.4's: the row locked FOR UPDATE, re-checked, updated WHERE version = the version read,
// with the history row and the id-only outbox event in the same transaction. A duplicate event, a retry or two workers find the request
// no longer waiting on that recipient and do nothing; an acknowledgment racing this wins in either order (the loser sees a changed
// version or status). The system actor is an empty app.user_id; migration 1115 makes that the ONLY writer of `failed_unreachable`.
import type { AckClass } from "@wardenx/types";
import { type Decision, ackFactsFor, writeEscalation } from "../ack-escalation/escalation-service";
import { M36_ACK_FAILED_UNREACHABLE, publishAckEvent } from "../ack-requests/ack-events";
import { type AckRow, AckStaleError, type AckStore } from "../ack-requests/ack-types";
import type { HintOutboxPort } from "../message-hint-events";

/** One failed route, as the consumer reconstructed it from the delivery rows of ONE alert and ONE recipient. */
export interface FailedRouteFacts {
  /** The message the failed alert was about (the alert's `sourceAggregateId`). One request per message. */
  readonly messageId: string;
  /** Whose routes all failed. Must still be the request's assignee. */
  readonly recipientUserId: string;
  /** When the failed alert was created: an alert from before the current window is about an earlier assignment. */
  readonly alertCreatedAt: Date;
}

export type RouteFailureOutcome =
  /** `messaging.escalation_timers` is off for the tenant: the request is left exactly as it is. */
  | { readonly kind: "flag_off" }
  /** Unknown request, or it is no longer waiting (acknowledged, resolved, cancelled, or already `failed_unreachable`). */
  | { readonly kind: "not_waiting" }
  /** The request is no longer assigned to the user whose routes failed, or the alert predates its current window. */
  | { readonly kind: "not_current" }
  /** Another writer got there first (acknowledged, reassigned, escalated or cancelled in between). */
  | { readonly kind: "stale" }
  | {
      readonly kind: "escalated";
      readonly requestId: string;
      readonly tier: number;
      readonly assignedUserId: string;
    }
  | {
      readonly kind: "failed_unreachable";
      readonly requestId: string;
      readonly ackClass: AckClass;
    };

export interface DeliveryFailureDeps {
  readonly store: AckStore;
  /** `messaging.escalation_timers`: the same ops flag as the timer (the early escalation IS an escalation). A throw propagates. */
  readonly isEnabled: (orgId: string) => Promise<boolean>;
  /** The ladder walk of WP 4.4 (`createTierDecider`), over the org-checking router guard. A throw propagates (the outbox retries). */
  readonly decide: (orgId: string, row: AckRow, asOf: string) => Promise<Decision>;
  readonly outbox: HintOutboxPort | undefined;
  readonly now?: () => Date;
}

export interface DeliveryFailureService {
  /** Every out-of-band route to `facts.recipientUserId` has terminally failed. Safe to call any number of times, in any order. */
  onAllRoutesFailed(orgId: string, facts: FailedRouteFacts): Promise<RouteFailureOutcome>;
}

const isWaiting = (row: AckRow): boolean => row.status === "pending" || row.status === "escalated";

/** The history row of a failed route follows the escalation row by a millisecond so a timeline reads "escalated" then its cause. */
const CAUSE_AFTER_MS = 1;

export function createDeliveryFailureService(deps: DeliveryFailureDeps): DeliveryFailureService {
  const now = deps.now ?? (() => new Date());

  async function settle(
    orgId: string,
    read: AckRow,
    decision: Decision,
    at: Date,
  ): Promise<RouteFailureOutcome> {
    return deps.store.runAsSystem(orgId, async (tx, rawTx) => {
      const row = await tx.findById(read.id, true);
      if (!row || row.version !== read.version || !isWaiting(row)) return { kind: "stale" };
      if (decision.kind === "routed") {
        const escalated = await writeEscalation(tx, rawTx, deps.outbox, row, decision, at);
        await tx.insertEvent({
          organizationId: orgId,
          requestId: row.id,
          eventType: "delivery_failed",
          actorUserId: null,
          fromStatus: "escalated",
          toStatus: "escalated",
          assignedUserId: escalated.assignedUserId,
          previousAssignedUserId: row.assignedUserId,
          tier: escalated.tier,
          at: new Date(at.getTime() + CAUSE_AFTER_MS),
        });
        return {
          kind: "escalated",
          requestId: row.id,
          tier: escalated.tier,
          assignedUserId: escalated.assignedUserId,
        };
      }
      const next = await tx.update(row.id, row.version, {
        status: "failed_unreachable",
        updatedAt: at,
      });
      await tx.insertEvent({
        organizationId: orgId,
        requestId: row.id,
        eventType: "delivery_failed",
        actorUserId: null,
        fromStatus: row.status,
        toStatus: "failed_unreachable",
        assignedUserId: row.assignedUserId,
        previousAssignedUserId: null,
        tier: row.currentTier,
        at,
      });
      await publishAckEvent(
        deps.outbox,
        rawTx,
        M36_ACK_FAILED_UNREACHABLE,
        ackFactsFor(next, {}, at),
      );
      return { kind: "failed_unreachable", requestId: row.id, ackClass: row.ackClass };
    });
  }

  async function onAllRoutesFailed(
    orgId: string,
    facts: FailedRouteFacts,
  ): Promise<RouteFailureOutcome> {
    if (!(await deps.isEnabled(orgId))) return { kind: "flag_off" };
    const at = now();
    const row = await deps.store.readAsSystem(orgId, (tx) =>
      tx.findByMessage(facts.messageId, false),
    );
    if (!row || !isWaiting(row)) return { kind: "not_waiting" };
    if (
      row.assignedUserId !== facts.recipientUserId ||
      facts.alertCreatedAt.getTime() < row.windowStartedAt.getTime()
    ) {
      return { kind: "not_current" };
    }
    const decision = await deps.decide(orgId, row, at.toISOString());
    try {
      return await settle(orgId, row, decision, at);
    } catch (error) {
      if (error instanceof AckStaleError) return { kind: "stale" };
      throw error;
    }
  }

  return { onAllRoutesFailed };
}
