// apps/backend/__tests__/f238-doclens-clinical-writeback.test.ts — F-238, no DB: the PURE halves of the DocLens
// → M12 medication-history / → M5 allergy writeback, and the governance facts the design rests on.
//
//   1. M22's clinical planner — every exclusion rule, the 42 CFR Part 2 / MAT screen, in-batch dedupe.
//   2. The shared contract — the dedupe key, the fail-closed commit parser both consumers use, M22's reply parser.
//   3. Governance (M12 D12 / AI Governance §2.1.1): nothing on this path can reach a `medication_order`; the
//      M32 D18 AI-prohibited zone (the operational form of D12's boot check) still passes for the DocLens
//      templates and still covers `medication_history_*`, so no LLM template may target the history store.
//
// The live chain (completion → outbox → M12 / M5 → back-ref, RLS as the app role) is
// `f238-doclens-clinical-writeback.live.test.ts`.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  type ActivePromptSummary,
  aiTargetPrefixIsProhibited,
  findAiProhibitedZoneViolations,
} from "@wardenx/ai-platform";
import {
  M22_EXTRACTION_ALLERGIES_REQUESTED_EVENT,
  M22_EXTRACTION_MEDICATION_HISTORY_REQUESTED_EVENT,
  doclensClinicalLineKey,
  doclensFieldPathIndex,
  parseDocLensClinicalCommit,
} from "@wardenx/types";
import { describe, expect, it } from "vitest";
import { buildM5ExtractionAllergyConsumer } from "../src/modules/05-patient/outbox-consumers/m22-extraction-allergies";
import { buildM12ExtractionMedicationHistoryConsumer } from "../src/modules/12-dosespot/outbox-consumers/m22-extraction-medication-history";
import { parseClinicalReply } from "../src/modules/22-documents/extraction/extraction-clinical-backref-consumer";
import {
  type ClinicalCandidateFact,
  clinicalWritebackTargetOf,
  planDocLensClinicalWriteback,
} from "../src/modules/22-documents/extraction/writeback-plan-clinical";

const PATIENT = "44444444-4444-4444-4444-444444444444";
const ORG = "11111111-1111-1111-1111-111111111111";
let n = 0;
function fact(over: Partial<ClinicalCandidateFact>): ClinicalCandidateFact {
  n += 1;
  return {
    candidateId: `cand-${n}`,
    decisionId: `dec-${n}`,
    fieldPath: `medications[${n}].name`,
    riskLevel: "high",
    sudDetected: false,
    extractedValue: "Morphine sulfate 5 mg PO q4h PRN pain",
    decision: "approve",
    editedValue: null,
    sourceDocumentId: "doc-1",
    sourcePage: 2,
    ...over,
  };
}
const plan = (
  facts: ClinicalCandidateFact[],
  over: {
    batchPatientId?: string | null;
    batchSudStatus?: "not_detected" | "detected" | "confirmed" | "rejected";
  } = {},
) =>
  planDocLensClinicalWriteback({
    batchPatientId: over.batchPatientId === undefined ? PATIENT : over.batchPatientId,
    batchSudStatus: over.batchSudStatus ?? "not_detected",
    facts,
  });

