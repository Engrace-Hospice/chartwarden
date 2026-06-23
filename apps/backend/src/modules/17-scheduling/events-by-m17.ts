// apps/backend/src/modules/17-scheduling/events-by-m17.ts — Module 17's outbox-event contributions
// (M17-T08, spec §4.11). The full `m17.*` taxonomy keyed on M17's own `visit` / `recurring_visit` /
// `time_off` / `route_segment` lifecycle, under the `m17.` namespace (M01 D8 outbox_event_catalog /
// M03 D9 / M04 D9). check-fitness-gaps.ts scans this file for naming (`mN.<resource>.<verb>` — the gate
// only requires the `mN.` prefix, so the single-segment route/reassignment alert names below are legal),
// ownership (moduleOwner='m17'), and valid declared consumers (real module ids).
//
// The canonical wire `eventName`s mirror `M17_EVENT_NAMES` in @wardenx/types (the closed §4.11 set the
// proposal worker / visit lifecycle / recurring + time-off machines / the optimisation + stale-visit +
// late-check + caregiver-reminder sweeps may emit). Each entry adds the TypeBox `payloadSchema` + declared
// consumers the dispatcher validates each publish against, so "DB updated but the event never went out" is
// closed in the same transaction as the mutation (M1 §25.5/§25.6). Idempotency: every emit is keyed on
// `(visitId, outboxTopic, transitionedAt)` via the M1 outbox helper.
//
// Phase-1 boundary (§0): M17 PUBLISHES the full set now — the producer side ships; the consumer attaches when
// that module locks. **`m17.visit.published` wires LIVE M8's visit-seeding inert consumer (M8 D9)** — an M8
// encounter authored against a `visit_id` now has its seed. M18 (Wave F) consumes `published`/`started`/
// `late_check_out_suspected` for the EVV bracket + geofence seed. M5's `patientCaseloadProvider` reads the
// `assigned`/`unassigned` caseload-contribution stream (§4.5 D11). The Phase-2 consumers — **M19** on-call
// triage (`no_show_detected` / `reassignment_needed` / `time_off.approved`), **M31** portal upcoming-visit
// notifications (`published` / `rescheduled` / `cancelled` / `caregiver_reminder_due`), and the M15/M16
// discipline-care-plan + bereavement seam consumers — stay inert deny-stubs until those modules land; M17
// never calls their routes, it only emits the typed outbox event. Consumer dedup is keyed on
// `(eventId, consumerName)` per the M1 outbox-consumer pattern.
import { Type } from "@sinclair/typebox";
import type { TSchema } from "@sinclair/typebox";
import type { ModuleEventContribution, ModuleToken } from "@wardenx/types";

const id = Type.String({ minLength: 1 });
const isoInstant = Type.String({ minLength: 1 });
const isoDate = Type.String({ minLength: 1 });
const nullableId = Type.Union([id, Type.Null()]);

// The §4.11 wire names mirror `M17_EVENT_NAMES` (@wardenx/types) EXACTLY. The single-segment alert names
// (`m17.route_optimized`, `m17.reassignment_needed`, …) are legal to the gate (it requires only the `mN.`
// prefix) but do NOT match the stricter `OutboxEventName` template (`m${number}.${string}.${string}`), so
// `eventName` is relaxed to `string` here (every other field stays fully type-checked) and the array is cast
// once to `ModuleEventContribution` — the M13/M14 events-by-mN.ts precedent.
interface M17OutboxEntry {
  readonly eventName: string;
  readonly moduleOwner: ModuleToken;
  readonly description: string;
  readonly payloadSchema: TSchema;
  readonly declaredConsumers: readonly ModuleToken[];
  readonly isOutboxOnly: boolean;
}

