import type { schema } from "@wardenx/db";
import {
  type BereavementPlanClosedEvent,
  type CahpsCandidateAddRequest,
  type ClaimAdjudicatedEvent,
  type DischargeDeathEvent,
  type ElectionSignedEvent,
  type EvvVisitVerifiedEvent,
  type HopeSubmissionAcceptedEvent,
  type IncidentTriggerEvent,
  type M30ConsumerPorts,
  M30_OUTBOX_SUBSCRIPTIONS,
  M30_OUTBOX_SUBSCRIPTION_TOPICS,
  M30_UPSTREAM_CONSUMER_NAME,
  M30_UPSTREAM_SUBSCRIPTIONS,
  M30_UPSTREAM_SUBSCRIPTIONS_DEFERRED,
  type MortalityReviewAutoCreateResult,
  type RecomputeEnqueueRequest,
  effectKindsForTopic,
  effectsForTopic,
  handleBereavementPlanClosed,
  handleClaimAdjudicated,
  handleDischargeDeath,
  handleDischargeDeathMortality,
  handleElectionSigned,
  handleEvvVisitVerified,
  handleHopeSubmissionAccepted,
  handleMedicationErrorReported,
  handleRestraintApplied,
  measureCodesForFamilies,
} from "@wardenx/quality";
// @wardenx/quality — M30 §4.10 upstream-consumer unit tests (PURE; in-memory ports; no DB).
//
// The inbound half of M30: the topic→effect subscription map (the §4.10 single source of truth) and the
// per-topic handlers that project a structurally-minimal upstream event into its M30 effect and fan it out
// through INJECTED ports. These tests inject in-memory ports (never a DB / queue), assert each upstream
// topic projects to the correct effect(s), and pin the handlers' field mapping + the ±-day HVLDL guard.
import { describe, expect, it } from "vitest";

// ── in-memory effect ports (capture every fan-out, never touch I/O) ──────────────────────────────────────

interface Captured {
  readonly recomputes: RecomputeEnqueueRequest[];
  readonly mortalityDrafts: MortalityReviewAutoCreateResult[];
  readonly cahpsCandidates: CahpsCandidateAddRequest[];
  readonly incidentDrafts: schema.NewIncidentReport[];
  readonly ports: M30ConsumerPorts;
}

function capturePorts(): Captured {
  const recomputes: RecomputeEnqueueRequest[] = [];
  const mortalityDrafts: MortalityReviewAutoCreateResult[] = [];
  const cahpsCandidates: CahpsCandidateAddRequest[] = [];
  const incidentDrafts: schema.NewIncidentReport[] = [];
  const ports: M30ConsumerPorts = {
    enqueueRecompute: async (request) => {
      recomputes.push(request);
    },
    createMortalityReviewDraft: async (result) => {
      mortalityDrafts.push(result);
    },
    addCahpsSampleCandidate: async (request) => {
      cahpsCandidates.push(request);
    },
    createIncidentDraft: async (row) => {
      incidentDrafts.push(row);
    },
  };
  return { recomputes, mortalityDrafts, cahpsCandidates, incidentDrafts, ports };
}

// ── the §4.10 subscription map (the topic→effect catalog) ────────────────────────────────────────────────

