// apps/backend/src/modules/36-messaging/outbox-consumers/death-board.ts - WP 6.9 (ADR-0098): when a patient dies, open the death-event
// coordination board. The same two events that feed the WP 3.8 lifecycle review queue, resolved by the SAME function so the two can never
// disagree about who died:
//   m6.admission.discharged (reason death) -> patient via M6's AdmissionStatusReader
//   m5.patient.deceased                      -> patient from the payload
// A discharge or transfer is not a death: it opens no board. An M6 death arrives twice (the discharge, then M5's cascade); the board is unique
// per patient, so the second event, and any redelivery, creates nothing and re-sends only deduped alerts. TENANT: from the envelope only. A
// malformed payload, an unresolved admission, or a patient nobody eligible can own THROWS (relay retry -> DLQ), never a silently unboarded death.
// Gated on the tenant flag `messaging.death_board`: off => no board is opened (a flag that cannot be read reads as off). Logs carry ids only.
import type { OutboxConsumerBinding } from "../../../bootstrap/outbox-dispatcher";
import type { DispatchableOutboxEvent } from "../../../bootstrap/outbox-dispatcher";
import type { DeathBoardService } from "../death-board/death-board-service";
import {
  M36_PATIENT_LIFECYCLE_REVIEW_EVENT_TYPES,
  type PatientLifecycleReviewDeps,
  resolve,
} from "./patient-lifecycle-review";

export const M36_DEATH_BOARD_CONSUMER = "m36.death-board" as const;
export const M36_DEATH_BOARD_EVENT_TYPES = M36_PATIENT_LIFECYCLE_REVIEW_EVENT_TYPES;

export interface DeathBoardConsumerDeps {
  readonly admissionCare: PatientLifecycleReviewDeps["admissionCare"];
  readonly service: Pick<DeathBoardService, "createForDeath">;
  /** The `messaging.death_board` tenant flag. A throw reads as off. */
  readonly isFlagOn: (orgId: string) => Promise<boolean>;
}

async function handleEvent(
  event: DispatchableOutboxEvent,
  deps: DeathBoardConsumerDeps,
): Promise<void> {
  const orgId = event.organizationId;
  if (!(await deps.isFlagOn(orgId).catch(() => false))) return;
  const trigger = await resolve(event, deps);
  if (!trigger || trigger.cause !== "death") return;
  await deps.service.createForDeath(orgId, trigger.patientId);
}

export function buildM36DeathBoardConsumer(deps: DeathBoardConsumerDeps): OutboxConsumerBinding {
  return {
    consumerName: M36_DEATH_BOARD_CONSUMER,
    consumerModule: "m36",
    eventTypes: M36_DEATH_BOARD_EVENT_TYPES,
    handle: (event) => handleEvent(event, deps),
  };
}
