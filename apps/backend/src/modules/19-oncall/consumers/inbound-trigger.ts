// apps/backend/src/modules/19-oncall/consumers/inbound-trigger.ts — M19-T04 (D10, §2.4, §2.6, §4.8, §7.6).
//
// What the M17 no-show and M18 late-checkout consumers SHARE: the draft a machine-opened `triage_call` is,
// the three-way dedupe, and the coverage verdict. Both deciders live in `./m17-no-show` and
// `./m18-late-checkout`; the rules that are identical for both live here, once, because a welfare-check
// call that behaves differently depending on which upstream module noticed the problem is a bug waiting for
// 2 a.m.
//
// ── THE THREE FACTS EVERY MACHINE-OPENED CALL NEEDS, AND WHERE EACH COMES FROM ─────────────────────────
//
//   tenancy (org + PE + location)  → read back from M17's `VisitReader` (see ../seams/consumed)
//   the shift it belongs to        → `triage_call.on_call_shift_id` is NOT NULL; resolved from M19's own
//                                     rows by `shiftCoversInstant`
//   idempotency                    → `triage_call_source_dedupe_uq` on `source_outbox_event_id`
//
// ── DEDUPE IS THREE-WAY, NOT ONE-WAY ───────────────────────────────────────────────────────────────────
//
// §2.6 / D10's guard is `UNIQUE(source_outbox_event_id)`, which collapses a REDELIVERY of one event. It
// does nothing about two DIFFERENT events describing the same problem — and that is not hypothetical:
// M17's late-check sweep emits `m17.visit.late_check_out_suspected`, M18 opens an `evv_missing_resolution`
// and emits `m18.evv.late_check_out_detected`, and M17's no-show detector can fire for the same visit. Two
// distinct event ids, two rows, two pages to the same nurse about the same patient.
//
// The natural dedupe grain would be the VISIT, but `triage_call` has no source-visit column: §3.3 gives it
// `linked_visit_proposal_id` (the visit M19 DISPATCHES on a `visit_dispatched_now` disposition — an
// outbound link) and nothing inbound. Adding one is a schema change, and T02's migrations are landed. The
// available grain is therefore the PATIENT, which is also the right one on the merits: a second welfare
// call about a patient whose first welfare call is still open is noise, not safety. So the deciders
// coalesce onto an existing OPEN machine-opened call for the same patient, and record that they did — an
// operator can see the trigger arrived and where it went.
//
// (If a later task revisits §3.3, `triage_call.source_visit_id` would make the grain exact and let two
// genuinely different patients' triggers on one visit stay separate. Recorded here rather than assumed.)
import type {
  AdmissionId,
  IsoInstant,
  LocationId,
  OnCallShiftId,
  OrgId,
  PatientId,
  ProviderEntityId,
  TriageCallId,
  TriageCallInboundChannel,
  TriageCallSource,
} from "@wardenx/types";
import { ONCALL_COVERAGE_LOOKAHEAD_HOURS } from "@wardenx/types";
import { require_ } from "../lifecycle/errors";
import { type OnCallShiftFacts, shiftCoversInstant } from "../roster/shift-machine";

/** An `on_call_shift` row the coverage resolver considers, with its id. */
export interface CoveringShiftCandidate extends OnCallShiftFacts {
  readonly shiftId: OnCallShiftId;
  readonly providerEntityId: ProviderEntityId;
}

/**
 * The tenancy + clinical anchors read back from M17's `VisitReader` for the visit a trigger names.
 *
 * A narrowing of `VisitDto` to exactly the columns a `triage_call` row needs. Narrow on purpose: the whole
 * `VisitDto` carries scheduling detail (route, EVV bracket, encounter link) that has no business shaping a
 * triage row, and a wide fact object invites a later edit to reach for one of them.
 */
export interface TriggerVisitContext {
  readonly visitId: string;
  readonly organizationId: OrgId;
  readonly providerEntityId: ProviderEntityId;
  readonly locationId: LocationId | null;
  readonly patientId: PatientId;
  readonly admissionId: AdmissionId;
  readonly scheduledStartedAt: IsoInstant;
  readonly scheduledEndedAt: IsoInstant;
}

