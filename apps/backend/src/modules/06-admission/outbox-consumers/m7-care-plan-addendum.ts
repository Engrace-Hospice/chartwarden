// apps/backend/src/modules/06-admission/outbox-consumers/m7-care-plan-addendum.ts — FY2027, 42 CFR 418.24(d)(2):
// "If there are any changes to the plan of care during the course of hospice care that impact the addendum
// determinations, the hospice must update the addendum, within 3 days". M6's consumer of M7's plan-of-care
// changes. It decides only WHETHER a change touches the unrelated determinations; every path then goes through
// the ONE generic entry point, `ElectionAddendumService.openAddendumUpdateWindow` (workstream B's medication / DME
// relatedness events will call that same function).
//
//   m7.problem.added / .resolved   — an `unrelated` problem was added or resolved                → update
//   m7.problem.updated             — the problem is or WAS `unrelated` (description edit or a
//                                    relatedness change in either direction)                      → update
//   m7.care_plan.version_signed    — compare the sources' current unrelated set with the latest
//                                    addendum version on file; a difference                       → update
//
// A problem event without `admissionId` (an event emitted before the payload was widened) is skipped: M6 cannot
// read M7's tables to resolve it, and the next signed care-plan version catches the change by diff.
// Idempotent: a redelivered event lands on the version it created (still a draft → `draft_refreshed`).
import type {
  DispatchableOutboxEvent,
  OutboxConsumerBinding,
} from "../../../bootstrap/outbox-dispatcher";
import type { ElectionAddendumService } from "../election-addendum/service";

export const M6_CARE_PLAN_ADDENDUM_CONSUMER = "m6.election-addendum-care-plan" as const;

export const M6_CARE_PLAN_ADDENDUM_EVENTS = [
  "m7.problem.added",
  "m7.problem.updated",
  "m7.problem.resolved",
  "m7.care_plan.version_signed",
] as const;

/** What the consumer decided for one event (pure). */
export type CarePlanAddendumDecision =
  | { readonly kind: "skip"; readonly why: string }
  | {
      readonly kind: "update";
      readonly admissionId: string;
      /** true for a signed version: only act when the determinations actually differ. */
      readonly requireDiff: boolean;
    };

const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

export function decideCarePlanAddendum(
  eventType: string,
  payload: Record<string, unknown>,
): CarePlanAddendumDecision {
  const admissionId = str(payload.admissionId);
  if (!admissionId) return { kind: "skip", why: "no admissionId on the payload" };
  switch (eventType) {
    case "m7.care_plan.version_signed":
      return { kind: "update", admissionId, requireDiff: true };
    case "m7.problem.added":
    case "m7.problem.resolved":
      return payload.kind === "unrelated"
        ? { kind: "update", admissionId, requireDiff: false }
        : { kind: "skip", why: "not an unrelated problem" };
    case "m7.problem.updated":
      return payload.kind === "unrelated" || payload.previousKind === "unrelated"
        ? { kind: "update", admissionId, requireDiff: false }
        : { kind: "skip", why: "relatedness not involved" };
    default:
      return { kind: "skip", why: `unexpected event ${eventType}` };
  }
}

export function buildM6CarePlanAddendumConsumer(deps: {
  readonly addendum: () => ElectionAddendumService;
  readonly now?: () => Date;
}): OutboxConsumerBinding {
  return {
    consumerName: M6_CARE_PLAN_ADDENDUM_CONSUMER,
    consumerModule: "m6",
    eventTypes: M6_CARE_PLAN_ADDENDUM_EVENTS,
    async handle(event: DispatchableOutboxEvent): Promise<void> {
      const payload = (event.payload ?? {}) as Record<string, unknown>;
      const decision = decideCarePlanAddendum(event.eventType, payload);
      if (decision.kind === "skip") return;
      // The plan-of-care change happened when the event was written; the consumer may run later.
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
          { requireDiff: decision.requireDiff },
        );
    },
  };
}
