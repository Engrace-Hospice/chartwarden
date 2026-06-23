// packages/forms/__tests__/render-variants.test.ts — M22-T09 the §7 render-variant builders.
//
// Proves the PURE render-content rules: the D20 SUD-aware redaction (§7.16 — value→null + placeholder + banner +
// metadata, no plaintext anywhere), the D23 Part-2 retention upgrade, the D22 critical watermark (§7.18), the D13
// Statement-of-Disagreement attach-to-disclosures + denied-only gate (§7.5 W5), and the W12 EVV (§7.12) / W13
// encounter (§7.13) layout-variant selectors.
import { describe, expect, it } from "vitest";
import {
  CRITICAL_RESULT_WATERMARK,
  SUD_REDACTED_PLACEHOLDER,
  SUD_RESULT_BANNER,
  buildEncounterPdfRenderPayload,
  buildEvvVerificationRenderPayload,
  buildLabResultsRenderPayload,
  buildStatementOfDisagreementPayload,
} from "../src/index";

describe("buildLabResultsRenderPayload (§7.15 W-M22-22 / §7.16 W-M22-23, D20/D22/D23)", () => {
  it("renders full plaintext + clinical retention for an all-non-SUD result set", () => {
    const out = buildLabResultsRenderPayload({
      orderId: "ord-1",
      observationId: "obs-1",
      orderingProviderName: "Dr. Rivera",
      resultValues: [
        { analyteName: "Potassium", loincCode: "2823-3", value: "4.1", unit: "mEq/L", abnormalFlag: null, isSudClass: false },
      ],
    });
    expect(out.resultValues[0].value).toBe("4.1");
    expect(out.resultValues[0].displayValue).toBe("4.1");
    expect(out.sudBanner).toBeNull();
    expect(out.watermark).toBeNull();
    expect(out.retentionClass).toBe("clinical_record");
    expect(out.metadata).toEqual({ sudRedacted: false, observationId: "obs-1", m11OrderId: "ord-1" });
  });

  it("D20 — redacts a SUD-class value to null + placeholder, sets the banner, and upgrades retention (D23)", () => {
    const out = buildLabResultsRenderPayload({
      orderId: "ord-9",
      observationId: "obs-9",
      resultValues: [
        { analyteName: "Methadone, urine", loincCode: "19357-1", value: "POSITIVE 350 ng/mL", abnormalFlag: "A", isSudClass: true },
        { analyteName: "Sodium", loincCode: "2951-2", value: "140", abnormalFlag: null, isSudClass: false },
      ],
    });
    const sud = out.resultValues[0];
    expect(sud.value).toBeNull();
    expect(sud.displayValue).toBe(SUD_REDACTED_PLACEHOLDER);
    // The non-SUD row in the same render is untouched.
    expect(out.resultValues[1].displayValue).toBe("140");
    expect(out.sudBanner).toBe(SUD_RESULT_BANNER);
    expect(out.retentionClass).toBe("compliance_42cfr_part2");
    expect(out.metadata.sudRedacted).toBe(true);
  });

  it("§7.16 — the SUD plaintext appears NOWHERE in the serialized render payload (defense in depth)", () => {
    const out = buildLabResultsRenderPayload({
      orderId: "ord-9",
      observationId: "obs-9",
      resultValues: [
        { analyteName: "Methadone, urine", loincCode: "19357-1", value: "POSITIVE 350 ng/mL", isSudClass: true },
      ],
    });
    expect(JSON.stringify(out)).not.toContain("POSITIVE 350 ng/mL");
  });

  it("D22 — the critical lane stamps the CRITICAL RESULT watermark", () => {
    const out = buildLabResultsRenderPayload({
      orderId: "ord-c",
      observationId: "obs-c",
      critical: true,
      resultValues: [{ analyteName: "Potassium", loincCode: "2823-3", value: "7.2", abnormalFlag: "HH", isSudClass: false }],
    });
    expect(out.watermark).toBe(CRITICAL_RESULT_WATERMARK);
  });
});

