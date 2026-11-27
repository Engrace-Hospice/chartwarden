import type { VisitPurpose } from "@chartwarden/types";
import { describe, expect, it } from "vitest";
import {
  LEGAL_VISIT_PAIRING_KEYS,
  classifyVisitPairing,
  isLegalVisitPairing,
  legalDisciplinesForPurpose,
} from "../src/pairing";
import { type SchedulingDiscipline, VISIT_PURPOSE_DISCIPLINES } from "../src/policy";

const none: readonly SchedulingDiscipline[] = [];
const base = {
  status: "published",
  purpose: "recert" as VisitPurpose,
  stampedDiscipline: "np",
  assigneeActive: true,
  heldDisciplines: none,
  credentialedDisciplines: none,
};

describe("legal pairing (CW-PI-04)", () => {
  it("accepts a pair the gate and M8 both allow and refuses the old NP recert", () => {
    expect(isLegalVisitPairing("recert", "rn")).toBe(true);
    expect(isLegalVisitPairing("recert", "np")).toBe(false);
    expect(isLegalVisitPairing("f2f", "md")).toBe(true);
  });

  it("refuses a legacy or unknown stamped value", () => {
    expect(isLegalVisitPairing("routine_visit", "RN")).toBe(false);
    expect(isLegalVisitPairing("routine_visit", "")).toBe(false);
    expect(isLegalVisitPairing("not_a_purpose" as VisitPurpose, "rn")).toBe(false);
  });

  it("refuses a discipline with an M8 pair that the purpose's gate does not accept", () => {
    // routine_visit is legal for lpn in M8, but discharge_visit lists rn only.
    expect(isLegalVisitPairing("discharge_visit", "lpn")).toBe(false);
  });

  it("never lists pa and gives every purpose at least one legal discipline", () => {
    for (const purpose of Object.keys(VISIT_PURPOSE_DISCIPLINES) as VisitPurpose[]) {
      expect(legalDisciplinesForPurpose(purpose).length).toBeGreaterThan(0);
      expect(legalDisciplinesForPurpose(purpose)).not.toContain("pa");
    }
    expect(LEGAL_VISIT_PAIRING_KEYS).toContain("recert:rn");
    expect(LEGAL_VISIT_PAIRING_KEYS).not.toContain("recert:np");
  });
});

describe("classifyVisitPairing (CW-PI-04)", () => {
  it("leaves a legal visit alone whatever its state", () => {
    expect(classifyVisitPairing({ ...base, stampedDiscipline: "rn", status: "completed" })).toEqual(
      { kind: "legal" },
    );
  });

  it("re-stamps an open visit to the single legal discipline its own clinician holds and is credentialed for", () => {
    expect(
      classifyVisitPairing({
        ...base,
        heldDisciplines: ["np", "rn"],
        credentialedDisciplines: ["np", "rn"],
      }),
    ).toEqual({ kind: "restamp", toDiscipline: "rn" });
  });

  it("re-stamps a proposed visit too", () => {
    expect(
      classifyVisitPairing({
        ...base,
        status: "proposed",
        heldDisciplines: ["rn"],
        credentialedDisciplines: ["rn"],
      }),
    ).toEqual({ kind: "restamp", toDiscipline: "rn" });
  });

  it("flags an assignee whose membership is no longer active instead of re-stamping", () => {
    expect(
      classifyVisitPairing({
        ...base,
        assigneeActive: false,
        heldDisciplines: ["rn"],
        credentialedDisciplines: ["rn"],
      }),
    ).toEqual({ kind: "review", reason: "ASSIGNEE_NOT_ACTIVE" });
  });

  it("flags a clinician who holds no legal discipline", () => {
    expect(
      classifyVisitPairing({ ...base, heldDisciplines: ["np"], credentialedDisciplines: ["np"] }),
    ).toEqual({ kind: "review", reason: "NO_LEGAL_DISCIPLINE_HELD" });
  });

  it("flags a legal discipline the clinician is not credentialed for", () => {
    expect(
      classifyVisitPairing({ ...base, heldDisciplines: ["rn"], credentialedDisciplines: [] }),
    ).toEqual({ kind: "review", reason: "LEGAL_DISCIPLINE_NOT_CREDENTIALED" });
  });

  it("never breaks a tie between two legal credentialed disciplines", () => {
    // routine_visit is legal for rn and lpn; the policy order is not a reason to pick one.
    expect(
      classifyVisitPairing({
        ...base,
        purpose: "routine_visit",
        stampedDiscipline: "np",
        heldDisciplines: ["rn", "lpn"],
        credentialedDisciplines: ["rn", "lpn"],
      }),
    ).toEqual({ kind: "review", reason: "AMBIGUOUS_LEGAL_DISCIPLINES" });
  });

  it("is unambiguous when only one of two legal disciplines is credentialed", () => {
    expect(
      classifyVisitPairing({
        ...base,
        purpose: "routine_visit",
        stampedDiscipline: "np",
        heldDisciplines: ["rn", "lpn"],
        credentialedDisciplines: ["lpn"],
      }),
    ).toEqual({ kind: "restamp", toDiscipline: "lpn" });
  });

  it("treats an NP on a HOPE visit as illegal: M8 seeds routine_visit, whose authors are RN and LPN", () => {
    expect(isLegalVisitPairing("huv1", "np")).toBe(false);
    expect(isLegalVisitPairing("huv1", "rn")).toBe(true);
    expect(isLegalVisitPairing("sfv", "np")).toBe(false);
    expect(isLegalVisitPairing("sfv", "lpn")).toBe(true);
  });

  it("flags a visit in progress and reports terminal visits as history", () => {
    const facts = {
      ...base,
      heldDisciplines: ["rn"] as const,
      credentialedDisciplines: ["rn"] as const,
    };
    expect(classifyVisitPairing({ ...facts, status: "en_route" })).toEqual({
      kind: "review",
      reason: "VISIT_IN_PROGRESS",
    });
    expect(classifyVisitPairing({ ...facts, status: "in_visit" })).toEqual({
      kind: "review",
      reason: "VISIT_IN_PROGRESS",
    });
    for (const status of ["completed", "cancelled", "no_show", "rescheduled"]) {
      expect(classifyVisitPairing({ ...facts, status })).toEqual({ kind: "historical" });
    }
  });
});
