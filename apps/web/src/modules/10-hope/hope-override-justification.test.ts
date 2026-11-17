import { describe, expect, it } from "vitest";
import {
  OVERRIDE_JUSTIFICATION_MAX,
  OVERRIDE_JUSTIFICATION_MIN,
  justificationLengthOk,
  justificationRefusalOf,
} from "./hope-override-justification";

// The mirror of the server's length rule: the minimum is measured after each run of Unicode White_Space collapses to one space (so
// no-break spaces and line separators cannot pad it), the maximum on the trimmed text as it is.

const NBSP = "\u00a0";
const LINE_SEPARATOR = "\u2028";
const PARAGRAPH_SEPARATOR = "\u2029";
const IDEOGRAPHIC_SPACE = "\u3000";
const run = (c: string, n = 8) => c.repeat(n);

describe("justificationLengthOk", () => {
  it("states the server's bounds", () => {
    expect([OVERRIDE_JUSTIFICATION_MIN, OVERRIDE_JUSTIFICATION_MAX]).toEqual([20, 1000]);
  });

  it.each([
    ["exactly twenty characters", "Outage delayed entry"],
    ["twenty after a run of spaces collapses", "Outage   delayed    entry"],
    ["twenty after a run of no-break spaces collapses", `Outage${run(NBSP)}delayed entry`],
    ["a thousand characters", "a".repeat(1000)],
  ])("takes %s", (_name, text) => {
    expect(justificationLengthOk(text)).toBe(true);
  });

  it.each([
    ["nothing", ""],
    ["nineteen characters", "Outage delayed entr"],
    ["nineteen visible characters padded with spaces", "Outage     delayed    entr"],
    ["nineteen visible characters padded with no-break spaces", `Outage${run(NBSP)}delayed entr`],
    [
      "nineteen padded with line and paragraph separators",
      `Outage${run(LINE_SEPARATOR)}delayed${run(PARAGRAPH_SEPARATOR)}entr`,
    ],
    ["nineteen padded with tabs and line breaks", "Outage\t\t\t\ndelayed\r\n\r\nentr"],
    ["nineteen padded with ideographic spaces", `Outage${run(IDEOGRAPHIC_SPACE)}delayed entr`],
    ["a thousand and one characters", "a".repeat(1001)],
  ])("refuses %s", (_name, text) => {
    expect(justificationLengthOk(text)).toBe(false);
  });
});

// The patient-identifier screen answers with the same code for whatever field it screened: only the justification's own field is the
// justification's refusal.
describe("justificationRefusalOf", () => {
  const failed = (code: string | null, invalidField?: { field: string; code: string | null }) =>
    ({
      ok: false,
      status: 422,
      message: "m",
      code,
      ...(invalidField ? { invalidField } : {}),
    }) as const;

  it.each([
    [
      "a patient-identifier refusal naming the justification",
      failed("EVIDENCE_LOOKS_LIKE_PHI", { field: "adminOverrideJustification", code: "X" }),
      "looks_like_phi",
    ],
    [
      "invalid characters in the justification",
      failed("VALIDATION_FAILED", {
        field: "adminOverrideJustification",
        code: "INVALID_CHARACTERS",
      }),
      "invalid_characters",
    ],
    [
      "another objection to the justification",
      failed("VALIDATION_FAILED", { field: "adminOverrideJustification", code: "TOO_SHORT" }),
      "not_accepted",
    ],
  ])("says so for %s", (_name, refusal, expected) => {
    expect(justificationRefusalOf(refusal)).toBe(expected);
  });

  it.each([
    [
      "a patient-identifier refusal naming another field",
      failed("EVIDENCE_LOOKS_LIKE_PHI", { field: "somethingElse", code: "X" }),
    ],
    ["a patient-identifier refusal naming no field", failed("EVIDENCE_LOOKS_LIKE_PHI")],
    ["any other refusal", failed("CONFLICT")],
  ])("leaves %s to the server's words", (_name, refusal) => {
    expect(justificationRefusalOf(refusal)).toBeNull();
  });
});
