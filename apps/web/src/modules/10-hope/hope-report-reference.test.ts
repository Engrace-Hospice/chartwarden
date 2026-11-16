import { describe, expect, it } from "vitest";
import {
  MAX_REFERENCE,
  hasForbiddenReferenceCharacter,
  hasForbiddenResultCode,
  hasUnstorableMessage,
  referenceRefusalOf,
} from "./hope-report-reference";

// The mirror of the server's report-reference rule: `^[A-Za-z0-9._:#/-][A-Za-z0-9 ._:#/-]*$`, 1 to 128 characters.

describe("hasForbiddenReferenceCharacter", () => {
  it("states the server's limit", () => {
    expect(MAX_REFERENCE).toBe(128);
  });

  it.each([
    ["letters, digits and the punctuation the server takes", "A-1_b.2:3#4/5"],
    ["spaces inside the value", "REF 1 2"],
    ["a first character that is punctuation", "#1"],
    ["exactly the limit", "a".repeat(128)],
    ["nothing (the reference is optional and then not sent)", ""],
  ])("takes %s", (_name, value) => {
    expect(hasForbiddenReferenceCharacter(value)).toBe(false);
  });

  it.each([
    ["a first character that is a space", " REF"],
    ["a value of spaces only", "   "],
    ["one over the limit", "a".repeat(129)],
    ["markup", "<b>"],
    ["a comma", "a,b"],
    ["a tab", "a\tb"],
    ["a line break", "a\nb"],
    ["an accented letter", "réf"],
  ])("refuses %s", (_name, value) => {
    expect(hasForbiddenReferenceCharacter(value)).toBe(true);
  });
});

// Which refusals are about the report reference: the code alone is not enough, the route screens a result row's tokens with the same
// code (`details[0].field = "results.<i>.<token>"`).
describe("referenceRefusalOf", () => {
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
      "a patient-identifier refusal naming the reference",
      failed("EVIDENCE_LOOKS_LIKE_PHI", { field: "reportReference", code: "X" }),
      "looks_like_phi",
    ],
    [
      "a validation refusal naming the reference",
      failed("VALIDATION_FAILED", { field: "reportReference", code: "INVALID" }),
      "invalid_characters",
    ],
  ])("says so for %s", (_name, refusal, expected) => {
    expect(referenceRefusalOf(refusal)).toBe(expected);
  });

  it.each([
    [
      "a patient-identifier refusal naming a result row's token",
      failed("EVIDENCE_LOOKS_LIKE_PHI", { field: "results.0.code", code: "X" }),
    ],
    ["a patient-identifier refusal naming no field", failed("EVIDENCE_LOOKS_LIKE_PHI")],
    [
      "a validation refusal naming a row",
      failed("VALIDATION_FAILED", { field: "results.1.itemCode", code: "INVALID" }),
    ],
    ["any other refusal", failed("CONFLICT")],
  ])("leaves %s to the server's words", (_name, refusal) => {
    expect(referenceRefusalOf(refusal)).toBeNull();
  });
});

// A row's CMS code and item code: ONE word of letters, digits and `. _ : # -`, up to 64, or empty (HOPE_RESULT_CODE_PATTERN).
describe("hasForbiddenResultCode", () => {
  it.each([
    ["a word", "E123"],
    ["punctuation the server takes", "a.b_c:d#e-f"],
    ["a leading dash (a CMS edit code)", "-3015"],
    ["exactly 64 characters", "a".repeat(64)],
    ["nothing", ""],
  ])("takes %s", (_name, value) => {
    expect(hasForbiddenResultCode(value)).toBe(false);
  });

  it.each([
    ["a space inside", "E 12"],
    ["a slash", "E/12"],
    ["a comma", "E,12"],
    ["a tab", "E\t12"],
    ["a zero-width space", "E\u200b1"],
    ["one over the limit", "a".repeat(65)],
  ])("refuses %s", (_name, value) => {
    expect(hasForbiddenResultCode(value)).toBe(true);
  });
});

// A row's message: prose, but nothing the database cannot store (UNSTORABLE_MESSAGE in hope-reference-screen.ts).
describe("hasUnstorableMessage", () => {
  it.each([
    ["prose", "Reçu (2 avertissements); voir « note »."],
    ["tab, line feed and carriage return", "a\tb\nc\r"],
    ["a surrogate pair", "ok \u{1F44D}"],
    ["nothing", ""],
  ])("takes %s", (_name, value) => {
    expect(hasUnstorableMessage(value)).toBe(false);
  });

  it.each([
    ["a control character", "a\u0001b"],
    ["a NUL", "a\u0000b"],
    ["an escape", "a\u001bb"],
    ["a high surrogate alone", "a\ud83db"],
    ["a low surrogate alone", "a\udc4db"],
  ])("refuses %s", (_name, value) => {
    expect(hasUnstorableMessage(value)).toBe(true);
  });
});