describe("M30 §4.10 outbox-subscription map", () => {
  it("is a frozen catalog of exactly the subscribed upstream topics", () => {
    expect(Object.isFrozen(M30_OUTBOX_SUBSCRIPTIONS)).toBe(true);
    expect([...M30_OUTBOX_SUBSCRIPTION_TOPICS].sort()).toEqual(
      [
        "m6.discharge.death",
        "m6.election.signed",
        "m10.hope.submission_accepted",
        "m12.medication.error_reported",
        "m16.bereavement.plan_closed_completed",
        "m16.bereavement.plan_closed_declined",
        "m16.bereavement.plan_closed_early",
        "m18.evv.visit_verified",
        "m23.claim.adjudicated",
        "m37.restraint.applied",
      ].sort(),
    );
  });

  it("projects each topic to the correct ordered effect kinds", () => {
    expect(effectKindsForTopic("m6.discharge.death")).toEqual([
      "mortality_review_draft",
      "cahps_candidate_add",
    ]);
    expect(effectKindsForTopic("m6.election.signed")).toEqual(["recompute"]);
    expect(effectKindsForTopic("m10.hope.submission_accepted")).toEqual(["recompute"]);
    expect(effectKindsForTopic("m12.medication.error_reported")).toEqual(["incident_draft"]);
    expect(effectKindsForTopic("m16.bereavement.plan_closed_completed")).toEqual(["recompute"]);
    expect(effectKindsForTopic("m16.bereavement.plan_closed_declined")).toEqual(["recompute"]);
    expect(effectKindsForTopic("m16.bereavement.plan_closed_early")).toEqual(["recompute"]);
    expect(effectKindsForTopic("m18.evv.visit_verified")).toEqual(["hvldl_near_death_recompute"]);
    expect(effectKindsForTopic("m23.claim.adjudicated")).toEqual(["recompute"]);
    expect(effectKindsForTopic("m37.restraint.applied")).toEqual(["incident_draft"]);
  });

  it("carries the right discriminator data on the typed effects", () => {
    const death = effectsForTopic("m6.discharge.death");
    expect(death[0]?.kind).toBe("mortality_review_draft");
    expect(death[1]?.kind).toBe("cahps_candidate_add");

    const medError = effectsForTopic("m12.medication.error_reported");
    const draft = medError[0];
    expect(draft?.kind).toBe("incident_draft");
    if (draft?.kind === "incident_draft") {
      expect(draft.incidentKind).toBe("medication_error");
    }

    const restraint = effectsForTopic("m37.restraint.applied")[0];
    expect(restraint?.kind).toBe("incident_draft");
    if (restraint?.kind === "incident_draft") {
      expect(restraint.incidentKind).toBe("restraint_use");
    }

    const evv = effectsForTopic("m18.evv.visit_verified")[0];
    if (evv?.kind === "hvldl_near_death_recompute") {
      expect(evv.windowDays).toBe(3);
    }
  });

  it("returns an EMPTY effect list for an unknown topic (tolerant no-op, never an error)", () => {
    expect(effectsForTopic("m99.unknown.event")).toEqual([]);
    expect(effectKindsForTopic("m99.unknown.event")).toEqual([]);
  });

  it("forward-declares one deferred consumer binding per subscribed topic", () => {
    expect(M30_UPSTREAM_SUBSCRIPTIONS_DEFERRED).toBe(true);
    expect(M30_UPSTREAM_SUBSCRIPTIONS).toHaveLength(M30_OUTBOX_SUBSCRIPTION_TOPICS.length);
    for (const binding of M30_UPSTREAM_SUBSCRIPTIONS) {
      expect(binding.consumerName).toBe(M30_UPSTREAM_CONSUMER_NAME);
      expect(M30_OUTBOX_SUBSCRIPTION_TOPICS).toContain(binding.eventName);
    }
  });
});

// ── measureCodesForFamilies (the pure family→codes resolver) ─────────────────────────────────────────────

describe("measureCodesForFamilies", () => {
  it("resolves the HCI family to its eleven indicator + composite codes, in catalog order, deduped", () => {
    const codes = measureCodesForFamilies(["hci"]);
    expect(codes).toEqual([
      "hci_indicator_01",
      "hci_indicator_02",
      "hci_indicator_03",
      "hci_indicator_04",
      "hci_indicator_05",
      "hci_indicator_06",
      "hci_indicator_07",
      "hci_indicator_08",
      "hci_indicator_09",
      "hci_indicator_10",
      "hci_composite",
    ]);
    // passing the family twice does not duplicate the codes.
    expect(measureCodesForFamilies(["hci", "hci"])).toEqual(codes);
  });

  it("resolves hope_derived to the two TFP measures and hvldl to its single code", () => {
    expect(measureCodesForFamilies(["hope_derived"])).toEqual(["tfp_pi", "tfp_npsi"]);
    expect(measureCodesForFamilies(["hvldl"])).toEqual(["hvldl"]);
  });

  it("the vendor-survey CAHPS family has no recompute-driven measures (empty)", () => {
    expect(measureCodesForFamilies(["cahps"])).toEqual([]);
  });
});

