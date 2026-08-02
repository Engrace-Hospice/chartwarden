// Module 28 — §8.2 / D3 / W-FHIR-03 the 42 CFR Part 2 SUD egress consent gate (M28-T05).
//
// These lock the per-resource egress posture: a disclosure the recipient may not receive is FILTERED; a
// wholly-SUD resource is FILTERED when the recipient lacks a Part-2 release; a DiagnosticReport is
// REDACTED WHOLE-REPORT (via the T04 D20 applier) rather than dropped; a permitted disclosure projects
// UNCHANGED; and the Bundle carries a de-duplicated `OperationOutcome` warning (not a silent "no data").

import { describe, expect, it } from "vitest";

import {
  applyEgressConsentGate,
  applySudRedactionToDiagnosticReport,
  DISCLOSURE_UNAUTHORIZED_TEXT,
  gateBundleForEgress,
  gateResourceForEgress,
  PART2_CONSENT_ABSENT_TEXT,
  PART2_REDACTED_TEXT,
  type DiagnosticReport,
  type EgressResourceInput,
  type FhirDisclosureConsentEvaluator,
  type FhirDisclosureDecision,
  type MedicationRequest,
} from "../src";

/** A fake M39 evaluator returning a fixed decision — the shape T06 binds the real `ConsentEvaluator` to. */
function evaluator(decision: FhirDisclosureDecision): FhirDisclosureConsentEvaluator {
  return { async evaluateForDisclosure() { return decision; } };
}

/** A per-patient evaluator, so a mixed-patient Bundle applies each patient's own consent (W-FHIR-03). */
function perPatientEvaluator(
  byPatient: Record<string, FhirDisclosureDecision>,
): FhirDisclosureConsentEvaluator {
  return {
    async evaluateForDisclosure({ patientId }) {
      return byPatient[patientId] ?? { allowed: true, redactSudContent: false };
    },
  };
}

function medReq(id: string, patientId: string): MedicationRequest {
  return {
    resourceType: "MedicationRequest",
    id,
    status: "active",
    intent: "order",
    subject: { reference: `Patient/${patientId}` },
    medicationCodeableConcept: { text: "buprenorphine" },
  };
}

/** A DiagnosticReport carrying one SUD-class contained Observation (the `R-SUD` marker the T04
 *  child-observation projector stamps), so the D20 applier collapses it whole-report. */
function sudReport(id: string, patientId: string): DiagnosticReport {
  return {
    resourceType: "DiagnosticReport",
    id,
    status: "final",
    code: { text: "UDS panel" },
    subject: { reference: `Patient/${patientId}` },
    conclusion: "positive for buprenorphine",
    result: [{ reference: `Observation/${id}--0` }],
    contained: [
      {
        resourceType: "Observation",
        id: `${id}--0`,
        status: "final",
        code: { text: "buprenorphine" },
        meta: { security: [{ code: "R-SUD" }] },
      },
    ],
  };
}

const ctx = { organizationId: "org-1", recipientClientId: "hie-1" };

