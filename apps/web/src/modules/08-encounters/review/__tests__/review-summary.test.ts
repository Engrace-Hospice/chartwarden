// WF09 WP3 — the read-only summary of what the note will state, built only from what the composer already holds (selections, the draft's
// section states, which saved records exist). It says what has an entry and on what basis; it never says a section is "complete" or
// "ready": the server judges that when the note is finalized. Synthetic data only.
import { describe, expect, it } from "vitest";
import type { DraftSectionView, DraftView } from "../../draft-api";
import type { DraftSections, TemplateView } from "../../encounters-api";
import { entryProgressTitle, sectionEntryLabel } from "../progress-wording";
import { type SummaryInput, buildNoteSummary } from "../review-summary";

const entry = (code: string, label: string, slots: string[] = []) => ({
  code,
  label,
  category: "observation",
  bodySystem: null,
  slots,
  slotSpecs: {},
  exclusiveGroup: null,
});

const template = {
  encounterId: "enc-1",
  templateKey: "routine_visit:rn",
  vocabVersion: "2026.1.0",
  encounterType: "routine_visit",
  discipline: "rn",
  sections: [
    {
      sectionId: "chief_concern",
      heading: "Reason for Visit",
      required: true,
      allowedCategories: [],
      recordedPanel: null,
      entries: [entry("nv.reason.routine", "Routine scheduled visit")],
    },
    {
      sectionId: "vitals_review",
      heading: "Vital Signs Review",
      required: true,
      allowedCategories: [],
      recordedPanel: null,
      entries: [],
    },
    {
      sectionId: "assessment",
      heading: "Assessment",
      required: true,
      allowedCategories: [],
      recordedPanel: null,
      entries: [
        entry("nv.resp.dyspnea_at_rest", "Dyspnea at rest"),
        entry("nv.edema.dependent", "Dependent edema", ["site"]),
      ],
    },
    {
      sectionId: "functional_status",
      heading: "Functional Status",
      required: false,
      allowedCategories: [],
      recordedPanel: "adl",
      entries: [],
    },
    {
      sectionId: "nutrition",
      heading: "Nutrition",
      required: false,
      allowedCategories: [],
      recordedPanel: "nutrition",
      entries: [],
    },
    {
      sectionId: "skin_wounds",
      heading: "Skin and Wounds",
      required: false,
      allowedCategories: [],
      recordedPanel: "wounds",
      entries: [],
    },
    {
      sectionId: "plan",
      heading: "Plan and Next Visit",
      required: true,
      allowedCategories: [],
      recordedPanel: null,
      entries: [],
    },
  ],
} as unknown as TemplateView;

const drafted = (sectionId: string, state: DraftSectionView["state"]): DraftSectionView => ({
  sectionId,
  state,
  text: "Drafted sentence.",
  contentHash: `hash-${sectionId}`,
  corpusVersion: "2026.1.0",
  part2Derived: false,
  origins: ["vitals"],
});

const draftOf = (...sections: DraftSectionView[]): DraftView => ({
  encounterId: "enc-1",
  patientId: "pat-1",
  templateKey: "routine_visit:rn",
  asOf: "2026-11-17T23:59:59.999Z",
  sections,
});

const input = (over: Partial<SummaryInput> = {}): SummaryInput => ({
  template,
  draft: {},
  drafted: null,
  recorded: {},
  fall: null,
  ...over,
});

const sectionOf = (summary: ReturnType<typeof buildNoteSummary>, id: string) => {
  const found = summary.sections.find((section) => section.sectionId === id);
  if (found === undefined) throw new Error(`no section ${id}`);
  return found;
};