// ── handlers — each topic fans out the correct effect through the ports ───────────────────────────────────

describe("M30 §4.10 upstream handlers", () => {
  it("m6.discharge.death → drafts a mortality review AND seeds the CAHPS candidate (in order)", async () => {
    const cap = capturePorts();
    const event: DischargeDeathEvent = {
      organizationId: "org-1",
      providerEntityId: "pe-1",
      deceasedPatientId: "patient-9",
      admissionId: "adm-9",
      deathAt: new Date("2025-02-10T12:00:00Z"),
      eventIdempotencyKey: "evt-death-1",
    };
    const report = await handleDischargeDeath(event, cap.ports);
    expect(report.effects).toEqual(["mortality_review_draft", "cahps_candidate_add"]);
    expect(cap.mortalityDrafts).toHaveLength(1);
    // the mortality draft rides the death event's idempotency key (§2.6).
    expect(cap.mortalityDrafts[0]?.row.createdViaEventIdempotencyKey).toBe("evt-death-1");
    // the CAHPS candidate mirrors the death keys; admissionId maps onto deceasedAdmissionId.
    expect(cap.cahpsCandidates).toHaveLength(1);
    expect(cap.cahpsCandidates[0]).toMatchObject({
      deceasedPatientId: "patient-9",
      deceasedAdmissionId: "adm-9",
      triggeringEventId: "evt-death-1",
      deathSource: "admission_discharge", // default/internal source
    });
  });

  it("m6.discharge.death maps an hl7_external source to the §4.13 'external_import' marker", async () => {
    const cap = capturePorts();
    await handleDischargeDeath(
      {
        organizationId: "org-1",
        providerEntityId: "pe-1",
        deceasedPatientId: "patient-ext",
        admissionId: "adm-ext",
        deathAt: new Date("2025-02-11T00:00:00Z"),
        eventIdempotencyKey: "evt-death-ext",
        source: "hl7_external",
      },
      cap.ports,
    );
    expect(cap.cahpsCandidates[0]?.deathSource).toBe("external_import");
  });

  it("m6.discharge.death (mortality half) drafts the review WITHOUT touching the CAHPS port (GAP-089)", async () => {
    const cap = capturePorts();
    const report = await handleDischargeDeathMortality(
      {
        organizationId: "org-1",
        providerEntityId: "pe-1",
        deceasedPatientId: "patient-9",
        admissionId: "adm-9",
        deathAt: new Date("2025-02-10T12:00:00Z"),
        eventIdempotencyKey: "evt-death-1",
      },
      { createMortalityReviewDraft: cap.ports.createMortalityReviewDraft },
    );
    expect(report.effects).toEqual(["mortality_review_draft"]);
    expect(cap.mortalityDrafts).toHaveLength(1);
    expect(cap.cahpsCandidates).toHaveLength(0);
    expect(cap.mortalityDrafts[0]?.row.status).toBe("pending");
  });

  it("m6.election.signed → enqueues an HCI recompute with the resolved codes", async () => {
    const cap = capturePorts();
    const event: ElectionSignedEvent = {
      eventId: "evt-elect-1",
      organizationId: "org-1",
      providerEntityId: "pe-1",
      patientId: "patient-1",
    };
    const report = await handleElectionSigned(event, cap.ports);
    expect(report.effects).toEqual(["recompute"]);
    expect(cap.recomputes).toHaveLength(1);
    expect(cap.recomputes[0]).toMatchObject({
      organizationId: "org-1",
      providerEntityId: "pe-1",
      families: ["hci"],
      triggeringEventId: "evt-elect-1",
    });
    expect(cap.recomputes[0]?.measureCodes).toEqual(measureCodesForFamilies(["hci"]));
  });

  it.each([
    "m16.bereavement.plan_closed_completed",
    "m16.bereavement.plan_closed_declined",
    "m16.bereavement.plan_closed_early",
  ] as const)(
    "%s → enqueues ONLY bereavement_coverage_rate, not the whole operational family",
    async (sourceEventName) => {
      const cap = capturePorts();
      const event: BereavementPlanClosedEvent = {
        eventId: "evt-plan-closed-1",
        organizationId: "org-1",
        providerEntityId: "pe-1",
        planId: "plan-1",
        sourceEventName,
      };
      const report = await handleBereavementPlanClosed(event, cap.ports);
      expect(report.eventName).toBe(sourceEventName);
      expect(report.effects).toEqual(["recompute"]);
      expect(cap.recomputes).toHaveLength(1);
      expect(cap.recomputes[0]).toMatchObject({
        organizationId: "org-1",
        providerEntityId: "pe-1",
        triggeringEventId: "evt-plan-closed-1",
      });
      // Explicit measure code, NOT measureCodesForFamilies(["operational"]) — the whole point (see the
      // handler's own doc comment): a plan closure has no data dependency on missed-dose rate, IDG
      // cadence, etc.
      expect(cap.recomputes[0]?.measureCodes).toEqual(["bereavement_coverage_rate"]);
      expect(cap.recomputes[0]?.measureCodes.length).toBeLessThan(
        measureCodesForFamilies(["operational"]).length,
      );
    },
  );

  it("m10.hope.submission_accepted → enqueues a HOPE-derived (TFP) recompute", async () => {
    const cap = capturePorts();
    const event: HopeSubmissionAcceptedEvent = {
      eventId: "evt-hope-1",
      organizationId: "org-1",
      providerEntityId: "pe-1",
      submissionId: "sub-1",
    };
    const report = await handleHopeSubmissionAccepted(event, cap.ports);
    expect(report.effects).toEqual(["recompute"]);
    expect(cap.recomputes[0]?.families).toEqual(["hope_derived"]);
    expect(cap.recomputes[0]?.measureCodes).toEqual(["tfp_pi", "tfp_npsi"]);
  });

  it("m23.claim.adjudicated → enqueues an HCI claims-derived recompute", async () => {
    const cap = capturePorts();
    const event: ClaimAdjudicatedEvent = {
      eventId: "evt-claim-1",
      organizationId: "org-1",
      providerEntityId: "pe-1",
      claimId: "claim-1",
    };
    const report = await handleClaimAdjudicated(event, cap.ports);
    expect(report.effects).toEqual(["recompute"]);
    expect(cap.recomputes[0]?.families).toEqual(["hci"]);
  });

  it("m12.medication.error_reported → auto-files a draft medication_error incident (D8)", async () => {
    const cap = capturePorts();
    const event: Extract<IncidentTriggerEvent, { type: "m12.medication.error_reported" }> = {
      type: "m12.medication.error_reported",
      organizationId: "org-1",
      providerEntityId: "pe-1",
      occurredAt: new Date("2025-02-12T09:00:00Z"),
      triggeringEventOutboxId: "evt-med-err-1",
      reportedByMembershipId: "svc-membership",
      medicationOrderId: "mo-1",
      medicationErrorId: "med-err-1",
      patientId: "patient-7",
    };
    const report = await handleMedicationErrorReported(event, cap.ports);
    expect(report.effects).toEqual(["incident_draft"]);
    expect(cap.incidentDrafts).toHaveLength(1);
    expect(cap.incidentDrafts[0]).toMatchObject({
      kind: "medication_error",
      lifecycle: "draft",
      mandatoryReportFlag: false,
      triggeringEventOutboxId: "evt-med-err-1",
    });
    expect(cap.incidentDrafts[0]?.kindData).toMatchObject({
      medicationOrderId: "mo-1",
      medicationErrorId: "med-err-1",
    });
  });

  it("m37.restraint.applied → auto-files a draft restraint_use incident (D8, F-185)", async () => {
    const cap = capturePorts();
    const event: Extract<IncidentTriggerEvent, { type: "m37.restraint.applied" }> = {
      type: "m37.restraint.applied",
      organizationId: "org-1",
      providerEntityId: "pe-1",
      occurredAt: new Date("2025-02-14T09:00:00Z"),
      triggeringEventOutboxId: "evt-restraint-1",
      reportedByMembershipId: "svc-membership",
      restraintEventId: "restraint-1",
      restraintKind: "four_point",
      patientId: "patient-11",
    };
    const report = await handleRestraintApplied(event, cap.ports);
    expect(report.effects).toEqual(["incident_draft"]);
    expect(cap.incidentDrafts).toHaveLength(1);
    expect(cap.incidentDrafts[0]).toMatchObject({
      kind: "restraint_use",
      severity: "moderate",
      lifecycle: "draft",
      mandatoryReportFlag: false,
      triggeringEventOutboxId: "evt-restraint-1",
      patientId: "patient-11",
      kindData: {
        restraintEventId: "restraint-1",
        restraintKind: "four_point",
        narrativeText: "Restraint applied; see IPU restraint record for clinical detail.",
      },
    });
  });

  it("m37.restraint.applied → uses the upstream summary as narrativeText when supplied", async () => {
    const cap = capturePorts();
    const event: Extract<IncidentTriggerEvent, { type: "m37.restraint.applied" }> = {
      type: "m37.restraint.applied",
      organizationId: "org-1",
      providerEntityId: "pe-1",
      occurredAt: new Date("2025-02-14T09:05:00Z"),
      triggeringEventOutboxId: "evt-restraint-2",
      reportedByMembershipId: "svc-membership",
      restraintEventId: "restraint-2",
      restraintKind: "chemical",
      summary: "Emergency chemical restraint per physician order.",
    };
    await handleRestraintApplied(event, cap.ports);
    expect(cap.incidentDrafts[0]?.kindData).toMatchObject({
      narrativeText: "Emergency chemical restraint per physician order.",
      summary: "Emergency chemical restraint per physician order.",
    });
  });

  it("m18.evv.visit_verified → enqueues HVLDL when the visit is WITHIN ±3 days of a death", async () => {
    const cap = capturePorts();
    const within: EvvVisitVerifiedEvent = {
      eventId: "evt-evv-1",
      organizationId: "org-1",
      providerEntityId: "pe-1",
      patientId: "patient-1",
      visitId: "visit-1",
      verifiedAt: new Date("2025-02-13T00:00:00Z"),
      nearestDeathWithinDays: 3, // exactly on the inclusive ±-day boundary
    };
    const report = await handleEvvVisitVerified(within, cap.ports);
    expect(report.effects).toEqual(["hvldl_near_death_recompute"]);
    expect(cap.recomputes[0]?.families).toEqual(["hvldl"]);
  });

  it("m18.evv.visit_verified → SKIPS (no-op) when the nearest death is OUTSIDE the ±3-day window", async () => {
    const cap = capturePorts();
    const outside: EvvVisitVerifiedEvent = {
      eventId: "evt-evv-2",
      organizationId: "org-1",
      providerEntityId: "pe-1",
      patientId: "patient-1",
      visitId: "visit-2",
      verifiedAt: new Date("2025-02-13T00:00:00Z"),
      nearestDeathWithinDays: 4, // strictly beyond the window
    };
    const report = await handleEvvVisitVerified(outside, cap.ports);
    expect(report.effects).toEqual([]);
    expect(cap.recomputes).toHaveLength(0);
  });

  it("m18.evv.visit_verified → ENQUEUES when proximity is unresolved (null) — never silently drops", async () => {
    const cap = capturePorts();
    const unresolved: EvvVisitVerifiedEvent = {
      eventId: "evt-evv-3",
      organizationId: "org-1",
      providerEntityId: "pe-1",
      patientId: "patient-1",
      visitId: "visit-3",
      verifiedAt: new Date("2025-02-13T00:00:00Z"),
      nearestDeathWithinDays: null,
    };
    const report = await handleEvvVisitVerified(unresolved, cap.ports);
    expect(report.effects).toEqual(["hvldl_near_death_recompute"]);
    expect(cap.recomputes).toHaveLength(1);
  });
});
