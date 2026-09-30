/**
 * F-214 (#251) — the PURE 42 CFR Part 2 gate on M7's claim-diagnosis read. No database: the consent verdict is
 * an input, so every gate rule is pinned exactly (withholding, re-ranking, terminal handling, same-code twin,
 * the 12-position cap applying AFTER withholding). The live proof against real consent rows is
 * `f214-claim-diagnoses-part2-consent.live.test.ts`.
 */
import { describe, expect, it } from "vitest";
import {
  type ClaimDiagnosisCandidate,
  applyPart2ClaimGate,
  needsPart2Decision,
} from "../src/modules/07-care-plan/seams/claim-diagnoses-gate";

const row = (
  code: string,
  kind: ClaimDiagnosisCandidate["kind"],
  sudRelated = false,
): ClaimDiagnosisCandidate => ({ code, kind, sudRelated });

describe("F-214 — applyPart2ClaimGate", () => {
  const ROWS = [
    row("C34.90", "terminal"),
    row("F11.20", "related", true), // SUD
    row("J44.9", "related"),
    row("I10", "unrelated"),
  ];

  it("consent allowed: SUD code included, ranked like any other", () => {
    const r = applyPart2ClaimGate(ROWS, true);
    expect(r.sequence.map((d) => d.code)).toEqual(["C34.90", "F11.20", "J44.9", "I10"]);
    expect(r.withheldForConsentCount).toBe(0);
    expect(r.terminalWithheldForConsent).toBe(false);
  });

  it("consent denied: SUD code omitted, positions re-ranked contiguously, count reported (no codes)", () => {
    const r = applyPart2ClaimGate(ROWS, false);
    expect(r.sequence).toEqual([
      { position: 1, code: "C34.90", relationship: "terminal" },
      { position: 2, code: "J44.9", relationship: "related" },
      { position: 3, code: "I10", relationship: "unrelated" },
    ]);
    expect(r.withheldForConsentCount).toBe(1);
    expect(r.terminalWithheldForConsent).toBe(false);
    expect(JSON.stringify(r)).not.toContain("F11.20");
  });

  it("a withheld TERMINAL is not replaced: the next diagnosis keeps its own relationship (never promoted)", () => {
    const r = applyPart2ClaimGate(
      [row("F11.20", "terminal", true), row("J44.9", "related"), row("I10", "unrelated")],
      false,
    );
    expect(r.terminalWithheldForConsent).toBe(true);
    expect(r.withheldForConsentCount).toBe(1);
    expect(r.sequence).toEqual([
      { position: 1, code: "J44.9", relationship: "related" },
      { position: 2, code: "I10", relationship: "unrelated" },
    ]);
    // No position is `terminal`, so terminal-only line pointers are empty and icd10_sequencing fails.
    expect(r.sequence.some((d) => d.relationship === "terminal")).toBe(false);
  });

  it("a same-code non-SUD twin cannot smuggle the protected code out", () => {
    const r = applyPart2ClaimGate(
      [
        row("C34.90", "terminal"),
        row("F11.20", "related", true),
        row("F11.20", "unrelated", false),
      ],
      false,
    );
    expect(r.sequence.map((d) => d.code)).toEqual(["C34.90"]);
    expect(r.withheldForConsentCount).toBe(1); // one distinct code
  });

  it("withholds every distinct SUD code and counts each once", () => {
    const r = applyPart2ClaimGate(
      [
        row("C34.90", "terminal"),
        row("F11.20", "related", true),
        row("F10.20", "related", true),
        row("F11.20", "unrelated", true),
      ],
      false,
    );
    expect(r.withheldForConsentCount).toBe(2);
    expect(r.sequence.map((d) => d.code)).toEqual(["C34.90"]);
  });

  it("the 12-position cap applies AFTER withholding (a withheld code does not consume a slot)", () => {
    const rows = [
      row("C34.90", "terminal"),
      row("F11.20", "related", true),
      ...Array.from({ length: 13 }, (_, i) => row(`R${10 + i}.0`, "related")),
    ];
    const denied = applyPart2ClaimGate(rows, false);
    expect(denied.sequence).toHaveLength(12);
    expect(denied.sequence.map((d) => d.position)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(denied.sequence.at(-1)?.code).toBe("R20.0");
    const allowed = applyPart2ClaimGate(rows, true);
    expect(allowed.sequence).toHaveLength(12);
    expect(allowed.sequence.some((d) => d.code === "F11.20")).toBe(true);
  });

  it("no SUD rows: consent verdict is irrelevant and nothing is withheld", () => {
    const plain = [row("C34.90", "terminal"), row("J44.9", "related")];
    expect(needsPart2Decision(plain)).toBe(false);
    expect(applyPart2ClaimGate(plain, false)).toEqual(applyPart2ClaimGate(plain, true));
    expect(needsPart2Decision(ROWS)).toBe(true);
  });
});
