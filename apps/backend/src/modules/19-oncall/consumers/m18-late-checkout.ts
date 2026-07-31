// apps/backend/src/modules/19-oncall/consumers/m18-late-checkout.ts — M19-T04 (§4.8, D10).
//
// M19's subscriber to `m18.evv.late_check_out_detected` — the handshake that CLOSES M18's Wave-F
// late-checkout consumer (Wave P2-2 acceptance #2). M18 owns the RULE (no EVV check-out within
// `scheduled_ended_at` + grace opens an `evv_missing_resolution` row); M19 owns the response: a
// welfare-check call, because a visit that never closed is either a clinician still in the home long past
// the scheduled end or an EVV device that stopped reporting, and at 22:00 nobody can tell which from the
// data alone.
//
// THE PAYLOAD IS THE THINNEST OF ANY M19 TRIGGER: `{ visitId, missingResolutionId, hoursPastGrace,
// hasCheckIn }` — no organization, no provider entity, no patient. M18's aggregate is the EVV resolution
// row, so the payload describes the ANOMALY, not the person it happened to. Every column
// `triage_call` needs is therefore read back through M17's `VisitReader` (../seams/consumed); an event name
// is a trigger, not a data feed, and this payload is the sharpest case of it in the corpus so far.
//
// `hasCheckIn === false` IS NOT A SEPARATE PATH, on purpose. A late check-OUT with no check-IN is the same
// visit M17's no-show detector fires on, and both events can land — which is exactly what the patient-grain
// coalesce in `./inbound-trigger` exists for. Branching here would mean either dropping the trigger (if
// M17's never fired, nobody rings the family) or opening a second call (two pages about one patient).
// Whichever event arrives first opens the call; the second coalesces into it and says so.
//
// PHASE-1 PURE DECISION CORE (the M21-T04 shape) — payload type + decider; the live binding is M19-T07's.
import type { IsoInstant, M19SubscribedEventName, OrgId } from "@wardenx/types";
import {
  type InboundTriggerAction,
  type InboundTriggerFacts,
  decideInboundTrigger,
} from "./inbound-trigger";

/** §4.8 — the subscribed event name, typed off the frozen list rather than spelled again. */
export const M18_LATE_CHECK_OUT_DETECTED_EVENT: Extract<
  M19SubscribedEventName,
  "m18.evv.late_check_out_detected"
> = "m18.evv.late_check_out_detected";

/** The `m18.evv.late_check_out_detected` payload (apps/backend/src/modules/18-evv/events-by-m18.ts). */
export interface M18LateCheckOutDetectedPayload {
  readonly visitId: string;
  readonly missingResolutionId: string;
  readonly hoursPastGrace: number;
  readonly hasCheckIn: boolean;
}

/**
 * The chief complaint a late-checkout call opens with — the platform's own words (see
 * `MachineOpenedCallDraft.chiefComplaintText` on why a denylisted column gets a frozen string).
 *
 * Deliberately says what is KNOWN ("the visit never closed") rather than what is feared. `hoursPastGrace`
 * is not interpolated: the number is already on the M18 resolution row the nurse can open, and a complaint
 * line that ages ("4.5 hours past grace") is wrong within the hour and is written into an append-only
 * clinical record.
 */
export const LATE_CHECKOUT_CHIEF_COMPLAINT =
  "Visit did not close as expected; welfare check on patient and clinician." as const;

/**
 * §4.8 — decide what an `m18.evv.late_check_out_detected` delivery does.
 *
 * Same four outcomes as the no-show path and for the same reasons (`./inbound-trigger`): redelivery of the
 * same event skips, a different event about a patient with an open welfare call coalesces, an unresolvable
 * visit dead-letters, and no covering shift reports a coverage gap rather than dropping the check into a
 * DLQ.
 */
export function decideLateCheckoutTrigger(input: {
  readonly organizationId: OrgId;
  readonly sourceOutboxEventId: string;
  readonly payload: M18LateCheckOutDetectedPayload;
  readonly facts: InboundTriggerFacts;
  readonly at: IsoInstant;
}): InboundTriggerAction {
  return decideInboundTrigger({
    organizationId: input.organizationId,
    sourceOutboxEventId: input.sourceOutboxEventId,
    source: "late_checkout",
    inboundChannel: "inbound_evv_anomaly",
    chiefComplaintText: LATE_CHECKOUT_CHIEF_COMPLAINT,
    facts: input.facts,
    at: input.at,
  });
}
