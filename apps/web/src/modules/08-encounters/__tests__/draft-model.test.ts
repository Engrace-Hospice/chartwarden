// The pure rules behind the visit-note draft screens (ADR-0114): which sections count as drafted, which need the clinician, how the
// server's refusals read, and the score trend. Synthetic data only.
import { describe, expect, it } from "vitest";
import type { DraftSectionView, DraftView } from "../draft-api";
import {
  describeChange,
  describeIssues,
  draftGateRefusal,
  draftIsActive,
  draftIssuesFrom,
  draftedStateOf,
  isDraftSectionView,
  replaceSection,
  resolutionNote,
  reviewCounts,
  signStaleMessage,
  touchesCarePlan,
  trendOf,
  trendWindow,
} from "../draft-model";

const section = (over: Partial<DraftSectionView> = {}): DraftSectionView => ({
  sectionId: "plan",
  state: "unresolved",
  text: "Goal: comfort at rest.",
  contentHash: "hash-1",
  corpusVersion: "2026.1.0",
  part2Derived: false,
  origins: ["care_plan_goal"],
  ...over,
});

const EMPTY: DraftSectionView = {
  sectionId: "chief_concern",
  state: "not_drafted",
  text: null,
  contentHash: null,
  corpusVersion: null,
  part2Derived: null,
  origins: [],
};

const draftOf = (...sections: DraftSectionView[]): DraftView => ({
  encounterId: "enc-1",
  patientId: "pat-1",
  templateKey: "routine_visit:rn",
  asOf: "2026-11-17T23:59:59.999Z",
  sections,
});

describe("draftIsActive", () => {
  it("is false with no draft, and with a draft that has nothing drafted", () => {
    expect(draftIsActive(null)).toBe(false);
    expect(draftIsActive(draftOf(EMPTY))).toBe(false);
    expect(draftIsActive(draftOf())).toBe(false);
  });

  it("is true as soon as one section is drafted, whatever its state", () => {
    expect(draftIsActive(draftOf(EMPTY, section({ state: "deselected" })))).toBe(true);
  });
});

describe("reviewCounts", () => {
  it("counts drafted sections, the resolved ones, and lists those that still need the clinician", () => {
    const draft = draftOf(
      EMPTY,
      section({ sectionId: "plan", state: "confirmed" }),
      section({ sectionId: "interventions", state: "deselected" }),
      section({ sectionId: "assessment", state: "unresolved" }),
      section({ sectionId: "vitals_review", state: "needs_reconfirmation" }),
    );
    const counts = reviewCounts(draft);
    expect(counts.drafted).toBe(4);
    expect(counts.resolved).toBe(2);
    expect(counts.needReview.map((s) => s.sectionId)).toEqual(["assessment", "vitals_review"]);
  });
});

describe("replaceSection", () => {
  it("returns a new draft with only that section swapped, leaving the original untouched", () => {
    const original = draftOf(section(), EMPTY);
    const next = replaceSection(original, section({ state: "confirmed" }));
    expect(next).not.toBe(original);
    expect(next.sections[0]?.state).toBe("confirmed");
    expect(next.sections[1]).toBe(EMPTY);
    expect(original.sections[0]?.state).toBe("unresolved");
  });
});

describe("touchesCarePlan", () => {
  it("is true for a section built from care-plan goals or interventions", () => {
    expect(touchesCarePlan(section({ origins: ["care_plan_goal"] }))).toBe(true);
    expect(touchesCarePlan(section({ origins: ["vitals", "care_plan_intervention"] }))).toBe(true);
    expect(touchesCarePlan(section({ origins: ["vitals"] }))).toBe(false);
  });
});

describe("draftIssuesFrom", () => {
  it("reads the per-section details of a finalize 422 or a sign 409", () => {
    const issues = draftIssuesFrom([
      { field: "plan", code: "DRAFT_SECTION_UNRESOLVED", message: "x" },
      { field: "interventions", code: "DRAFT_SECTION_STALE", message: "y" },
      { field: "assessment", code: "REQUIRED_SECTION_EMPTY", message: "z" },
    ]);
    expect(issues).toEqual([
      { sectionId: "plan", reason: "unresolved" },
      { sectionId: "interventions", reason: "stale" },
    ]);
  });

  it("returns nothing for a shape it does not know", () => {
    expect(draftIssuesFrom(undefined)).toEqual([]);
    expect(draftIssuesFrom("nope")).toEqual([]);
    expect(draftIssuesFrom([null, 4, {}])).toEqual([]);
  });
});

describe("isDraftSectionView", () => {
  it("accepts a section with a known state and known origins", () => {
    expect(isDraftSectionView(section())).toBe(true);
    expect(isDraftSectionView(EMPTY)).toBe(true);
  });

  it("refuses a section the screens could not read: unknown state, unknown or missing origins, not an object", () => {
    expect(isDraftSectionView({ ...section(), state: "approved" })).toBe(false);
    expect(isDraftSectionView({ ...section(), state: "toString" })).toBe(false);
    expect(isDraftSectionView({ ...section(), origins: ["telepathy"] })).toBe(false);
    expect(isDraftSectionView({ ...section(), origins: undefined })).toBe(false);
    expect(isDraftSectionView({ ...section(), sectionId: 4 })).toBe(false);
    expect(isDraftSectionView(null)).toBe(false);
    expect(isDraftSectionView("plan")).toBe(false);
  });
});