describe("F-238 — M22 clinical planner", () => {
  it("routes medication lines to M12 history and allergy lines to M5, verbatim, ignoring other paths", () => {
    const p = plan([
      fact({ fieldPath: "medications[0].name", extractedValue: "  Morphine 5 mg PO q4h PRN  " }),
      fact({ fieldPath: "allergies[1].substance", extractedValue: "Penicillin — hives" }),
      fact({ fieldPath: "patient.phoneHome", riskLevel: "low", extractedValue: "503-555-0100" }),
    ]);
    expect(p.targetPatientId).toBe(PATIENT);
    expect(p.medicationLines).toMatchObject([
      {
        fieldPath: "medications[0].name",
        lineIndex: 0,
        text: "Morphine 5 mg PO q4h PRN",
        sourcePage: 2,
      },
    ]);
    expect(p.allergyLines).toMatchObject([
      { fieldPath: "allergies[1].substance", lineIndex: 1, text: "Penicillin — hives" },
    ]);
    expect(p.excluded).toEqual([]); // the demographics path is the F-235 planner's, not reported here
  });

  it("uses the reviewer's edit for approve_with_edit, and refuses an edit that is missing", () => {
    const p = plan([
      fact({ decision: "approve_with_edit", editedValue: "Morphine 10 mg PO q4h PRN" }),
      fact({ decision: "approve_with_edit", editedValue: "   " }),
      fact({ extractedValue: null }),
    ]);
    expect(p.medicationLines.map((l) => l.text)).toEqual(["Morphine 10 mg PO q4h PRN"]);
    expect(p.excluded.map((e) => e.reason)).toEqual(["edited_value_missing", "value_missing"]);
  });

  it("a rejected decision is no intent and is not reported", () => {
    const p = plan([fact({ decision: "reject" })]);
    expect(p.medicationLines).toEqual([]);
    expect(p.excluded).toEqual([]);
    expect(p.targetPatientId).toBeNull();
  });

  it("fails closed on a mis-tiered candidate (the paths are HIGH risk: per-field + vision re-read)", () => {
    const p = plan([fact({ riskLevel: "low" }), fact({ riskLevel: "medium" })]);
    expect(p.medicationLines).toEqual([]);
    expect(p.excluded.map((e) => e.reason)).toEqual(["risk_not_high", "risk_not_high"]);
  });

  it("never writes back without a resolved patient (no headless create)", () => {
    const p = plan(
      [fact({}), fact({ fieldPath: "allergies[0].substance", extractedValue: "Sulfa" })],
      {
        batchPatientId: null,
      },
    );
    expect(p.targetPatientId).toBeNull();
    expect(p.excluded.map((e) => e.reason)).toEqual(["patient_unresolved", "patient_unresolved"]);
  });

  it("42 CFR Part 2 — a SUD-flagged candidate stays out unless a reviewer rejected the detection", () => {
    for (const status of ["not_detected", "detected", "confirmed"] as const) {
      const p = plan([fact({ sudDetected: true, extractedValue: "Lisinopril 10 mg daily" })], {
        batchSudStatus: status,
      });
      expect(p.medicationLines).toEqual([]);
      expect(p.excluded[0]?.reason).toBe("sud_detected");
    }
    const cleared = plan([fact({ sudDetected: true, extractedValue: "Lisinopril 10 mg daily" })], {
      batchSudStatus: "rejected",
    });
    expect(cleared.medicationLines).toHaveLength(1);
  });

  it("MAT drugs never go out while SUD is detected/confirmed (or undetected) — medications AND allergies", () => {
    const lines = [
      "Methadone 10 mg PO BID",
      "Suboxone 8 mg/2 mg SL daily",
      "buprenorphine patch 5 mcg/hr",
      "Vivitrol 380 mg IM monthly",
      "Naltrexone 50 mg PO daily",
      "Antabuse 250 mg daily",
      "Lucemyra 0.18 mg",
    ];
    for (const status of ["not_detected", "detected", "confirmed"] as const) {
      const p = plan(
        [
          ...lines.map((v) => fact({ extractedValue: v })),
          fact({ fieldPath: "allergies[0].substance", extractedValue: "Naltrexone — rash" }),
        ],
        { batchSudStatus: status },
      );
      expect(p.medicationLines).toEqual([]);
      expect(p.allergyLines).toEqual([]);
      expect(new Set(p.excluded.map((e) => e.reason))).toEqual(
        new Set(["sud_treatment_medication"]),
      );
    }
    // The spec's own false positive (W4 acceptance #2): methadone for PAIN, detection rejected by a reviewer.
    const pain = plan([fact({ extractedValue: "Methadone 5 mg PO q8h for pain" })], {
      batchSudStatus: "rejected",
    });
    expect(pain.medicationLines.map((l) => l.text)).toEqual(["Methadone 5 mg PO q8h for pain"]);
  });

  it("an over-long line is excluded, never truncated", () => {
    const p = plan([fact({ extractedValue: `Morphine ${"x".repeat(600)}` })]);
    expect(p.medicationLines).toEqual([]);
    expect(p.excluded[0]?.reason).toBe("value_too_long");
  });

  it("dedupes within a batch by the normalized line — the repeat is reported, the first is kept", () => {
    const p = plan([
      fact({ extractedValue: "Morphine 5 mg PO q4h PRN." }),
      fact({ extractedValue: "morphine 5 mg  po q4h prn" }),
      fact({ extractedValue: "Morphine 10 mg PO q4h PRN" }),
      fact({ fieldPath: "allergies[0].substance", extractedValue: "Morphine 5 mg PO q4h PRN" }),
    ]);
    expect(p.medicationLines.map((l) => l.text)).toEqual([
      "Morphine 5 mg PO q4h PRN.",
      "Morphine 10 mg PO q4h PRN",
    ]);
    expect(p.allergyLines).toHaveLength(1); // same text on the OTHER target is not a duplicate
    expect(p.excluded.map((e) => e.reason)).toEqual(["duplicate_in_batch"]);
  });

  it("classifies field paths by the registry's generic path", () => {
    expect(clinicalWritebackTargetOf("medications[12].name")).toBe("medication_history");
    expect(clinicalWritebackTargetOf("allergies[0].substance")).toBe("allergy");
    expect(clinicalWritebackTargetOf("medications[0].dose")).toBeNull();
    expect(clinicalWritebackTargetOf("patient.email")).toBeNull();
  });
});

