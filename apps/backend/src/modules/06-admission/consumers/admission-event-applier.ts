// apps/backend/src/modules/06-admission/consumers/admission-event-applier.ts — the M6 side of the
// M29 inbound-HL7 consumer (M6-T11, spec §4.8). PHASE-1 PURE DECISION CORE.
//
// The `AdmissionEventApplier` is the `m29.hl7_inbound_proposal.accepted` consumer for
// `ownerModule='m6'`. It handles three resource kinds — `discharge_event` (the external-death subpath
// is the high-value one), `admission_event` (concurrent-hospital-admission alert), and
// `cancel_admission` (referral-withdrawn handling). Per §4.8 the applier is NOT a published seam: it
// composes M6's own service layer so the state machines stay authoritative. It NEVER auto-creates
// admissions, NEVER signs election statements, NEVER mutates CTI/F2F state (D13 narrow rails); the
// single admission-lifecycle transition it can drive is the external-death discharge, and only when
// the full D14 precondition set holds (§2.4.1 R-EXT-01) — every other signal becomes an informational
// `compliance_window` (severity `info`, D15) for human triage.
//
// M29 (HL7/ADT interop) is Wave H — there is no `m29.hl7_inbound_proposal.accepted` PRODUCER yet, so
// the outbox binding is forward-declared/deferred (see ./../outbox-consumers/m29-proposal-accepted.ts).
// What ships now is the PURE, fully-tested decision core {@link decideAdmissionEvent}: given the
// accepted-proposal payload + the facts the applier reads (idempotency, the matched patient's
// admission summary, the active election period covering the death date, a pending-referral lookup),
// it returns the {@link ApplierAction} descriptor describing the effect to apply. Wiring M29 later
// (W-M6-31..35) is binding the outbox handler to this decider + executing each action through the
// `dischargeService` / `referralService` / `complianceWindowService` the route layer already owns.
import type {
  ActiveElectionPeriod,
  AdmissionId,
  AdmissionSummary,
  ComplianceWindowKind,
  ExternalSignalWindowPayload,
  LocalDate,
} from "@wardenx/types";

// ── The accepted-proposal payload M6 consumes (§4.8.2) ───────────────────────────────────────────────

/** The parsed ADT event context M29's T-29.06 attaches to an M6-owned proposal (§4.8.2). M6 does NOT
 * parse HL7 (§ Non-goals) — it reads this already-parsed projection. */
export interface ProposedEventContext {
  readonly eventType: string; // 'A01' | 'A03' | 'A11' …
  readonly eventTimestamp: string; // ISO from EVN-2
  readonly dischargeDisposition?: string; // PV1-36 / EVN-4 (e.g. '20' = Expired)
  readonly admissionSource?: string; // PV1-14
  readonly patientClass?: string; // PV1-2 ('I' = inpatient, 'O' = outpatient, 'E' = emergency)
  readonly facilityCode?: string; // PV1-3 building/facility
  readonly mappedDischargeReason?:
    | "death"
    | "transferred_to_acute"
    | "left_against_advice"
    | "other";
  /** For a cancel-admit (A11) this is the REFERENCED original-admit control id, not the cancel's own. */
  readonly messageControlId: string;
  readonly sendingFacility: string;
  readonly sendingApplication?: string;
}

/** The resource kinds an accepted proposal can carry; only the last three are M6-owned (§4.8.2). */
export type ProposalResourceKind =
  | "patient_demographic_update"
  | "new_patient"
  | "admission_event"
  | "discharge_event"
  | "cancel_admission";

/** The `m29.hl7_inbound_proposal.accepted` payload (§4.8.2). The M5-owned fields are present but unused
 * by M6; `proposedEventContext` is the M6 (T-29.06 §2.3) extension. */
