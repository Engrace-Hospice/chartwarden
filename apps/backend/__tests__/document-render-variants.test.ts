// apps/backend/__tests__/document-render-variants.test.ts — M22-T09 the §7.5 Statement-of-Disagreement
// attachment, the §7.16 SUD-redacted placeholder render, the §7.12/§7.13/§7.15 EVV/encounter/lab render
// variants, and the §7.15 lab back-ref deny-stub. All pure (no DB, no PDF library, no seam registration
// needed for the deciders); the lab deny-stub resolver fail-closes against an empty seam registry.
import { afterEach, describe, expect, it } from "vitest";
import { __resetSeamsForTest } from "../src/bootstrap/seams/registry";
import {
  type AmendmentDeniedPayload,
  type EncounterRenderPayload,
  type EvvVerificationPayload,
  type LabBackrefFacts,
  type LabResultsRenderPayload,
  type LabResultsRequestPayload,
  // lab back-ref consumer
  M22_LAB_RESULTS_BINDING,
  M22_LAB_RESULTS_BINDING_DEFERRED,
  M22_LAB_RESULTS_CONSUMER,
  M22_LAB_RESULTS_EVENT,
  PLATFORM_TEMPLATE_TABLE,
  // statement of disagreement
  SOD_AMENDMENT_TAG,
  // render variants
  SUD_REDACTED_PLACEHOLDER,
  SUD_REDACTION_BANNER,
  SUD_RETENTION_CLASS,
  StatementOfDisagreementError,
  decideLabBackref,
  planEncounterRender,
  planEvvVerificationRender,
  planLabResultsRender,
  planStatementOfDisagreement,
  redactSudValue,
  resolveLabResultsPayload,
} from "../src/modules/22-documents/index";

const ORG = "00000000-0000-4000-8000-0000000000ee";
const PAT = "00000000-0000-4000-8000-0000000000aa";
const AGG = "00000000-0000-4000-8000-0000000000bb";

afterEach(() => __resetSeamsForTest());

// ── §7.5 W5 — Statement of Disagreement attachment (D13) ────────────────────────────────────────────────

describe("M22-T09 — §7.5 W5 Statement of Disagreement", () => {
  function denied(over: Partial<AmendmentDeniedPayload> = {}): AmendmentDeniedPayload {
    return {
      amendmentId: AGG,
      patientId: PAT,
      organizationId: ORG,
      decision: "denied",
      statementText:
        "I disagree with the recorded allergy; I have never had a penicillin reaction.",
      denialReason: "The chart entry is supported by the admitting H&P.",
      ...over,
    };
  }

  it("attaches the SoD as a GENESIS version (append-only) with attach_to_disclosures + the amendment tag", () => {
    const plan = planStatementOfDisagreement({
      payload: denied(),
      versionId: "v1",
      currentMaxVersion: 0,
    });

    expect(plan.templateKey).toBe("patient_amendment_statement_of_disagreement");
    // §7.5: the SoD does NOT alter the original — it is an append-only version (T03 versioning).
    expect(plan.version.to).toBe("active");
    expect(plan.version.effects).toContainEqual({ kind: "flip_active_version", versionId: "v1" });
    expect(plan.version.effects).toContainEqual({ kind: "outbox", event: "m22.document.created" });
    // §7.5 step 4–5: attach_to_disclosures=true, tag the amendment id, publish the SoD event.
    expect(plan.attachEffects).toContainEqual({
      kind: "set_field",
      field: "attach_to_disclosures",
      value: "true",
    });
    expect(plan.attachEffects).toContainEqual({
      kind: "set_field",
      field: SOD_AMENDMENT_TAG,
      value: AGG,
    });
    expect(plan.attachEffects).toContainEqual({
      kind: "outbox",
      event: "m22.document.statement_of_disagreement_published",
    });
    expect(plan.content.statementText).toContain("I disagree");
  });

  it("appends a SECOND SoD as version n≥2 (m22.document.versioned), preserving the prior SoD", () => {
    const plan = planStatementOfDisagreement({
      payload: denied(),
      versionId: "v2",
      currentMaxVersion: 1,
    });
    expect(plan.version.effects).toContainEqual({
      kind: "outbox",
      event: "m22.document.versioned",
    });
    expect(plan.version.effects).not.toContainEqual({ kind: "set_status", status: "superseded" });
  });

  it("refuses to render a SoD for a non-denied amendment (only a denial yields a SoD)", () => {
    expect(() =>
      planStatementOfDisagreement({
        payload: denied({ decision: "approved" }),
        versionId: "v1",
        currentMaxVersion: 0,
      }),
    ).toThrow(StatementOfDisagreementError);
  });

  it("resolves the SoD template key in the platform template table (compliance class)", () => {
    const d = PLATFORM_TEMPLATE_TABLE.patient_amendment_statement_of_disagreement;
    expect(d).toBeDefined();
    expect(d?.retentionClass).toBe("compliance");
    expect(d?.aggregateType).toBe("patient_amendment_statement_of_disagreement");
  });
});