describe("buildStatementOfDisagreementPayload (§7.5 W5 / D13)", () => {
  it("renders the SoD with attach_to_disclosures + the amendment tag on a denial", () => {
    const out = buildStatementOfDisagreementPayload({
      amendmentRequestId: "amd-1",
      patientId: "pat-1",
      decision: "denied",
      statementText: "I disagree with the recorded allergy.",
      denialReason: "Record is accurate per the ordering physician.",
    });
    expect(out).not.toBeNull();
    expect(out?.attachToDisclosures).toBe(true);
    expect(out?.tags.original_amendment_request_id).toBe("amd-1");
    expect(out?.retentionClass).toBe("compliance");
    expect(out?.statementText).toContain("I disagree");
  });

  it("renders NO SoD for a non-denied decision (approved / withdrawn)", () => {
    expect(
      buildStatementOfDisagreementPayload({ amendmentRequestId: "amd-2", patientId: "pat-1", decision: "approved" }),
    ).toBeNull();
    expect(
      buildStatementOfDisagreementPayload({ amendmentRequestId: "amd-3", patientId: "pat-1", decision: "withdrawn" }),
    ).toBeNull();
  });
});

describe("buildEvvVerificationRenderPayload (§7.12 W12)", () => {
  it("embeds the map section for a geo-verified visit", () => {
    const out = buildEvvVerificationRenderPayload({
      visitId: "v-1",
      evvRecordId: "evv-1",
      aggregatorRefId: "agg-1",
      acceptedAt: "2026-06-22T10:00:00.000Z",
      geoVerification: { latitude: 45.5, longitude: -122.6, snapshotPresent: true },
    });
    expect(out.geoVerified).toBe(true);
    expect(out.mapSection).toEqual({ latitude: 45.5, longitude: -122.6, snapshotPresent: true });
    expect(out.exceptionNarrative).toBeNull();
  });

  it("populates the exception narrative for an alternate-method visit (geo unavailable)", () => {
    const out = buildEvvVerificationRenderPayload({
      visitId: "v-2",
      evvRecordId: "evv-2",
      aggregatorRefId: "agg-2",
      acceptedAt: "2026-06-22T10:00:00.000Z",
      alternateMethodReason: "caregiver attestation",
    });
    expect(out.geoVerified).toBe(false);
    expect(out.mapSection).toBeNull();
    expect(out.exceptionNarrative).toBe("Geographic verification unavailable; alternate method used: caregiver attestation");
  });

  it("treats geo present but snapshot missing as the alternate path", () => {
    const out = buildEvvVerificationRenderPayload({
      visitId: "v-3",
      evvRecordId: "evv-3",
      aggregatorRefId: "agg-3",
      acceptedAt: "2026-06-22T10:00:00.000Z",
      geoVerification: { latitude: 1, longitude: 2, snapshotPresent: false },
      alternateMethodReason: "snapshot capture failed",
    });
    expect(out.geoVerified).toBe(false);
    expect(out.exceptionNarrative).toContain("snapshot capture failed");
  });
});

describe("buildEncounterPdfRenderPayload (§7.13 W13)", () => {
  it("marks an initial encounter as v1 with no AI sidebar", () => {
    const out = buildEncounterPdfRenderPayload({ encounterId: "enc-1" });
    expect(out.versionReason).toBe("initial");
    expect(out.narrativeSidebar).toBeNull();
  });

  it("marks an addendum as a new version", () => {
    const out = buildEncounterPdfRenderPayload({ encounterId: "enc-1", isAddendum: true });
    expect(out.versionReason).toBe("addendum");
  });

  it("renders the M32 AI-assisted sidebar with attribution + capability disclosure footer", () => {
    const out = buildEncounterPdfRenderPayload({
      encounterId: "enc-2",
      narrativeEnhancement: { text: "Patient tolerating PO intake.", reviewedBy: "RN Patel", capabilityId: "cap-narr-1" },
    });
    expect(out.narrativeSidebar?.text).toContain("PO intake");
    expect(out.narrativeSidebar?.attribution).toBe("AI-suggested, reviewed by RN Patel");
    expect(out.narrativeSidebar?.capabilityDisclosureFooter).toContain("cap-narr-1");
  });
});