const M17_OUTBOX_ENTRIES: readonly M17OutboxEntry[] = [
  // ── proposal → publish → assignment (§2.2.1 / §4.5 / §4.11) ──────────────────────────────────────────────
  {
    eventName: "m17.visit.proposed",
    moduleOwner: "m17",
    description: "The frequency/order/IDG/supervisory proposal worker emitted a visit_proposal (D5).",
    payloadSchema: Type.Object({
      proposalId: id, patientId: id, admissionId: id, source: id,
      proposedForDate: isoDate, proposedVisitPurpose: id, proposedDiscipline: id,
    }),
    declaredConsumers: ["m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m17.visit.published",
    moduleOwner: "m17",
    description: "A proposal/manual create cleared the D8 pre-schedule gate and published — CLOSES M8's visit-seeding inert consumer (M8 D9); M18 seeds the EVV geofence; M31 portal upcoming-visit (Phase 2).",
    payloadSchema: Type.Object({
      visitId: id, patientId: id, admissionId: id, assignedMembershipId: id,
      visitPurpose: id, visitSetting: id, scheduledStartedAt: isoInstant, scheduledEndedAt: isoInstant,
      patientAddressId: nullableId, externalFacilityId: nullableId,
      parentRecurringVisitId: nullableId, parentProposalId: nullableId,
    }),
    declaredConsumers: ["m8", "m18", "m31", "m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m17.visit.assigned",
    moduleOwner: "m17",
    description: "A visit was assigned/reassigned — the §4.5 D11 caseload-contribution payload M5's patientCaseloadProvider reads; M19 on-call roster (Phase 2).",
    payloadSchema: Type.Object({
      visitId: id, assignedMembershipId: id, patientId: id,
      scheduledStartedAt: isoInstant, scheduledEndedAt: isoInstant,
    }),
    declaredConsumers: ["m5", "m19", "m20"],
    isOutboxOnly: true,
  },
  {
    eventName: "m17.visit.unassigned",
    moduleOwner: "m17",
    description: "A visit was cancelled/rescheduled/reassigned away from a clinician — the caseload-removal counterpart M5 reads.",
    payloadSchema: Type.Object({
      visitId: id, formerAssignedMembershipId: id, patientId: id,
    }),
    declaredConsumers: ["m5", "m19"],
    isOutboxOnly: true,
  },
  // ── in-visit lifecycle (§2.2.1 / §4.11) ─────────────────────────────────────────────────────────────────
  {
    eventName: "m17.visit.started",
    moduleOwner: "m17",
    description: "published → en_route (EVV check-in or self-attest start); M18 brackets the visit.",
    payloadSchema: Type.Object({ visitId: id, startedAt: isoInstant, evvBracketState: id }),
    declaredConsumers: ["m18", "m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m17.visit.completed",
    moduleOwner: "m17",
    description: "in_visit → completed (driven by the M8 encounter-signed consumer, system actor, §2.2.1).",
    payloadSchema: Type.Object({
      visitId: id, completedAt: isoInstant, encounterId: nullableId, evvBracketState: id,
    }),
    declaredConsumers: ["m18", "m30", "m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m17.visit.cancelled",
    moduleOwner: "m17",
    description: "* → cancelled (warn when within 4h of the scheduled time); M18 closes the bracket, M31 notifies the portal (Phase 2).",
    payloadSchema: Type.Object({ visitId: id, cancelledBy: id, reason: Type.String(), reasonCode: id }),
    declaredConsumers: ["m18", "m31", "m33", "m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m17.visit.rescheduled",
    moduleOwner: "m17",
    description: "published → rescheduled (a new visit row carries the new time); M31 notifies the portal (Phase 2).",
    payloadSchema: Type.Object({
      visitId: id, rescheduledIntoVisitId: id, oldStartedAt: isoInstant, newStartedAt: isoInstant, reason: Type.String(),
    }),
    declaredConsumers: ["m18", "m31", "m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m17.visit.no_show_detected",
    moduleOwner: "m17",
    description: "published → no_show — flows to M19 on-call triage (Phase 2, inert); M36 warns.",
    payloadSchema: Type.Object({
      visitId: id, patientId: id, clinicianMembershipId: id, scheduledStartedAt: isoInstant, reason: Type.String(),
    }),
    declaredConsumers: ["m19", "m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m17.visit.late_check_out_suspected",
    moduleOwner: "m17",
    description: "The late-check sweep found an `in_visit` visit past scheduled_ended_at + grace with no checkout/encounter — M18 opens an evv_missing_resolution row (M18 §7 / D6).",
    payloadSchema: Type.Object({
      visitId: id, patientId: id, organizationId: id, expectedCheckOutBy: isoInstant, suspectedAt: isoInstant,
    }),
    declaredConsumers: ["m18"],
    isOutboxOnly: true,
  },
  // ── recurring + time-off (§2.2.3 / §2.2.6 / §4.11) ──────────────────────────────────────────────────────
  {
    eventName: "m17.recurring_visit.discontinued",
    moduleOwner: "m17",
    description: "active → discontinued — the policy stops; future child visits are cancelled.",
    payloadSchema: Type.Object({
      recurringVisitId: id, cancelledChildCount: Type.Integer({ minimum: 0 }), discontinuedBy: id,
    }),
    declaredConsumers: ["m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m17.time_off.requested",
    moduleOwner: "m17",
    description: "A PTO/sick/etc. request was created — M36 surfaces the approval queue with the conflict count.",
    payloadSchema: Type.Object({
      timeOffId: id, membershipId: id, startsAt: isoInstant, endsAt: isoInstant, kind: id,
      conflictingVisitCount: Type.Integer({ minimum: 0 }),
    }),
    declaredConsumers: ["m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m17.time_off.approved",
    moduleOwner: "m17",
    description: "requested → approved — triggers the reassignment scan; M19 on-call coverage (Phase 2).",
    payloadSchema: Type.Object({
      timeOffId: id, membershipId: id, approvedBy: id, affectedPublishedVisitCount: Type.Integer({ minimum: 0 }),
    }),
    declaredConsumers: ["m19", "m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m17.time_off.denied",
    moduleOwner: "m17",
    description: "requested → denied — M36 notifies the requester with the reason.",
    payloadSchema: Type.Object({ timeOffId: id, deniedBy: id, reason: Type.String() }),
    declaredConsumers: ["m36"],
    isOutboxOnly: true,
  },
  // ── route optimisation (§4.10 / §7.9 / §4.11) — Phase-1 emits the degraded path ─────────────────────────
  {
    eventName: "m17.route_optimized",
    moduleOwner: "m17",
    description: "The optimize-day worker completed a per-clinician day route (only when scheduling.route_optimization is ON).",
    payloadSchema: Type.Object({
      membershipId: id, serviceDate: isoDate, segmentCount: Type.Integer({ minimum: 0 }),
      totalProposedMiles: Type.Number(), totalProposedDriveMinutes: Type.Number(),
    }),
    declaredConsumers: ["m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m17.route_optimization_degraded",
    moduleOwner: "m17",
    description: "OSRM circuit open / optimisation disabled during optimize-day — the §7.9 Phase-1 degraded path; M36 warns.",
    payloadSchema: Type.Object({ membershipId: id, serviceDate: isoDate, reason: Type.String() }),
    declaredConsumers: ["m33", "m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m17.reassignment_needed",
    moduleOwner: "m17",
    description: "The reassignment scan found a published visit whose clinician became ineligible (PTO/credential/volunteer-gate) — M19 triage (Phase 2); M36 warns.",
    payloadSchema: Type.Object({
      visitId: id, affectedMembershipId: id,
      reason: Type.Union([
        Type.Literal("pto_approved"),
        Type.Literal("credential_expired"),
        Type.Literal("volunteer_gate_expired"),
      ]),
    }),
    declaredConsumers: ["m19", "m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m17.stale_visit_detected",
    moduleOwner: "m17",
    description: "The stale-visit sweep found a visit stuck `in_visit` > 48h — M36 alerts the operator.",
    payloadSchema: Type.Object({
      visitId: id, stuckInState: Type.Literal("in_visit"), hoursStuck: Type.Number(),
    }),
    declaredConsumers: ["m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m17.caregiver_reminder_due",
    moduleOwner: "m17",
    description: "The caregiver-reminder cron found an opted-in visit ~24h out — M22 renders the reminder, M36 delivers; M31 portal (Phase 2).",
    payloadSchema: Type.Object({
      visitId: id, patientId: id, channel: Type.Union([Type.Literal("sms"), Type.Literal("email")]),
      scheduledStartedAt: isoInstant,
    }),
    declaredConsumers: ["m22", "m31", "m36"],
    isOutboxOnly: true,
  },
];

/** Module 17's §4.11 outbox-event catalog contribution (the boot UPSERTs each into `outbox_event_catalog`). */
export const M17_OUTBOX_EVENTS: ModuleEventContribution =
  M17_OUTBOX_ENTRIES as unknown as ModuleEventContribution;
