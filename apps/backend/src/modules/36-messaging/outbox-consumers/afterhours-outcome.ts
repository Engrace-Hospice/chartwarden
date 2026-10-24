// ADR-0082 slice S3/S4: records M19's id-only answer (`m19.afterhours_triage.outcome`) on the link row of the after-hours send that asked.
// The tenant comes from the envelope, never the payload. It does NOT consult the flag: an answer M19 already committed is recorded.
// Redelivery converges (the same outcome again is a no-op; the table keeps the first). A malformed payload, an unknown source event
// id or a DIFFERENT second outcome THROWS, so the outbox retries and then dead-letters it (never a silent drop, never an overwrite).
// The thread line is derived from the recorded outcome at read time (afterhours-triage/afterhours-lines.ts); nothing is copied from M19.
import { AFTERHOURS_TRIAGE_OUTCOMES, type AfterHoursTriageOutcome } from "@chartwarden/types";
import type {
  DispatchableOutboxEvent,
  OutboxConsumerBinding,
} from "../../../bootstrap/outbox-dispatcher";
import type { AfterHoursLinkStore } from "../afterhours-triage/afterhours-link-store";

export const M36_AFTERHOURS_OUTCOME_CONSUMER = "m36.afterhours-outcome" as const;
export const M19_AFTERHOURS_OUTCOME_EVENT = "m19.afterhours_triage.outcome" as const;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: unknown): v is string => typeof v === "string" && UUID_RE.test(v);

export function buildM36AfterHoursOutcomeConsumer(deps: {
  readonly store: Pick<AfterHoursLinkStore, "recordOutcome">;
  /** Ids and a status word only. */
  readonly warn?: (message: string, context: Record<string, string>) => void;
}): OutboxConsumerBinding {
  return {
    consumerName: M36_AFTERHOURS_OUTCOME_CONSUMER,
    consumerModule: "m36",
    eventTypes: [M19_AFTERHOURS_OUTCOME_EVENT],
    async handle(event: DispatchableOutboxEvent) {
      const p = (event.payload ?? {}) as Record<string, unknown>;
      const outcome = p.outcome;
      const hasCall = p.triageCallId !== null && p.triageCallId !== undefined;
      const wellFormed =
        isUuid(p.sourceOutboxEventId) &&
        (AFTERHOURS_TRIAGE_OUTCOMES as readonly unknown[]).includes(outcome) &&
        (outcome === "no_coverage" ? !hasCall : isUuid(p.triageCallId));
      if (!wellFormed) {
        deps.warn?.("after-hours triage outcome malformed", {
          organizationId: event.organizationId,
          eventId: event.id,
        });
        throw new Error(`${M36_AFTERHOURS_OUTCOME_CONSUMER}: malformed outcome event`);
      }
      const result = await deps.store.recordOutcome(
        event.organizationId,
        p.sourceOutboxEventId as string,
        outcome as AfterHoursTriageOutcome,
        outcome === "no_coverage" ? null : (p.triageCallId as string),
      );
      if (result === "unknown" || result === "conflict") {
        deps.warn?.("after-hours triage outcome not applied", {
          organizationId: event.organizationId,
          eventId: event.id,
          result,
        });
        throw new Error(`${M36_AFTERHOURS_OUTCOME_CONSUMER}: outcome ${result}`);
      }
    },
  };
}
