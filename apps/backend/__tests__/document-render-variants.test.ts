// apps/backend/__tests__/document-render-variants.test.ts — M22-T09 the §7 render-variant consumers.
//
// Covers the backend variant resolvers layered over the §4.11 render core: the §7.5 W5 Statement-of-Disagreement
// pipeline (denied-only + the SoD-published outbox intent), the §7.15/§7.16/§7.18 SUD-aware lab-results render
// with the M29 `LabObservationReader` deny-stub (inert → `awaiting_reader` in Phase 1; live → redacted payload),
// and the §7.12 W12 EVV / §7.13 W13 encounter variant resolvers.
import { SUD_REDACTED_PLACEHOLDER } from "@wardenx/forms";
import { describe, expect, it } from "vitest";
import {
  type LabObservationReader,
  type ResolvedLabObservation,
  denyStubLabObservationReader,
  resolveEncounterPdfRender,
  resolveEvvVerificationRender,
  resolveLabResultsRender,
  resolveStatementOfDisagreement,
  statementOfDisagreementPublishedEvent,
} from "../src/modules/22-documents/index";

const ORG = "org-1";

describe("resolveStatementOfDisagreement (§7.5 W5 / D13)", () => {
  it("renders + sets attach_to_disclosures on a denial, then describes the SoD-published intent", () => {
    const res = resolveStatementOfDisagreement("m5.patient.amendment_decided", {
      organizationId: ORG,
      patientId: "pat-1",
      amendmentRequestId: "amd-1",
      decision: "denied",
      statementText: "I disagree.",
    });
    expect(res.status).toBe("render");
    if (res.status !== "render") throw new Error("unreachable");
    expect(res.payload.attachToDisclosures).toBe(true);
    expect(res.payload.tags.original_amendment_request_id).toBe("amd-1");

    const evt = statementOfDisagreementPublishedEvent(res, "doc-sod-1");
    expect(evt).toEqual({
      eventName: "m22.document.statement_of_disagreement_published",
      payload: {
        documentId: "doc-sod-1",
        organizationId: ORG,
        patientId: "pat-1",
        originalAmendmentRequestId: "amd-1",
      },
    });
  });

  it("skips a non-denied decision and a non-M5 event and a malformed payload", () => {
    expect(
      resolveStatementOfDisagreement("m5.patient.amendment_decided", {
        organizationId: ORG,
        patientId: "pat-1",
        amendmentRequestId: "amd-2",
        decision: "approved",
      }).status,
    ).toBe("skip");
    expect(resolveStatementOfDisagreement("m99.other", { decision: "denied" }).status).toBe("skip");
    // missing amendmentRequestId
    expect(
      resolveStatementOfDisagreement("m5.patient.amendment_decided", {
        organizationId: ORG,
        patientId: "pat-1",
        decision: "denied",
      }).status,
    ).toBe("skip");
  });
});