// ── §7.16 W-M22-23 — SUD-redacted placeholder render ────────────────────────────────────────────────────

describe("M22-T09 — §7.16 SUD-redacted placeholder render", () => {
  it("redacts a SUD-class value to the fixed PHI-free placeholder when consent is absent", () => {
    const out = redactSudValue({
      value: "positive (methadone)",
      isSudClass: true,
      consentPresent: false,
    });
    expect(out.redacted).toBe(true);
    expect(out.value).toBe(SUD_REDACTED_PLACEHOLDER);
    // no PHI in the placeholder — the actual value never appears.
    expect(out.value).not.toContain("methadone");
  });

  it("passes the plaintext value through when consent IS present", () => {
    const out = redactSudValue({
      value: "positive (methadone)",
      isSudClass: true,
      consentPresent: true,
    });
    expect(out.redacted).toBe(false);
    expect(out.value).toBe("positive (methadone)");
  });

  it("never redacts a non-SUD value regardless of consent", () => {
    const out = redactSudValue({ value: "5.2 mEq/L", isSudClass: false, consentPresent: false });
    expect(out.redacted).toBe(false);
    expect(out.value).toBe("5.2 mEq/L");
  });
});

// ── §7.15 / §7.16 — lab-results render variant ──────────────────────────────────────────────────────────