describe("buildNoteSummary: sections", () => {
  it("lists every template section in order, each with no entry when nothing is written", () => {
    const summary = buildNoteSummary(input());
    expect(summary.sections.map((s) => s.sectionId)).toEqual(
      template.sections.map((s) => s.sectionId),
    );
    expect(summary.sections.every((s) => !s.hasEntry && s.basis.length === 0)).toBe(true);
  });

  it("names the statements the author selected by their label", () => {
    const draft: DraftSections = {
      assessment: { entries: [{ code: "nv.resp.dyspnea_at_rest", params: {} }], freeText: "" },
    };
    const section = sectionOf(buildNoteSummary(input({ draft })), "assessment");
    expect(section.statements).toEqual(["Dyspnea at rest"]);
    expect(section.basis).toEqual(["selection"]);
    expect(section.hasEntry).toBe(true);
  });

  it("counts the author's own text as an entry without repeating the text", () => {
    const draft: DraftSections = {
      vitals_review: { entries: [], freeText: "BP 120/70, resting." },
    };
    const section = sectionOf(buildNoteSummary(input({ draft })), "vitals_review");
    expect(section.basis).toEqual(["own_text"]);
    expect(JSON.stringify(section)).not.toContain("BP 120/70");
  });

  it("does not count whitespace as text", () => {
    const draft: DraftSections = { plan: { entries: [], freeText: "   " } };
    expect(sectionOf(buildNoteSummary(input({ draft })), "plan").hasEntry).toBe(false);
  });

  it("counts a saved ADL or nutrition record as the entry of the section that states it", () => {
    const summary = buildNoteSummary(input({ recorded: { adl: true, nutrition: false } }));
    expect(sectionOf(summary, "functional_status")).toMatchObject({
      hasEntry: true,
      basis: ["saved_record"],
    });
    expect(sectionOf(summary, "nutrition").hasEntry).toBe(false);
  });

  it("does not count a recorded wound as an entry, as the server does not", () => {
    const summary = buildNoteSummary(input({ recorded: { wounds: true } }));
    expect(sectionOf(summary, "skin_wounds").hasEntry).toBe(false);
  });

  it("counts drafted text the author confirmed, and shows each drafted section's state", () => {
    const summary = buildNoteSummary(
      input({
        drafted: draftOf(
          drafted("assessment", "confirmed"),
          drafted("plan", "unresolved"),
          drafted("vitals_review", "needs_reconfirmation"),
          drafted("chief_concern", "not_drafted"),
        ),
      }),
    );
    expect(sectionOf(summary, "assessment")).toMatchObject({
      hasEntry: true,
      basis: ["confirmed_draft"],
      draftState: "confirmed",
    });
    expect(sectionOf(summary, "plan")).toMatchObject({ hasEntry: false, draftState: "unresolved" });
    expect(sectionOf(summary, "vitals_review")).toMatchObject({
      hasEntry: false,
      draftState: "needs_reconfirmation",
    });
    expect(sectionOf(summary, "chief_concern").draftState).toBeNull();
  });

  it("flags a selected statement whose detail is still empty", () => {
    const draft: DraftSections = {
      assessment: { entries: [{ code: "nv.edema.dependent", params: { site: "" } }], freeText: "" },
    };
    expect(sectionOf(buildNoteSummary(input({ draft })), "assessment").needsDetails).toBe(true);
  });

  it("points each row's edit at its own section", () => {
    const summary = buildNoteSummary(input());
    expect(sectionOf(summary, "plan").edit).toEqual({ kind: "section", sectionId: "plan" });
  });

  it("marks required and optional sections as the template does", () => {
    const summary = buildNoteSummary(input());
    expect(sectionOf(summary, "assessment").required).toBe(true);
    expect(sectionOf(summary, "nutrition").required).toBe(false);
  });
});

describe("buildNoteSummary: what was recorded on the visit", () => {
  it("states only what the composer knows: saved, nothing saved, or not shown here", () => {
    const summary = buildNoteSummary(input({ recorded: { adl: true, nutrition: false } }));
    const finding = (id: string) => summary.findings.find((f) => f.id === id);
    expect(finding("adl")).toMatchObject({
      status: "recorded",
      edit: { kind: "section", sectionId: "functional_status" },
    });
    expect(finding("nutrition")).toMatchObject({ status: "none" });
    expect(finding("wounds")).toMatchObject({
      status: "unknown",
      edit: { kind: "section", sectionId: "skin_wounds" },
    });
    expect(finding("vitals")).toMatchObject({ status: "unknown", edit: { kind: "vitals" } });
  });

  it("leaves out a finding the template has no section for", () => {
    const slim = {
      ...template,
      sections: template.sections.filter((s) => s.recordedPanel === null),
    } as TemplateView;
    const ids = buildNoteSummary(input({ template: slim })).findings.map((f) => f.id);
    expect(ids).toEqual(["vitals", "care_plan"]);
  });

  it("names the fall link only when the visit follows up a fall, and whether one is chosen", () => {
    const none = buildNoteSummary(input({ fall: { linked: false } }));
    expect(none.findings.find((f) => f.id === "fall")).toMatchObject({ status: "none" });
    const linked = buildNoteSummary(input({ fall: { linked: true } }));
    expect(linked.findings.find((f) => f.id === "fall")).toMatchObject({
      status: "recorded",
      edit: { kind: "section", sectionId: "chief_concern" },
    });
    expect(buildNoteSummary(input()).findings.some((f) => f.id === "fall")).toBe(false);
  });

  it("counts linked care-plan items when the composer knows them, else sends the author to the plan step", () => {
    const known = buildNoteSummary(input({ carePlanLinks: 2 })).findings.find(
      (f) => f.id === "care_plan",
    );
    expect(known).toMatchObject({ status: "recorded", detail: "2 care-plan items linked" });
    const one = buildNoteSummary(input({ carePlanLinks: 1 })).findings.find(
      (f) => f.id === "care_plan",
    );
    expect(one?.detail).toBe("1 care-plan item linked");
    const none = buildNoteSummary(input({ carePlanLinks: 0 })).findings.find(
      (f) => f.id === "care_plan",
    );
    expect(none).toMatchObject({ status: "none", edit: { kind: "plan_step" } });
    const unknown = buildNoteSummary(input()).findings.find((f) => f.id === "care_plan");
    expect(unknown).toMatchObject({ status: "unknown", edit: { kind: "plan_step" } });
  });
});

describe("progress wording: entered, never ready", () => {
  it("labels a section by what the author has done, not by whether the server will take it", () => {
    expect(sectionEntryLabel({ hasEntry: true, needsDetails: false, required: true })).toBe(
      "Entered",
    );
    expect(sectionEntryLabel({ hasEntry: true, needsDetails: true, required: true })).toBe(
      "Needs details",
    );
    expect(sectionEntryLabel({ hasEntry: false, needsDetails: false, required: true })).toBe(
      "Required, no entry",
    );
    expect(sectionEntryLabel({ hasEntry: false, needsDetails: false, required: false })).toBe(
      "No entry",
    );
  });

  it("titles the progress by entries, with no percentage", () => {
    expect(entryProgressTitle(3, 7)).toBe("3 of 7 sections have an entry");
    expect(entryProgressTitle(1, 1)).toBe("1 of 1 section has an entry");
  });
});
