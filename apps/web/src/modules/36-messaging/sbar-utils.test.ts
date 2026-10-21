import { SBAR_PLATFORM_FLOOR, validateSbar } from "@chartwarden/types";
import { describe, expect, it } from "vitest";
import {
  buildSbarBody,
  defaultSbarUrgency,
  emptySbarValues,
  sbarAllowedInChannel,
  sbarIssuesFromError,
  sbarOfferedInChannel,
} from "./sbar-utils";

const policy = { ...SBAR_PLATFORM_FLOOR, hints: {} };
const filled = (text: string) => ({
  ...emptySbarValues("discipline"),
  sections: { situation: text, background: text, assessment: text, recommendation: text },
});

describe("buildSbarBody", () => {
  it("splits paragraphs on blank lines and keeps single newlines as breaks", () => {
    const body = buildSbarBody(filled("one\ntwo\n\n\nthree"));
    const block = body.doc.content[0];
    expect(block?.type === "sbar" && block.situation).toEqual([
      {
        type: "paragraph",
        content: [
          { type: "text", text: "one" },
          { type: "hardBreak" },
          { type: "text", text: "two" },
        ],
      },
      { type: "paragraph", content: [{ type: "text", text: "three" }] },
    ]);
  });

  it("is valid against the floor when every section has text, REQUIRED when blank", () => {
    expect(validateSbar(buildSbarBody(filled("x")), policy)).toEqual([]);
    const issues = validateSbar(buildSbarBody(filled("  \n ")), policy);
    expect(issues.map((i) => i.code)).toEqual(["REQUIRED", "REQUIRED", "REQUIRED", "REQUIRED"]);
  });
});

describe("channel rules", () => {
  it("defaults urgency by kind", () => {
    expect(defaultSbarUrgency("on_call")).toBe("important");
    expect(defaultSbarUrgency("care_team")).toBe("routine");
  });
  it("refuses announcement and bereavement; a patient-channel policy limits to care_team", () => {
    expect(sbarAllowedInChannel("announcement")).toBe(false);
    expect(sbarAllowedInChannel("bereavement")).toBe(false);
    expect(sbarOfferedInChannel("dm", false)).toBe(true);
    expect(sbarOfferedInChannel("dm", true)).toBe(false);
    expect(sbarOfferedInChannel("care_team", true)).toBe(true);
  });
});

describe("sbarIssuesFromError", () => {
  it("reads sbar.* details and ignores anything else or malformed", () => {
    expect(sbarIssuesFromError(null)).toEqual([]);
    expect(
      sbarIssuesFromError({
        error: {
          details: [
            { field: "sbar.situation", code: "TOO_LONG", message: "m" },
            { field: "body", code: "X", message: "n" },
            null,
          ],
        },
      }),
    ).toEqual([{ field: "sbar.situation", code: "TOO_LONG", message: "m" }]);
  });
});