/** The `triage_call` row a D10 trigger inserts. Every §3.3 NOT NULL is non-null by construction. */
export interface MachineOpenedCallDraft {
  readonly organizationId: OrgId;
  readonly providerEntityId: ProviderEntityId;
  readonly locationId: LocationId | null;
  readonly onCallShiftId: OnCallShiftId;
  readonly patientId: PatientId;
  readonly admissionId: AdmissionId;
  /** D10 — always `system_inbound`: nobody dialled in. */
  readonly callerKind: "system_inbound";
  readonly inboundChannel: TriageCallInboundChannel;
  readonly source: TriageCallSource;
  /** §2.6 / D10 — the redelivery guard's key. */
  readonly sourceOutboxEventId: string;
  /**
   * The platform's own words, never a caller's. `chief_complaint_text` is §3.6-denylisted because it
   * normally holds what the caller said; a machine-opened call has no caller, so the column gets a frozen
   * platform string. It is deliberately generic — the clinical detail lives in the linked visit and in the
   * protocol the nurse applies, and duplicating it into a denylisted column would put a second unscrubbed
   * copy where the denylist exists to prevent one.
   */
  readonly chiefComplaintText: string;
  /** §2.7 step 2 — a machine-opened call is opened NOW; the paper-origin path is the only one that
   *  back-dates, and it is a human action with its own permission. */
  readonly openedAt: IsoInstant;
}

/** Facts the worker resolves before either decider can run. */
export interface InboundTriggerFacts {
  /** §2.6 — a call already written for THIS outbox event (the redelivery guard). */
  readonly existingCallForEventId: TriageCallId | null;
  /** An OPEN machine-opened call already running for this patient (the coalesce grain, above). */
  readonly openMachineCallForPatientId: TriageCallId | null;
  /** M17 `VisitReader.visitForEncounter`; null when the visit does not resolve under this tenant. */
  readonly visit: TriggerVisitContext | null;
  /** M19's own non-terminal shifts for the visit's ProviderEntity around the trigger instant. */
  readonly candidateShifts: readonly CoveringShiftCandidate[];
}

/**
 * The coverage gap a trigger ran into — the payload of `m19.oncall_shift.coverage_gap` (§4.10) and of the
 * `m19.oncall.coverage_gap_detected` alert (§4.9).
 *
 * `discipline` is fixed at `clinical_rn` because that is the coverage CoP 418.100(c)(2) obligates and the
 * one §7.4's watchdog scans for: a night with a chaplain but no nurse is a gap, and a night with a nurse
 * but no chaplain is not.
 */
export interface TriggerCoverageGap {
  readonly organizationId: OrgId;
  readonly providerEntityId: ProviderEntityId;
  readonly gapStartsAt: IsoInstant;
  readonly gapEndsAt: IsoInstant;
  readonly discipline: "clinical_rn";
}

/**
 * How far the reported gap runs: to the next shift that starts after the trigger, or — when nothing is
 * scheduled at all — to the end of §4.8's 24-hour lookahead, so the two paths that report a gap describe
 * the same window the same way. A zero-length gap would render as "no coverage, for no time", which reads
 * as noise on the DON's banner and is the fastest way to get a system-locked alert ignored.
 */
export function resolveGapWindow(
  candidates: readonly CoveringShiftCandidate[],
  at: IsoInstant,
): { readonly gapStartsAt: IsoInstant; readonly gapEndsAt: IsoInstant } {
  const nextStart = candidates
    .filter((s) => (s.status === "scheduled" || s.status === "active") && s.shiftStartsAt > at)
    .map((s) => s.shiftStartsAt)
    .sort()[0];
  const lookaheadEnd = new Date(
    new Date(at).getTime() + ONCALL_COVERAGE_LOOKAHEAD_HOURS * 3_600_000,
  ).toISOString();
  return { gapStartsAt: at, gapEndsAt: nextStart ?? lookaheadEnd };
}

/**
 * What a D10 inbound trigger resolved to. Four arms, and the fourth is the one that matters.
 *
 * `no_coverage` exists because the alternative is worse. `triage_call.on_call_shift_id` is NOT NULL, so a
 * trigger arriving when no shift covers the instant CANNOT open a call. Throwing would send it round the
 * queue's three attempts and into a DLQ — a patient welfare check parked in an ops queue, invisible to
 * anyone clinical. And this is not an edge case: §7.6's own scenario is a 14:00 visit whose no-show is
 * detected at 15:00, which is exactly when an agency that only staffs nights has no `on_call_shift` at all.
 *
 * So the missing shift is reported as what it IS: a coverage gap, on the §4.10 topic and the §4.9
 * system-locked `critical` alert that already exist for it. The §4.8 watchdog would find the same gap
 * within 30 minutes on its own cadence; a live trigger that could not be handled is the same finding with
 * evidence attached, and it should not wait for the next tick.
 */
