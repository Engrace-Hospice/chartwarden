// apps/backend/__tests__/f238-doclens-dx-writeback.test.ts — F-238 dx-writeback, no DB: the PURE halves of
// the DocLens → M7 diagnosis writeback. The shared contract helpers (`@wardenx/types` code shape, Part 2
// code range, dedupe key, role label), M22's commit planner (every exclusion reason + governance rules), M7's
// fail-closed payload parse, its M38 validator, and M22's back-ref item-key parse. The live chain is
// `f238-doclens-dx-writeback.live.test.ts`.
import {
  diagnosisDedupeKey,
  isSudIcd10Code,
  normalizeDiagnosisRole,
  normalizeIcd10CmShape,
  parseDiagnosisFieldPath,
} from "@wardenx/types";
import { afterEach, describe, expect, it } from "vitest";
import { registerSeam } from "../src/bootstrap/index";
import {
  m38Icd10Validator,
  parseDiagnosisCommitRequested,
} from "../src/modules/07-care-plan/outbox-consumers/m22-diagnosis-writeback";
import { parseDiagnosisItemKey } from "../src/modules/22-documents/extraction/extraction-dx-backref-consumer";
import { planDocLensWriteback } from "../src/modules/22-documents/extraction/writeback-plan";
import {
  type DiagnosisCandidateFact,
  descriptionHasSudWording,
  planDiagnosisWriteback,
} from "../src/modules/22-documents/extraction/writeback-plan-dx";

const PATIENT = "44444444-4444-4444-4444-444444444444";
const JOB_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const JOB_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
let n = 0;
function fact(over: Partial<DiagnosisCandidateFact>): DiagnosisCandidateFact {
  n += 1;
  return {
    candidateId: `cand-${n}`,
    decisionId: `dec-${n}`,
    extractionJobId: JOB_A,
    fieldPath: "diagnoses[0].description",
    sudDetected: false,
    extractedValue: "Congestive heart failure",
    decision: "approve",
    editedValue: null,
    editedCode: null,
    sourceDocumentId: "doc-1",
    ...over,
  };
}
/** One diagnosis (description + code + role) at index `i` of `job`. */
function dx(
  i: number,
  desc: string,
  code: string | null,
  role: string | null,
  job = JOB_A,
  over: Partial<DiagnosisCandidateFact> = {},
): DiagnosisCandidateFact[] {
  const out = [
    fact({
      extractionJobId: job,
      fieldPath: `diagnoses[${i}].description`,
      extractedValue: desc,
      ...over,
    }),
  ];
  if (code !== null) {
    out.push(
      fact({
        extractionJobId: job,
        fieldPath: `diagnoses[${i}].icd10`,
        extractedValue: code,
        ...over,
      }),
    );
  }
  if (role !== null) {
    out.push(
      fact({
        extractionJobId: job,
        fieldPath: `diagnoses[${i}].role`,
        extractedValue: role,
        ...over,
      }),
    );
  }
  return out;
}
const plan = (facts: DiagnosisCandidateFact[], over: Record<string, unknown> = {}) =>
  planDiagnosisWriteback({ batchPatientId: PATIENT, facts, ...over });
const reasons = (p: ReturnType<typeof plan>) =>
  Object.fromEntries(p.excluded.map((e) => [e.fieldPath, e.reason]));

