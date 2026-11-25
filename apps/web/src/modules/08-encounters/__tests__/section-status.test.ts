// What the composer says about one section (rail word, header chip, free-text hint): one source for all three, judged against the
// server rule they stand for: a required section stops finalize while it is empty, an optional one never does, and a half-filled
// statement stops finalize in either. Synthetic facts only.
import { describe, expect, it } from "vitest";
import {
  type FreeTextFacts,
  type SectionFacts,
  notesHint,
  sectionChip,
  sectionState,
} from "../section-status";

const facts = (over: Partial<SectionFacts> = {}): SectionFacts => ({
  required: false,
  populated: false,
  needsDetails: false,
  ...over,
});
const textFacts = (over: Partial<FreeTextFacts> = {}): FreeTextFacts => ({
  ...facts(),
  hasStatements: false,
  documentedByRecord: false,
  ...over,
});

describe("sectionState (the rail word)", () => {
  it("calls an empty optional section Not started, and an empty required one Required", () => {
    expect(sectionState(facts())).toBe("Not started");
    expect(sectionState(facts({ required: true }))).toBe("Required");
  });

  it("calls a populated section Documented, required or not", () => {
    expect(sectionState(facts({ populated: true }))).toBe("Documented");
    expect(sectionState(facts({ required: true, populated: true }))).toBe("Documented");
  });

  it("calls a half-filled statement Needs details even when the section has content, required or not", () => {
    expect(sectionState(facts({ populated: true, needsDetails: true }))).toBe("Needs details");
    expect(sectionState(facts({ required: true, populated: true, needsDetails: true }))).toBe(
      "Needs details",
    );
  });
});

describe("sectionChip (the header chip)", () => {
  it("says Required exactly when the template requires the section", () => {
    expect(sectionChip(facts({ required: true }))).toEqual({
      label: "Required",
      blocksFinalize: true,
    });
    expect(sectionChip(facts({ required: true, populated: true })).label).toBe("Required");
  });

  it("says Optional for an optional section, whether or not it is documented", () => {
    expect(sectionChip(facts())).toEqual({ label: "Optional", blocksFinalize: false });
    expect(sectionChip(facts({ populated: true })).label).toBe("Optional");
  });

  it("never says Optional of an optional section that holds a half-filled statement", () => {
    expect(sectionChip(facts({ populated: true, needsDetails: true }))).toEqual({
      label: "Needs details",
      blocksFinalize: true,
    });
  });

  it("agrees with the rail: the chip blocks finalize exactly when the rail is not Documented or Not started", () => {
    for (const required of [false, true]) {
      for (const populated of [false, true]) {
        for (const needsDetails of [false, true]) {
          const f = facts({ required, populated, needsDetails });
          const stops = sectionChip(f).blocksFinalize;
          const state = sectionState(f);
          const railSaysStopped = state === "Needs details" || state === "Required";
          // A required section that is documented stops nothing, but its chip still names the rule; every other case lines up.
          expect(stops || !railSaysStopped, JSON.stringify(f)).toBe(true);
          if (!required) expect(stops, JSON.stringify(f)).toBe(railSaysStopped);
        }
      }
    }
  });
});

describe("notesHint (the line under Additional clinical notes)", () => {
  it("tells the author an optional section with nothing to say can be left empty, and does not call it required", () => {
    const hint = notesHint(textFacts());
    expect(hint).toMatch(/^Optional\. Leave it empty/);
    expect(hint).not.toMatch(/Required/);
  });

  it("keeps the required wording for a required section that has no preset statements", () => {
    expect(notesHint(textFacts({ required: true }))).toMatch(
      /^Required\. This section has no preset statements; document it here in your own words\./,
    );
  });

  it("says Required, with the way out, for an empty required section that offers statements", () => {
    expect(notesHint(textFacts({ required: true, hasStatements: true }))).toMatch(
      /^Required\. Select a statement above, or write this section here/,
    );
  });

  it("calls the box optional once a required section with statements is populated, and for an optional one", () => {
    const expected = /^Optional\. Enter only information not already represented/;
    expect(notesHint(textFacts({ required: true, hasStatements: true, populated: true }))).toMatch(
      expected,
    );
    expect(notesHint(textFacts({ hasStatements: true }))).toMatch(expected);
  });

  it("points at the saved record when it documents a section that has no statements", () => {
    expect(
      notesHint(textFacts({ required: true, populated: true, documentedByRecord: true })),
    ).toMatch(/The saved record above documents this section/);
  });
});