describe("resolveLabResultsRender (§7.15/§7.16/§7.18 + the M29 reader deny-stub)", () => {
  const event = {
    organizationId: ORG,
    patientId: "pat-1",
    orderId: "ord-1",
    observationId: "obs-1",
  };

  function liveReader(observation: ResolvedLabObservation): LabObservationReader {
    return { async loadObservation() { return { available: true, observation }; } };
  }

  it("is INERT (awaiting_reader) while the M29 deny-stub is in place (Wave H not landed)", async () => {
    const res = await resolveLabResultsRender("m11.order.results_received", event, {
      labObservationReader: denyStubLabObservationReader,
    });
    expect(res.status).toBe("awaiting_reader");
  });

  it("renders full plaintext (clinical) for an all-non-SUD observation on a live reader", async () => {
    const reader = liveReader({
      observationId: "obs-1",
      orderId: "ord-1",
      orderingProviderName: "Dr. Rivera",
      resultValues: [{ analyteName: "Sodium", loincCode: "2951-2", value: "140", isSudClass: false }],
    });
    const res = await resolveLabResultsRender("m11.order.results_received", event, { labObservationReader: reader });
    expect(res.status).toBe("render");
    if (res.status !== "render") throw new Error("unreachable");
    expect(res.payload.retentionClass).toBe("clinical_record");
    expect(res.payload.resultValues[0].displayValue).toBe("140");
    expect(res.critical).toBe(false);
  });

  it("§7.16 — redacts a SUD-class value + upgrades retention to Part 2 on a live reader", async () => {
    const reader = liveReader({
      observationId: "obs-1",
      orderId: "ord-1",
      orderingProviderName: null,
      resultValues: [{ analyteName: "Methadone", loincCode: "19357-1", value: "POSITIVE", isSudClass: true }],
    });
    const res = await resolveLabResultsRender("m11.order.results_received", event, { labObservationReader: reader });
    if (res.status !== "render") throw new Error("unreachable");
    expect(res.payload.resultValues[0].value).toBeNull();
    expect(res.payload.resultValues[0].displayValue).toBe(SUD_REDACTED_PLACEHOLDER);
    expect(res.payload.retentionClass).toBe("compliance_42cfr_part2");
    expect(JSON.stringify(res.payload)).not.toContain("POSITIVE");
  });

  it("§7.18 — the critical event sets the critical flag (the dispatcher emits rendered_critical_results)", async () => {
    const reader = liveReader({
      observationId: "obs-1",
      orderId: "ord-1",
      orderingProviderName: null,
      resultValues: [{ analyteName: "Potassium", loincCode: "2823-3", value: "7.2", abnormalFlag: "HH", isSudClass: false }],
    });
    const res = await resolveLabResultsRender("m11.order.results_received_critical", event, {
      labObservationReader: reader,
    });
    if (res.status !== "render") throw new Error("unreachable");
    expect(res.critical).toBe(true);
    expect(res.payload.watermark).toBe("CRITICAL RESULT");
  });

  it("skips a non-lab event and a payload missing the observation id", async () => {
    expect(
      (await resolveLabResultsRender("m8.encounter.signed", event, { labObservationReader: denyStubLabObservationReader }))
        .status,
    ).toBe("skip");
    expect(
      (
        await resolveLabResultsRender(
          "m11.order.results_received",
          { organizationId: ORG, patientId: "pat-1", orderId: "ord-1" },
          { labObservationReader: denyStubLabObservationReader },
        )
      ).status,
    ).toBe("skip");
  });
});

describe("resolveEvvVerificationRender (§7.12 W12)", () => {
  it("renders the geo map section for a geo-verified acceptance", () => {
    const res = resolveEvvVerificationRender("m18.evv.aggregator_accepted", {
      organizationId: ORG,
      patientId: "pat-1",
      visitId: "v-1",
      evvRecordId: "evv-1",
      aggregatorRefId: "agg-1",
      acceptedAt: "2026-06-22T10:00:00.000Z",
      submissionId: "sub-1",
      geoVerification: { latitude: 45.5, longitude: -122.6, snapshotPresent: true },
    });
    if (res.status !== "render") throw new Error("unreachable");
    expect(res.aggregateId).toBe("sub-1");
    expect(res.payload.geoVerified).toBe(true);
    expect(res.payload.mapSection).not.toBeNull();
  });

  it("renders the exception narrative for an alternate-method acceptance and skips wrong events", () => {
    const res = resolveEvvVerificationRender("m18.evv.aggregator_accepted", {
      organizationId: ORG,
      patientId: "pat-1",
      visitId: "v-2",
      evvRecordId: "evv-2",
      aggregatorRefId: "agg-2",
      acceptedAt: "2026-06-22T10:00:00.000Z",
      alternateMethodReason: "caregiver attestation",
    });
    if (res.status !== "render") throw new Error("unreachable");
    expect(res.payload.exceptionNarrative).toContain("caregiver attestation");
    expect(resolveEvvVerificationRender("m99.other", {}).status).toBe("skip");
  });
});

describe("resolveEncounterPdfRender (§7.13 W13)", () => {
  it("renders v1 for a signed encounter and a new version for an addendum", () => {
    const v1 = resolveEncounterPdfRender("m8.encounter.signed", {
      organizationId: ORG,
      patientId: "pat-1",
      encounterId: "enc-1",
    });
    if (v1.status !== "render") throw new Error("unreachable");
    expect(v1.payload.versionReason).toBe("initial");

    const add = resolveEncounterPdfRender("m8.encounter.addendum_signed", {
      organizationId: ORG,
      patientId: "pat-1",
      encounterId: "enc-1",
    });
    if (add.status !== "render") throw new Error("unreachable");
    expect(add.payload.versionReason).toBe("addendum");
  });

  it("renders the M32 narrative sidebar when an enhancement is attached", () => {
    const res = resolveEncounterPdfRender("m8.encounter.signed", {
      organizationId: ORG,
      patientId: "pat-1",
      encounterId: "enc-2",
      narrativeEnhancement: { text: "Stable.", reviewedBy: "RN Patel", capabilityId: "cap-1" },
    });
    if (res.status !== "render") throw new Error("unreachable");
    expect(res.payload.narrativeSidebar?.attribution).toBe("AI-suggested, reviewed by RN Patel");
  });
});
