// apps/backend/src/modules/23-billing-medicare/outbox-consumers/m23-revalidate-triggers.ts — F-153 (#248):
// the §4.8 "revalidate.consumer" PRODUCER side, and the first thing that has ever enqueued a
// `revalidate.consumer` BullMQ job.
//
// ── WHAT WAS MISSING ─────────────────────────────────────────────────────────────────────────────────
//
// `M23_QUEUES.revalidateConsumer` ("revalidate.consumer") has had a real, registered BullMQ WORKER since
// this module's launch-worker set landed (`runRevalidateConsumer` in `jobs/m23-jobs.ts`,
// `registerM23LaunchWorkers` starts it at boot alongside claim/NOE/NOTR submission). Nothing has ever
// ADDED a job to that queue: `M23_OUTBOX_SUBSCRIPTIONS`'s six `revalidate` topics (`m6.cti.signed`,
// `m6.f2f.attested`, `m6.loc.changed`, `m6.election.period_ended`, `m8.encounter.cosigned`,
// `m5.patient.deceased`) and the pure `consumers/handlers.ts` abstraction that projects them to this
// effect were never wired to a live `OutboxConsumerBinding` — that abstraction is unit-tested but has NO
// caller anywhere outside its own tests (its `registerM23Consumers({ports, bind})` two-arg registrar is
// never invoked from `apps/backend/src/index.ts`). This module's REAL live bindings (the NOE draft, the
// NOTR draft, the remittance-posted transition) are each a hand-written `OutboxConsumerBinding` in this
// directory instead — this file follows that same, actually-wired pattern rather than the dead one.
//
// ── WHY THIS BINDS ONLY SIX OF THE SEVEN handlers-unbound EVENTS, NOT `m25.taxonomy.unmapped_code_observed`
//
// That event needs a genuinely NEW M23-side mechanism (a pre-submission validation-rule SUGGESTION queue
// D13 gestures at but that has no table, no route and no consumer anywhere in this module) — reported,
// not built, here (see the deferred-consumers registry entry for the precise reason).
//
// ── THE TARGET RESOLVER, AND WHY `m18.evv.late_check_resolved` STAYS OUT OF THIS PASS
//
// `runRevalidateConsumer` reads every affected claim through the injected {@link
// RevalidationTargetResolverPort} (`jobs/m23-jobs.ts`), which the composition root has never bound
// (fail-closed — the worker throws, loudly, DLQ'd, the moment a job actually runs). `buildDrizzleRevalidationTargetResolver`
// (`./m23-revalidation-target-resolver.ts`) is the real implementation this pass adds, over
// `ClaimRepository.listRevalidationTargets` (F-153): every claim in VALIDATING/READY matching the event's
// `patientId` / `admissionId` (exact, on `claim`'s own logical-FK columns) or `encounterId` (a jsonb
// containment scan of `claim_line.backing_encounter_ids` — the only fact shape needing the child table).
// Every one of the six events bound here carries `patientId`, `admissionId`, or `encounterId` DIRECTLY on
// its catalogued payload (verified against each producing module's `events-by-mNN.ts`):
//   • `m6.cti.signed` / `m6.f2f.attested` / `m5.patient.deceased` → `patientId`
//   • `m6.loc.changed` / `m6.election.period_ended` → `admissionId`
//   • `m8.encounter.cosigned` → `encounterId` (no patient/admission id on this payload at all)
// `m18.evv.late_check_resolved` is NOT bound in this pass: its catalogued payload carries only `visitId`
// (`events-by-m18.ts`), and mapping a visit to a claim needs an M8 encounter lookup (`encounter.visit_id`
// — the reverse of F-123's `encounterVisitIdsForOrg`) M23 has no seam for today. Reported, not guessed at
// — inventing a visitId→claim heuristic here would be exactly the kind of unverified cross-module
// shortcut this series exists to catch (the F-102 "a guessed provider entity is a mis-stated cost
// report" lesson, applied to a mis-triggered claim re-validation instead).
//
// ── `m5.patient.deceased` IS BOUND FOR ITS `revalidate` EFFECT ONLY, NOT ITS `freeze_new_claims` ONE
//
// The dead `consumers/handlers.ts` abstraction's `handlePatientDeceased` also calls a `freezeNewClaims`
// port — genuinely unbuilt infrastructure: no `claim` column, no separate table, and no code path
// anywhere in this module writes a "new claims frozen for this patient" fact (confirmed: the port exists
// only as a `vi.fn()` mock in `__tests__/consumer-domain.test.ts`, never a real implementation). Binding
// only the revalidate effect here is not a half-bind of one atomic action — `freeze_new_claims` and
// `revalidate` are two independent effects of one event (per `M23_OUTBOX_SUBSCRIPTIONS`'s own ordered
// `effects` array), and the revalidate half is independently complete and correct on its own. The freeze
// half stays reported, not fixed, needing real new schema before it can bind.
//
// Event names are STRING literals; no M6/M8/M5 schema is imported. `RevalidateEnqueuePort` is the single
// port the composition root binds to a real `Queue("revalidate.consumer").add(...)` call.
import type { RevalidateConsumerJob } from "../jobs/m23-jobs";