export interface ProposalAcceptedPayload {
  readonly proposalId: string;
  readonly organizationId: string;
  readonly sourceMessageId: string;
  readonly resourceKind: ProposalResourceKind;
  readonly ownerModule: "m5" | "m6";
  readonly matchedPatientId: string | null;
  readonly decidedByMembershipId: string;
  readonly decidedAt: string;
  readonly decisionRationale?: string | null;
  readonly appliedFields?: readonly string[] | null;
  readonly proposedPatientCandidate?: unknown;
  readonly proposedEventContext?: ProposedEventContext;
}

// ── The facts the applier reads before deciding (resolved by the live consumer from M6 services) ──────

/** Everything the applier must read before it can decide, surfaced as data so {@link decideAdmissionEvent}
 * stays pure. The Wave-H consumer resolves these via the audit log (idempotency), the
 * `AdmissionStatusReader`/`ElectionPeriodReader` seams, and `ReferralService.findPendingByExternalMessageRef`. */
export interface ApplierFacts {
  /** A prior `m6.applier.processed` audit row already references this `proposalId` (idempotency, W-M6-35). */
  readonly alreadyProcessed: boolean;
  /** The matched patient's current admission, or null if none is visible (death/admission paths). */
  readonly admissionSummary: AdmissionSummary | null;
  /** The election period covering the death date, or null if none (D14 precondition (d), death path). */
  readonly activePeriodOnDeathDate: ActiveElectionPeriod | null;
  /** A `pending` referral whose `external_message_ref` matches the cancel-admit reference, else null. */
  readonly pendingReferralId: string | null;
}

// ── The effect descriptor the decider returns (executed by the Wave-H consumer) ───────────────────────

/** The three external-signal window kinds the applier may open (all `severity='info'`, D15). */
export type ExternalSignalWindowType = Extract<
  ComplianceWindowKind,
  "concurrent_hospital_admission" | "external_discharge_notice" | "hl7_admission_cancellation"
>;

/** A fully-resolved informational compliance window the applier opens for human triage (§4.8 helpers). */
export interface ExternalSignalWindowDescriptor {
  readonly type: ExternalSignalWindowType;
  readonly severity: "info";
  readonly autoAcknowledge: boolean;
  readonly patientId: string | null;
  readonly payload: ExternalSignalWindowPayload & {
    readonly eventTimestamp: string;
    readonly facilityCode?: string;
    readonly patientClass?: string;
  };
}

/** The audit `outcome` recorded on the `m6.applier.processed` row for an applied action (§4.8 helpers). */
export type ApplierProcessedOutcome =
  | "external_discharge_notice_created"
  | "external_death_discharge_recorded"
  | "inactive_patient_admission_signal"
  | "concurrent_hospital_admission_window_opened"
  | "cancel_admit_no_matching_referral"
  | "referral_withdrawn"
  | `precondition_failed_${string}`;

/** The effect the applier resolved for an accepted proposal. The live consumer executes exactly one. */
export type ApplierAction =
  /** A redelivery of an already-processed proposal — skip, audit `m6.applier.idempotent_skip` (W-M6-35). */
  | { readonly kind: "idempotent_skip" }
  /** Not M6-owned, or an M6-owned-but-unsupported resource kind — no effect, no refusal. */
  | { readonly kind: "ignore"; readonly reason: "not_m6_owned" | "unsupported_resource_kind" }
  /** A contract violation (D13) — audit `m6.applier.contract_violation_refused` + emit `m6.applier.refused`. */
  | { readonly kind: "refuse"; readonly reason: string }
  /** Open an informational compliance window for human triage; record `outcome` on the processed row. */
  | {
      readonly kind: "open_window";
      readonly window: ExternalSignalWindowDescriptor;
      readonly outcome: ApplierProcessedOutcome;
    }
  /** The narrow D14 happy path — record the external-death discharge via `DischargeService.recordExternalDeath`. */
  | {
      readonly kind: "record_external_death";
      readonly admissionId: AdmissionId;
      readonly dischargeDate: LocalDate;
      readonly sendingFacility: string;
      readonly outcome: "external_death_discharge_recorded";
    }
  /** A cancel-admit matched a pending referral — withdraw it via `ReferralService.markWithdrawnFromHl7`. */
  | {
      readonly kind: "withdraw_referral";
      readonly referralId: string;
      readonly withdrawnVia: "hl7_cancel_admit";
      readonly sendingFacility: string;
      readonly outcome: "referral_withdrawn";
    };

