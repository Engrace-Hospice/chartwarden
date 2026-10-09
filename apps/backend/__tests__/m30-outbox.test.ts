// apps/backend/__tests__/m30-outbox.test.ts — M1-T10 transactional-outbox conformance for the M30
// HQRP & Quality WRITE service. Once the Drizzle M30 write service is bound to the live
// `buildTxOutboxPublisher` (apps/backend/src/bootstrap/outbox-persister.ts), a non-conformant emit payload
// THROWS in the catalog dispatcher and rolls the mutation's tx back. This test locks the 13 §4.10 `m30.*`
// events the WRITE service emits against their REGISTERED `payloadSchema` in events-by-m30.ts, so a future
// edit to an emit site that drifts from the schema fails HERE (not at runtime as a rolled-back tenant
// write).
//
// The payload literals below are structured EXACTLY as routes/write-service-drizzle.ts builds them at each
// emit site (the m33-outbox / encounter-outbox precedent of asserting representative payloads against the
// locked schema). Negative cases prove the schema actually constrains (a missing org key / wrong-typed
// counter / wrong phase literal all fail).
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import { M30_OUTBOX_EVENTS } from "../src/modules/30-quality/index";

const ORG = "00000000-0000-4000-8000-0000000000ee";
const INCIDENT = "a0000000-0000-4000-8000-000000000001";
const RESULT = "a1000000-0000-4000-8000-000000000001";
const PROJECT = "b0000000-0000-4000-8000-000000000001";
const INDICATOR = "b1000000-0000-4000-8000-000000000001";
const PIP = "b2000000-0000-4000-8000-000000000001";
const CYCLE = "c0000000-0000-4000-8000-000000000001";
const ACTOR = "d0000000-0000-4000-8000-000000000001";
const NOMINEE = "d0000000-0000-4000-8000-000000000002";
const FINDING = "c1000000-0000-4000-8000-000000000001";
const REVIEW = "d0000000-0000-4000-8000-000000000001";
const CITATION = "e0000000-0000-4000-8000-000000000001";
const EVENT = "f0000000-0000-4000-8000-000000000001";
const CASE = "f1000000-0000-4000-8000-000000000001";
const USER = "90000000-0000-4000-8000-000000000001";
const PATIENT = "91000000-0000-4000-8000-000000000001";
const AT = "2026-06-27T12:00:00.000Z";

const schemaFor = (eventName: string) => {
  const entry = M30_OUTBOX_EVENTS.find((e) => e.eventName === eventName);
  if (!entry) throw new Error(`m30 event '${eventName}' is not registered in M30_OUTBOX_EVENTS`);
  return entry.payloadSchema;
};

/** Assert a representative emit payload Value.Checks TRUE against its registered §4.10 schema. */
const conforms = (eventName: string, payload: Record<string, unknown>): boolean =>
  Value.Check(schemaFor(eventName), payload);

