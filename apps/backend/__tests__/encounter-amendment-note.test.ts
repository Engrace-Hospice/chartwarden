// S1 PR E2 - the amended sections of an addendum as the sign sees them (ADR-0114 VN-D30 / VN-D12, design 3.1 "Amendment"). Pure: fake seams, a
// fake store; no database. The addendum owner runs through the SAME draft pipeline as a note (recomputed for the author as of the visit time,
// bound to a content hash and the corpus version); only the sections the addendum NAMES count, and only a confirmed one is amended.
import type { SelectionState } from "@chartwarden/hearthnote";
import { VOCAB_VERSION } from "@chartwarden/narrative-vocab";
import { describe, expect, it } from "vitest";
import {
  amendedSectionsOf,
  restrictToNamed,
} from "../src/modules/08-encounters/drafting/amendment-note";
import { computeDraft } from "../src/modules/08-encounters/drafting/compute";
import { finalNoteOf } from "../src/modules/08-encounters/drafting/final-note";
import type { NoteDraft } from "../src/modules/08-encounters/drafting/note-draft";
import {
  type ConfirmationRecord,
  sectionStates,
  unresolvedSections,
} from "../src/modules/08-encounters/drafting/section-state";
import { NOW, carePlan, change, fakePorts, viewer } from "./_encounter-draft-fixtures";
import { draftEncounterRow } from "./_encounter-draft-memory-store";

const encounter = draftEncounterRow();
const selection: SelectionState = {
  templateKey: "routine_visit:rn",
  vocabVersion: VOCAB_VERSION,
  encounterType: "routine_visit",
  discipline: "rn",
  sections: [
    { sectionId: "chief_concern", entries: [], freeText: "Routine visit per care plan." },
    { sectionId: "plan", entries: [], freeText: "Family meeting arranged." },
  ],
};

/** The care plan has a goal (-> `plan`) and an intervention (-> `interventions`); one medication change -> `interventions`. */
async function noteDraftOf(confirm: (draft: NoteDraft["computed"]) => ConfirmationRecord[]) {
  const ports = fakePorts({
    carePlanAsOf: async () => carePlan(),
    medicationChangesBetween: async () => [
      change("started", "2026-11-12T16:00:00.000Z", { id: "order-a", isSudTreatment: false }),
    ],
    previousSignedVisitAt: async () => new Date("2026-11-10T15:00:00.000Z"),
    loadSelection: async () => ({
      selection,
      context: { patient: "Patient", serviceDate: "2026-11-18" },
    }),
    part2DisclosureAllowed: async () => true,
  });
  const computed = await computeDraft(ports, encounter, viewer(), NOW);
  const states = sectionStates(computed.draft, confirm(computed));
  return { computed, states, actions: unresolvedSections(states) } satisfies NoteDraft;
}

const drafted = (draft: NoteDraft, sectionId: string) => {
  const section = draft.computed.draft.sections.find((s) => s.sectionId === sectionId);
  if (section?.state !== "drafted") throw new Error(`section ${sectionId} is not drafted`);
  return section;
};
const resolve = (
  draft: NoteDraft["computed"],
  sectionId: string,
  how: ConfirmationRecord["resolution"],
): ConfirmationRecord => {
  const section = draft.draft.sections.find((s) => s.sectionId === sectionId);
  if (section?.state !== "drafted") throw new Error(`section ${sectionId} is not drafted`);
  return {
    sectionId,
    resolution: how,
    contentHash: section.contentHash,
    corpusVersion: section.corpusVersion,
  };
};

