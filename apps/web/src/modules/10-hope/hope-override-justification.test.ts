import { describe, expect, it } from "vitest";
import {
  OVERRIDE_JUSTIFICATION_MAX,
  OVERRIDE_JUSTIFICATION_MIN,
  justificationLengthOk,
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
