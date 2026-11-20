import { VOCAB_VERSION } from "@chartwarden/narrative-vocab";
// packages/hearthnote/__tests__/assembly.test.ts — M8-T05 (spec §2.6, architecture §10.5.2).
// Layer-1 deterministic core: byte-identical assembly, template-order rendering, verbatim free-text,
// numeric-direct interpolation, and the D11 vocab-pin / legal-pair / unknown-code guards.
import { describe, expect, it } from "vitest";
import {
  type AssemblyContext,
  HearthnoteAssemblyError,
  NOTE_BLOCK_SEPARATOR,
  type SelectionState,
  assemble,
  assembleBlocks,
  assembleLayer1,
  joinBlocks,
  missingRequiredSections,
  resolveTemplate,
} from "../src/index";

const CONTEXT: AssemblyContext = {
  patient: "Jane Doe",
  serviceDate: "2026-06-21",
  location: "patient residence",
};

/** A routine RN visit selection (valid corpus codes, pinned to the active version). */
function rnRoutineSelection(overrides: Partial<SelectionState> = {}): SelectionState {
  return {
    templateKey: "routine_visit:rn",
    vocabVersion: VOCAB_VERSION,
    encounterType: "routine_visit",
    discipline: "rn",
    sections: [
      {
        sectionId: "chief_concern",
        entries: [],
        freeText: "Routine scheduled visit per care plan.",
      },
      {
        sectionId: "assessment",
        entries: [{ code: "nv.cv.stable" }, { code: "nv.resp.unlabored" }],
      },
      {
        sectionId: "symptom_management",
        entries: [{ code: "nv.sym.pain_controlled", params: { pain_score: 2 } }],
      },
      {
        sectionId: "plan",
        entries: [],
        freeText: "Continue current plan; RN to revisit in one week.",
      },
    ],
    ...overrides,
  };
}

describe("assembleLayer1 — deterministic core", () => {
  const template = resolveTemplate("routine_visit", "rn")!;

  it("renders sections in TEMPLATE order, omitting empty sections", () => {
    const { narrative, sectionsAssembled } = assembleLayer1(
      template,
      rnRoutineSelection(),
      CONTEXT,
    );
    expect(sectionsAssembled).toEqual([
      "chief_concern",
      "assessment",
      "symptom_management",
      "plan",
    ]);
    expect(narrative).toBe(
      [
        "Reason for Visit\nRoutine scheduled visit per care plan.",
        "Assessment\nJane Doe is cardiovascularly stable with no chest pain or palpitations reported. Jane Doe's respirations are unlabored and lung sounds are clear to auscultation.",
        "Symptom Management\nJane Doe's pain is well controlled at 2 of 10 on the current medication regimen.",
        "Plan and Next Visit\nContinue current plan; RN to revisit in one week.",
      ].join("\n\n"),
    );
  });

  it("is byte-identical across repeated runs (same inputs → same bytes)", () => {
    const a = assembleLayer1(template, rnRoutineSelection(), CONTEXT).narrative;
    const b = assembleLayer1(template, rnRoutineSelection(), CONTEXT).narrative;
    expect(a).toBe(b);
  });

  it("renders in template order regardless of selection order", () => {
    const reordered = rnRoutineSelection({
      sections: [...rnRoutineSelection().sections].reverse(),
    });
    expect(assembleLayer1(template, reordered, CONTEXT).sectionsAssembled).toEqual([
      "chief_concern",
      "assessment",
      "symptom_management",
      "plan",
    ]);
  });

  it("preserves clinician free-text verbatim (no grammar applied)", () => {
    const verbatim = "pt's spouse asked about respite — referred to MSW.";
    const sel = rnRoutineSelection({
      sections: [{ sectionId: "chief_concern", entries: [], freeText: verbatim }],
    });
    expect(assembleLayer1(template, sel, CONTEXT).narrative).toBe(`Reason for Visit\n${verbatim}`);
  });

  it("interpolates numeric-direct vitals from context (never paraphrased)", () => {
    const sel = rnRoutineSelection({
      sections: [{ sectionId: "assessment", entries: [{ code: "nv.resp.dyspnea" }] }],
    });
    const ctx: AssemblyContext = { ...CONTEXT, vitals: { o2_lpm: 2 } };
    expect(assembleLayer1(template, sel, ctx).narrative).toContain("oxygen at 2 L/min");
  });

  it("entry params override context for slot collisions", () => {
    const sel = rnRoutineSelection({
      sections: [
        {
          sectionId: "symptom_management",
          entries: [{ code: "nv.sym.pain_controlled", params: { pain_score: 7 } }],
        },
      ],
    });
    expect(assembleLayer1(template, sel, CONTEXT).narrative).toContain("controlled at 7 of 10");
  });

  it("throws UNKNOWN_VOCAB_CODE for a code outside the corpus", () => {
    const sel = rnRoutineSelection({
      sections: [{ sectionId: "assessment", entries: [{ code: "nv.bogus" }] }],
    });
    expect(() => assembleLayer1(template, sel, CONTEXT)).toThrowError(HearthnoteAssemblyError);
    try {
      assembleLayer1(template, sel, CONTEXT);
    } catch (e) {
      expect((e as HearthnoteAssemblyError).code).toBe("UNKNOWN_VOCAB_CODE");
    }
  });
});

