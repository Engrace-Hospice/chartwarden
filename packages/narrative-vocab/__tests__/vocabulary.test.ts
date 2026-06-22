// packages/narrative-vocab/__tests__/vocabulary.test.ts — M8-T05 (spec §2.6, architecture §10.5.2).
// Corpus integrity + lookup helpers for the bounded clinical vocabulary leaf.
import { describe, expect, it } from "vitest";
import {
  VOCABULARY,
  VOCAB_BY_CODE,
  VOCAB_VERSION,
  entriesFor,
  getVocabEntry,
  hasVocabEntry,
} from "../src/index";

describe("narrative-vocab corpus", () => {
  it("pins a semantic version (the D11 selection pin source)", () => {
    expect(VOCAB_VERSION).toMatch(/^narrative-vocab@/);
  });

  it("has unique entry codes", () => {
    const codes = VOCABULARY.map((e) => e.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it("indexes every entry by code", () => {
    expect(VOCAB_BY_CODE.size).toBe(VOCABULARY.length);
    for (const e of VOCABULARY) expect(getVocabEntry(e.code)).toBe(e);
  });

  it("every entry is tagged with ≥1 discipline and ≥1 encounter type", () => {
    for (const e of VOCABULARY) {
      expect(e.disciplines.length).toBeGreaterThan(0);
      expect(e.encounterTypes.length).toBeGreaterThan(0);
    }
  });

  it("observation entries carry a body system; non-observations do not require one", () => {
    for (const e of VOCABULARY) {
      if (e.category === "observation") expect(e.bodySystem).toBeDefined();
    }
  });

  it("hasVocabEntry / getVocabEntry reflect membership", () => {
    expect(hasVocabEntry("nv.cv.stable")).toBe(true);
    expect(hasVocabEntry("nv.nope")).toBe(false);
    expect(getVocabEntry("nv.nope")).toBeUndefined();
  });
});

describe("entriesFor(encounterType, discipline)", () => {
  it("returns only entries tagged for BOTH the type and the discipline", () => {
    const rnRoutine = entriesFor("routine_visit", "rn");
    expect(rnRoutine.length).toBeGreaterThan(0);
    for (const e of rnRoutine) {
      expect(e.encounterTypes).toContain("routine_visit");
      expect(e.disciplines).toContain("rn");
    }
  });

  it("surfaces the F2F attestation only for md/np on a face_to_face", () => {
    expect(entriesFor("face_to_face", "md").some((e) => e.code === "nv.att.f2f")).toBe(true);
    expect(entriesFor("routine_visit", "rn").some((e) => e.code === "nv.att.f2f")).toBe(false);
  });

  it("returns entries in stable corpus order", () => {
    const a = entriesFor("routine_visit", "rn").map((e) => e.code);
    const b = entriesFor("routine_visit", "rn").map((e) => e.code);
    expect(a).toEqual(b);
  });
});
