import { describe, expect, it } from "vitest";
import { MAX_REFERENCE, hasForbiddenReferenceCharacter } from "./hope-report-reference";

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