describe("M22-T09 — §7.15/§7.16 lab-results render variant", () => {
  function labPayload(over: Partial<LabResultsRenderPayload> = {}): LabResultsRenderPayload {
    return {
      orderId: AGG,
      patientId: PAT,
      orderingPhysician: "Dr. Vega",
      signedAt: "2026-06-24T10:00:00.000Z",
      resultValues: [
        {
          observationId: "o1",
          loincCode: "2823-3",
          label: "Potassium",
          value: "5.2",
          unit: "mEq/L",
          isSudClass: false,
        },
        {
          observationId: "o2",
          loincCode: "19357-1",
          label: "Methadone, urine",
          value: "positive",
          unit: null,
          isSudClass: true,
        },
      ],
      ...over,
    };
  }

  it("renders all rows plaintext when there is no SUD-class row → clinical_record, no SUD flag", () => {
    const v = planLabResultsRender({
      payload: labPayload({
        resultValues: [
          {
            observationId: "o1",
            loincCode: "2823-3",
            label: "Potassium",
            value: "5.2",
            unit: "mEq/L",
            isSudClass: false,
          },
        ],
      }),
      consentPresent: false,
    });
    expect(v.templateKey).toBe("lab_results_pdf");
    expect(v.aggregateType).toBe("order_record");
    expect(v.sudRedacted).toBe(false);
    expect(v.retentionClassOverride).toBeUndefined();
    const rows = v.content.resultValues as Array<{ value: string | null }>;
    expect(rows[0]?.value).toBe("5.2");
    expect(v.content.sudBanner).toBeNull();
  });

  it("redacts the SUD-class row + sets the SUD banner + forces compliance_42cfr_part2 when consent absent", () => {
    const v = planLabResultsRender({ payload: labPayload(), consentPresent: false });
    expect(v.sudRedacted).toBe(true);
    expect(v.retentionClassOverride).toBe(SUD_RETENTION_CLASS);
    expect(v.content.sudBanner).toBe(SUD_REDACTION_BANNER);
    const rows = v.content.resultValues as Array<{
      value: string | null;
      redacted: boolean;
      isSudClass: boolean;
    }>;
    expect(rows[0]?.value).toBe("5.2"); // non-SUD plaintext
    expect(rows[1]?.value).toBe(SUD_REDACTED_PLACEHOLDER); // SUD redacted
    expect(rows[1]?.redacted).toBe(true);
    // no plaintext SUD value anywhere in the rendered content (the §7.16 grep guarantee).
    expect(JSON.stringify(v.content)).not.toContain("positive");
  });

  it("renders the SUD-class value plaintext when consent IS present (clinical_record stays)", () => {
    const v = planLabResultsRender({ payload: labPayload(), consentPresent: true });
    expect(v.sudRedacted).toBe(false);
    expect(v.retentionClassOverride).toBeUndefined();
    expect(v.content.sudBanner).toBeNull();
    const rows = v.content.resultValues as Array<{ value: string | null }>;
    expect(rows[1]?.value).toBe("positive");
  });

  it("publishes the lab_results_pdf template key in the platform template table", () => {
    expect(PLATFORM_TEMPLATE_TABLE.lab_results_pdf).toBeDefined();
    expect(PLATFORM_TEMPLATE_TABLE.lab_results_pdf?.aggregateType).toBe("order_record");
  });
});

// ── §7.12 W12 — EVV verification render variant ─────────────────────────────────────────────────────────

describe("M22-T09 — §7.12 EVV verification render variant", () => {
  function evv(over: Partial<EvvVerificationPayload> = {}): EvvVerificationPayload {
    return {
      evvRecordId: "evv1",
      patientId: PAT,
      visitId: "visit1",
      aggregatorRefId: "agg1",
      acceptedAt: "2026-06-24T09:00:00.000Z",
      ...over,
    };
  }

  it("renders the map-snapshot section for a geo-verified visit", () => {
    const v = planEvvVerificationRender(
      evv({ geoVerification: { lat: 45.5, lng: -122.6, mapSnapshotRef: "snap1" } }),
    );
    expect(v.templateKey).toBe("evv_verification");
    expect(v.aggregateType).toBe("evv_verification");
    expect(v.sudRedacted).toBe(false);
    const geo = v.content.geoSection as { kind: string; mapSnapshotRef: string | null };
    expect(geo.kind).toBe("map_snapshot");
    expect(geo.mapSnapshotRef).toBe("snap1");
  });

  it("renders the exception narrative for an alternate-method visit (geo unavailable)", () => {
    const v = planEvvVerificationRender(
      evv({ alternateMethodReason: "rural area, no GPS signal" }),
    );
    const geo = v.content.geoSection as { kind: string; narrative: string };
    expect(geo.kind).toBe("exception_narrative");
    expect(geo.narrative).toContain("alternate method used: rural area, no GPS signal");
  });
});

// ── §7.13 W13 — encounter PDF render variant ────────────────────────────────────────────────────────────