describe("F-238 — the shared contract helpers (@wardenx/types)", () => {
  it("normalizes ICD-10-CM SHAPE without changing a character beyond case/space/dot", () => {
    expect(normalizeIcd10CmShape("i50.9")).toBe("I50.9");
    expect(normalizeIcd10CmShape(" I509 ")).toBe("I50.9");
    expect(normalizeIcd10CmShape("C34.90")).toBe("C34.90");
    expect(normalizeIcd10CmShape("S72.001A")).toBe("S72.001A");
    expect(normalizeIcd10CmShape("C4A.0")).toBe("C4A.0");
    expect(normalizeIcd10CmShape("U07.1")).toBe("U07.1");
    expect(normalizeIcd10CmShape("G30")).toBe("G30");
    expect(normalizeIcd10CmShape("G30.")).toBe("G30");
    for (const bad of [
      "",
      "I5",
      "150.9",
      "I50.12345",
      "I5.09",
      "heart failure",
      "I50..9",
      "I-50",
    ]) {
      expect(normalizeIcd10CmShape(bad)).toBeNull();
    }
  });

  it("42 CFR Part 2 code range: F10–F19 except F17 (nicotine)", () => {
    expect(isSudIcd10Code("F10.20")).toBe(true);
    expect(isSudIcd10Code("f11.20")).toBe(true);
    expect(isSudIcd10Code("F19.10")).toBe(true);
    expect(isSudIcd10Code("F17.210")).toBe(false);
    expect(isSudIcd10Code("F20.9")).toBe(false);
    expect(isSudIcd10Code("F03.90")).toBe(false);
    expect(isSudIcd10Code(null)).toBe(false);
  });

  it("dedupes on the normalized code, else the normalized description", () => {
    expect(diagnosisDedupeKey("i50.9", "CHF")).toBe("icd10:I50.9");
    expect(diagnosisDedupeKey("I509", "anything")).toBe("icd10:I50.9");
    expect(diagnosisDedupeKey(null, "  Congestive  Heart-Failure ")).toBe(
      "desc:congestive heart failure",
    );
  });

  it("the document's role label is a label: unknown → unspecified, never guessed upward", () => {
    expect(normalizeDiagnosisRole("Principal")).toBe("principal");
    expect(normalizeDiagnosisRole("primary")).toBe("principal");
    expect(normalizeDiagnosisRole("history")).toBe("history");
    expect(normalizeDiagnosisRole("terminal")).toBe("unspecified");
    expect(normalizeDiagnosisRole(null)).toBe("unspecified");
  });

  it("parses diagnosis field paths only", () => {
    expect(parseDiagnosisFieldPath("diagnoses[3].icd10")).toEqual({ index: 3, slot: "icd10" });
    expect(parseDiagnosisFieldPath("diagnoses[].icd10")).toBeNull();
    expect(parseDiagnosisFieldPath("medications[0].name")).toBeNull();
    expect(parseDiagnosisFieldPath("diagnoses[0].kind")).toBeNull();
  });
});

