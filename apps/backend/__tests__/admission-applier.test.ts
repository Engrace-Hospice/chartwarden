// apps/backend/__tests__/admission-applier.test.ts — M6-T11 the `AdmissionEventApplier` decision core
// (§4.8) + the deferred M29 consumer binding (§4.8.3). Exercises the pure {@link decideAdmissionEvent}
// over the §7.7 external-HL7 workflows (W-M6-31..35), the five D14 preconditions (§2.4.1 R-EXT-01), the
// D13 contract-violation refusals, and the not-m6-owned ignore — no DB, the state machines stay the
// only path to active-state mutations. The applier composes M6's own services so there is no M29 schema
// import; the binding is forward-declared/deferred until M29 lands in Wave H.
import { describe, expect, it } from "vitest";
import {
  type ApplierFacts,
  M6_PROPOSAL_ACCEPTED_CONSUMER,
  M6_PROPOSAL_ACCEPTED_CONSUMER_DEFERRED,
  type ProposalAcceptedPayload,
  decideAdmissionEvent,
  decideProposalAccepted,
} from "../src/modules/06-admission";

// ── fixtures ──────────────────────────────────────────────────────────────────────────────────────────

const ORG = "11111111-1111-4111-8111-111111111111";
const PT = "22222222-2222-4222-8222-222222222222";
const ADM = "33333333-3333-4333-8333-333333333333";
const PERIOD = "44444444-4444-4444-8444-444444444444";

function payload(over: Partial<ProposalAcceptedPayload> = {}): ProposalAcceptedPayload {
  return {
    proposalId: "prop-1",
    organizationId: ORG,
    sourceMessageId: "msg-1",
    resourceKind: "discharge_event",
    ownerModule: "m6",
    matchedPatientId: PT,
    decidedByMembershipId: "mem-1",
    decidedAt: "2026-03-15T13:00:00.000Z",
    decisionRationale: "confirmed with family",
    ...over,
  };
}

function deathCtx(over: Record<string, unknown> = {}) {
  return {
    eventType: "A03",
    eventTimestamp: "2026-03-15T12:00:00.000Z",
    dischargeDisposition: "20",
    mappedDischargeReason: "death" as const,
    messageControlId: "MSG-1",
    sendingFacility: "ST_MARYS_HOSPITAL",
    ...over,
  };
}

function facts(over: Partial<ApplierFacts> = {}): ApplierFacts {
  return {
    alreadyProcessed: false,
    admissionSummary: null,
    activePeriodOnDeathDate: null,
    pendingReferralId: null,
    ...over,
  };
}

const ACTIVE_ADMISSION = {
  admissionId: ADM,
  patientId: PT,
  organizationId: ORG,
  providerEntityId: "55555555-5555-4555-8555-555555555555",
  status: "active" as const,
  admissionAt: "2026-01-30" as const,
  activatedAt: "2026-01-30" as const,
  dischargedAt: null,
  currentElectionPeriodId: PERIOD,
  currentLevelOfCare: "routine_home_care" as const,
};

const PERIOD_COVERING_DEATH = {
  periodId: PERIOD,
  sequence: 2,
  levelOfCare: "routine_home_care" as const,
  startDate: "2026-01-30" as const,
  endDate: "2026-04-29" as const,
};

// ── W-M6-31 — external death notification (happy path) ────────────────────────────────────────────────

describe("decideAdmissionEvent — W-M6-31 external death (happy path)", () => {
  it("records the external-death discharge when all five D14 preconditions hold", () => {
    const action = decideAdmissionEvent(
      payload({ proposedEventContext: deathCtx() }),
      facts({ admissionSummary: ACTIVE_ADMISSION, activePeriodOnDeathDate: PERIOD_COVERING_DEATH }),
    );
    expect(action).toEqual({
      kind: "record_external_death",
      admissionId: ADM,
      dischargeDate: "2026-03-15",
      sendingFacility: "ST_MARYS_HOSPITAL",
      outcome: "external_death_discharge_recorded",
    });
  });
});

// ── D14 preconditions (§2.4.1 R-EXT-01) — each failure routes to an informational window ──────────────

