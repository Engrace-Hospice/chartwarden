import type { AlertEmitter } from "@chartwarden/messaging";
// WP 3.7: records the decision an OWNING module (M8, M14) reports for a chart-promotion proposal, then tells the requester
// with one fixed-text in-app alert (rule m36.promotion.decided). M36 never decides accepted/rejected itself: this consumer is
// the only writer of result_ref / decided_by / decided_at (ADR-0063 D4).
//
// Trust: the tenant comes from the envelope, never the payload; the OWNING module comes from the event NAME (m8.* /
// m14.*), never the payload, and the service ignores an event whose owner is not the request's target module (a spoof).
// This consumer does NOT consult the `messaging.promotions` flag: a decision an owner already committed must be recorded.
// Redelivery converges (a repeat is a no-op and alerts nobody); unknown / conflicting / ignored events are logged with ids
// only and never thrown, so a poison event cannot wedge the queue. The alert text carries no message text and no patient.
import {
  CHART_PROMOTION_OUTCOMES,
  CHART_PROMOTION_OWNER_EVENT,
  CHART_PROMOTION_REASON_CODES,
  type ChartPromotionOutcome,
  type ChartPromotionReasonCode,
  type ChartPromotionTargetModule,
} from "@chartwarden/types";
import type {
  DispatchableOutboxEvent,
  OutboxConsumerBinding,
} from "../../../bootstrap/outbox-dispatcher";
import type {
  PromotionOutcomeEvent,
  PromotionOutcomeResult,
} from "../promotions/promotion-service";

export const M36_PROMOTION_OUTCOME_CONSUMER = "m36.chart-promotion-outcomes" as const;

/** The two owner events, keyed by the module that owns the target (the catalog entries live in events-by-m8 / m14). */
export const M36_PROMOTION_OUTCOME_EVENTS = [
  CHART_PROMOTION_OWNER_EVENT.m8,
  CHART_PROMOTION_OWNER_EVENT.m14,
] as const;

/** Alert type that is an alert-rule key only (not an outbox catalog event); seeded in PLATFORM_DEFAULT_ALERT_RULES. */
export const PROMOTION_DECIDED_ALERT = "m36.promotion.decided" as const;

/** PROVISIONAL wording (clinical-lead sign-off pending): no name, patient or message text. */
export const PROMOTION_DECIDED_TEXT = {
  accepted: "Your chart promotion was accepted",
  rejected: "Your chart promotion was not accepted",
} as const;

export const PROMOTION_REQUESTER_DEEP_LINK = "/notifications?tab=promotions";

export interface PromotionOutcomeDeps {
  readonly alerts: AlertEmitter;
  readonly applyOutcome: (
    orgId: string,
    event: PromotionOutcomeEvent,
  ) => Promise<PromotionOutcomeResult>;
  /** Log sink (ids and enum values only). */
  readonly warn?: (message: string, context: Record<string, string>) => void;
}

function ownerModuleOf(eventType: string): ChartPromotionTargetModule | null {
  for (const [module, name] of Object.entries(CHART_PROMOTION_OWNER_EVENT)) {
    if (name === eventType) return module as ChartPromotionTargetModule;
  }
  return null;
}

const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

function reasonOf(v: unknown): ChartPromotionReasonCode | null {
  return (CHART_PROMOTION_REASON_CODES as readonly unknown[]).includes(v)
    ? (v as ChartPromotionReasonCode)
    : null;
}

export function buildM36PromotionOutcomesConsumer(
  deps: PromotionOutcomeDeps,
): OutboxConsumerBinding {
  const warn = (message: string, context: Record<string, string>): void =>
    deps.warn?.(message, context);

  return {
    consumerName: M36_PROMOTION_OUTCOME_CONSUMER,
    consumerModule: "m36",
    eventTypes: M36_PROMOTION_OUTCOME_EVENTS,
    async handle(event: DispatchableOutboxEvent) {
      const ownerModule = ownerModuleOf(event.eventType);
      const p = (event.payload ?? {}) as Record<string, unknown>;
      const promotionRequestId = str(p.promotionRequestId);
      const outcome = p.outcome;
      const at = new Date(typeof p.at === "string" ? p.at : event.createdAt);
      if (
        ownerModule === null ||
        promotionRequestId === null ||
        !(CHART_PROMOTION_OUTCOMES as readonly unknown[]).includes(outcome) ||
        Number.isNaN(at.getTime())
      ) {
        warn("chart promotion outcome event malformed; ignored", {
          organizationId: event.organizationId,
          eventId: event.id,
        });
        return;
      }
      const result = await deps.applyOutcome(event.organizationId, {
        ownerModule,
        promotionRequestId,
        outcome: outcome as ChartPromotionOutcome,
        resultRef: str(p.resultRef),
        decidedByUserId: str(p.decidedByUserId),
        reasonCode: reasonOf(p.reasonCode),
        at,
      });
      if (result.applied === "accepted" || result.applied === "rejected") {
        await deps.alerts.emit(event.organizationId, {
          eventType: PROMOTION_DECIDED_ALERT,
          severity: "info",
          correlationId: `promotion:${promotionRequestId}:${event.id}:${PROMOTION_DECIDED_ALERT}`,
          payload: {
            requestedByUserId: result.requestedByUserId,
            promotionRequestId,
            message: PROMOTION_DECIDED_TEXT[result.applied],
            deepLink: PROMOTION_REQUESTER_DEEP_LINK,
          },
        });
        return;
      }
      if (result.applied !== "noop") {
        warn("chart promotion outcome not applied", {
          organizationId: event.organizationId,
          promotionRequestId,
          applied: result.applied,
          ownerModule,
        });
      }
    },
  };
}