describe("assemble — resolves + guards", () => {
  it("assembles a valid selection via its own pair", () => {
    expect(assemble(rnRoutineSelection(), CONTEXT).narrative.length).toBeGreaterThan(0);
  });

  it("throws VOCAB_VERSION_MISMATCH when the pin is stale (D11)", () => {
    const sel = rnRoutineSelection({ vocabVersion: "narrative-vocab@1900.01.0" });
    try {
      assemble(sel, CONTEXT);
      throw new Error("expected throw");
    } catch (e) {
      expect((e as HearthnoteAssemblyError).code).toBe("VOCAB_VERSION_MISMATCH");
    }
  });

  it("throws TEMPLATE_KEY_MISMATCH when templateKey disagrees with the pair", () => {
    const sel = rnRoutineSelection({ templateKey: "telephonic:rn" });
    try {
      assemble(sel, CONTEXT);
      throw new Error("expected throw");
    } catch (e) {
      expect((e as HearthnoteAssemblyError).code).toBe("TEMPLATE_KEY_MISMATCH");
    }
  });

  it("throws TEMPLATE_NOT_FOUND for an illegal pair", () => {
    const sel = rnRoutineSelection({
      templateKey: "face_to_face:rn",
      encounterType: "face_to_face",
      discipline: "rn",
    });
    try {
      assemble(sel, CONTEXT);
      throw new Error("expected throw");
    } catch (e) {
      expect((e as HearthnoteAssemblyError).code).toBe("TEMPLATE_NOT_FOUND");
    }
  });
});

describe("missingRequiredSections — Layer-3 check-1 input", () => {
  const template = resolveTemplate("routine_visit", "rn")!;

  it("lists required sections with no populated selection", () => {
    const sel = rnRoutineSelection({
      sections: [{ sectionId: "assessment", entries: [{ code: "nv.cv.stable" }] }],
    });
    const missing = missingRequiredSections(template, sel);
    expect(missing).toContain("chief_concern");
    expect(missing).toContain("plan");
    expect(missing).not.toContain("assessment");
  });

  it("counts a free-text-only section as populated", () => {
    const sel = rnRoutineSelection({
      sections: [{ sectionId: "chief_concern", entries: [], freeText: "Per plan." }],
    });
    expect(missingRequiredSections(template, sel)).not.toContain("chief_concern");
  });
});

describe("assembleBlocks / joinBlocks — the section blocks Layer 1 joins (ADR-0114 sealing)", () => {
  const template = resolveTemplate("routine_visit", "rn")!;

  it("joining the blocks is exactly the Layer-1 narrative, and each block is a heading and its body", () => {
    const blocks = assembleBlocks(template, rnRoutineSelection(), CONTEXT);
    expect(blocks.map((b) => b.sectionId)).toEqual([
      "chief_concern",
      "assessment",
      "symptom_management",
      "plan",
    ]);
    expect(blocks[0]?.text).toBe("Reason for Visit\nRoutine scheduled visit per care plan.");
    expect(joinBlocks(blocks)).toBe(
      assembleLayer1(template, rnRoutineSelection(), CONTEXT).narrative,
    );
    expect(blocks.map((b) => b.text).join(NOTE_BLOCK_SEPARATOR)).toBe(joinBlocks(blocks));
  });

  it("a body override replaces the rendered selection of that section only, even where the clinician selected nothing", () => {
    const blocks = assembleBlocks(template, rnRoutineSelection(), CONTEXT, {
      plan: "Drafted plan text.",
      interventions: "Drafted interventions text.",
    });
    const byId = new Map(blocks.map((b) => [b.sectionId, b.text]));
    expect(byId.get("plan")).toBe("Plan and Next Visit\nDrafted plan text.");
    expect(byId.get("interventions")).toBe("Interventions\nDrafted interventions text.");
    expect(byId.get("chief_concern")).toBe(
      "Reason for Visit\nRoutine scheduled visit per care plan.",
    );
    // template order, not selection or override order
    expect(blocks.map((b) => b.sectionId)).toEqual([
      "chief_concern",
      "assessment",
      "symptom_management",
      "interventions",
      "plan",
    ]);
  });

  it("an empty override body omits the section like an empty selection does", () => {
    const blocks = assembleBlocks(template, rnRoutineSelection(), CONTEXT, { plan: "" });
    expect(blocks.map((b) => b.sectionId)).not.toContain("plan");
  });
});