// ── Window builders ───────────────────────────────────────────────────────────────────────────────────

function externalSignalPayload(
  payload: ProposalAcceptedPayload,
  resourceKind: ExternalSignalWindowPayload["resourceKind"],
  reasonCode: string,
  summary: string,
  ctx: ProposedEventContext,
  extra?: { readonly facilityCode?: string; readonly patientClass?: string },
): ExternalSignalWindowDescriptor["payload"] {
  return {
    source: "m29_proposal_accept",
    proposalId: payload.proposalId,
    sourceMessageId: payload.sourceMessageId,
    resourceKind,
    reasonCode,
    summary,
    eventTimestamp: ctx.eventTimestamp,
    ...extra,
  };
}

function openWindow(
  window: ExternalSignalWindowDescriptor,
  outcome: ApplierProcessedOutcome,
): ApplierAction {
  return { kind: "open_window", window, outcome };
}

// ── The pure decision core (§4.8) ─────────────────────────────────────────────────────────────────────

/**
 * Decide the single effect to apply for an accepted M29 proposal (§4.8, pure). The handler resolves
 * {@link ApplierFacts} from M6's read seams + audit log, then this returns the {@link ApplierAction}
 * descriptor. Mirrors the §4.8 `handle` → `applyDischargeEvent` / `applyAdmissionEvent` /
 * `applyCancelAdmission` arms exactly, including the five D14 preconditions and the idempotency gate.
 */
export function decideAdmissionEvent(
  payload: ProposalAcceptedPayload,
  facts: ApplierFacts,
): ApplierAction {
  if (payload.ownerModule !== "m6") return { kind: "ignore", reason: "not_m6_owned" };
  if (facts.alreadyProcessed) return { kind: "idempotent_skip" };

  switch (payload.resourceKind) {
    case "discharge_event":
      return decideDischargeEvent(payload, facts);
    case "admission_event":
      return decideAdmissionSignal(payload, facts);
    case "cancel_admission":
      return decideCancelAdmission(payload, facts);
    default:
      // patient_demographic_update / new_patient are M5-owned — M6 never reaches these for ownerModule='m6'.
      return { kind: "ignore", reason: "unsupported_resource_kind" };
  }
}

function decideDischargeEvent(
  payload: ProposalAcceptedPayload,
  facts: ApplierFacts,
): ApplierAction {
  const ctx = payload.proposedEventContext;
  if (!ctx) return { kind: "refuse", reason: "missing_event_context" };
  if (!payload.matchedPatientId) return { kind: "refuse", reason: "no_matched_patient" };

  // Non-death external discharge → informational window only (never moves the admission state machine).
  if (ctx.mappedDischargeReason !== "death") {
    return openWindow(
      {
        type: "external_discharge_notice",
        severity: "info",
        autoAcknowledge: false,
        patientId: payload.matchedPatientId,
        payload: externalSignalPayload(
          payload,
          "discharge_event",
          "non_death_discharge_external",
          `External discharge notice from ${ctx.sendingFacility}; reason=${ctx.mappedDischargeReason ?? "unknown"}; for human review.`,
          ctx,
        ),
      },
      "external_discharge_notice_created",
    );
  }

  // Death path — the five D14 preconditions (§2.4.1 R-EXT-01). Any failure → informational window.
  const summary = facts.admissionSummary;
  if (!summary || summary.status !== "active") {
    return failedPrecondition(payload, ctx, "precondition_no_active_admission");
  }
  if (summary.dischargedAt) {
    return failedPrecondition(payload, ctx, "precondition_already_discharged");
  }
  if (!facts.activePeriodOnDeathDate) {
    return failedPrecondition(payload, ctx, "precondition_no_active_election_period");
  }
  const deathDate = ctx.eventTimestamp.slice(0, 10) as LocalDate;
  const period = facts.activePeriodOnDeathDate;
  if (deathDate < period.startDate || deathDate > period.endDate) {
    return failedPrecondition(payload, ctx, "precondition_death_date_outside_election_period");
  }

  // All preconditions met — record the discharge through the standard discharge cascade.
  return {
    kind: "record_external_death",
    admissionId: summary.admissionId,
    dischargeDate: deathDate,
    sendingFacility: ctx.sendingFacility,
    outcome: "external_death_discharge_recorded",
  };
}

