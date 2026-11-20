// packages/hearthnote/__tests__/draft-golden.test.ts — golden output of the visit-note draft compiler
// (S1 PR B, ADR-0114). The expected text was written by hand from the corpus phrases; the content hashes
// were computed independently (Python hashlib over the canonical JSON below), so they pin the canonical
// serialization rule and not just "whatever the implementation returns".
import { VOCAB_VERSION } from "@chartwarden/narrative-vocab";
import { describe, expect, it } from "vitest";
import { type Draft, canonicalJson, compileDraft } from "../src/index";
import { AS_OF, DEPS, baseInputs } from "./_draft-fixtures";

const SECTION_ORDER = [
  "chief_concern",
  "vitals_review",
  "assessment",
  "functional_status",
  "nutrition",
  "skin_wounds",
  "symptom_management",
  "interventions",
  "plan",
];

/** A section by id: the template's section list grows (recorded ADL, nutrition and wound sections), so no position is pinned. */
const sectionOf = (draft: Draft, sectionId: string) =>
  draft.sections.find((s) => s.sectionId === sectionId);

describe("compileDraft — golden", () => {
  const draft: Draft = compileDraft(baseInputs(), DEPS);

  it("lists every template section, in template order", () => {
    expect(draft.templateKey).toBe("routine_visit:rn");
    expect(draft.asOf).toBe(AS_OF);
    expect(draft.sections.map((s) => s.sectionId)).toEqual(SECTION_ORDER);
  });

  it("leaves chief_concern empty: it has no automatic source in v1 (VN-D9)", () => {
    expect(sectionOf(draft, "chief_concern")).toEqual({
      sectionId: "chief_concern",
      state: "empty",
      reason: "nothing_to_draft_from",
    });
  });

  it("drafts vitals_review from the visit's vitals", () => {
    expect(sectionOf(draft, "vitals_review")).toEqual({
      sectionId: "vitals_review",
      state: "drafted",
      text: "Blood pressure 118/76 mmHg. Heart rate 72 beats per minute. Respiratory rate 16 breaths per minute. Temperature 98.6 degrees F. Oxygen saturation 98%. Pain score 3 of 10.",
      sourceRefs: [{ kind: "vitals", id: "vitals-1" }],
      part2Derived: false,
      contentHash: "7d5e032444b6f5097e81bef5375045a1a96e9165e7c93f4c6d3579bfbe8c036c",
      corpusVersion: VOCAB_VERSION,
    });
  });

  it("drafts assessment from PPS, then the clinician's own selection", () => {
    expect(sectionOf(draft, "assessment")).toEqual({
      sectionId: "assessment",
      state: "drafted",
      text: "PPS 50%, down from 60% on 2026-11-10. Test Patient One is cardiovascularly stable with no chest pain or palpitations reported.",
      sourceRefs: [{ kind: "scale_reading", id: "scale-pps-2" }],
      part2Derived: false,
      contentHash: "782a5d302f42526e26c8d8106b85c64314fc3a5e9e9b9748a6675df19247f118",
      corpusVersion: VOCAB_VERSION,
    });
  });

  it("drafts symptom_management from ESAS-r readings ordered by label", () => {
    expect(sectionOf(draft, "symptom_management")).toEqual({
      sectionId: "symptom_management",
      state: "drafted",
      text: "ESAS-r pain 4, down from 6 on 2026-11-10. ESAS-r tiredness 5, no earlier reading recorded.",
      sourceRefs: [
        { kind: "scale_reading", id: "scale-esas-pain" },
        { kind: "scale_reading", id: "scale-esas-tiredness" },
      ],
      part2Derived: false,
      contentHash: "8a9c71a71f5187dc57eeb19963ba3be87643bcef324032d107a090ab5499e73b",
      corpusVersion: VOCAB_VERSION,
    });
  });

  it("drafts interventions from care-plan interventions, then medication changes", () => {
    expect(sectionOf(draft, "interventions")).toEqual({
      sectionId: "interventions",
      state: "drafted",
      text: "Care-plan intervention performed: Skin assessment and repositioning schedule review. Morphine sulfate oral solution order was changed on 2026-11-12.",
      sourceRefs: [
        { kind: "care_plan_intervention", id: "intervention-1" },
        { kind: "medication_change", id: "med-change-1" },
      ],
      part2Derived: false,
      contentHash: "f18ee1387bda6f45479e12d8abce4ae43526f1e114894464f7d37965bc02cfe3",
      corpusVersion: VOCAB_VERSION,
    });
  });

  it("drafts plan from care-plan goals ordered by id, with progress only where stated", () => {
    expect(sectionOf(draft, "plan")).toEqual({
      sectionId: "plan",
      state: "drafted",
      text: "Care-plan goal: Caregiver demonstrates safe repositioning. Care-plan goal: Pain controlled at a level the patient finds acceptable; progress: Pain reported at 3 of 10 at the last two visits.",
      sourceRefs: [
        { kind: "care_plan_goal", id: "goal-a" },
        { kind: "care_plan_goal", id: "goal-b" },
      ],
      part2Derived: false,
      contentHash: "04b3f89b3b909bef278d0f97bc010bd0cf41d2e64b015b5ce041c67d94baf6f3",
      corpusVersion: VOCAB_VERSION,
    });
  });

  it("hashes exactly the canonical JSON of {format, part2Derived, sectionId, sourceRefs, text}", () => {
    const seen: string[] = [];
    compileDraft(baseInputs(), {
      sha256Hex: (canonical) => {
        seen.push(canonical);
        return DEPS.sha256Hex(canonical);
      },
    });
    expect(seen).toHaveLength(5);
    expect(seen[0]).toBe(
      '{"format":"hearthnote-draft-section/1","part2Derived":false,"sectionId":"vitals_review","sourceRefs":[{"id":"vitals-1","kind":"vitals"}],"text":"Blood pressure 118/76 mmHg. Heart rate 72 beats per minute. Respiratory rate 16 breaths per minute. Temperature 98.6 degrees F. Oxygen saturation 98%. Pain score 3 of 10."}',
    );
  });
});

describe("canonicalJson — the serialization rule behind contentHash", () => {
  it("sorts object keys by UTF-16 code unit at every depth and keeps array order", () => {
    expect(canonicalJson({ b: 1, a: { d: [3, 1], c: null }, B: true })).toBe(
      '{"B":true,"a":{"c":null,"d":[3,1]},"b":1}',
    );
  });

  it("omits keys whose value is undefined", () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it("NFC-normalizes strings and turns CRLF and CR into LF", () => {
    const decomposed = "Cafe\u0301"; // e + combining acute accent
    const composed = "Caf\u00e9";
    expect(canonicalJson(decomposed)).toBe(JSON.stringify(composed));
    expect(canonicalJson("a\r\nb\rc\nd")).toBe(JSON.stringify("a\nb\nc\nd"));
  });

  it("normalizes keys too, so a decomposed key cannot fork the hash", () => {
    expect(canonicalJson({ "e\u0301": 1 })).toBe(canonicalJson({ "\u00e9": 1 }));
  });

  it("refuses numbers JSON cannot carry and values it cannot order", () => {
    expect(() => canonicalJson(Number.NaN)).toThrow(RangeError);
    expect(() => canonicalJson(Number.POSITIVE_INFINITY)).toThrow(RangeError);
    expect(() => canonicalJson([undefined as never])).toThrow(TypeError);
  });

  it("writes -0 as 0", () => {
    expect(canonicalJson(-0)).toBe("0");
  });
});
