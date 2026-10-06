// GAP-036 follow-up — the allergy gate's verdict (class/brand matching + acknowledgement inputs), and the
// override authorization rule, proven without a database.
import { describe, expect, it, vi } from "vitest";
import {
  ALLERGY_OVERRIDE_MIN_REASON_LENGTH,
  allergyGateError,
  evaluateAllergyGate,
  resolveAllergyOverride,
} from "../src/modules/12-dosespot/medication-order-safety-gates";

const ORG = "org-1";
const PAT = "pat-1";
const reader = (rows: unknown) => ({ activeAllergies: vi.fn(async () => rows as never) });
const gate = (rows: unknown, drugName = "Morphine") =>
  evaluateAllergyGate({
    organizationId: ORG,
    patientId: PAT,
    drugName,
    resolveReader: () => reader(rows),
  });
const row = (allergenText: string, severity: "mild" | "severe" | null = null) => ({
  allergenText,
  verificationStatus: "verified" as const,
  severity,
});

describe("evaluateAllergyGate", () => {
  it("is clear for an empty list", async () => {
    expect(await gate([])).toEqual({ status: "clear" });
  });
  it("catches a class allergy ('opioids' vs morphine)", async () => {
    const r = await gate([row("opioids")]);
    expect(r).toMatchObject({
      status: "conflict",
      matches: [{ kind: "class", classId: "opioid", label: "opioid", severity: null }],
    });
  });
  it("catches a brand name ordered against a generic allergy", async () => {
    expect((await gate([row("Morphine")], "MS Contin 15 mg")).status).toBe("conflict");
  });
  it("catches penicillin -> cephalosporin cross-reactivity", async () => {
    const r = await gate([row("penicillin", "severe")], "Ceftriaxone");
    expect(r).toMatchObject({
      status: "conflict",
      matches: [{ kind: "cross_reactive", classId: "cephalosporin", severity: "severe" }],
    });
  });
  it("collects every matching allergy", async () => {
    const r = await gate([row("opioids"), row("Morphine"), row("latex")]);
    expect(r.status === "conflict" && r.matches.length).toBe(2);
  });
  it("an unrelated allergy is clear", async () => {
    expect(await gate([row("penicillin")])).toEqual({ status: "clear" });
  });
  it("is unreadable (never clear) for null, a throw, a malformed list or a blank drug", async () => {
    expect(await gate(null)).toEqual({ status: "unreadable" });
    expect(await gate("nope")).toEqual({ status: "unreadable" });
    expect(await gate([], "  ")).toEqual({ status: "unreadable" });
    expect(
      await evaluateAllergyGate({
        organizationId: ORG,
        patientId: PAT,
        drugName: "Morphine",
        resolveReader: () => {
          throw new Error("M5 down");
        },
      }),
    ).toEqual({ status: "unreadable" });
  });
  it("a malformed row fails closed rather than being skipped", async () => {
    expect(await gate([{ allergenText: 42 }])).toEqual({ status: "unreadable" });
  });
});

describe("resolveAllergyOverride", () => {
  const conflict = {
    status: "conflict" as const,
    matches: [{ kind: "class" as const, classId: "opioid", label: "opioid", severity: null }],
  };
  const reason = "x".repeat(ALLERGY_OVERRIDE_MIN_REASON_LENGTH);

  it("no conflict -> nothing to override", () => {
    expect(resolveAllergyOverride({ status: "clear" }, undefined)).toEqual({
      outcome: "proceed",
      override: null,
    });
  });
  it("conflict without a reason is refused with the acknowledgement hint", () => {
    expect(resolveAllergyOverride(conflict, undefined)).toEqual({
      outcome: "blocked",
      gate: conflict,
    });
  });
  it("conflict + reason + fresh step-up proceeds and records the override", () => {
    expect(resolveAllergyOverride(conflict, { reason, stepUpFresh: true })).toEqual({
      outcome: "proceed",
      override: { reason, matches: conflict.matches },
    });
  });
  it("conflict + reason but stale step-up is a step-up refusal, not a pass", () => {
    expect(resolveAllergyOverride(conflict, { reason, stepUpFresh: false })).toEqual({
      outcome: "step_up_required",
    });
  });
  it("a too-short or blank reason does not count as an acknowledgement", () => {
    expect(resolveAllergyOverride(conflict, { reason: "short", stepUpFresh: true }).outcome).toBe(
      "blocked",
    );
    expect(
      resolveAllergyOverride(conflict, { reason: " ".repeat(40), stepUpFresh: true }).outcome,
    ).toBe("blocked");
  });
  it("an unreadable list can never be overridden", () => {
    expect(resolveAllergyOverride({ status: "unreadable" }, { reason, stepUpFresh: true })).toEqual(
      {
        outcome: "unreadable",
      },
    );
  });
});

describe("allergyGateError", () => {
  it("is a 422 ALLERGY_CHECK_NOT_PASSED naming the class without echoing allergy text", () => {
    const err = allergyGateError({
      status: "conflict",
      matches: [{ kind: "class", classId: "opioid", label: "opioid", severity: "severe" }],
    });
    expect(err.statusCode).toBe(422);
    expect(err.code).toBe("ALLERGY_CHECK_NOT_PASSED");
    expect(err.message).toContain("opioid");
    expect(err.message).toMatch(/acknowledg/i);
    expect(err.details?.[0]).toMatchObject({
      field: "allergyOverrideReason",
      code: "ACKNOWLEDGEMENT_REQUIRED",
    });
  });
  it("an unreadable list is the same code with NO acknowledgement offered", () => {
    const err = allergyGateError({ status: "unreadable" });
    expect(err.code).toBe("ALLERGY_CHECK_NOT_PASSED");
    expect(err.message).not.toMatch(/acknowledg/i);
  });
});
