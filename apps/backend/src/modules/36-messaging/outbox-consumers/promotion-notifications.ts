// WP 3.7: tells the people who can act on a chart-promotion proposal that one is waiting, with fixed-text in-app alerts
// (AlertEmitter seam), like handoff-notifications.ts. The tenant comes from the envelope and the target from the stored
// request, never the payload. Every text is PROVISIONAL (clinical-lead sign-off pending) and contains no name, patient or
// message text: the alert says that something is waiting, never what. Correlation ids carry the event id so a redelivery
// converges on the (org, correlation_id) dedupe.
//
//   m36.promotion.requested, still proposed:
//     m8  -> each care-team member (not the requester) who holds encounter.addendum_sign, capped (m36.promotion.review_requested)
//     m14 -> the permission holders of idg.coordinate (rule m36.promotion.idg_review_requested)
//     nobody resolved -> the requester is told (m36.promotion.no_reviewer): the loud fallback, never a silent drop.
// The requester's "decided" alert is sent by the outcome consumer (promotion-outcomes.ts), only when a decision is applied.
import type { AlertEmitter } from "@chartwarden/messaging";
import type {
  DispatchableOutboxEvent,
  OutboxConsumerBinding,
} from "../../../bootstrap/outbox-dispatcher";
import { M36_PROMOTION_EVENTS } from "../promotions/promotion-events";
import { PROMOTION_REQUESTER_DEEP_LINK } from "./promotion-outcomes";

export const M36_PROMOTION_NOTIFICATION_CONSUMER = "m36.chart-promotion-notifications" as const;
export const M36_PROMOTION_NOTIFICATION_EVENTS = [M36_PROMOTION_EVENTS.requested] as const;

/** Alert types that are alert-rule keys only (not outbox catalog events); seeded in PLATFORM_DEFAULT_ALERT_RULES. */
export const PROMOTION_REVIEW_REQUESTED_ALERT = "m36.promotion.review_requested" as const;
export const PROMOTION_IDG_REVIEW_REQUESTED_ALERT = "m36.promotion.idg_review_requested" as const;
export const PROMOTION_NO_REVIEWER_ALERT = "m36.promotion.no_reviewer" as const;

export const PROMOTION_NOTIFICATION_TEXT = {
  reviewRequested:
    "A colleague proposed a secure message for the chart. Open the patient's record to review it.",
  idgReviewRequested:
    "A colleague proposed a secure message for an IDG agenda. Open the IDG meeting to review it.",
  noReviewer:
    "No reviewer could be reached about your chart promotion. Nothing was added to the chart.",
} as const;

/** The care-team audience of an addendum proposal is capped so one proposal cannot page a whole team. */
export const PROMOTION_MAX_REVIEWERS = 20;

const REVIEWER_DEEP_LINK = "/notifications";

export interface PromotionNotificationFacts {
  readonly requestedByUserId: string;
  readonly targetModule: string;
  readonly status: string;
  readonly patientId: string;
}

export interface PromotionNotificationDeps {
  readonly alerts: AlertEmitter;
  /** The request as stored (null when it is gone); a stale event for a request that is no longer proposed alerts nobody. */
  readonly requestFacts: (
    orgId: string,
    promotionRequestId: string,
  ) => Promise<PromotionNotificationFacts | null>;
  /** Every user with an open assignment for the patient (the M5 CareTeamProvider seam, injected). */
  readonly careTeamMembers: (orgId: string, patientId: string) => Promise<readonly string[]>;
  /** May this user sign an addendum (holds encounter.addendum_sign)? A throw reads as no. */
  readonly canSignAddendum: (orgId: string, userId: string) => Promise<boolean>;
}

function requireId(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${M36_PROMOTION_NOTIFICATION_CONSUMER}: missing ${key}`);
  }
  return value;
}

export function buildM36PromotionNotificationsConsumer(
  deps: PromotionNotificationDeps,
): OutboxConsumerBinding {
  const emit = (
    event: DispatchableOutboxEvent,
    promotionRequestId: string,
    alertType: string,
    recipient: Record<string, string>,
    message: string,
    deepLink: string,
  ) =>
    deps.alerts.emit(event.organizationId, {
      eventType: alertType,
      severity: "info",
      correlationId: [
        `promotion:${promotionRequestId}:${event.id}`,
        alertType,
        ...Object.values(recipient),
      ].join(":"),
      payload: { ...recipient, promotionRequestId, message, deepLink },
    });

  async function reviewers(orgId: string, facts: PromotionNotificationFacts): Promise<string[]> {
    const team = await deps.careTeamMembers(orgId, facts.patientId);
    const out: string[] = [];
    for (const userId of new Set(team)) {
      if (userId === facts.requestedByUserId) continue;
      const allowed = await deps.canSignAddendum(orgId, userId).catch(() => false);
      if (allowed) out.push(userId);
      if (out.length >= PROMOTION_MAX_REVIEWERS) break;
    }
    return out;
  }

  async function onRequested(event: DispatchableOutboxEvent, p: Record<string, unknown>) {
    const orgId = event.organizationId;
    const promotionRequestId = requireId(p, "promotionRequestId");
    const facts = await deps.requestFacts(orgId, promotionRequestId);
    if (!facts || facts.status !== "proposed") return;
    let reached = 0;
    if (facts.targetModule === "m8") {
      for (const reviewerUserId of await reviewers(orgId, facts)) {
        const sent = await emit(
          event,
          promotionRequestId,
          PROMOTION_REVIEW_REQUESTED_ALERT,
          { reviewerUserId },
          PROMOTION_NOTIFICATION_TEXT.reviewRequested,
          REVIEWER_DEEP_LINK,
        );
        reached += sent.resolvedRecipientCount;
      }
    } else if (facts.targetModule === "m14") {
      const sent = await emit(
        event,
        promotionRequestId,
        PROMOTION_IDG_REVIEW_REQUESTED_ALERT,
        {},
        PROMOTION_NOTIFICATION_TEXT.idgReviewRequested,
        REVIEWER_DEEP_LINK,
      );
      reached = sent.resolvedRecipientCount;
    }
    if (reached > 0) return;
    await emit(
      event,
      promotionRequestId,
      PROMOTION_NO_REVIEWER_ALERT,
      { requestedByUserId: facts.requestedByUserId },
      PROMOTION_NOTIFICATION_TEXT.noReviewer,
      PROMOTION_REQUESTER_DEEP_LINK,
    );
  }

  return {
    consumerName: M36_PROMOTION_NOTIFICATION_CONSUMER,
    consumerModule: "m36",
    eventTypes: M36_PROMOTION_NOTIFICATION_EVENTS,
    async handle(event: DispatchableOutboxEvent) {
      if (event.eventType !== M36_PROMOTION_EVENTS.requested) return;
      await onRequested(event, (event.payload ?? {}) as Record<string, unknown>);
    },
  };
}
