// apps/backend/src/modules/19-oncall/events-by-m19.ts — Module 19's outbox-event catalog contribution,
// the `m19.*` taxonomy `write-service-drizzle.ts` and the D10 inbound-trigger watchdog
// (`consumers/inbound-trigger.ts`) publish/declare, closed over `M19_EVENT_NAMES` (@wardenx/types,
// `packages/types/src/oncall.ts`) — the pre-existing source of truth every idempotency-key entry and
// consumer wiring already referenced by name.
//
// GENUINE GAP, not a stylistic omission: unlike every other module, M19 shipped with NO
// `events-by-m19.ts` at all and no entry in `apps/backend/src/index.ts`'s `buildBootOutboxCatalog([...])`
// list. Every one of the ten call-scoped/shift emits in `write-service-drizzle.ts` throws
// `OutboxEventValidationError: unknown_event` and rolls back its own transaction on the very first call —
// `POST /oncall/shifts/:id/open`, `POST /triage-calls`, disposition, escalation, protocol application,
// abandon — were unconditionally 500s in every environment, not seed-specific. `shifts.routes.ts`'s own
// route comments already named `m19.oncall_shift.activated` as a topic M36 and M20 subscribe to, and
// M20's `consumers/index.ts` lists it in `M20_SUBSCRIBED_EVENT_NAMES` — the consumer side already
// expected this catalog to exist.
//
// Payload shapes are transcribed from each event's actual construction site in `write-service-drizzle.ts`
// (the `payloads: {...}` object literal passed to `runEffects`, or `dispositionPayloads()`), NOT invented.
// One exception was true at the time this file was written and no longer is: `m19.oncall_shift.
// coverage_gap`'s schema mirrors `consumers/inbound-trigger.ts`'s `TriggerCoverageGap`, and at the time
// nothing published it. `consumers/bindings.ts` (F-043/#103) now does — the D10 `no_coverage` outcome
// publishes it INSTEAD of a call, since `triage_call.on_call_shift_id` is NOT NULL and a thrown DLQ entry
// would park a patient-welfare check where no clinician would see it. `m19.triage.summary_requested`
// still has no producer at all: reserved for the M22 caregiver/attending PDF-summary render request this
// module's own spec names (F-142/#248 corrected the declared consumer from m32 to m22 — a prior
// documentation error), its schema is the same conservative call-scoped base every other
// `m19.triage_call.*` event carries — a future implementer may need to widen it, but a closed,
// too-narrow schema here is strictly safer than an unregistered event name.
import { Type } from "@sinclair/typebox";
import type { ModuleEventContribution } from "@wardenx/types";

const id = Type.String({ minLength: 1 });
const isoInstant = Type.String({ minLength: 1 });
const nullableId = Type.Union([id, Type.Null()]);
const nullableStr = Type.Union([Type.String(), Type.Null()]);

/** The §4.10-equivalent payload base every `m19.triage_call.*` event carries (`callEventBase` in
 *  `write-service-drizzle.ts`). */
const callEventBase = {
  orgId: id,
  providerEntityId: id,
  triageCallId: id,
  occurredAt: isoInstant,
};

