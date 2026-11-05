import type { ChartWardenError } from "@chartwarden/types";
import { describe, expect, it } from "vitest";
import {
  EVIDENCE_NOTE_MAX,
  EVIDENCE_REF_MAX,
  normalizeEvidence,
  normalizeReason,
} from "../onboarding/evidence";

const refusal = (fn: () => unknown): ChartWardenError => {
  try {
    fn();
  } catch (e) {
    return e as ChartWardenError;
  }
  throw new Error("expected a refusal");
};

describe("normalizeEvidence", () => {
  it("trims the note and returns a null ref when none is given", () => {
    expect(normalizeEvidence({ evidenceNote: "  signed order form on file  " })).toEqual({
      note: "signed order form on file",
      ref: null,
    });
  });

  it("keeps a trimmed ref", () => {
    expect(normalizeEvidence({ evidenceNote: "ok", evidenceRef: " DOC-1042 " })).toEqual({
      note: "ok",
      ref: "DOC-1042",
    });
  });

  it("treats a blank ref as absent", () => {
    expect(normalizeEvidence({ evidenceNote: "ok", evidenceRef: "   " }).ref).toBeNull();
  });

  it("refuses a missing, blank or non-string note as ONBOARDING_EVIDENCE_REQUIRED (422)", () => {
    for (const evidenceNote of [undefined, "", "    ", 12, null]) {
      const err = refusal(() => normalizeEvidence({ evidenceNote }));
      expect(err.code).toBe("ONBOARDING_EVIDENCE_REQUIRED");
      expect(err.statusCode).toBe(422);
      expect(err.details?.[0]?.field).toBe("evidenceNote");
    }
  });

  it("accepts a note of exactly the maximum length and refuses one over it", () => {
    expect(normalizeEvidence({ evidenceNote: "x".repeat(EVIDENCE_NOTE_MAX) }).note).toHaveLength(
      EVIDENCE_NOTE_MAX,
    );
    const err = refusal(() =>
      normalizeEvidence({ evidenceNote: "x".repeat(EVIDENCE_NOTE_MAX + 1) }),
    );
    expect(err.code).toBe("ONBOARDING_EVIDENCE_INVALID");
    expect(err.statusCode).toBe(422);
  });

  it("measures the note after trimming", () => {
    const padded = ` ${"x".repeat(EVIDENCE_NOTE_MAX)} `;
    expect(normalizeEvidence({ evidenceNote: padded }).note).toHaveLength(EVIDENCE_NOTE_MAX);
  });

  it("refuses a ref over its maximum", () => {
    const err = refusal(() =>
      normalizeEvidence({ evidenceNote: "ok", evidenceRef: "r".repeat(EVIDENCE_REF_MAX + 1) }),
    );
    expect(err.code).toBe("ONBOARDING_EVIDENCE_INVALID");
    expect(err.details?.[0]?.field).toBe("evidenceRef");
  });
});

describe("normalizeReason", () => {
  it("trims and requires at least 8 characters", () => {
    expect(normalizeReason("  customer confirmed by phone  ")).toBe("customer confirmed by phone");
    expect(refusal(() => normalizeReason("short")).code).toBe("ONBOARDING_REASON_REQUIRED");
    expect(refusal(() => normalizeReason("        ")).statusCode).toBe(422);
  });
});
