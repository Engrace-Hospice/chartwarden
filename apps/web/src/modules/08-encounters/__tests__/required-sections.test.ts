// Which required sections the composer counts as still empty (ADR-0114), mirroring the server's gate check 1 (`required_sections`): a
// section is populated by the clinician's own entries or free text, or by drafted text they CONFIRMED. A deselected, unresolved or
// stale (`needs_reconfirmation`) drafted section does not populate it. The server stays the judge; this only tells the author first.
// Synthetic data only.
import { describe, expect, it } from "vitest";
import type { DraftSectionView, DraftView } from "../draft-api";
import { confirmedSectionIds } from "../draft-model";
import { type DraftSections, type TemplateView, unmetRequiredSections } from "../encounters-api";

const template = {
  encounterId: "enc-1",
  templateKey: "routine_visit:rn",
  vocabVersion: "2026.1.0",
  encounterType: "routine_visit",
  discipline: "rn",
  sections: [
    { sectionId: "chief_concern", heading: "Reason for Visit", required: false },
    { sectionId: "assessment", heading: "Assessment", required: true },
    { sectionId: "plan", heading: "Plan and Next Visit", required: true },
  ].map((section) => ({ ...section, allowedCategories: [], entries: [] })),
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

const NOTHING_WRITTEN: DraftSections = {};

describe("confirmedSectionIds", () => {
  it("holds only the sections whose drafted text the clinician confirmed", () => {
    const ids = confirmedSectionIds(
      draftOf(
        drafted("chief_concern", "confirmed"),
        drafted("assessment", "deselected"),
        drafted("plan", "unresolved"),
        drafted("interventions", "needs_reconfirmation"),
        drafted("vitals_review", "not_drafted"),
      ),
    );
    expect([...ids]).toEqual(["chief_concern"]);
  });

  it("is empty when there is no draft to read", () => {
    expect(confirmedSectionIds(null).size).toBe(0);
  });
});

describe("unmetRequiredSections", () => {
  it("lists every empty required section when nothing is written and nothing is confirmed", () => {
    expect(unmetRequiredSections(template, NOTHING_WRITTEN)).toEqual([
      "Assessment",
      "Plan and Next Visit",
    ]);
  });

  it("counts a confirmed drafted section as populated", () => {
    const confirmed = confirmedSectionIds(draftOf(drafted("assessment", "confirmed")));
    expect(unmetRequiredSections(template, NOTHING_WRITTEN, confirmed)).toEqual([
      "Plan and Next Visit",
    ]);
  });

  it.each(["deselected", "unresolved", "needs_reconfirmation", "not_drafted"] as const)(
    "does not count a %s drafted section",
    (state) => {
      const confirmed = confirmedSectionIds(draftOf(drafted("assessment", state)));
      expect(unmetRequiredSections(template, NOTHING_WRITTEN, confirmed)).toEqual([
        "Assessment",
        "Plan and Next Visit",
      ]);
    },
  );

  it("still counts the clinician's own entries or free text in a deselected section", () => {
    const written: DraftSections = {
      assessment: { entries: [{ code: "nv.resp.dyspnea_at_rest", params: {} }], freeText: "" },
      plan: { entries: [], freeText: "  Call family tomorrow.  " },
    };
    const confirmed = confirmedSectionIds(
      draftOf(drafted("assessment", "deselected"), drafted("plan", "deselected")),
    );
    expect(unmetRequiredSections(template, written, confirmed)).toEqual([]);
  });

  it("does not count whitespace as the clinician's own text", () => {
    const written: DraftSections = { assessment: { entries: [], freeText: "   " } };
    expect(unmetRequiredSections(template, written)).toEqual(["Assessment", "Plan and Next Visit"]);
  });

  it("ignores a confirmed section that is not a required one", () => {
    const confirmed = confirmedSectionIds(draftOf(drafted("chief_concern", "confirmed")));
    expect(unmetRequiredSections(template, NOTHING_WRITTEN, confirmed)).toEqual([
      "Assessment",
      "Plan and Next Visit",
    ]);
  });
});
