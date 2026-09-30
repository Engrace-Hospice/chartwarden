// apps/backend/src/modules/24-billing-medicaid/outbox-consumers/m24-revalidate-triggers.ts —
// F-165 (#248, m24 group): the "trigger-revalidate" producer side of the m24 `handlers-unbound` deferred-consumers
// group — `m5.patient.updated`, `m5.patient.address_changed`, `m8.encounter.signed`. M24's own
// `M24_SUBSCRIPTION_MAP` (`consumers/subscription-map.ts`) has named all three for this action since
// F-140, with a real (never-bound) handler (`handleUpstreamChange` → `enqueueRevalidation`).
//
// Mirrors the F-153 M23 `revalidate.consumer` trigger (`23-billing-medicare/outbox-consumers/
// m23-revalidate-triggers.ts`) file-for-file: enqueues the RAW upstream event onto the
// `medicaid-revalidate` BullMQ queue; `runMedicaidRevalidate` (`../jobs/revalidate-jobs.ts`, this same
// pass) is the real processor. Every one of these three events carries `patientId` directly on its
// LOCKED payload (`05-patient/events-by-m5.ts` / `08-encounters/events-by-m8.ts`) — no cross-module id
// resolution needed, unlike M23's admissionId/encounterId cases.
import type { DispatchableOutboxEvent, OutboxConsumerBinding } from "../../../bootstrap/outbox-dispatcher";
import type { RevalidateJob } from "../jobs/revalidate-jobs";

export const M24_REVALIDATE_TRIGGER_EVENTS = [
  "m5.patient.updated",
  "m5.patient.address_changed",
  "m8.encounter.signed",
] as const;

export type M24RevalidateTriggerEventName = (typeof M24_REVALIDATE_TRIGGER_EVENTS)[number];

export interface RevalidateEnqueuePort {
  enqueue(job: RevalidateJob): Promise<{ readonly jobId: string }>;
}

export interface M24RevalidateTriggerConsumerDeps {
  readonly enqueue: RevalidateEnqueuePort;
}

function patientIdOf(payload: unknown, consumerName: string): string {
  const p = (payload ?? {}) as Record<string, unknown>;
  const patientId = p.patientId;
  if (typeof patientId !== "string" || patientId.length === 0) {
    throw new Error(`${consumerName}: payload has no patientId`);
  }
  return patientId;
}

/**
 * Build the `OutboxConsumerBinding` for one revalidate-trigger event. Enqueues the event's
 * `patientId` onto `medicaid-revalidate`; `runMedicaidRevalidate` resolves that patient's
 * revalidate-eligible claims and re-runs the §2.3 rule cycle. The BullMQ `jobId` this binding mints
 * is derived from the outbox event id (`../jobs/revalidate-jobs.ts`'s enqueue port), so a redelivery
 * of the SAME event is a BullMQ-level no-op.
 */
export function buildM24RevalidateTriggerConsumerFor(
  eventName: M24RevalidateTriggerEventName,
  deps: M24RevalidateTriggerConsumerDeps,
): OutboxConsumerBinding {
  const consumerName = `m24.revalidate-trigger.${eventName}`;
  return {
    consumerName,
    consumerModule: "m24",
    eventTypes: [eventName],
    async handle(event: DispatchableOutboxEvent): Promise<void> {
      const patientId = patientIdOf(event.payload, consumerName);
      await deps.enqueue.enqueue({
        organizationId: event.organizationId,
        eventId: event.id,
        eventName,
        patientId,
      });
    },
  };
}

/** Every revalidate-trigger `OutboxConsumerBinding` this pass adds, one per bound event name. */
export function buildM24RevalidateTriggerConsumers(
  deps: M24RevalidateTriggerConsumerDeps,
): OutboxConsumerBinding[] {
  return M24_REVALIDATE_TRIGGER_EVENTS.map((eventName) =>
    buildM24RevalidateTriggerConsumerFor(eventName, deps),
  );
}
