// apps/backend/src/modules/36-messaging/medication-questions/medication-question-events.ts - WP 3.10: the one outbox event a
// medication question emits when it has no nurse. PHI-free by construction: ids, an enum and an instant - no patient id and
// no text. Published in the SAME transaction as the write that left the question unrouted (the caller passes its `tx`).
// The catalog entry lives in events-by-m36.ts (S2).
import type { MedicationQuestionUnroutedReason } from "@wardenx/types";
import type { HintOutboxPort } from "../message-hint-events";

export const M36_MEDICATION_QUESTION_UNROUTED = "m36.medication_question.unrouted";
const AGGREGATE_KIND = "message";

export interface MedicationQuestionUnroutedFacts {
  readonly orgId: string;
  readonly channelId: string;
  readonly messageId: string;
  readonly askedByUserId: string;
  readonly reason: MedicationQuestionUnroutedReason;
  readonly at: Date;
}

export function medicationQuestionUnroutedPayload(
  f: MedicationQuestionUnroutedFacts,
): Record<string, unknown> {
  return {
    organizationId: f.orgId,
    channelId: f.channelId,
    messageId: f.messageId,
    askedByUserId: f.askedByUserId,
    reason: f.reason,
    at: f.at.toISOString(),
  };
}

export async function publishMedicationQuestionUnrouted(
  outbox: HintOutboxPort | undefined,
  tx: unknown,
  facts: MedicationQuestionUnroutedFacts,
): Promise<void> {
  await outbox?.publish(tx, {
    eventName: M36_MEDICATION_QUESTION_UNROUTED,
    organizationId: facts.orgId,
    aggregateKind: AGGREGATE_KIND,
    aggregateId: facts.messageId,
    payload: medicationQuestionUnroutedPayload(facts),
  });
}
