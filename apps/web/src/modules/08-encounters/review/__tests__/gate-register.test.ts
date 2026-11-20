// WF09 WP3 — the web's mirror of the server's compliance-gate register: which of the thirteen checks the server decides at finalize,
// which at sign, and which nothing decides. The backend's `gate-register-mirror.test.ts` holds this file to gate/checks.ts; these tests
// hold the shape the panel relies on.
import { describe, expect, it } from "vitest";
import { GATE_REGISTER, checksInGroup } from "../gate-register";

describe("the gate register mirror", () => {
  it("lists the thirteen checks once each, in the server's order", () => {
    expect(GATE_REGISTER.map((check) => check.ordinal)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13,
    ]);
    expect(new Set(GATE_REGISTER.map((check) => check.id)).size).toBe(13);
  });

  it("puts the checks the gate evaluates, the late-entry reason (judged before the gate) and the vocabulary version in the finalize group", () => {
    expect(checksInGroup("finalize").map((check) => check.id)).toEqual([
      "required_sections",
      "required_vitals",
      "required_scales",
      "late_entry_ceiling",
      "care_plan_review",
      "vocab_version_pin",
      "draft_sections_resolved",
    ]);
  });

  it("puts what is enforced only when the note is signed in the sign group", () => {
    expect(checksInGroup("sign").map((check) => check.id)).toEqual([
      "step_up_fresh",
      "eligible_cosigner",
      "f2f_attested",
    ]);
  });

  it("says the late-entry reason is judged at finalize, before the other checks, in whole calendar days, and the override at sign", () => {
    const late = GATE_REGISTER.find((check) => check.id === "late_entry_ceiling");
    expect(late?.group).toBe("finalize");
    expect(late?.description).toMatch(/more than 1 calendar day after the visit date/);
    expect(late?.description).toMatch(/when you finalize, before the other checks/);
    expect(late?.description).toMatch(/At sign, a note more than 3 days late/);
    expect(late?.description).toMatch(/more than 14 days late by a director/);
    expect(late?.description).not.toMatch(/24 hours/);
  });

  it("says the face-to-face link must already exist and that signing does not write the record", () => {
    const f2f = GATE_REGISTER.find((check) => check.id === "f2f_attested");
    expect(f2f?.description).toMatch(/already be linked to its face-to-face record/);
    expect(f2f?.description).toMatch(/Signing does not write that record/);
    expect(f2f?.description).not.toMatch(/written together with the signature/);
  });

  it("does not name a scope for the drafted sections that the code does not state", () => {
    const drafted = GATE_REGISTER.find((check) => check.id === "draft_sections_resolved");
    expect(drafted?.description).not.toMatch(/RN routine/);
    expect(drafted?.description).toMatch(/template has a drafted section/);
  });

  it("puts what nothing decides, and what is asked for but not recorded, in the not-checked group", () => {
    expect(checksInGroup("not_checked").map((check) => check.id)).toEqual([
      "required_hope_items",
      "layer2_decisions",
      "attestation_confirmed",
    ]);
    expect(checksInGroup("not_checked").map((check) => check.kind)).toEqual([
      "not_evaluated",
      "not_evaluated",
      "unrecorded",
    ]);
  });

  it("says the server does not record the acknowledgment, and never says it was verified", () => {
    const attestation = GATE_REGISTER.find((check) => check.id === "attestation_confirmed");
    expect(attestation?.description).toMatch(/does not record this acknowledgment/i);
    expect(attestation?.description).not.toMatch(/attested|verified|confirmed/i);
  });

  it("says AI review decisions are not checked because AI enhancement is not available", () => {
    const layer2 = GATE_REGISTER.find((check) => check.id === "layer2_decisions");
    expect(layer2?.description).toMatch(/not available/i);
  });

  it("states each conditional check's condition in its own words", () => {
    const text = (id: string): string =>
      GATE_REGISTER.find((check) => check.id === id)?.description ?? "";
    expect(text("required_vitals")).toMatch(/only/i);
    expect(text("required_scales")).toMatch(/only .*recert/i);
    expect(text("care_plan_review")).toMatch(/only .*active care plan/i);
    expect(text("draft_sections_resolved")).toMatch(/only .*draft/i);
  });

  it("never describes a check as passed", () => {
    for (const check of GATE_REGISTER) {
      expect(`${check.title} ${check.description}`).not.toMatch(
        /\bpass(ed|es)?\b|\bcomplete\b|\bready\b/i,
      );
    }
  });
});