describe("applyEgressConsentGate — pure per-resource decision", () => {
  const sudMedInput = (): EgressResourceInput<MedicationRequest> => ({
    resource: medReq("mr-1", "carol"),
    patientId: "carol",
    sudClass: true,
    onSudRedact: "filter",
  });

  it("filters the resource when the disclosure is not authorized (allowed:false)", () => {
    const out = applyEgressConsentGate(sudMedInput(), { allowed: false, redactSudContent: false });
    expect(out.action).toBe("filter");
    if (out.action !== "filter") throw new Error("unreachable");
    expect(out.warning.issue[0]?.severity).toBe("warning");
    expect(out.warning.issue[0]?.code).toBe("suppressed");
    expect(out.warning.issue[0]?.details?.text).toBe(DISCLOSURE_UNAUTHORIZED_TEXT);
  });

  it("filters a wholly-SUD resource when redactSudContent and strategy is filter (W-FHIR-03 step 4)", () => {
    const out = applyEgressConsentGate(sudMedInput(), { allowed: true, redactSudContent: true });
    expect(out.action).toBe("filter");
    if (out.action !== "filter") throw new Error("unreachable");
    expect(out.warning.issue[0]?.details?.text).toBe(PART2_CONSENT_ABSENT_TEXT);
  });

  it("projects the SUD resource unchanged when the recipient holds a Part-2 release (W-FHIR-03 step 5)", () => {
    const out = applyEgressConsentGate(sudMedInput(), { allowed: true, redactSudContent: false });
    expect(out.action).toBe("include");
    if (out.action !== "include") throw new Error("unreachable");
    expect(out.resource.id).toBe("mr-1");
  });

  it("projects a non-SUD resource unchanged regardless of the SUD flag", () => {
    const input: EgressResourceInput<MedicationRequest> = {
      resource: medReq("mr-2", "dave"),
      patientId: "dave",
      sudClass: false,
      onSudRedact: "filter",
    };
    const out = applyEgressConsentGate(input, { allowed: true, redactSudContent: true });
    expect(out.action).toBe("include");
  });

  it("redacts a DiagnosticReport WHOLE-REPORT (not drops it) via the injected D20 applier", () => {
    const input: EgressResourceInput<DiagnosticReport> = {
      resource: sudReport("dr-1", "carol"),
      patientId: "carol",
      sudClass: true,
      onSudRedact: applySudRedactionToDiagnosticReport,
    };
    const out = applyEgressConsentGate(input, { allowed: true, redactSudContent: true });
    expect(out.action).toBe("redact");
    if (out.action !== "redact") throw new Error("unreachable");
    expect(out.warning.issue[0]?.details?.text).toBe(PART2_REDACTED_TEXT);
    // The collapsed report keeps its id but leaks no SUD value, LOINC, or conclusion.
    const wire = JSON.stringify(out.resource);
    expect(out.resource.id).toBe("dr-1");
    expect(out.resource.conclusion).toBeUndefined();
    expect(wire).not.toContain("buprenorphine");
    expect(out.resource.meta?.security?.some((s) => s.code === "R")).toBe(true);
  });
});

describe("gateResourceForEgress — consults M39 per resource", () => {
  it("passes the (org, patient, recipient) tuple through to evaluateForDisclosure", async () => {
    const seen: unknown[] = [];
    const spy: FhirDisclosureConsentEvaluator = {
      async evaluateForDisclosure(args) {
        seen.push(args);
        return { allowed: true, redactSudContent: true };
      },
    };
    await gateResourceForEgress(spy, ctx, {
      resource: medReq("mr-1", "carol"),
      patientId: "carol",
      sudClass: true,
      onSudRedact: "filter",
    });
    expect(seen).toEqual([
      { organizationId: "org-1", patientId: "carol", recipientClientId: "hie-1", asOf: undefined },
    ]);
  });
});

describe("gateBundleForEgress — search / $everything result set (W-FHIR-14 + W-FHIR-03)", () => {
  it("filters SUD resources, keeps non-SUD, and folds ONE deduplicated warning", async () => {
    const inputs: EgressResourceInput<MedicationRequest>[] = [
      { resource: medReq("mr-carol", "carol"), patientId: "carol", sudClass: true, onSudRedact: "filter" },
      { resource: medReq("mr-carol-2", "carol"), patientId: "carol", sudClass: true, onSudRedact: "filter" },
      { resource: medReq("mr-dave", "dave"), patientId: "dave", sudClass: false, onSudRedact: "filter" },
    ];
    const result = await gateBundleForEgress(
      perPatientEvaluator({
        carol: { allowed: true, redactSudContent: true },
        dave: { allowed: true, redactSudContent: false },
      }),
      ctx,
      inputs,
    );
    expect(result.resources.map((r) => r.id)).toEqual(["mr-dave"]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]?.issue[0]?.details?.text).toBe(PART2_CONSENT_ABSENT_TEXT);
  });

  it("returns no warning when every disclosure is permitted", async () => {
    const result = await gateBundleForEgress(
      evaluator({ allowed: true, redactSudContent: false }),
      ctx,
      [{ resource: medReq("mr-1", "carol"), patientId: "carol", sudClass: true, onSudRedact: "filter" }],
    );
    expect(result.resources).toHaveLength(1);
    expect(result.warnings).toHaveLength(0);
  });
});
