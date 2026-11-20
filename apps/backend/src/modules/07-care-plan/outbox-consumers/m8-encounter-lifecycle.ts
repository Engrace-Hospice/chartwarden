// apps/backend/src/modules/07-care-plan/outbox-consumers/m8-encounter-lifecycle.ts — WF09: the visit note's lifecycle drives the plan-of-care CHANGE
// PROPOSALS recorded in it (M7 `care_plan_change_proposal`, ../change-proposals-db.ts).
//
//   m8.encounter.finalized → the visit's DRAFT proposals become `pending`: they join the plan's review list, where the case manager or a
//                            supervisor accepts or dismisses each. Until then they are invisible to everyone but their author.
//   m8.encounter.voided    → the visit's draft proposals are `withdrawn` (M8 voids only a draft encounter, so a draft proposal is all there can be).
//
// Both touch ONLY that visit's `draft` rows: a decided proposal (accepted / dismissed) and another visit's drafts are never moved, and a
// redelivery finds nothing left to move, so each binding is idempotent without a receipt table. M7 reads no M8 table: the visit is a logical id.
// The finalized payload names the visit's patient (`encounterId`, `patientId`, `vocabVersionId`, ...; the catalog requires it), and the release is
// narrowed to that patient's proposals, so a draft recorded against another patient's plan under this visit's id is never released by it. A
// finalized event emitted by the release BEFORE the catalog required the patient (one still in the outbox at deploy) carries none: the patient is
// then resolved through M8's `EncounterDraftReader` seam (organization from the event) and the release narrowed to it, never made on the visit
// id alone, which would reach every patient's drafts. The consumer throws only when the seam cannot answer (a visit it does not know, a
// malformed id, an unreadable M8). The voided payload names no patient, which is safe: it only withdraws drafts.
//
// A malformed payload THROWS (retry → DLQ): a visit that never releases its proposals would leave the author's plan changes stranded as drafts.
import type { DbClient } from "@chartwarden/db";
import type { EncounterDraftReader } from "@chartwarden/types";
import type { OutboxConsumerBinding } from "../../../bootstrap/outbox-dispatcher";
import type { CarePlanWriteOutboxPort } from "../care-plan-route-service-db";
import { createDbChangeProposalService } from "../change-proposals-db";
import { seamEncounterDraftReader } from "../change-proposals-visit";

export const M7_ENCOUNTER_FINALIZED_EVENT = "m8.encounter.finalized";
export const M7_ENCOUNTER_VOIDED_EVENT = "m8.encounter.voided";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The visit an event names, and (when the event says so) its patient. Throws on anything else. */
export function parseEncounterEvent(
  payload: unknown,
  consumer: string,
): { readonly encounterId: string; readonly patientId?: string } {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new Error(`${consumer}: event payload must be an object`);
  }
  const { encounterId, patientId } = payload as Record<string, unknown>;
  if (typeof encounterId !== "string" || !UUID_RE.test(encounterId)) {
    throw new Error(`${consumer}: 'encounterId' must be a uuid`);
  }
  if (patientId === undefined) return { encounterId };
  if (typeof patientId !== "string" || !UUID_RE.test(patientId)) {
    throw new Error(`${consumer}: 'patientId' must be a uuid when present`);
  }
  return { encounterId, patientId };
}

/** The patient of a visit whose event named none, from M8. Throws when M8 does not know the visit (or answers a malformed id). */
async function patientOfVisit(
  visits: EncounterDraftReader,
  organizationId: string,
  encounterId: string,
  consumer: string,
): Promise<string> {
  const facts = await visits.draftOf({ organizationId, encounterId });
  if (!facts) {
    throw new Error(
      `${consumer}: the event names no patient and M8 does not know visit ${encounterId}`,
    );
  }
  if (!UUID_RE.test(facts.patientId))
    throw new Error(`${consumer}: M8 answered a malformed patient id`);
  return facts.patientId;
}

export function buildM7EncounterFinalizedConsumer(deps: {
  readonly db: DbClient;
  readonly outbox?: CarePlanWriteOutboxPort;
  /** M8's visit facts (resolves the patient of an event that names none); defaults to the `EncounterDraftReader` seam. */
  readonly visits?: EncounterDraftReader;
}): OutboxConsumerBinding {
  const consumerName = "m7.m8-encounter-finalized";
  const visits = deps.visits ?? seamEncounterDraftReader;
  const service = createDbChangeProposalService(deps.db, deps.outbox, { visits });
  return {
    consumerName,
    consumerModule: "m7",
    eventTypes: [M7_ENCOUNTER_FINALIZED_EVENT],
    async handle(event) {
      const parsed = parseEncounterEvent(event.payload, consumerName);
      const { encounterId } = parsed;
      const patientId =
        parsed.patientId ??
        (await patientOfVisit(visits, event.organizationId, encounterId, consumerName));
      await service.releaseForEncounter(event.organizationId, encounterId, { patientId });
    },
  };
}

export function buildM7EncounterVoidedConsumer(deps: {
  readonly db: DbClient;
  readonly outbox?: CarePlanWriteOutboxPort;
}): OutboxConsumerBinding {
  const consumerName = "m7.m8-encounter-voided";
  const service = createDbChangeProposalService(deps.db, deps.outbox);
  return {
    consumerName,
    consumerModule: "m7",
    eventTypes: [M7_ENCOUNTER_VOIDED_EVENT],
    async handle(event) {
      const { encounterId } = parseEncounterEvent(event.payload, consumerName);
      await service.withdrawForEncounter(event.organizationId, encounterId);
    },
  };
}