/** Module 19's outbox-event catalog contribution — the full closed `M19_EVENT_NAMES` set. */
export const M19_OUTBOX_EVENTS: ModuleEventContribution = [
  {
    eventName: "m19.triage_call.opened",
    moduleOwner: "m19",
    description: "A triage call was opened against a covering on-call shift.",
    payloadSchema: Type.Object({
      ...callEventBase,
      onCallShiftId: id,
      source: id,
      patientId: nullableId,
      paperOrigin: Type.Boolean(),
      originalOpenedAt: nullableId,
    }),
    declaredConsumers: [],
    isOutboxOnly: true,
  },
  {
    eventName: "m19.triage_call.protocol_applied",
    moduleOwner: "m19",
    description: "The server-authoritative D5 protocol was pinned to a triage call.",
    payloadSchema: Type.Object({
      ...callEventBase,
      triageProtocolId: id,
      protocolVersion: id,
      mandatoryEscalation: nullableStr,
    }),
    declaredConsumers: [],
    isOutboxOnly: true,
  },
  {
    eventName: "m19.triage_call.red_flag_hit",
    moduleOwner: "m19",
    description:
      "A protocol question answer matched a D5 red-flag predicate, opening a mandatory escalation.",
    payloadSchema: Type.Object({
      ...callEventBase,
      questionId: id,
      escalationId: id,
    }),
    declaredConsumers: [],
    isOutboxOnly: true,
  },
  {
    eventName: "m19.triage_call.escalation_recorded",
    moduleOwner: "m19",
    description:
      "A D7 escalation tier was recorded against a triage call (manual or protocol-mandatory).",
    payloadSchema: Type.Object({
      ...callEventBase,
      escalationId: id,
      tier: id,
      triggerKind: id,
    }),
    declaredConsumers: [],
    isOutboxOnly: true,
  },
  {
    eventName: "m19.triage_call.disposition_selected",
    moduleOwner: "m19",
    description: "The D6 disposition was recorded for a triage call.",
    payloadSchema: Type.Object({
      ...callEventBase,
      disposition: id,
      dispositionData: Type.Unknown(),
    }),
    declaredConsumers: [],
    isOutboxOnly: true,
  },
  {
    eventName: "m19.triage_call.documented",
    moduleOwner: "m19",
    description:
      "`documented_pending_encounter → documented` — advanced by the M8 `encounter.signed` consumer (`clinical/m8-encounter-signed.ts`), never by a route directly.",
    payloadSchema: Type.Object({
      ...callEventBase,
      signedEncounterId: id,
      documentedAt: isoInstant,
    }),
    declaredConsumers: [],
    isOutboxOnly: true,
  },
  {
    eventName: "m19.triage_call.visit_needed",
    moduleOwner: "m19",
    description:
      "A disposition (visit_dispatched_now / visit_scheduled_first_light / pronouncement_scheduled) requires M17 to create a visit.",
    payloadSchema: Type.Object({
      ...callEventBase,
      patientId: nullableId,
      requestedDiscipline: nullableStr,
      requestedArrivalBy: nullableId,
      proposedForDate: nullableId,
      reason: nullableStr,
      // F-166 (#248) — the M17 consumer needs to tell `visit_dispatched_now` apart from
      // `pronouncement_scheduled` (both set `requestedArrivalBy` and leave `proposedForDate` null; the
      // payload alone is otherwise ambiguous between them) so it can pick the right `visit_purpose`
      // (`prn` vs `pronouncement`) rather than guess from `reason`'s free text.
      visitKind: Type.Union([
        Type.Literal("dispatch_now"),
        Type.Literal("first_light"),
        Type.Literal("pronouncement"),
      ]),
    }),
    declaredConsumers: ["m17"],
    isOutboxOnly: true,
  },
  {
    eventName: "m19.triage_call.gip_admission_proposed",
    moduleOwner: "m19",
    description: "A disposition proposed a GIP level-of-care change for M37 to action.",
    payloadSchema: Type.Object({
      ...callEventBase,
      patientId: nullableId,
      gipCriteriaSummary: nullableStr,
      preferredFacility: nullableStr,
    }),
    // F-143 (#248) — m6 REMOVED: M19's own spec (line 18, the "Consumed by" table; line 1947, Lock
    // status) is decisive that M37 — never M6 — is the real consumer ("M37 IPU / GIP module consumes
    // `m19.triage_call.gip_admission_proposed` at M37 lock"). M6's own advisory role on this
    // disposition is a SEAM (line 401: "M11 `level_of_care_change` order draft via M11 seam"), not an
    // outbox subscription; M6 never subscribes to this event.
    declaredConsumers: ["m37"],
    isOutboxOnly: true,
  },
  {
    eventName: "m19.triage_call.care_plan_change_indicated",
    moduleOwner: "m19",
    description:
      "A disposition indicated a care-plan-relevant change (rides alongside gip_admission_proposed).",
    payloadSchema: Type.Object({
      ...callEventBase,
      patientId: nullableId,
      changeKind: id,
    }),
    // F-142 (#248) — m7 corrected to m14: this module's own §11 D8-cascade table (line 117) is
    // decisive — "M19 emits `m19.triage_call.care_plan_change_indicated` consumed by M14's IDG packet
    // builder so the next IDG agenda includes it" — the real consumer was always M14, not M7.
    declaredConsumers: ["m14"],
    isOutboxOnly: true,
  },
  {
    eventName: "m19.triage_call.closed",
    moduleOwner: "m19",
    description: "A triage call reached a terminal state (abandoned, or the ordinary close path).",
    payloadSchema: Type.Object({
      ...callEventBase,
      finalDisposition: nullableStr,
    }),
    declaredConsumers: [],
    isOutboxOnly: true,
  },
  {
    eventName: "m19.oncall_shift.activated",
    moduleOwner: "m19",
    description:
      "An `on_call_shift` moved `scheduled → active` (D7's policy snapshot pinned) — the canonical shift-open topic M36's channel synchronizer and M20's SOS on-call-roster lookup both subscribe to.",
    payloadSchema: Type.Object({
      orgId: id,
      providerEntityId: id,
      occurredAt: isoInstant,
      shiftId: id,
      discipline: id,
      membershipId: nullableId,
      externalActorId: nullableId,
      openedAt: isoInstant,
    }),
    // F-043/#103 — M20's own `consumers/index.ts` states why it has no consumer for this and never will:
    // the topic exists in `M20_SUBSCRIBED_EVENT_NAMES` as the re-sync trigger for a CACHED on-call
    // resolution, and M20 caches none — the D14 union is resolved live at fan-out, because a cached
    // roster is a 3 a.m. staleness bug. Nothing to re-sync, nothing to consume, and a declaration with no
    // consumer behind it deferred every shift activation forever.
    declaredConsumers: [],
    seamConsumers: ["m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m19.oncall_shift.completed",
    moduleOwner: "m19",
    description:
      "An `on_call_shift` closed — removes the departing actor from M36's channel; messages sent during their tenure stay attributed to them (§4.5).",
    payloadSchema: Type.Object({
      orgId: id,
      providerEntityId: id,
      occurredAt: isoInstant,
      shiftId: id,
    }),
    declaredConsumers: [],
    seamConsumers: ["m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m19.oncall_shift.coverage_gap",
    moduleOwner: "m19",
    description:
      "The §4.8 D10 inbound-trigger watchdog found no covering shift for the RN discipline CoP 418.100(c)(2) requires — schema mirrors `TriggerCoverageGap` (`consumers/inbound-trigger.ts`), published by `consumers/bindings.ts`'s `no_coverage` outcome (#103).",
    payloadSchema: Type.Object({
      organizationId: id,
      providerEntityId: id,
      gapStartsAt: isoInstant,
      gapEndsAt: isoInstant,
      discipline: Type.Literal("clinical_rn"),
    }),
    declaredConsumers: [],
    seamConsumers: ["m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m19.triage.summary_requested",
    moduleOwner: "m19",
    description:
      "A triage call generated a patient-facing summary (caregiver/attending instructions); M22 renders the PDF, M19 has no PDF code. No producer exists yet. Schema kept to the conservative call-scoped base shared by every other `m19.triage_call.*` event.",
    payloadSchema: Type.Object(callEventBase),
    // F-142 (#248) — corrected m32 to m22: this file's own prior comment ("reserved for an M32 AI
    // call-summary request") was a documentation error, contradicted three separate ways by this
    // module's own locked spec — the §"Consumed by" table (module 22: "M19 emits
    // `m19.triage.summary_requested` and M22 renders the PDF; M19 has no PDF code"), the §4.10 outbox
    // events table ("(M22 consumer)"), and the Lock-status section ("M22 caregiver-summary consumer
    // subscribes to `m19.triage.summary_requested` at M22 lock") — and by `packages/types/src/
    // oncall.ts`'s own payload doc comment ("→ M22 renders the caregiver/attending summary document").
    declaredConsumers: ["m22"],
    isOutboxOnly: true,
  },
];