describe("draftGateRefusal", () => {
  it("splits a finalize refusal into the drafted sections it names and every other detail", () => {
    const vitals = { field: "vitals", code: "VITALS_REQUIRED", message: "Vitals are required" };
    const refusal = draftGateRefusal([
      vitals,
      { field: "plan", code: "DRAFT_SECTION_UNRESOLVED", message: "x" },
    ]);
    expect(refusal?.issues).toEqual([{ sectionId: "plan", reason: "unresolved" }]);
    expect(refusal?.others).toEqual([vitals]);
  });

  it("is null when the refusal is not about the draft at all", () => {
    expect(draftGateRefusal([{ field: "vitals", code: "VITALS_REQUIRED" }])).toBeNull();
    expect(draftGateRefusal(undefined)).toBeNull();
  });
});

describe("signStaleMessage", () => {
  const headingOf = (id: string): string => ({ plan: "Plan" })[id] ?? id;

  it("names the sections the sign refusal listed", () => {
    const text = signStaleMessage(
      [{ field: "plan", code: "DRAFT_SECTION_STALE", message: "changed" }],
      headingOf,
    );
    expect(text).toContain("need another look before this note can be signed");
    expect(text).toContain("Plan (changed since you resolved it)");
  });

  it("still says what to do when the refusal names none", () => {
    const text = signStaleMessage(undefined, headingOf);
    expect(text).toContain("need another look before this note can be signed.");
    expect(text).toContain("Review them in the note editor, then sign again.");
  });
});

describe("describeIssues", () => {
  const headingOf = (id: string): string => ({ plan: "Plan and Next Visit" })[id] ?? id;

  it("names each section with why, in the clinician's words", () => {
    const text = describeIssues(
      [
        { sectionId: "plan", reason: "unresolved" },
        { sectionId: "interventions", reason: "stale" },
      ],
      headingOf,
    );
    expect(text).toContain("Plan and Next Visit (not confirmed or deselected yet)");
    expect(text).toContain("interventions (changed since you resolved it)");
  });
});

describe("resolutionNote", () => {
  it("says what a confirmation covers", () => {
    const note = resolutionNote("confirmed", section(), section({ state: "confirmed" }));
    expect(note.tone).toBe("success");
    expect(note.text).toMatch(/confirmed/i);
  });

  it("says the drafted text stays out of the note on a deselect", () => {
    const note = resolutionNote(
      "deselected",
      section({ origins: ["vitals"] }),
      section({ state: "deselected" }),
    );
    expect(note.text).toMatch(/stays out of the note/);
    expect(note.text).not.toMatch(/care-plan/i);
  });

  it("warns that a care-plan deselect unlinked the items from the visit", () => {
    const note = resolutionNote("deselected", section(), section({ state: "deselected" }));
    expect(note.text).toMatch(/unlinked from this visit/);
  });

  it("explains a section that was left empty by the deselect", () => {
    const note = resolutionNote("deselected", section(), EMPTY);
    expect(note.tone).toBe("info");
    expect(note.text).toMatch(/nothing is left to draft/i);
  });
});

describe("trendOf", () => {
  const point = (capturedAt: string, score: number | null) => ({ capturedAt, score });

  it("finds the latest scored reading and the change against the one before it", () => {
    const trend = trendOf([
      point("2026-11-10T10:00:00Z", 60),
      point("2026-11-17T10:00:00Z", 50),
      point("2026-11-03T10:00:00Z", 70),
    ]);
    expect(trend.latest?.score).toBe(50);
    expect(trend.previous?.score).toBe(60);
    expect(trend.change).toBe(-10);
    expect(trend.recent.map((p) => p.score)).toEqual([50, 60, 70]);
  });

  it("ignores unscored readings and readings after the visit time", () => {
    const trend = trendOf(
      [
        point("2026-11-10T10:00:00Z", 60),
        point("2026-11-12T10:00:00Z", null),
        point("2026-11-19T10:00:00Z", 30),
      ],
      "2026-11-17T23:59:59.999Z",
    );
    expect(trend.latest?.score).toBe(60);
    expect(trend.previous).toBeNull();
    expect(trend.change).toBeNull();
  });

  it("is empty with no readings", () => {
    expect(trendOf([]).latest).toBeNull();
  });

  it("keeps at most four recent readings", () => {
    const points = [1, 2, 3, 4, 5, 6].map((n) => point(`2026-11-0${n}T10:00:00Z`, n * 10));
    expect(trendOf(points).recent).toHaveLength(4);
  });
});

describe("trendWindow", () => {
  it("covers the 90 days up to the service date", () => {
    expect(trendWindow("2026-11-17")).toEqual({ from: "2026-08-19", to: "2026-11-17" });
  });

  it("takes only the date of a date-time", () => {
    expect(trendWindow("2026-11-17T08:00:00.000Z")?.to).toBe("2026-11-17");
  });

  it("has no window for a service date it cannot read, instead of throwing", () => {
    expect(trendWindow("not-a-date")).toBeNull();
    expect(trendWindow("")).toBeNull();
  });
});

describe("describeChange", () => {
  it("reads up, down and no change", () => {
    expect(describeChange(10)).toBe("up 10");
    expect(describeChange(-10)).toBe("down 10");
    expect(describeChange(0)).toBe("no change");
    expect(describeChange(null)).toBe("first reading");
  });
});

describe("draftedStateOf", () => {
  const draftOf = (...sections: DraftSectionView[]) => ({ sections }) as unknown as DraftView;

  it("is the state of the section's drafted text", () => {
    const draft = draftOf(section({ sectionId: "plan", state: "confirmed" }));
    expect(draftedStateOf(draft, "plan")).toBe("confirmed");
  });

  it("is nothing for a section with nothing drafted, an unknown section, or no draft", () => {
    const draft = draftOf(section({ sectionId: "plan", state: "not_drafted", text: null }));
    expect(draftedStateOf(draft, "plan")).toBeUndefined();
    expect(draftedStateOf(draft, "pain")).toBeUndefined();
    expect(draftedStateOf(null, "plan")).toBeUndefined();
  });
});
