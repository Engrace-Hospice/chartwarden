// apps/backend/src/modules/19-oncall/consumers/m36-delivery-failed.ts — M19-T07 (§4.8, D10, §2.7 D-D).
//
// M19's subscriber to `m36.notification.delivery_failed` — §4.8's `m19.m36-delivery-failed.consumer`,
// whose whole job is stated in five words: "with on-call recipient". A delivery failure to a billing clerk
// is M36's problem; a delivery failure to the person covering tonight means the page did not arrive, and
// the agency currently believes someone was told something they were not.
//
// ── WHY THIS TRIGGER DOES NOT REUSE `decideInboundTrigger` ─────────────────────────────────────────────
//
// The M17 / M18 triggers describe a VISIT and read their tenancy back through M17's `VisitReader`. A
// delivery failure describes a MESSAGE. There is no visit to read back, and — critically — when the failed
// alert was ABOUT a triage call, opening a second call for the same patient is the exact duplication the
// patient-grain coalesce in `./inbound-trigger` exists to prevent. So the response splits on whether the
// undelivered alert named an M19 call:
//
//   • IT DID → escalate the EXISTING call one rung (`sla_breach` trigger kind, tier 1). The clinical record
//     already exists; what is missing is a human who knows. A second `triage_call` row would fork the
//     narrative of one 2 a.m. event across two records, and §7.2's audit chain reads one call.
//   • IT DID NOT → open a PATIENT-LESS operational call (`source = 'm36_delivery_failure'`,
//     `inbound_channel = 'inbound_alert_failure'`). `triage_call.patient_id` is nullable precisely because
//     a call exists before its caller is identified (§3.3); here there is no caller at all, and the row is
//     the worklist item that makes "the on-call channel is dark" something a supervisor sees rather than a
//     line in a dead-letter queue.
//   • NEITHER, because the recipient was not on-call → `ignore`. §4.8's filter, honoured rather than
//     widened: M19 does not own every failed notification in the platform.
//
// ── THE PAYLOAD IS REAL, AND SO IS THE PRODUCER ─────────────────────────────────────────────────────────
//
// `events-by-m36.ts` catalogues the wire payload (#205 hard-half follow-up); the type below is this
// module's own domain-shaped VIEW of it, mapped from the catalog's generic `sourceAggregateId` by
// `./bindings.ts` (`triageCallId: payload.alertEventType?.startsWith("m19.") ? sourceAggregateId : null` —
// M19 only trusts an aggregate id when the alert that failed to deliver was one of its own). Every field
// M19 cannot get is still handled: an absent `providerEntityId` on an on-call failure cannot anchor a row
// (`triage_call.provider_entity_id` is NOT NULL), so it dead-letters for a human rather than being
// anchored to a guess. M36's `applyDeliveryTransition` (delivery-settlement.ts) is the producer; this
// decider is exercised end to end by m19-inbound-triggers.live.
import type {
  IsoInstant,
  M19SubscribedEventName,
  OrgId,
  ProviderEntityId,
  TriageCallId,
  TriageEscalationTier,
} from "@chartwarden/types";
import { require_ } from "../lifecycle/errors";
import {
  type CoveringShiftCandidate,
  type TriggerCoverageGap,
  resolveCoveringShift,
  resolveGapWindow,
} from "./inbound-trigger";

/** §4.8 — the subscribed event name, typed off the frozen list rather than spelled again. */
export const M36_DELIVERY_FAILED_EVENT: Extract<
  M19SubscribedEventName,
  "m36.notification.delivery_failed"
> = "m36.notification.delivery_failed";

/** The recipient classes M36 resolves an alert to. Only `on_call` is M19's business (§4.8). */
export type M36DeliveryRecipientKind =
  | "on_call"
  | "role_set"
  | "care_team"
  | "individual"
  | "other";

/** The `m36.notification.delivery_failed` payload M19 requires (forward-declared — see the header). */
export interface M36DeliveryFailedPayload {
  readonly notificationId: string;
  /** Which recipient resolver M36 used. M19 acts only on `on_call`. */
  readonly recipientKind: M36DeliveryRecipientKind;
  /** The ProviderEntity whose on-call channel was targeted. Required to anchor any M19 row. */
  readonly providerEntityId: ProviderEntityId | null;
  /** The alert event type M36 was delivering (`m19.triage.*` when the page was ours). */
  readonly alertEventType: string | null;
  /** The M19 call the undelivered alert was about, when it was about one. */
  readonly triageCallId: TriageCallId | null;
  /** The channel that failed (`sms`, `voice_dial`, `push`, …) — recorded, never branched on. */
  readonly channel: string | null;
  readonly failedAt: IsoInstant;
}

/** The facts the worker resolves before the decider can run. */
export interface DeliveryFailureFacts {
  /** §2.6 — a call already written for THIS outbox event (the redelivery guard). */
  readonly existingCallForEventId: TriageCallId | null;
  /** Does the named call still exist under this tenant, and is it still open? */
  readonly namedCallIsOpen: boolean;
  /** M19's own non-terminal shifts for the payload's ProviderEntity around the failure instant. */
  readonly candidateShifts: readonly CoveringShiftCandidate[];
}