describe("F-238 — M22 diagnosis commit planner", () => {
  it("groups description + code + role per (job, index) into one item with the code AS PRINTED", () => {
    const p = plan([
      ...dx(0, "Congestive heart failure", "i50.9", "Principal"),
      ...dx(1, "Type 2 diabetes", "E11.9", "secondary"),
    ]);
    expect(p.targetPatientId).toBe(PATIENT);
    expect(p.excluded).toEqual([]);
    expect(p.items).toEqual([
      {
        itemKey: `${JOB_A}#0`,
        description: "Congestive heart failure",
        icd10Code: "I50.9",
        icd10Source: "document",
        documentRole: "principal",
        sudRelated: false,
      },
      {
        itemKey: `${JOB_A}#1`,
        description: "Type 2 diabetes",
        icd10Code: "E11.9",
        icd10Source: "document",
        documentRole: "secondary",
        sudRelated: false,
      },
    ]);
    expect(p.committed).toHaveLength(6);
  });

  it("two documents in one batch number their lists independently — same index, different items", () => {
    const p = plan([
      ...dx(0, "COPD", "J44.9", null, JOB_A),
      ...dx(0, "CKD stage 4", "N18.4", null, JOB_B),
    ]);
    expect(p.items.map((i) => i.itemKey)).toEqual([`${JOB_A}#0`, `${JOB_B}#0`]);
  });

  it("governance: a reviewer EDIT of the code is the code sent (`reviewer_edit`); a model code is never an input", () => {
    const facts = [
      fact({ fieldPath: "diagnoses[0].description", extractedValue: "CHF" }),
      fact({
        fieldPath: "diagnoses[0].icd10",
        extractedValue: "I50.9",
        decision: "approve_with_edit",
        editedCode: "I50.22",
      }),
    ];
    const p = plan(facts);
    expect(p.items[0]).toMatchObject({ icd10Code: "I50.22", icd10Source: "reviewer_edit" });
    // editedValue is accepted when the reviewer typed the code there instead of editedCode.
    const p2 = plan([
      fact({ fieldPath: "diagnoses[0].description", extractedValue: "CHF" }),
      fact({
        fieldPath: "diagnoses[0].icd10",
        extractedValue: null,
        decision: "approve_with_edit",
        editedValue: "I50.23",
      }),
    ]);
    expect(p2.items[0]).toMatchObject({ icd10Code: "I50.23", icd10Source: "reviewer_edit" });
  });

  it("a rejected / absent code does not sink the diagnosis — it goes WITHOUT a code (nothing invented)", () => {
    const p = plan([
      fact({ fieldPath: "diagnoses[0].description", extractedValue: "Failure to thrive" }),
      fact({ fieldPath: "diagnoses[0].icd10", extractedValue: "R62.7", decision: "reject" }),
    ]);
    expect(p.items[0]).toMatchObject({ icd10Code: null, icd10Source: null });
    expect(p.excluded).toEqual([]);
  });

  it("icd10_malformed / icd10_edit_missing exclude ONLY the code candidate", () => {
    const p = plan([...dx(0, "Dementia", "dementia NOS", null)]);
    expect(p.items[0]?.icd10Code).toBeNull();
    expect(reasons(p)).toEqual({ "diagnoses[0].icd10": "icd10_malformed" });
    const p2 = plan([
      fact({ fieldPath: "diagnoses[0].description", extractedValue: "Dementia" }),
      fact({ fieldPath: "diagnoses[0].icd10", decision: "approve_with_edit", editedCode: null }),
    ]);
    expect(p2.items).toHaveLength(1);
    expect(reasons(p2)).toEqual({ "diagnoses[0].icd10": "icd10_edit_missing" });
  });

  it("description_not_approved — a code or role without an attested description goes nowhere", () => {
    const p = plan([
      fact({ fieldPath: "diagnoses[0].description", decision: "reject" }),
      fact({ fieldPath: "diagnoses[0].icd10", extractedValue: "I50.9" }),
      fact({ fieldPath: "diagnoses[0].role", extractedValue: "principal" }),
    ]);
    expect(p.items).toEqual([]);
    expect(p.targetPatientId).toBeNull();
    expect(reasons(p)).toEqual({
      "diagnoses[0].icd10": "description_not_approved",
      "diagnoses[0].role": "description_not_approved",
    });
  });

  it("the role label never leaves as anything but the four labels (and is never a kind)", () => {
    const p = plan([...dx(0, "Lung cancer", "C34.90", "terminal diagnosis")]);
    expect(p.items[0]?.documentRole).toBe("unspecified");
    expect(Object.keys(p.items[0] ?? {})).not.toContain("kind");
  });

  it("patient_unresolved — never a headless create", () => {
    const p = planDiagnosisWriteback({ batchPatientId: null, facts: dx(0, "CHF", "I50.9", null) });
    expect(p.items).toEqual([]);
    expect(new Set(p.excluded.map((e) => e.reason))).toEqual(new Set(["patient_unresolved"]));
  });

  it("edited_value_missing / value_missing / conflicting_values on the description", () => {
    expect(
      reasons(
        plan([fact({ fieldPath: "diagnoses[0].description", decision: "approve_with_edit" })]),
      ),
    ).toEqual({ "diagnoses[0].description": "edited_value_missing" });
    expect(
      reasons(plan([fact({ fieldPath: "diagnoses[0].description", extractedValue: "  " })])),
    ).toEqual({ "diagnoses[0].description": "value_missing" });
    const p = plan([
      fact({ fieldPath: "diagnoses[0].description", extractedValue: "CHF" }),
      fact({ fieldPath: "diagnoses[0].description", extractedValue: "COPD" }),
    ]);
    expect(p.items).toEqual([]);
    expect(p.excluded.map((e) => e.reason)).toEqual(["conflicting_values", "conflicting_values"]);
  });

  describe("42 CFR Part 2", () => {
    it("sud_detected: a diagnosis on a SUD-flagged page stays out unless the batch detection was REJECTED", () => {
      const facts = dx(0, "Chronic pain", "G89.4", null, JOB_A, { sudDetected: true });
      for (const s of ["not_detected", "detected", "confirmed"] as const) {
        const p = plan(facts, { batchSudStatus: s });
        expect(p.items).toEqual([]);
        expect(new Set(p.excluded.map((e) => e.reason))).toEqual(new Set(["sud_detected"]));
      }
      expect(plan(facts, { batchSudStatus: "rejected" }).items).toHaveLength(1);
    });

    it("an F10–F19 (not F17) code or SUD wording marks the item sudRelated", () => {
      expect(plan(dx(0, "Opioid dependence", "F11.20", null)).items[0]?.sudRelated).toBe(true);
      expect(plan(dx(0, "Opioid use disorder, severe", null, null)).items[0]?.sudRelated).toBe(
        true,
      );
      expect(plan(dx(0, "Nicotine dependence", "F17.210", null)).items[0]?.sudRelated).toBe(false);
      expect(plan(dx(0, "Denies alcohol use disorder", null, null)).items[0]?.sudRelated).toBe(
        false,
      );
    });

    it("sud_confirmed_batch / sud_unresolved: nothing Part 2 goes out of a confirmed (or unresolved) batch", () => {
      const facts = [
        ...dx(0, "Alcohol dependence", "F10.20", null),
        ...dx(1, "CHF", "I50.9", null),
      ];
      const confirmed = plan(facts, { batchSudStatus: "confirmed" });
      expect(confirmed.items.map((i) => i.description)).toEqual(["CHF"]);
      expect(reasons(confirmed)).toEqual({
        "diagnoses[0].description": "sud_confirmed_batch",
        "diagnoses[0].icd10": "sud_confirmed_batch",
      });
      expect(reasons(plan(facts, { batchSudStatus: "detected" }))).toMatchObject({
        "diagnoses[0].description": "sud_unresolved",
      });
      // Not detected / rejected: it goes, FLAGGED, so M7's Part 2 gates hold it.
      expect(plan(facts, { batchSudStatus: "rejected" }).items[0]?.sudRelated).toBe(true);
    });

    it("descriptionHasSudWording runs the W4 rules (negation-aware)", () => {
      expect(descriptionHasSudWording("cocaine use disorder")).toBe(true);
      expect(descriptionHasSudWording("no history of alcohol dependence")).toBe(false);
      expect(descriptionHasSudWording("hypertension")).toBe(false);
    });
  });

  it("rejected candidates are no intent and are not reported", () => {
    const p = plan([...dx(0, "CHF", "I50.9", "principal", JOB_A, { decision: "reject" })]);
    expect(p.items).toEqual([]);
    expect(p.excluded).toEqual([]);
  });

  it("the M5 planner still reports a diagnosis path as not_a_writeback_target (completion filters it out)", () => {
    const p = planDocLensWriteback({
      batchPatientId: PATIENT,
      facts: [
        {
          candidateId: "c",
          decisionId: "d",
          fieldPath: "diagnoses[0].description",
          riskLevel: "high",
          sudDetected: false,
          extractedValue: null,
          decision: "approve",
          editedValue: null,
          sourceDocumentId: "doc",
        },
      ],
    });
    expect(p.excluded).toEqual([
      { candidateId: "c", fieldPath: "diagnoses[0].description", reason: "not_a_writeback_target" },
    ]);
  });
});