describe("F-238 — the shared contract", () => {
  it("the dedupe key normalizes case, whitespace and surrounding punctuation only", () => {
    expect(doclensClinicalLineKey("  Morphine  5 mg PO.  ")).toBe("morphine 5 mg po");
    expect(doclensClinicalLineKey("• Penicillin – hives;")).toBe("penicillin – hives");
    expect(doclensClinicalLineKey("Morphine 5 mg")).not.toBe(
      doclensClinicalLineKey("Morphine 50 mg"),
    );
    expect(doclensFieldPathIndex("allergies[7].substance")).toBe(7);
  });

  const line = {
    candidateId: "c1",
    decisionId: "d1",
    fieldPath: "medications[0].name",
    lineIndex: 0,
    text: "Morphine 5 mg",
    sourceDocumentId: "doc",
    sourcePage: 1,
  };
  const commit = (over: Record<string, unknown> = {}) => ({
    extractionCommitId: "r1",
    organizationId: ORG,
    intakeBatchId: "b1",
    targetModule: "m12",
    targetAggregateId: PATIENT,
    reviewerMembershipId: "m1",
    batchSudStatus: "not_detected",
    lines: [line],
    requestedAt: "2026-10-04T00:00:00.000Z",
    ...over,
  });

  it("the commit parser fails closed on the wrong target, another tenant, or a malformed line", () => {
    expect(parseDocLensClinicalCommit(commit(), ORG, "m12").ok).toBe(true);
    expect(parseDocLensClinicalCommit(commit(), ORG, "m5")).toMatchObject({ ok: false });
    expect(parseDocLensClinicalCommit(commit(), "other-org", "m12")).toMatchObject({ ok: false });
    expect(
      parseDocLensClinicalCommit(commit({ lines: [{ ...line, text: "" }] }), ORG, "m12"),
    ).toMatchObject({ ok: false });
    expect(parseDocLensClinicalCommit(commit({ lines: [line, line] }), ORG, "m12")).toMatchObject({
      ok: false,
      reason: "duplicate candidate in lines",
    });
    expect(parseDocLensClinicalCommit(null, ORG, "m12")).toMatchObject({ ok: false });
  });

  it("both consumers throw (→ DLQ) on a payload that is not theirs", async () => {
    const stub = {} as never;
    const m12 = buildM12ExtractionMedicationHistoryConsumer({ db: stub, outbox: stub });
    const m5 = buildM5ExtractionAllergyConsumer({ db: stub, outbox: stub });
    expect(m12.eventTypes).toEqual([M22_EXTRACTION_MEDICATION_HISTORY_REQUESTED_EVENT]);
    expect(m5.eventTypes).toEqual([M22_EXTRACTION_ALLERGIES_REQUESTED_EVENT]);
    await expect(
      m12.handle({ organizationId: ORG, payload: commit({ targetModule: "m5" }) }),
    ).rejects.toThrow(/targetModule/);
    await expect(m5.handle({ organizationId: ORG, payload: commit() })).rejects.toThrow(
      /targetModule/,
    );
  });

  it("M22's reply parser refuses a held outcome without a row id, or another tenant's reply", () => {
    const reply = {
      patientId: PATIENT,
      organizationId: ORG,
      extractionCommitId: "r1",
      appliedAt: "2026-10-04T00:00:00.000Z",
      lineOutcomes: [
        { candidateId: "c1", outcome: "created", recordId: "row-1" },
        { candidateId: "c2", outcome: "skipped", reason: "x" },
      ],
    };
    expect(parseClinicalReply(reply, ORG).lineOutcomes).toHaveLength(2);
    expect(() =>
      parseClinicalReply(
        { ...reply, lineOutcomes: [{ candidateId: "c1", outcome: "created" }] },
        ORG,
      ),
    ).toThrow();
    expect(() => parseClinicalReply(reply, "other-org")).toThrow();
  });
});