/** The event names this pass binds to the `revalidate.consumer` producer. */
export const M23_REVALIDATE_TRIGGER_EVENTS = [
  "m6.cti.signed",
  "m6.f2f.attested",
  "m6.loc.changed",
  "m6.election.period_ended",
  "m8.encounter.cosigned",
  "m5.patient.deceased",
] as const;

export type M23RevalidateTriggerEventName = (typeof M23_REVALIDATE_TRIGGER_EVENTS)[number];

/** Enqueue one `revalidate.consumer` job (the composition root binds this to a real BullMQ `Queue`). */
export interface RevalidateEnqueuePort {
  enqueue(job: RevalidateConsumerJob): Promise<{ readonly jobId: string }>;
}

export interface M23RevalidateTriggerConsumerDeps {
  readonly enqueue: RevalidateEnqueuePort;
}

/**
 * Build the `OutboxConsumerBinding` for one revalidate-trigger event (§4.8). Enqueues the RAW upstream
 * event (id + name + payload) onto `revalidate.consumer`; `runRevalidateConsumer` (already a registered,
 * running worker) resolves affected claims through the injected {@link RevalidationTargetResolverPort} and
 * fans out `validation-run` jobs, idempotent on `(eventId, targetClaimId)`. The BullMQ `jobId` this binding
 * mints is `eventName` — the outbox event id — so a redelivery of the SAME event is a BullMQ-level no-op
 * before the resolver ever runs a second time.
 */
export function buildM23RevalidateTriggerConsumerFor(
  eventName: M23RevalidateTriggerEventName,
  deps: M23RevalidateTriggerConsumerDeps,
) {
  return {
    consumerName: `m23.revalidate-trigger.${eventName}`,
    consumerModule: "m23" as const,
    eventTypes: [eventName] as const,
    async handle(event: {
      readonly id: string;
      readonly organizationId: string;
      readonly payload: unknown;
    }): Promise<void> {
      const eventPayload =
        typeof event.payload === "object" && event.payload !== null
          ? (event.payload as Record<string, unknown>)
          : {};
      await deps.enqueue.enqueue({
        organizationId: event.organizationId,
        eventId: event.id,
        eventName,
        eventPayload,
      });
    },
  };
}

/** Every revalidate-trigger `OutboxConsumerBinding` this pass adds, one per bound event name. */
export function buildM23RevalidateTriggerConsumers(deps: M23RevalidateTriggerConsumerDeps) {
  return M23_REVALIDATE_TRIGGER_EVENTS.map((eventName) =>
    buildM23RevalidateTriggerConsumerFor(eventName, deps),
  );
}