describe("F-238 — M7 receipt + M22 back-ref parsing (fail closed)", () => {
  const ORG = "11111111-1111-1111-1111-111111111111";
  const good = {
    extractionCommitId: "r1",
    organizationId: ORG,
    intakeBatchId: "b1",
    targetModule: "m7",
    targetAggregateId: PATIENT,
    sourceDocumentIds: ["d1"],
    reviewerMembershipId: "m1",
    referralDate: "2026-10-01",
    diagnoses: [
      {
        itemKey: `${JOB_A}#0`,
        description: "CHF",
        icd10Code: "I50.9",
        icd10Source: "document",
        documentRole: "principal",
        sudRelated: false,
      },
    ],
    requestedAt: "2026-10-01T00:00:00Z",
  };

  it("accepts a well-formed payload and refuses cross-tenant / wrong-target / guessed shapes", () => {
    expect(parseDiagnosisCommitRequested(good, ORG).diagnoses).toHaveLength(1);
    expect(() => parseDiagnosisCommitRequested(good, "other-org")).toThrow(/payload org/);
    expect(() => parseDiagnosisCommitRequested({ ...good, targetModule: "m5" }, ORG)).toThrow();
    const codeWithoutSource = { ...good.diagnoses[0], icd10Source: null };
    expect(() =>
      parseDiagnosisCommitRequested({ ...good, diagnoses: [codeWithoutSource] }, ORG),
    ).toThrow();
    const kindSmuggled = { ...good.diagnoses[0], documentRole: "terminal" };
    expect(() =>
      parseDiagnosisCommitRequested({ ...good, diagnoses: [kindSmuggled] }, ORG),
    ).toThrow();
  });

  it("parses `<extractionJobId>#<n>` item keys and refuses anything else", () => {
    expect(parseDiagnosisItemKey(`${JOB_A}#12`)).toEqual({ jobId: JOB_A, index: 12 });
    expect(() => parseDiagnosisItemKey("diagnoses[0]")).toThrow(/malformed itemKey/);
    expect(() => parseDiagnosisItemKey(`${JOB_A}#x`)).toThrow();
  });
});