describe("restrictToNamed: only the sections the addendum names count", () => {
  it("leaves an unresolved section the addendum does not name out of the actions", async () => {
    const draft = await noteDraftOf(() => []);
    expect(draft.actions.map((a) => a.sectionId).sort()).toEqual(["interventions", "plan"]);
    const restricted = restrictToNamed(draft, ["plan"]);
    expect(restricted.states.map((s) => s.sectionId)).toEqual(["plan"]);
    expect(restricted.actions).toEqual([{ sectionId: "plan", reason: "unresolved" }]);
  });

  it("a named section whose resolution no longer matches is stale, one that matches is not an action", async () => {
    const draft = await noteDraftOf((c) => [
      resolve(c, "plan", "confirmed"),
      { ...resolve(c, "interventions", "confirmed"), contentHash: "f".repeat(64) },
    ]);
    expect(restrictToNamed(draft, ["plan"]).actions).toEqual([]);
    expect(restrictToNamed(draft, ["plan", "interventions"]).actions).toEqual([
      { sectionId: "interventions", reason: "stale" },
    ]);
  });

  it("a named section the template does not carry has nothing to amend (not an action, not amended)", async () => {
    const draft = await noteDraftOf((c) => [resolve(c, "plan", "confirmed")]);
    const restricted = restrictToNamed(draft, ["plan", "no_such_section"]);
    expect(restricted.states.map((s) => s.sectionId)).toEqual(["plan"]);
    expect(restricted.actions).toEqual([]);
  });
});

describe("restrictToNamed keeps the draft's own actions for the named sections (S5b)", () => {
  it("an action beyond what a section's state gives (a confirmed idg_followup the recompute no longer drafts) counts when the addendum names that section, and not otherwise", async () => {
    const draft = await noteDraftOf((c) => [resolve(c, "plan", "confirmed")]);
    const stale = { sectionId: "idg_followup", reason: "stale" } as const;
    const withIdg: NoteDraft = { ...draft, actions: [...draft.actions, stale] };
    expect(restrictToNamed(withIdg, ["plan", "idg_followup"]).actions).toEqual([stale]);
    expect(restrictToNamed(withIdg, ["plan"]).actions).toEqual([]);
  });
});

describe("amendedSectionsOf: only a confirmed named section is written", () => {
  it("returns the confirmed section's block exactly as the signed note carries it (heading, line break, body)", async () => {
    const draft = await noteDraftOf((c) => [
      resolve(c, "plan", "confirmed"),
      resolve(c, "interventions", "confirmed"),
    ]);
    const amended = amendedSectionsOf(restrictToNamed(draft, ["plan"]));
    expect(amended.map((s) => s.sectionId)).toEqual(["plan"]);
    const note = finalNoteOf(draft.computed, draft.states);
    expect(amended[0]?.text).toBe(note.sections.find((s) => s.sectionId === "plan")?.text);
    expect(amended[0]?.text).toContain(drafted(draft, "plan").text);
  });

  it("a deselected section and a section with nothing drafted are not amended, and never fall back to the clinician's own words", async () => {
    const draft = await noteDraftOf((c) => [
      resolve(c, "plan", "deselected"),
      resolve(c, "interventions", "confirmed"),
    ]);
    const amended = amendedSectionsOf(restrictToNamed(draft, ["plan", "assessment"]));
    expect(amended).toEqual([]);
  });

  it("carries the compiler's Part 2 verdict and the source ids of the confirmed section (ids and kinds, never text)", async () => {
    const draft = await noteDraftOf((c) => [resolve(c, "interventions", "confirmed")]);
    const [amended] = amendedSectionsOf(restrictToNamed(draft, ["interventions"]));
    const section = drafted(draft, "interventions");
    expect(amended?.part2Derived).toBe(section.part2Derived);
    expect(amended?.sourceRefs).toEqual(section.sourceRefs.map(({ kind, id }) => ({ kind, id })));
    expect(JSON.stringify(amended?.sourceRefs)).not.toContain(section.text);
  });

  it("is in template order, whatever order the addendum named them in", async () => {
    const draft = await noteDraftOf((c) => [
      resolve(c, "plan", "confirmed"),
      resolve(c, "interventions", "confirmed"),
    ]);
    const amended = amendedSectionsOf(restrictToNamed(draft, ["plan", "interventions"]));
    expect(amended.map((s) => s.sectionId)).toEqual(["interventions", "plan"]);
  });
});
