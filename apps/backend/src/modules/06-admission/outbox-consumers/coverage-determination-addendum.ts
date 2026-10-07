// apps/backend/src/modules/06-admission/outbox-consumers/coverage-determination-addendum.ts — FY2027, 42 CFR
// 418.24(d)(2): a change to the hospice's coverage determination for a drug (M12 medication order) or a DME /
// supply item (M21 supply request) changes the addendum's non-covered list, so the hospice must update the
// addendum within 3 days. Same single entry point as the M7 plan-of-care consumer:
// `ElectionAddendumService.openAddendumUpdateWindow`.
//
//   covered_related → covered_related (e.g. a no-op)                                      → skip
//   either side not covered (newly excluded, re-included, or reason edited while excluded) → update
//
// An event without `admissionId` (an order outside an admission) is skipped: there is no election to amend.
import type {
  DispatchableOutboxEvent,
  OutboxConsumerBinding,
} from "../../../bootstrap/outbox-dispatcher";
import type { ElectionAddendumService } from "../election-addendum/service";

export const M6_COVERAGE_ADDENDUM_CONSUMER = "m6.election-addendum-coverage" as const;

export const M6_COVERAGE_ADDENDUM_EVENTS = [
  "m12.medication_order.coverage_determination_changed",
  "m21.supply_request.coverage_determination_changed",
] as const;

const COVERED = "covered_related";

export type CoverageAddendumDecision =
  | { readonly kind: "skip"; readonly why: string }
  | { readonly kind: "update"; readonly admissionId: string };

const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

export function decideCoverageAddendum(payload: Record<string, unknown>): CoverageAddendumDecision {
  const admissionId = str(payload.admissionId);
  if (!admissionId) return { kind: "skip", why: "no admissionId on the payload" };
  const current = str(payload.hospiceCoverage);
  const previous = str(payload.previousHospiceCoverage);
  if (current === COVERED && (previous === null || previous === COVERED)) {
    return { kind: "skip", why: "item covered before and after" };
  }
  return { kind: "update", admissionId };
}

export function buildM6CoverageAddendumConsumer(deps: {
  readonly addendum: () => ElectionAddendumService;
  readonly now?: () => Date;
}): OutboxConsumerBinding {
  return {
    consumerName: M6_COVERAGE_ADDENDUM_CONSUMER,
    consumerModule: "m6",
    eventTypes: M6_COVERAGE_ADDENDUM_EVENTS,
    async handle(event: DispatchableOutboxEvent): Promise<void> {
      const decision = decideCoverageAddendum((event.payload ?? {}) as Record<string, unknown>);
      if (decision.kind === "skip") return;
      // The determination changed when the event was written; the consumer may run later.
      const triggeredAt =
        event.createdAt instanceof Date && !Number.isNaN(event.createdAt.getTime())
          ? event.createdAt
          : (deps.now ?? (() => new Date()))();
      await deps
        .addendum()
        .openAddendumUpdateWindow(
          event.organizationId,
          decision.admissionId,
          triggeredAt,
          event.eventType,
          { requireDiff: false },
        );
    },
  };
}
