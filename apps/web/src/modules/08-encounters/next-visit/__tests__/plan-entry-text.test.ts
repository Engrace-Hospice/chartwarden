// The optional structured fields of the Plan and Next Visit section assemble into the note's own sentences, the same way every time, with
// the clinician's words kept exactly as typed. Synthetic text only.
import { describe, expect, it } from "vitest";
import {
  EMPTY_PLAN_ENTRY,
  PLAN_VISIT_BY_OPTIONS,
  appendToFreeText,
  planEntryLines,
  planEntryText,
} from "../plan-entry-text";

describe("planEntryLines", () => {
  it("states nothing for fields left empty", () => {
    expect(planEntryLines(EMPTY_PLAN_ENTRY)).toEqual([]);
    expect(planEntryText(EMPTY_PLAN_ENTRY)).toBe("");
  });

  it("says who the next visit is with and the day, in a fixed date form", () => {
    expect(
      planEntryLines({ ...EMPTY_PLAN_ENTRY, nextVisitBy: "rn", nextVisitDate: "2026-12-05" }),
    ).toEqual(["Next visit: RN, Dec 5, 2026."]);
  });

  it("says the day alone, or who alone, when only one is given", () => {
    expect(planEntryLines({ ...EMPTY_PLAN_ENTRY, nextVisitDate: "2026-12-05" })).toEqual([
      "Next visit: Dec 5, 2026.",
    ]);
    expect(planEntryLines({ ...EMPTY_PLAN_ENTRY, nextVisitBy: "chha" })).toEqual([
      "Next visit: Hospice aide.",
    ]);
  });

  it("leaves out a date that is not a real calendar day rather than stating it", () => {
    expect(planEntryLines({ ...EMPTY_PLAN_ENTRY, nextVisitDate: "2026-02-30" })).toEqual([]);
  });

  it("keeps the clinician's own words exactly, trimmed of the space around them", () => {
    const lines = planEntryLines({
      ...EMPTY_PLAN_ENTRY,
      nextVisitFocus: "  Recheck R heel wound; reassess pain after the dose change.  ",
      followUps: "Call pharmacy re: refill",
      pendingOrders: "Hospital bed requested; awaiting delivery",
      teaching: "Reviewed turning schedule with daughter",
      whenToCall: "New fever, uncontrolled pain, or a fall",
    });
    expect(lines).toEqual([
      "Focus of next visit: Recheck R heel wound; reassess pain after the dose change.",
      "Follow-ups from this visit: Call pharmacy re: refill",
      "Orders and supplies pending: Hospital bed requested; awaiting delivery",
      "Teaching and instructions given: Reviewed turning schedule with daughter",
      "Call the hospice if: New fever, uncontrolled pain, or a fall",
    ]);
  });

  it("orders the lines the same way whatever order the fields were filled in", () => {
    const filled = {
      ...EMPTY_PLAN_ENTRY,
      whenToCall: "w",
      teaching: "t",
      pendingOrders: "o",
      followUps: "f",
      nextVisitFocus: "x",
      nextVisitDate: "2026-01-02",
      nextVisitBy: "msw",
    };
    expect(
      planEntryText(filled)
        .split("\n")
        .map((l) => l.split(":")[0]),
    ).toEqual([
      "Next visit",
      "Focus of next visit",
      "Follow-ups from this visit",
      "Orders and supplies pending",
      "Teaching and instructions given",
      "Call the hospice if",
    ]);
  });

  it("offers a label for every discipline it can name, with no duplicates", () => {
    const values = PLAN_VISIT_BY_OPTIONS.map((o) => o.value);
    expect(new Set(values).size).toBe(values.length);
    expect(values).toEqual(
      expect.arrayContaining(["rn", "lpn", "chha", "msw", "chaplain", "md_np", "volunteer"]),
    );
  });
});

describe("appendToFreeText", () => {
  it("starts the section with the added lines when it was empty", () => {
    expect(appendToFreeText("", "Next visit: RN.")).toBe("Next visit: RN.");
    expect(appendToFreeText("   \n", "Next visit: RN.")).toBe("Next visit: RN.");
  });

  it("adds below what the clinician already wrote, which is left as typed", () => {
    expect(appendToFreeText("Continue current plan.", "Next visit: RN.")).toBe(
      "Continue current plan.\nNext visit: RN.",
    );
  });

  it("does not add the same lines twice", () => {
    const once = appendToFreeText("Continue current plan.", "Next visit: RN.");
    expect(appendToFreeText(once, "Next visit: RN.")).toBe(once);
  });

  it("changes nothing when there is nothing to add", () => {
    expect(appendToFreeText("Continue current plan.", "")).toBe("Continue current plan.");
  });
});