describe("F-238 — the M38 validator keeps every code (never drops, never replaces)", () => {
  afterEach(() => {
    registerSeam("TerminologyProvider", {} as never);
  });
  const asOf = new Date("2026-10-01T00:00:00Z");

  it("valid / not_valid_as_of when ICD-10-CM is loaded for the date", async () => {
    registerSeam("TerminologyProvider", {
      async lookupBatch(_s: string, codes: readonly string[]) {
        const m = new Map<string, { status: string }>();
        for (const c of codes) {
          if (c === "R69" || c === "I50.9") m.set(c, { status: "active" });
          if (c === "I50.1") m.set(c, { status: "retired" });
        }
        return m;
      },
    } as never);
    const v = await m38Icd10Validator(["I50.9", "I50.1", "Z99.99"], asOf);
    expect(Object.fromEntries(v)).toEqual({
      "I50.9": "valid",
      "I50.1": "not_valid_as_of",
      "Z99.99": "not_valid_as_of",
    });
  });

  it("unvalidated when ICD-10-CM is not loaded, the seam is unbound, or it throws", async () => {
    registerSeam("TerminologyProvider", {
      async lookupBatch() {
        return new Map();
      },
    } as never);
    expect(Object.fromEntries(await m38Icd10Validator(["I50.9"], asOf))).toEqual({
      "I50.9": "unvalidated",
    });
    registerSeam("TerminologyProvider", {
      async lookupBatch() {
        throw new Error("m38 down");
      },
    } as never);
    expect(Object.fromEntries(await m38Icd10Validator(["I50.9"], asOf))).toEqual({
      "I50.9": "unvalidated",
    });
    registerSeam("TerminologyProvider", {} as never);
    expect(Object.fromEntries(await m38Icd10Validator(["I50.9"], asOf))).toEqual({
      "I50.9": "unvalidated",
    });
  });
});
