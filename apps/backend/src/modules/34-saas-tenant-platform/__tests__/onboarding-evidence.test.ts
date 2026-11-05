import type { ChartWardenError } from "@chartwarden/types";
import { describe, expect, it } from "vitest";
import {
  EVIDENCE_NOTE_MAX,
  EVIDENCE_REF_MAX,
  normalizeBlockerReason,
  normalizeEvidence,
  normalizeOptionalNote,
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

describe("control characters and NUL", () => {
  it("rejects NUL as a typed 422 in every free-text field (Postgres text cannot hold it: it would be a 500)", () => {
    const nul = "before\u0000after";
    const cases: Array<[string, () => unknown]> = [
      ["evidenceNote", () => normalizeEvidence({ evidenceNote: nul })],
      ["evidenceRef", () => normalizeEvidence({ evidenceNote: "ok", evidenceRef: nul })],
      ["reason", () => normalizeReason(`a long enough reason ${nul}`)],
      ["note", () => normalizeOptionalNote(nul)],
      ["blockerReason", () => normalizeBlockerReason(`waiting on ${nul}`)],
    ];
    for (const [field, run] of cases) {
      const err = refusal(run);
      expect(err.code).toBe("ONBOARDING_TEXT_INVALID");
      expect(err.statusCode).toBe(422);
      expect(err.details?.[0]?.field).toBe(field);
    }
  });

  it("strips every other control character but keeps tab and newline", () => {
    expect(normalizeEvidence({ evidenceNote: "a\u0007b\r\nc\td\u001be\u007ff" }).note).toBe(
      "ab\nc\tdef",
    );
    expect(normalizeReason("agreed\u0008 with the customer")).toBe("agreed with the customer");
  });

  it("measures length after stripping, so control characters cannot pad a too-short reason", () => {
    expect(refusal(() => normalizeReason("sh\u0007o\u0007r\u0007t")).code).toBe(
      "ONBOARDING_REASON_REQUIRED",
    );
  });
});

describe("patient-identifier screen", () => {
  const SSN = "900-12-3456"; // area 9xx is never issued
  const MBI = "1EG4TE5MK73"; // synthetic registry value

  it("refuses an SSN-shaped value in an evidence note, ref, reason, note or blocker reason", () => {
    const cases: Array<[string, () => unknown]> = [
      ["evidenceNote", () => normalizeEvidence({ evidenceNote: `verified, patient ${SSN}` })],
      ["evidenceRef", () => normalizeEvidence({ evidenceNote: "ok", evidenceRef: SSN })],
      ["reason", () => normalizeReason(`confirmed for beneficiary ${SSN}`)],
      ["note", () => normalizeOptionalNote(`attesting for ${SSN}`)],
      ["blockerReason", () => normalizeBlockerReason(`waiting on ${SSN}`)],
    ];
    for (const [field, run] of cases) {
      const err = refusal(run);
      expect(err.code).toBe("EVIDENCE_LOOKS_LIKE_PHI");
      expect(err.statusCode).toBe(422);
      expect(err.details?.[0]?.field).toBe(field);
    }
  });

  it("refuses an MBI-shaped value", () => {
    expect(refusal(() => normalizeEvidence({ evidenceNote: `MBI ${MBI} checked` })).code).toBe(
      "EVIDENCE_LOOKS_LIKE_PHI",
    );
  });

  it("says why in plain words and never echoes the value back", () => {
    const err = refusal(() => normalizeEvidence({ evidenceNote: `patient ${SSN}` }));
    expect(err.message).toMatch(/patient|identifier/i);
    expect(err.message).not.toContain(SSN);
    expect(JSON.stringify(err.details)).not.toContain(SSN);
  });
});

describe("normalizeReason bounds and normalizeOptionalNote", () => {
  it("takes the field's own maximum", () => {
    expect(normalizeReason("r".repeat(500), { max: 500 })).toHaveLength(500);
    expect(refusal(() => normalizeReason("r".repeat(501), { max: 500 })).code).toBe(
      "ONBOARDING_REASON_REQUIRED",
    );
  });

  it("names the field it was given in the refusal", () => {
    const err = refusal(() => normalizeReason("short", { field: "skipRationale" }));
    expect(err.details?.[0]?.field).toBe("skipRationale");
  });

  it("an optional note is null when absent or blank, trimmed otherwise, and bounded", () => {
    expect(normalizeOptionalNote(undefined)).toBeNull();
    expect(normalizeOptionalNote("   ")).toBeNull();
    expect(normalizeOptionalNote("  all checks reviewed  ")).toBe("all checks reviewed");
    expect(refusal(() => normalizeOptionalNote("n".repeat(2001))).code).toBe(
      "ONBOARDING_EVIDENCE_INVALID",
    );
  });

  it("a blocker reason is required (5 to 1000 characters)", () => {
    expect(normalizeBlockerReason("  waiting on the customer  ")).toBe("waiting on the customer");
    expect(refusal(() => normalizeBlockerReason("abc")).code).toBe("ONBOARDING_REASON_REQUIRED");
  });
});