// ── Governance: M12 D12 / AI Governance §2.1.1 ───────────────────────────────────────────────────────────
const SRC = join(__dirname, "../src/modules");
function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const full = join(dir, e);
    if (statSync(full).isDirectory()) out.push(...filesUnder(full));
    else if (e.endsWith(".ts")) out.push(full);
  }
  return out;
}
/** Source with comments removed — a comment explaining D12 is not a code path. */
function code(file: string): string {
  return readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("F-238 — governance: no medication_order on any DocLens path", () => {
  it("no M22 source touches the medication_order table", () => {
    for (const f of filesUnder(join(SRC, "22-documents"))) {
      expect(code(f), f).not.toMatch(/\bmedicationOrders\b/);
    }
  });

  it("every M12 file handling an `m22.extraction.*` event writes only medication_history_record", () => {
    // `consumers/index.ts` is the string-literal subscription registry (names only, no handler).
    const REGISTRY = "12-dosespot/consumers/index.ts";
    const handlers = filesUnder(join(SRC, "12-dosespot"))
      .filter((f) => /m22\.extraction\.|M22_EXTRACTION_/.test(code(f)))
      .map((f) => f.slice(SRC.length + 1))
      .filter((f) => f !== REGISTRY);
    expect(handlers).toEqual(["12-dosespot/outbox-consumers/m22-extraction-medication-history.ts"]);
    for (const f of handlers) {
      const c = code(join(SRC, f));
      expect(c).not.toMatch(/\bmedicationOrders\b|medication_order\b/);
      expect(c).toMatch(/schema\.medicationHistoryRecords/);
    }
  });

  it("the M12 reconcile path never mints an order (resultingOrderId is always null in the DB backend)", () => {
    const db = readFileSync(join(SRC, "12-dosespot/dosespot-route-service-db.ts"), "utf8");
    const body = db.slice(db.indexOf("async reconcileHistory("), db.indexOf("async listRefills("));
    expect(body).toContain("resultingOrderId: null");
    expect(body).not.toMatch(/insert\(MO\)|insertDraft\(/);
  });

  it("the M32 D18 AI-prohibited zone (D12's boot enforcement) passes for DocLens and covers the history store", () => {
    // The DocLens templates' declared output target (scripts/db/seed-scenario-doclens-ai.ts): the model
    // writes CANDIDATES (M22), never a medication entity.
    const doclens = (capabilityKey: string): ActivePromptSummary =>
      ({
        capabilityKey,
        promptTemplateId: "t",
        templateKey: `${capabilityKey}/v1`,
        version: 1,
        outputEntityTargetPrefix: "extraction_candidate",
        outputTypePrefix: capabilityKey,
        gitArtifactPath: "x",
        contentHash: "h",
      }) as ActivePromptSummary;
    expect(
      findAiProhibitedZoneViolations(
        ["doclens_classify", "doclens_extract", "doclens_vision_verify", "doclens_sud_detect"].map(
          doclens,
        ),
      ),
    ).toEqual([]);
    // No LLM template may target the history store directly either — the zone's `medication_` prefix
    // covers it, so the only writer of a `doclens_intake` row is M12's deterministic consumer of a
    // HUMAN-attested line.
    expect(aiTargetPrefixIsProhibited("medication_history_record")?.decision).toBe("M12 D12");
    expect(aiTargetPrefixIsProhibited("medication_order")?.decision).toBe("M12 D12");
    expect(aiTargetPrefixIsProhibited("patient_allergy")).toBeNull();
  });
});
