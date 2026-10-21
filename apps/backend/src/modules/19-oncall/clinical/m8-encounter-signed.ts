// apps/backend/src/modules/19-oncall/clinical/m8-encounter-signed.ts — M19-T05 (D8, §2.2.1, §7.1, §4.8).
//
// THE OTHER HALF OF D8. `../clinical/encounter-link` opens the draft; this file is what CLOSES the loop:
// M8's `m8.encounter.signed` is the trigger that advances `documented_pending_encounter → documented`, and
// D8 chose it deliberately over a clinician's claim of "documented" — the survey-record artifact is the
// SIGNED encounter, so the call may not close on an unsigned one. A clinician who opens the encounter and
// walks away leaves the call parked and the gap visible, which is the intended behaviour, not a bug.
//
// THE PAYLOAD IS A TRIGGER, NOT A DATA FEED (the M16-T03 / M21-T04 / M19-T04 finding, and it holds again
// here). M8's LOCKED `m8.encounter.signed` payload carries `encounterId`, `patientId`, `admissionId`,
// `signedAt` and much else — but NO `organizationId` and, crucially, no triage-call id. M19 cannot filter
// deliveries by "is this mine?" from the payload; it has to read its OWN `triage_call` back by
// `linked_encounter_id`. That read is a port, not a seam (it is M19's row), and it is also the dedupe: a
// re-delivered event finds a call already in `documented` and plans a skip.
//
// The pure decision core ships here, the M21-T04 / M19-T04 shape. The live outbox binding, the
// transactional advance and the §4.9 alert dispatch land with the M19-T07 route/service layer that owns
// `withOrgContext` and the effect runner.
import type {
  AdmissionId,
  EncounterId,
  IsoInstant,
  M19SubscribedEventName,
  MembershipId,
  OrgId,
  PatientId,
  TriageCallId,
} from "@chartwarden/types";
import {
  type TriageCallFacts,
  type TriageCallTransition,
  markDocumented,
} from "../lifecycle/triage-call";

/** §4.8 — the subscribed event name, typed off the frozen `M19_SUBSCRIBED_EVENT_NAMES` list rather than
 *  spelled again, so an upstream rename breaks the build instead of orphaning this handler. */
export const M8_ENCOUNTER_SIGNED_EVENT: Extract<M19SubscribedEventName, "m8.encounter.signed"> =
  "m8.encounter.signed";

/**
 * The subset of M8's LOCKED `m8.encounter.signed` payload M19 reads
 * (apps/backend/src/modules/08-encounters/events-by-m8.ts).
 *
 * `signedAt` is read and USED, not merely carried: `documented_at` must be the instant the encounter was
 * signed, not the instant this consumer happened to drain. The two differ by whatever the queue was behind
 * by, and the 30-minute amendment grace before `documented → closed` is measured from `documented_at` — so
 * a consumer clock would silently extend or shorten the window a clinician has to amend.
 */
export interface M8EncounterSignedPayload {
  readonly encounterId: EncounterId;
  readonly patientId: PatientId;
  readonly admissionId: AdmissionId;
  readonly signedByMembershipId: MembershipId;
  readonly signedAt: IsoInstant;
}

/** The M19-owned read behind the consumer: which call, if any, is waiting on this encounter. Not a seam —
 *  `triage_call` is M19's own row. Drizzle-backed in T07; in-memory in the §9 tests. */
export interface EncounterSignedPorts {
  /** The call whose `linked_encounter_id` is this encounter, under the consumer's `app.org_id`. */
  findCallByLinkedEncounter(
    organizationId: OrgId,
    encounterId: EncounterId,
  ): Promise<(TriageCallFacts & { readonly triageCallId: TriageCallId }) | null>;
}

/** The plan for one consumed `m8.encounter.signed`. */
export type TriageDocumentedPlan =
  | {
      readonly kind: "advance";
      readonly triageCallId: TriageCallId;
      readonly transition: TriageCallTransition;
    }
  | {
      readonly kind: "skip";
      readonly reason: /** The signed encounter belongs to no triage call — the ordinary case. Most encounters in the
       *  system are visit documentation and have nothing to do with M19. NOT an error. */
        | "no_linked_call"
        /** The call is no longer in `documented_pending_encounter` — a re-delivery (already `documented`
         *  or `closed`), or an amended-and-re-signed encounter on a call that has moved on. Idempotency
         *  lives here rather than only in the outbox-consumer ledger. */
        | "not_pending_encounter";
      readonly triageCallId: TriageCallId | null;
    };

/**
 * §2.2.1 / D8 — map one consumed `m8.encounter.signed` + the call it is linked to onto the call's
 * `documented_pending_encounter → documented` transition. PURE.
 *
 * The state check is done HERE rather than by letting `markDocumented` throw, because a re-delivery is a
 * NORMAL event on an at-least-once queue and a thrown `INVALID_STATE_TRANSITION` would send it to the DLQ.
 * `markDocumented` still runs its own link guard (an encounter id that is not the linked one refuses),
 * which cannot fire on this path — the call was found BY the link — but is the guard that protects the
 * route-driven caller.
 */
export function planTriageDocumentation(input: {
  readonly payload: M8EncounterSignedPayload;
  readonly call: (TriageCallFacts & { readonly triageCallId: TriageCallId }) | null;
}): TriageDocumentedPlan {
  const call = input.call;
  if (call === null) return { kind: "skip", reason: "no_linked_call", triageCallId: null };
  if (call.state !== "documented_pending_encounter") {
    return { kind: "skip", reason: "not_pending_encounter", triageCallId: call.triageCallId };
  }
  return {
    kind: "advance",
    triageCallId: call.triageCallId,
    transition: markDocumented({
      call,
      signedEncounterId: input.payload.encounterId,
      at: input.payload.signedAt,
    }),
  };
}

/**
 * §4.8 — resolve the fact the decider needs for one delivery, then decide.
 *
 * The org id comes from the M1 outbox envelope the dispatcher is running under, NOT from the payload
 * (which carries none) — the same shape M19-T04's inbound-trigger consumers use.
 */
export async function decideEncounterSigned(input: {
  readonly organizationId: OrgId;
  readonly payload: M8EncounterSignedPayload;
  readonly ports: EncounterSignedPorts;
}): Promise<TriageDocumentedPlan> {
  const call = await input.ports.findCallByLinkedEncounter(
    input.organizationId,
    input.payload.encounterId,
  );
  return planTriageDocumentation({ payload: input.payload, call });
}