describe("decideAdmissionEvent — D14 preconditions", () => {
  it("(a) no active admission → external_discharge_notice window", () => {
    const action = decideAdmissionEvent(
      payload({ proposedEventContext: deathCtx() }),
      facts({ admissionSummary: { ...ACTIVE_ADMISSION, status: "discharged" } }),
    );
    expect(action.kind).toBe("open_window");
    if (action.kind !== "open_window") return;
    expect(action.window.type).toBe("external_discharge_notice");
    expect(action.window.severity).toBe("info");
    expect(action.window.payload.reasonCode).toBe("precondition_no_active_admission");
    expect(action.outcome).toBe("precondition_failed_precondition_no_active_admission");
  });

  it("(a') no admission summary at all → external_discharge_notice window", () => {
    const action = decideAdmissionEvent(payload({ proposedEventContext: deathCtx() }), facts());
    expect(action.kind).toBe("open_window");
  });

  it("(b) already discharged → external_discharge_notice window", () => {
    const action = decideAdmissionEvent(
      payload({ proposedEventContext: deathCtx() }),
      facts({ admissionSummary: { ...ACTIVE_ADMISSION, dischargedAt: "2026-03-01" } }),
    );
    expect(action.kind === "open_window" && action.window.payload.reasonCode).toBe(
      "precondition_already_discharged",
    );
  });

  it("(c) non-death discharge reason → informational window, never a discharge", () => {
    const action = decideAdmissionEvent(
      payload({
        proposedEventContext: deathCtx({ mappedDischargeReason: "transferred_to_acute" }),
      }),
      facts({ admissionSummary: ACTIVE_ADMISSION, activePeriodOnDeathDate: PERIOD_COVERING_DEATH }),
    );
    expect(action.kind === "open_window" && action.window.payload.reasonCode).toBe(
      "non_death_discharge_external",
    );
  });

  it("(d) no active election period covering the death date → window", () => {
    const action = decideAdmissionEvent(
      payload({ proposedEventContext: deathCtx() }),
      facts({ admissionSummary: ACTIVE_ADMISSION, activePeriodOnDeathDate: null }),
    );
    expect(action.kind === "open_window" && action.window.payload.reasonCode).toBe(
      "precondition_no_active_election_period",
    );
  });

  it("(d') death date outside the active election period → window", () => {
    const action = decideAdmissionEvent(
      payload({ proposedEventContext: deathCtx({ eventTimestamp: "2026-05-10T12:00:00.000Z" }) }),
      facts({ admissionSummary: ACTIVE_ADMISSION, activePeriodOnDeathDate: PERIOD_COVERING_DEATH }),
    );
    expect(action.kind === "open_window" && action.window.payload.reasonCode).toBe(
      "precondition_death_date_outside_election_period",
    );
  });
});

// ── W-M6-32 — concurrent hospital admission (informational window) ────────────────────────────────────

describe("decideAdmissionEvent — W-M6-32 concurrent hospital admission", () => {
  it("opens a concurrent_hospital_admission window (info, no auto-ack) for an active patient", () => {
    const action = decideAdmissionEvent(
      payload({
        resourceKind: "admission_event",
        proposedEventContext: deathCtx({
          eventType: "A01",
          mappedDischargeReason: undefined,
          patientClass: "I",
          facilityCode: "B3",
        }),
      }),
      facts({ admissionSummary: ACTIVE_ADMISSION }),
    );
    expect(action.kind).toBe("open_window");
    if (action.kind !== "open_window") return;
    expect(action.window.type).toBe("concurrent_hospital_admission");
    expect(action.window.autoAcknowledge).toBe(false);
    expect(action.window.payload.facilityCode).toBe("B3");
    expect(action.window.payload.patientClass).toBe("I");
    expect(action.outcome).toBe("concurrent_hospital_admission_window_opened");
  });

  it("auto-acknowledges an admission signal for a patient not on active hospice", () => {
    const action = decideAdmissionEvent(
      payload({
        resourceKind: "admission_event",
        proposedEventContext: deathCtx({ eventType: "A01" }),
      }),
      facts({ admissionSummary: null }),
    );
    expect(action.kind).toBe("open_window");
    if (action.kind !== "open_window") return;
    expect(action.window.autoAcknowledge).toBe(true);
    expect(action.outcome).toBe("inactive_patient_admission_signal");
  });
});

// ── W-M6-33 — cancel-admit matches pending referral ──────────────────────────────────────────────────