function decideAdmissionSignal(
  payload: ProposalAcceptedPayload,
  facts: ApplierFacts,
): ApplierAction {
  const ctx = payload.proposedEventContext;
  if (!ctx || !payload.matchedPatientId)
    return { kind: "refuse", reason: "missing_context_or_patient" };

  const summary = facts.admissionSummary;
  if (!summary || summary.status !== "active") {
    // Admission signal for a patient not on active hospice — very low value; auto-acknowledge.
    return openWindow(
      {
        type: "external_discharge_notice", // overload — inactive-patient admission notice routes here (§4.8)
        severity: "info",
        autoAcknowledge: true,
        patientId: payload.matchedPatientId,
        payload: externalSignalPayload(
          payload,
          "admission_event",
          "admission_signal_for_inactive_patient",
          `External admission signal from ${ctx.sendingFacility} for patient not on active hospice; informational.`,
          ctx,
        ),
      },
      "inactive_patient_admission_signal",
    );
  }

  // Concurrent admission while on active hospice — high operational interest; triage required.
  return openWindow(
    {
      type: "concurrent_hospital_admission",
      severity: "info",
      autoAcknowledge: false,
      patientId: payload.matchedPatientId,
      payload: externalSignalPayload(
        payload,
        "admission_event",
        "concurrent_hospital_admission_during_active_hospice",
        `Active hospice patient appears to have been admitted to ${ctx.sendingFacility} on ${ctx.eventTimestamp}. Triage required: GIP transition, revocation, or note.`,
        ctx,
        { facilityCode: ctx.facilityCode, patientClass: ctx.patientClass },
      ),
    },
    "concurrent_hospital_admission_window_opened",
  );
}

function decideCancelAdmission(
  payload: ProposalAcceptedPayload,
  facts: ApplierFacts,
): ApplierAction {
  const ctx = payload.proposedEventContext;
  if (!ctx) return { kind: "refuse", reason: "missing_event_context" };

  // No matching pending referral (race lost to a human accept, or never tracked) → informational only.
  if (!facts.pendingReferralId) {
    return openWindow(
      {
        type: "hl7_admission_cancellation",
        severity: "info",
        autoAcknowledge: true,
        patientId: payload.matchedPatientId ?? null,
        payload: externalSignalPayload(
          payload,
          "cancel_admission",
          "cancel_admit_no_matching_referral",
          `Cancel-admit received from ${ctx.sendingFacility} referencing ${ctx.messageControlId} but no matching pending referral.`,
          ctx,
        ),
      },
      "cancel_admit_no_matching_referral",
    );
  }

  // Matching pending referral — withdraw it (the service's WHERE status='pending' guard backstops races).
  return {
    kind: "withdraw_referral",
    referralId: facts.pendingReferralId,
    withdrawnVia: "hl7_cancel_admit",
    sendingFacility: ctx.sendingFacility,
    outcome: "referral_withdrawn",
  };
}

function failedPrecondition(
  payload: ProposalAcceptedPayload,
  ctx: ProposedEventContext,
  reasonCode: string,
): ApplierAction {
  return openWindow(
    {
      type: "external_discharge_notice",
      severity: "info",
      autoAcknowledge: false,
      patientId: payload.matchedPatientId ?? null,
      payload: externalSignalPayload(
        payload,
        "discharge_event",
        reasonCode,
        `External death notice received but D14 precondition failed: ${reasonCode}. Human review required.`,
        ctx,
      ),
    },
    `precondition_failed_${reasonCode}`,
  );
}