describe("M30 write-service outbox payloads conform to the registered §4.10 catalog schemas", () => {
  it("m30.incident.state_changed — the emitIncidentStateChange payload Value.Checks true", () => {
    expect(
      conforms("m30.incident.state_changed", {
        orgId: ORG,
        incidentId: INCIDENT,
        fromState: "draft",
        toState: "submitted",
        actorUserId: USER,
        occurredAt: AT,
      }),
    ).toBe(true);
  });

  it("m30.incident.submitted — the submitIncident payload Value.Checks true", () => {
    expect(
      conforms("m30.incident.submitted", {
        orgId: ORG,
        incidentId: INCIDENT,
        kind: "fall",
        severity: "moderate",
        reportedAt: AT,
        hasPatientLink: true,
      }),
    ).toBe(true);
  });

  it("m30.cahps.results_ingested — the ingestCahpsResults payload Value.Checks true", () => {
    expect(
      conforms("m30.cahps.results_ingested", {
        orgId: ORG,
        period: { start: AT, end: AT },
        measuresAffected: ["communication", "timely_help"],
      }),
    ).toBe(true);
  });

  it("m30.qapi.project_chartered — the charterQapiProject payload Value.Checks true", () => {
    expect(
      conforms("m30.qapi.project_chartered", {
        orgId: ORG,
        projectId: PROJECT,
        indicatorId: INDICATOR,
        phase: "planned",
      }),
    ).toBe(true);
  });

  it("m30.qapi.pip_closed — the closeQapiPip payload Value.Checks true (linked + unlinked)", () => {
    // linked to a chartered project
    expect(
      conforms("m30.qapi.pip_closed", {
        orgId: ORG,
        projectId: PROJECT,
        pipId: PIP,
        outcome: "target_met",
        closedAt: AT,
        closedBy: { membershipId: ACTOR, role: "qapi_coordinator" },
        nominatedCosigner: { membershipId: NOMINEE, role: "medical_director" },
        cosignerAttested: true,
      }),
    ).toBe(true);
    // a PIP need not hang off a project — the nullable FK is emitted as `null`, not an empty id.
    expect(
      conforms("m30.qapi.pip_closed", {
        orgId: ORG,
        projectId: null,
        pipId: PIP,
        outcome: "target_met",
        closedAt: AT,
        closedBy: { membershipId: ACTOR, role: "qapi_coordinator" },
        nominatedCosigner: { membershipId: NOMINEE, role: "medical_director" },
        cosignerAttested: true,
      }),
    ).toBe(true);
  });

  it("m30.sra.cycle_opened — the openSraCycle payload Value.Checks true", () => {
    expect(
      conforms("m30.sra.cycle_opened", {
        orgId: ORG,
        cycleId: CYCLE,
        fiscalYear: 2026,
        scopeTemplateVersion: "v1",
      }),
    ).toBe(true);
  });

  it("m30.sra.finding_added — the addSraFinding payload Value.Checks true", () => {
    expect(
      conforms("m30.sra.finding_added", {
        orgId: ORG,
        cycleId: CYCLE,
        findingId: FINDING,
        controlRef: "AC-2",
        riskBand: "high",
      }),
    ).toBe(true);
  });

  it("m30.sra.cycle_closed — the closeSraCycle payload Value.Checks true", () => {
    expect(
      conforms("m30.sra.cycle_closed", {
        orgId: ORG,
        cycleId: CYCLE,
        closedAt: AT,
        openFindingsAtClose: 2,
        closedBy: { membershipId: ACTOR, role: "hipaa_security_officer" },
        nominatedCosigner: { membershipId: NOMINEE, role: "compliance_officer" },
        cosignerAttested: true,
      }),
    ).toBe(true);
    // the event is published only after the nominee attested: a payload claiming otherwise, or lacking the nominee, is refused
    const base = {
      orgId: ORG,
      cycleId: CYCLE,
      closedAt: AT,
      openFindingsAtClose: 2,
      closedBy: { membershipId: ACTOR, role: "hipaa_security_officer" },
      nominatedCosigner: { membershipId: NOMINEE, role: "compliance_officer" },
    };
    expect(
      Value.Check(schemaFor("m30.sra.cycle_closed"), { ...base, cosignerAttested: false }),
    ).toBe(false);
    expect(
      Value.Check(schemaFor("m30.sra.cycle_closed"), { ...base, nominatedCosigner: undefined }),
    ).toBe(false);
  });

  it("m30.mortality.review_completed — the completeMortalityReview payload Value.Checks true", () => {
    expect(
      conforms("m30.mortality.review_completed", {
        orgId: ORG,
        reviewId: REVIEW,
        dimensions: { clinical: "recorded", satisfaction: "recorded", compliance: "recorded" },
      }),
    ).toBe(true);
  });

  it("m30.cop.status_changed — the updateCopCitation payload Value.Checks true (null lastReviewedAt)", () => {
    expect(
      conforms("m30.cop.status_changed", {
        orgId: ORG,
        citationId: CITATION,
        fromStatus: "not_met",
        toStatus: "met",
        lastReviewedAt: null,
      }),
    ).toBe(true);
  });

  it("m30.infection.event_recorded — the recordInfectionEvent payload Value.Checks true", () => {
    expect(
      conforms("m30.infection.event_recorded", {
        orgId: ORG,
        eventId: EVENT,
        pathogen: "mrsa",
        bodySite: "wound",
        patientId: PATIENT,
      }),
    ).toBe(true);
  });

  it("m30.infection.outbreak_opened — the inline-cluster payload Value.Checks true", () => {
    expect(
      conforms("m30.infection.outbreak_opened", {
        orgId: ORG,
        caseId: CASE,
        pathogen: "mrsa",
        bodySite: "wound",
        eventCount: 3,
        firstEventAt: AT,
        lastEventAt: AT,
      }),
    ).toBe(true);
  });

  it("m30.infection.outbreak_resolved — the updateInfectionOutbreak payload Value.Checks true", () => {
    expect(
      conforms("m30.infection.outbreak_resolved", {
        orgId: ORG,
        caseId: CASE,
        resolutionNote: "", // `?? ""` — an empty note is permitted (Type.String())
        resolvedAt: AT,
      }),
    ).toBe(true);
  });

  it("the schema constrains — a missing org key, a wrong-typed counter, and a wrong phase literal all fail", () => {
    // missing orgId → the org-scoped outbox row could not be keyed → rejected.
    expect(
      Value.Check(schemaFor("m30.incident.submitted"), {
        incidentId: INCIDENT,
        kind: "fall",
        severity: "moderate",
        reportedAt: AT,
        hasPatientLink: true,
      }),
    ).toBe(false);
    // openFindingsAtClose must be a non-negative integer (not a string).
    expect(
      Value.Check(schemaFor("m30.sra.cycle_closed"), {
        orgId: ORG,
        cycleId: CYCLE,
        closedAt: AT,
        openFindingsAtClose: "2",
      }),
    ).toBe(false);
    // phase is a Literal('planned') — any other value fails.
    expect(
      Value.Check(schemaFor("m30.qapi.project_chartered"), {
        orgId: ORG,
        projectId: PROJECT,
        indicatorId: INDICATOR,
        phase: "active",
      }),
    ).toBe(false);
  });
});