describe("decideAdmissionEvent — W-M6-33 cancel-admit", () => {
  it("withdraws a matched pending referral", () => {
    const action = decideAdmissionEvent(
      payload({
        resourceKind: "cancel_admission",
        proposedEventContext: deathCtx({ eventType: "A11", messageControlId: "MSG-12345" }),
      }),
      facts({ pendingReferralId: "ref_w33" }),
    );
    expect(action).toEqual({
      kind: "withdraw_referral",
      referralId: "ref_w33",
      withdrawnVia: "hl7_cancel_admit",
      sendingFacility: "ST_MARYS_HOSPITAL",
      outcome: "referral_withdrawn",
    });
  });

  it("opens an informational hl7_admission_cancellation window when no referral matches (race lost)", () => {
    const action = decideAdmissionEvent(
      payload({
        resourceKind: "cancel_admission",
        proposedEventContext: deathCtx({ eventType: "A11" }),
      }),
      facts({ pendingReferralId: null }),
    );
    expect(action.kind).toBe("open_window");
    if (action.kind !== "open_window") return;
    expect(action.window.type).toBe("hl7_admission_cancellation");
    expect(action.window.autoAcknowledge).toBe(true);
    expect(action.outcome).toBe("cancel_admit_no_matching_referral");
  });
});

// ── W-M6-35 — idempotency on event replay ─────────────────────────────────────────────────────────────

describe("decideAdmissionEvent — W-M6-35 idempotency", () => {
  it("skips a redelivery whose proposalId was already processed", () => {
    const action = decideAdmissionEvent(
      payload({ proposedEventContext: deathCtx() }),
      facts({
        alreadyProcessed: true,
        admissionSummary: ACTIVE_ADMISSION,
        activePeriodOnDeathDate: PERIOD_COVERING_DEATH,
      }),
    );
    expect(action).toEqual({ kind: "idempotent_skip" });
  });
});

// ── D13 narrow-rails — contract violations refuse; non-m6 proposals are ignored ──────────────────────

describe("decideAdmissionEvent — narrow rails (D13)", () => {
  it("ignores a proposal owned by another module", () => {
    const action = decideAdmissionEvent(
      payload({ ownerModule: "m5", proposedEventContext: deathCtx() }),
      facts(),
    );
    expect(action).toEqual({ kind: "ignore", reason: "not_m6_owned" });
  });

  it("refuses a discharge proposal with no event context", () => {
    const action = decideAdmissionEvent(payload({ proposedEventContext: undefined }), facts());
    expect(action).toEqual({ kind: "refuse", reason: "missing_event_context" });
  });

  it("refuses a discharge proposal with no matched patient", () => {
    const action = decideAdmissionEvent(
      payload({ matchedPatientId: null, proposedEventContext: deathCtx() }),
      facts(),
    );
    expect(action).toEqual({ kind: "refuse", reason: "no_matched_patient" });
  });

  it("refuses an admission signal missing context or patient", () => {
    const action = decideAdmissionEvent(
      payload({
        resourceKind: "admission_event",
        matchedPatientId: null,
        proposedEventContext: deathCtx({ eventType: "A01" }),
      }),
      facts(),
    );
    expect(action).toEqual({ kind: "refuse", reason: "missing_context_or_patient" });
  });
});

// ── the deferred consumer binding (§4.8.3) ────────────────────────────────────────────────────────────

describe("M29 proposal-accepted consumer binding", () => {
  it("forward-declares the event/consumer names and stays deferred until M29 lands (Wave H)", () => {
    expect(M6_PROPOSAL_ACCEPTED_CONSUMER).toEqual({
      eventName: "m29.hl7_inbound_proposal.accepted",
      consumerName: "m6.admission-event-applier",
    });
    expect(M6_PROPOSAL_ACCEPTED_CONSUMER_DEFERRED).toBe(true);
  });

  it("decideProposalAccepted delegates to the pure decider", () => {
    const p = payload({ proposedEventContext: deathCtx() });
    const f = facts({
      admissionSummary: ACTIVE_ADMISSION,
      activePeriodOnDeathDate: PERIOD_COVERING_DEATH,
    });
    expect(decideProposalAccepted(p, f)).toEqual(decideAdmissionEvent(p, f));
  });
});
