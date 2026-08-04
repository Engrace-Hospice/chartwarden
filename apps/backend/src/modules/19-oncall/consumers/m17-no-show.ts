// apps/backend/src/modules/19-oncall/consumers/m17-no-show.ts — M19-T04 (§7.6, §4.8, D10).
//
// M19's subscriber to `m17.visit.no_show_detected` — the handshake that CLOSES M17's Wave-F no-show
// consumer (Wave P2-2 acceptance #2). M17 owns the RULE that a published visit whose window passed with no
// check-in and no encounter is a no-show; M19 owns what the agency DOES about it: open a proactive
// welfare-check call so somebody rings the family. Neither imports the other — the whole contract is one
// outbox event name, read off `M19_SUBSCRIBED_EVENT_NAMES` in `@wardenx/types` so an upstream rename breaks
// the build instead of orphaning this handler.
//
// §7.6's scenario end to end: RN Tom's 14:00 visit has no EVV check-in by 15:00; M17 marks the visit
// `no_show` and emits; this consumer opens a `source='no_show'` call in `open` state linked to the visit's
// patient; a `warn` M36 alert reaches the on-call TN (the §4.9 rule makes `m19.triage.case_opened` `warn`
// rather than `info` precisely for a machine-opened call — nobody has necessarily looked at it yet); the TN
// rings the family and learns the patient was hospitalised at 13:30.
//
// PHASE-1 PURE DECISION CORE, the M21-T04 shape: this file is the payload type plus the decider. The live
// outbox binding, the transactional insert and the alert dispatch land with the M19-T07 route/service layer
// that owns `withOrgContext` and the effect runner.
import type {
  IsoInstant,
  M19SubscribedEventName,
  MembershipId,
  OrgId,
  PatientId,
} from "@wardenx/types";
import {
  type InboundTriggerAction,
  type InboundTriggerFacts,
  decideInboundTrigger,
} from "./inbound-trigger";

/** §4.8 — the subscribed event name, typed off the frozen list rather than spelled again. */
export const M17_NO_SHOW_DETECTED_EVENT: Extract<
  M19SubscribedEventName,
  "m17.visit.no_show_detected"
> = "m17.visit.no_show_detected";

/**
 * The `m17.visit.no_show_detected` payload (apps/backend/src/modules/17-scheduling/events-by-m17.ts).
 *
 * It DOES carry `patientId`, unlike M18's late-checkout payload — but not `organizationId`,
 * `providerEntityId` or `locationId`, and `triage_call` needs the first two NOT NULL. The visit read-back
 * is therefore still mandatory, and once it happens the payload's `patientId` is redundant: the decider
 * uses the VISIT's patient, so a payload and a visit that disagree resolve to the visit rather than
 * silently opening a call about the wrong person.
 */
export interface M17VisitNoShowDetectedPayload {
  readonly visitId: string;
  readonly patientId: PatientId;
  readonly clinicianMembershipId: MembershipId;
  readonly scheduledStartedAt: IsoInstant;
  readonly reason: string;
}

/**
 * §7.6 — the chief complaint a no-show call opens with, verbatim from the spec.
 *
 * A frozen platform string, not the M17 `reason` field. `reason` is M17's own free text about why the
 * scheduler marked the visit no-show ("clinician reported vehicle breakdown"), and copying it into
 * `triage_call.chief_complaint_text` would put a second unscrubbed copy of another module's prose into a
 * §3.6-denylisted column — while telling the triage nurse the scheduler's problem instead of the patient's.
 */
export const NO_SHOW_CHIEF_COMPLAINT = "Visit missed; check on patient." as const;

/**
 * §7.6 / §4.8 — decide what an `m17.visit.no_show_detected` delivery does.
 *
 * Idempotent on the outbox event id (§2.6 / D10's `triage_call_source_dedupe_uq`), coalescing onto an
 * already-open machine call for the patient, dead-lettering on an unresolvable visit, and reporting a
 * coverage gap when no shift covers the moment — see `./inbound-trigger` for why each fails the way it
 * does. This wrapper's only job is to name the source, the channel and the complaint.
 */
export function decideNoShowTrigger(input: {
  readonly organizationId: OrgId;
  readonly sourceOutboxEventId: string;
  readonly payload: M17VisitNoShowDetectedPayload;
  readonly facts: InboundTriggerFacts;
  readonly at: IsoInstant;
}): InboundTriggerAction {
  return decideInboundTrigger({
    organizationId: input.organizationId,
    sourceOutboxEventId: input.sourceOutboxEventId,
    source: "no_show",
    inboundChannel: "inbound_visit_failure",
    chiefComplaintText: NO_SHOW_CHIEF_COMPLAINT,
    facts: input.facts,
    at: input.at,
  });
}