/**
 * The tier a failed on-call page escalates to.
 *
 * `tier_1_rn_supervisor` and not higher, deliberately: the supervisor is the person who can raise someone
 * else on the roster tonight, and §7.2's higher tiers are clinical-authority rungs, not reachability ones.
 * Waking the medical director because an SMS gateway timed out would train the tier-3 recipient to ignore
 * the rung that also carries suicidal ideation.
 */
export const DELIVERY_FAILURE_ESCALATION_TIER: TriageEscalationTier = "tier_1_rn_supervisor";

/** The chief complaint an operational (patient-less) delivery-failure call opens with — platform words. */
export const DELIVERY_FAILURE_CHIEF_COMPLAINT =
  "After-hours alert delivery failed; confirm on-call coverage is reachable." as const;

/** The row a patient-less operational call inserts. Every §3.3 NOT NULL is non-null by construction. */
export interface OperationalCallDraft {
  readonly organizationId: OrgId;
  readonly providerEntityId: ProviderEntityId;
  readonly onCallShiftId: string;
  /** D10 — always `system_inbound`: nobody dialled in. */
  readonly callerKind: "system_inbound";
  readonly inboundChannel: "inbound_alert_failure";
  readonly source: "m36_delivery_failure";
  readonly sourceOutboxEventId: string;
  readonly chiefComplaintText: string;
  readonly openedAt: IsoInstant;
}

/** What an `m36.notification.delivery_failed` delivery resolved to. */
export type DeliveryFailureAction =
  /** §4.8's filter — the failure was not to an on-call recipient. */
  | { readonly kind: "ignore"; readonly reason: "recipient_not_on_call" }
  /** §2.6 — a redelivery of the same outbox event. */
  | { readonly kind: "idempotent_skip"; readonly triageCallId: TriageCallId }
  /** The undelivered alert named a still-open M19 call: escalate THAT call, do not open a second. */
  | {
      readonly kind: "escalate_existing";
      readonly triageCallId: TriageCallId;
      readonly tier: TriageEscalationTier;
    }
  /** No call named (or the named one has closed): open the patient-less operational worklist row. */
  | { readonly kind: "open_operational_call"; readonly draft: OperationalCallDraft }
  /** Nothing covers the failure instant — report the gap rather than dropping the finding. */
  | { readonly kind: "no_coverage"; readonly gap: TriggerCoverageGap };

/**
 * §4.8 — decide what an `m36.notification.delivery_failed` delivery does.
 *
 * ORDER: the §4.8 recipient filter first (cheapest, and it is the majority case), then idempotency, then
 * the named-call branch, then coverage. The named-call branch is checked BEFORE the ProviderEntity
 * requirement because escalating an existing call needs no new row and therefore no tenancy anchor — the
 * call already carries one.
 *
 * A CLOSED named call falls THROUGH to the operational branch rather than escalating. §2.2.4 forbids
 * writing an escalation onto a terminal call, and a page that failed after the call closed still means the
 * channel is dark tonight — which is the operational row's whole purpose.
 */
export function decideDeliveryFailureTrigger(input: {
  readonly organizationId: OrgId;
  readonly sourceOutboxEventId: string;
  readonly payload: M36DeliveryFailedPayload;
  readonly facts: DeliveryFailureFacts;
  readonly at: IsoInstant;
}): DeliveryFailureAction {
  const { payload, facts } = input;

  if (payload.recipientKind !== "on_call") {
    return { kind: "ignore", reason: "recipient_not_on_call" };
  }
  if (facts.existingCallForEventId !== null) {
    return { kind: "idempotent_skip", triageCallId: facts.existingCallForEventId };
  }
  if (payload.triageCallId !== null && facts.namedCallIsOpen) {
    return {
      kind: "escalate_existing",
      triageCallId: payload.triageCallId,
      tier: DELIVERY_FAILURE_ESCALATION_TIER,
    };
  }

  // From here a NEW row is written, so the tenancy anchor is mandatory (§3.3's NOT NULL columns).
  require_(
    payload.providerEntityId !== null,
    "DELIVERY_FAILURE_PROVIDER_ENTITY_UNRESOLVED",
    `m36 delivery failure ${input.sourceOutboxEventId} names an on-call recipient but no provider entity; it cannot anchor a triage_call row`,
  );
  const providerEntityId = payload.providerEntityId;

  const shift = resolveCoveringShift(facts.candidateShifts, input.at);
  if (shift === null) {
    return {
      kind: "no_coverage",
      gap: {
        organizationId: input.organizationId,
        providerEntityId,
        ...resolveGapWindow(facts.candidateShifts, input.at),
        discipline: "clinical_rn",
      },
    };
  }

  return {
    kind: "open_operational_call",
    draft: {
      organizationId: input.organizationId,
      providerEntityId,
      onCallShiftId: shift.shiftId,
      callerKind: "system_inbound",
      inboundChannel: "inbound_alert_failure",
      source: "m36_delivery_failure",
      sourceOutboxEventId: input.sourceOutboxEventId,
      chiefComplaintText: DELIVERY_FAILURE_CHIEF_COMPLAINT,
      openedAt: input.at,
    },
  };
}