export type InboundTriggerAction =
  /** §2.6 — a redelivery of the same outbox event. No write, no re-emit, no second page. */
  | { readonly kind: "idempotent_skip"; readonly triageCallId: TriageCallId }
  /** A different event about a patient whose welfare call is already open. Recorded, not written. */
  | { readonly kind: "coalesced"; readonly intoTriageCallId: TriageCallId }
  /** Insert the row and run `openCallEffects({ machineOpened: true })`. */
  | { readonly kind: "open_call"; readonly draft: MachineOpenedCallDraft }
  /** No shift covers the trigger instant — emit the coverage gap instead of a call. */
  | { readonly kind: "no_coverage"; readonly gap: TriggerCoverageGap };

/**
 * D10 — pick the shift a machine-opened call belongs to.
 *
 * Preference order is `active` before `scheduled` (a shift the cron has already opened is the live one),
 * then earliest-starting, so the choice is deterministic when a hybrid tenant has an internal and an
 * external shift covering the same window. Returns null when nothing covers `at`.
 */
export function resolveCoveringShift(
  candidates: readonly CoveringShiftCandidate[],
  at: IsoInstant,
): CoveringShiftCandidate | null {
  const covering = candidates.filter((s) => shiftCoversInstant(s, at));
  if (covering.length === 0) return null;
  const ranked = [...covering].sort((a, b) => {
    if (a.status !== b.status) return a.status === "active" ? -1 : 1;
    if (a.shiftStartsAt !== b.shiftStartsAt) return a.shiftStartsAt < b.shiftStartsAt ? -1 : 1;
    return a.shiftId < b.shiftId ? -1 : 1;
  });
  // `covering` is non-empty, so the sort produced at least one element.
  return ranked[0] as CoveringShiftCandidate;
}

/**
 * The shared body of both deciders: dedupe, resolve tenancy, resolve coverage, build the draft.
 *
 * ORDERING IS DELIBERATE and matches the M21-T04 precedent — idempotency first (a redelivery must never
 * re-emit, whatever else has since changed), then the coalesce, then the fail-closed tenancy anchor, then
 * coverage. The coalesce sits AFTER the event-id check so a redelivery of the very call that is open
 * reports as the redelivery it is rather than as a coalesce into itself.
 *
 * Throws `TRIGGER_ORG_MISMATCH` / `TRIGGER_VISIT_UNRESOLVED` — both dead-letter the delivery for a human
 * rather than write a row anchored to a guess. `TRIGGER_NO_COVERING_SHIFT` is NOT thrown; see
 * {@link InboundTriggerAction}.
 */
export function decideInboundTrigger(input: {
  readonly organizationId: OrgId;
  readonly sourceOutboxEventId: string;
  readonly source: TriageCallSource;
  readonly inboundChannel: TriageCallInboundChannel;
  readonly chiefComplaintText: string;
  readonly facts: InboundTriggerFacts;
  readonly at: IsoInstant;
}): InboundTriggerAction {
  const { facts } = input;

  if (facts.existingCallForEventId !== null) {
    return { kind: "idempotent_skip", triageCallId: facts.existingCallForEventId };
  }
  if (facts.openMachineCallForPatientId !== null) {
    return { kind: "coalesced", intoTriageCallId: facts.openMachineCallForPatientId };
  }

  const visit = facts.visit;
  require_(
    visit !== null,
    "TRIGGER_VISIT_UNRESOLVED",
    `VisitReader resolved no visit for inbound trigger ${input.sourceOutboxEventId}`,
  );
  require_(
    visit.organizationId === input.organizationId,
    "TRIGGER_ORG_MISMATCH",
    `trigger ${input.sourceOutboxEventId} runs under org ${input.organizationId} but its visit belongs to ${visit.organizationId}`,
  );

  const shift = resolveCoveringShift(facts.candidateShifts, input.at);
  if (shift === null) {
    return {
      kind: "no_coverage",
      gap: {
        organizationId: visit.organizationId,
        providerEntityId: visit.providerEntityId,
        ...resolveGapWindow(facts.candidateShifts, input.at),
        discipline: "clinical_rn",
      },
    };
  }

  return {
    kind: "open_call",
    draft: {
      organizationId: visit.organizationId,
      providerEntityId: visit.providerEntityId,
      locationId: visit.locationId,
      onCallShiftId: shift.shiftId,
      patientId: visit.patientId,
      admissionId: visit.admissionId,
      callerKind: "system_inbound",
      inboundChannel: input.inboundChannel,
      source: input.source,
      sourceOutboxEventId: input.sourceOutboxEventId,
      chiefComplaintText: input.chiefComplaintText,
      openedAt: input.at,
    },
  };
}