describe("M22-T09 — §7.13 encounter PDF render variant", () => {
  function enc(over: Partial<EncounterRenderPayload> = {}): EncounterRenderPayload {
    return {
      encounterId: "enc1",
      patientId: PAT,
      signedAt: "2026-06-24T11:00:00.000Z",
      signedByClinician: "Nurse Ada",
      body: { narrative: "Patient resting comfortably." },
      ...over,
    };
  }

  it("renders the standard encounter form with no AI sidebar by default", () => {
    const v = planEncounterRender(enc());
    expect(v.templateKey).toBe("encounter");
    expect(v.aggregateType).toBe("encounter");
    const sidebar = v.content.aiNarrativeSidebar as { present: boolean };
    expect(sidebar.present).toBe(false);
    expect(v.content.capabilityDisclosureFooter).toBe(false);
  });

  it("renders the AI-assisted narrative sidebar + capability-disclosure footer when M32 enhancement present", () => {
    const v = planEncounterRender(
      enc({
        aiNarrative: {
          text: "Suggested summary…",
          capabilityId: "cap_narr",
          reviewedByClinician: "Nurse Ada",
        },
      }),
    );
    const sidebar = v.content.aiNarrativeSidebar as { present: boolean; label: string };
    expect(sidebar.present).toBe(true);
    expect(sidebar.label).toContain("reviewed by Nurse Ada");
    expect(v.content.capabilityDisclosureFooter).toBe(true);
  });
});

// ── §7.15 — lab back-ref consumer (deny-stub) ───────────────────────────────────────────────────────────

describe("M22-T09 — §7.15 lab back-ref consumer (deny-stub, M29 Wave H)", () => {
  function reqPayload(): LabResultsRequestPayload {
    return {
      orderId: AGG,
      organizationId: ORG,
      observationId: "o1",
      patientId: PAT,
      orderingPhysicianMdmId: "mdm1",
      signedAt: "2026-06-24T10:00:00.000Z",
      attachmentKind: "full",
    };
  }
  function labFacts(over: Partial<LabBackrefFacts> = {}): LabBackrefFacts {
    return {
      alreadyRendered: false,
      observationsResolved: true,
      renderPayload: {
        orderId: AGG,
        patientId: PAT,
        orderingPhysician: "Dr. Vega",
        signedAt: "2026-06-24T10:00:00.000Z",
        resultValues: [
          {
            observationId: "o1",
            loincCode: "2823-3",
            label: "Potassium",
            value: "5.2",
            unit: "mEq/L",
            isSudClass: false,
          },
        ],
      },
      sudConsentPresent: false,
      ...over,
    };
  }

  it("declares the §7.15 binding as deferred (M29 Wave H — not wired into the dispatcher yet)", () => {
    expect(M22_LAB_RESULTS_BINDING_DEFERRED).toBe(true);
    expect(M22_LAB_RESULTS_BINDING.eventName).toBe(M22_LAB_RESULTS_EVENT);
    expect(M22_LAB_RESULTS_BINDING.consumerName).toBe(M22_LAB_RESULTS_CONSUMER);
    expect(M22_LAB_RESULTS_EVENT).toBe("m11.order.results_received");
  });

  it("idempotent-skips a re-delivered order (D14)", () => {
    expect(decideLabBackref(reqPayload(), labFacts({ alreadyRendered: true }))).toEqual({
      kind: "idempotent_skip",
    });
  });

  it("DEFERS (never renders) when the M29 observation reader is unavailable — the deny-stub path", () => {
    const action = decideLabBackref(
      reqPayload(),
      labFacts({ observationsResolved: false, renderPayload: null }),
    );
    expect(action).toEqual({ kind: "observations_unresolved", observationId: "o1" });
  });

  it("renders the lab variant once observations resolve (happy path)", () => {
    const action = decideLabBackref(reqPayload(), labFacts());
    expect(action.kind).toBe("render");
    if (action.kind === "render") {
      expect(action.variant.templateKey).toBe("lab_results_pdf");
      expect(action.retentionClass).toBe("clinical_record");
      expect(action.orderId).toBe(AGG);
    }
  });

  it("the M29 deny-stub resolver fail-CLOSES to null against an empty seam registry (Wave H)", async () => {
    const out = await resolveLabResultsPayload({
      organizationId: ORG,
      orderId: AGG,
      observationId: "o1",
    });
    expect(out).toBeNull();
  });
});
