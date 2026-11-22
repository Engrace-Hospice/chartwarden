// ADR-0114 S4b (VN-D59, VN-D61, VN-D62) — resolving a social-work plan section keeps or leaves out the M15 goals and interventions it states, by the
// care-plan link rules (the SAME pure planners, over `encounter_discipline_plan_link` rows): confirming keeps them, deselecting leaves them out, a removal
// changes the section's hash, the row's Part 2 flag fails closed, and an amendment writes no link. The seams are fakes and the store is in memory (its link
// rules are the production planners), so no database is involved; the live suite proves the Drizzle store. Synthetic ids only.
import type { DisciplinePlanElementsAsOf } from "@chartwarden/types";
import { describe, expect, it } from "vitest";
import { computeDraft } from "../src/modules/08-encounters/drafting/compute";
import { resolveSection } from "../src/modules/08-encounters/drafting/resolve-section";
import {
  NOW,
  PATIENT_ID,
  carePlan,
  fakePorts,
  selectionFor,
  viewer,
} from "./_encounter-draft-fixtures";
import {
  type DisciplineLinkRow,
  memoryDraftStore as baseMemoryDraftStore,
  draftEncounterRow,
  memoryRunInOrg,
} from "./_encounter-draft-memory-store";

const MEMBER = "00000000-0000-4000-8000-0000000000aa";
const MSW = draftEncounterRow({ encounterType: "msw_followup", discipline: "msw" });
const MSW_SELECTION = selectionFor("msw_followup", "msw");
/** The in-memory store of a social-work visit: its stored selection is the template's own (the default one is the RN routine visit's). */
const memoryDraftStore = (options: Parameters<typeof baseMemoryDraftStore>[0] = {}) =>
  baseMemoryDraftStore({ selection: MSW_SELECTION, ...options });
const author = viewer({ roles: ["msw"] });

const goal = (goalId: string, text: string, over: Record<string, unknown> = {}) => ({
  goalId,
  text,
  source: "clinical",
  revised: false,
  sudRelated: false,
  ...over,
});
const intervention = (interventionId: string, scopeText: string) => ({
  interventionId,
  scopeText,
  frequencyText: "weekly",
  sudRelated: false,
});
const planOf = (over: Record<string, unknown> = {}): DisciplinePlanElementsAsOf =>
  ({
    planId: "plan-1",
    patientId: PATIENT_ID,
    goals: [
      goal("goal-1", "Name two ways to cope"),
      goal("goal-2", "Write a letter to the family"),
    ],
    interventions: [intervention("iv-1", "Supportive counselling")],
    redacted: false,
    ...over,
  }) as unknown as DisciplinePlanElementsAsOf;

const seams = (answer: DisciplinePlanElementsAsOf = planOf(), disclosed = false) =>
  fakePorts({
    disciplinePlanAsOf: async () => answer,
    part2DisclosureAllowed: async () => disclosed,
  });

type Store = ReturnType<typeof memoryDraftStore>["store"];

async function section(store: Store, sectionId: string, ports = seams(), who = author) {
  const { draft } = await computeDraft({ ...ports, ...store }, MSW, who, NOW);
  const found = draft.sections.find((s) => s.sectionId === sectionId);
  if (found === undefined) throw new Error(`no section ${sectionId}`);
  return found;
}

async function resolve(
  store: Store,
  sectionId: string,
  resolution: "confirmed" | "deselected",
  ports = seams(),
  who = author,
) {
  const seen = await section(store, sectionId, ports, who);
  if (seen.state !== "drafted") throw new Error(`section ${sectionId} is not drafted`);
  return resolveSection(ports, store, {
    encounter: MSW,
    viewer: who,
    actorMembershipId: MEMBER,
    addendumId: null,
    sectionId,
    resolution,
    contentHash: seen.contentHash,
    corpusVersion: seen.corpusVersion,
    now: NOW,
  });
}

const liveIds = (rows: readonly DisciplineLinkRow[]) =>
  rows.filter((r) => r.removedAt === null).map((r) => r.goalId ?? r.interventionId);
const removedIds = (rows: readonly DisciplineLinkRow[]) =>
  rows.filter((r) => r.removedAt !== null).map((r) => r.goalId ?? r.interventionId);

describe("confirming a social-work plan section", () => {
  it("keeps every goal the section states, one live row each, and counts them on the event", async () => {
    const { store, disciplineLinks, links } = memoryDraftStore();
    const { event } = await resolve(store, "plan", "confirmed");

    expect(liveIds(disciplineLinks)).toEqual(["goal-1", "goal-2"]);
    expect(event?.carePlanElementsLinked).toBe(2);
    // The M7 table is not the one written, and the other section's elements are not touched.
    expect(links).toEqual([]);
    expect(liveIds(disciplineLinks)).not.toContain("iv-1");
  });

  it("keeps the interventions of the other section when that one is confirmed", async () => {
    const { store, disciplineLinks } = memoryDraftStore();
    await resolve(store, "interventions", "confirmed");
    expect(liveIds(disciplineLinks)).toEqual(["iv-1"]);
  });

  it("is idempotent: the same content confirmed again writes no row", async () => {
    const { store, disciplineLinks } = memoryDraftStore();
    await resolve(store, "plan", "confirmed");
    const again = await resolve(store, "plan", "confirmed");

    expect(disciplineLinks).toHaveLength(2);
    expect(again.event).toBeNull();
  });
});

describe("deselecting a social-work plan section", () => {
  it("leaves its goals out: each is removed and the recomputed section is no longer drafted", async () => {
    const { store, disciplineLinks } = memoryDraftStore();
    const { event } = await resolve(store, "plan", "deselected");

    expect(removedIds(disciplineLinks)).toEqual(["goal-1", "goal-2"]);
    expect(liveIds(disciplineLinks)).toEqual([]);
    expect(event?.carePlanElementsRemoved).toBe(2);
    expect((await section(store, "plan")).state).not.toBe("drafted");
    // the interventions are another section: they stay
    expect((await section(store, "interventions")).state).toBe("drafted");
  });

  it("removes a goal that was confirmed (a live row) and one that was never linked alike", async () => {
    const { store, disciplineLinks } = memoryDraftStore({
      disciplineLinks: [
        {
          id: "link-0",
          goalId: "goal-1",
          interventionId: null,
          removedAt: null,
          removedByMembershipId: null,
          part2Derived: false,
        },
      ],
    });
    await resolve(store, "plan", "deselected");

    expect(removedIds(disciplineLinks).sort()).toEqual(["goal-1", "goal-2"]);
    expect(liveIds(disciplineLinks)).toEqual([]);
  });
});

describe("a goal left out of the plan", () => {
  const goal2Removed: DisciplineLinkRow = {
    id: "link-0",
    goalId: "goal-2",
    interventionId: null,
    removedAt: new Date("2026-11-20T12:00:00Z"),
    removedByMembershipId: MEMBER,
    part2Derived: false,
  };

  it("is not in the draft, and the section no longer hashes to what was seen before", async () => {
    const full = await section(memoryDraftStore().store, "plan");
    const less = await section(memoryDraftStore({ disciplineLinks: [goal2Removed] }).store, "plan");

    expect(full.state).toBe("drafted");
    expect(less.state).toBe("drafted");
    if (full.state === "drafted" && less.state === "drafted") {
      expect(less.text).not.toContain("letter to the family");
      expect(less.contentHash).not.toBe(full.contentHash);
      expect(less.sourceRefs.map((r) => r.id)).toEqual(["goal-1"]);
    }
  });

  it("makes a confirmation of the earlier content stale (DRAFT_SECTION_STALE)", async () => {
    const full = await section(memoryDraftStore().store, "plan");
    if (full.state !== "drafted") throw new Error("not drafted");
    const { store } = memoryDraftStore({ disciplineLinks: [goal2Removed] });

    await expect(
      resolveSection(seams(), store, {
        encounter: MSW,
        viewer: author,
        actorMembershipId: MEMBER,
        addendumId: null,
        sectionId: "plan",
        resolution: "confirmed",
        contentHash: full.contentHash,
        corpusVersion: full.corpusVersion,
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: "DRAFT_SECTION_STALE" });
  });

  it("comes back when it is kept again (a live row after the removed one)", async () => {
    const live: DisciplineLinkRow = {
      ...goal2Removed,
      id: "link-1",
      removedAt: null,
      removedByMembershipId: null,
    };
    const kept = await section(
      memoryDraftStore({ disciplineLinks: [goal2Removed, live] }).store,
      "plan",
    );
    expect(kept.state === "drafted" && kept.sourceRefs.map((r) => r.id)).toEqual([
      "goal-1",
      "goal-2",
    ]);
  });
});

describe("Part 2 (VN-D61)", () => {
  const withPart2Goal = planOf({
    goals: [
      goal("goal-1", "Name two ways to cope"),
      goal("goal-2", "Discuss the treatment programme", { sudRelated: true }),
    ],
  });

  it("an entitled viewer's confirmation writes rows flagged Part 2 (the section's flag: fail closed)", async () => {
    const { store, disciplineLinks } = memoryDraftStore();
    await resolve(store, "plan", "confirmed", seams(withPart2Goal, true));

    expect(liveIds(disciplineLinks)).toEqual(["goal-1", "goal-2"]);
    expect(disciplineLinks.every((r) => r.part2Derived)).toBe(true);
  });

  it("a section with no Part 2 source writes rows flagged not Part 2", async () => {
    const { store, disciplineLinks } = memoryDraftStore();
    await resolve(store, "plan", "confirmed");
    expect(disciplineLinks.every((r) => !r.part2Derived)).toBe(true);
  });

  it("a goal with no Part 2 flag at all is Part 2 (a missing flag is never 'not SUD')", async () => {
    const unflagged = planOf({
      goals: [goal("goal-1", "Name two ways to cope", { sudRelated: undefined })],
    });
    const { store, disciplineLinks } = memoryDraftStore();
    await resolve(store, "plan", "confirmed", seams(unflagged, true));
    expect(disciplineLinks.map((r) => r.part2Derived)).toEqual([true]);
  });

  it("a viewer without disclosure is handed no Part 2 goal, so no row names one", async () => {
    const redactedPlan = planOf({
      goals: [goal("goal-1", "Name two ways to cope")],
      redacted: true,
    });
    const { store, disciplineLinks } = memoryDraftStore();
    await resolve(store, "plan", "confirmed", seams(redactedPlan, false));

    expect(liveIds(disciplineLinks)).toEqual(["goal-1"]);
    expect(JSON.stringify(disciplineLinks)).not.toContain("goal-2");
    expect(disciplineLinks.every((r) => !r.part2Derived)).toBe(true);
  });
});

describe("what writes no discipline-plan link", () => {
  it("an amendment's draft (VN-D62) changes no link of the note", async () => {
    const { unit, disciplineLinks } = memoryRunInOrg({ selection: MSW_SELECTION });
    const amendment = unit.amendmentStore("addendum-1");
    await resolve(amendment as Store, "plan", "confirmed");
    await resolve(amendment as Store, "plan", "deselected");

    expect(disciplineLinks).toEqual([]);
  });

  it("an RN visit's care-plan section links M7 elements and no M15 one", async () => {
    const { store, links, disciplineLinks } = memoryDraftStore({
      selection: selectionFor("routine_visit", "rn"),
    });
    const rn = draftEncounterRow();
    const ports = fakePorts({ carePlanAsOf: async () => carePlan() });
    const { draft } = await computeDraft({ ...ports, ...store }, rn, viewer(), NOW);
    const plan = draft.sections.find((s) => s.sectionId === "plan");
    if (plan?.state !== "drafted") throw new Error("plan is not drafted");
    await resolveSection(ports, store, {
      encounter: rn,
      viewer: viewer(),
      actorMembershipId: MEMBER,
      addendumId: null,
      sectionId: "plan",
      resolution: "confirmed",
      contentHash: plan.contentHash,
      corpusVersion: plan.corpusVersion,
      now: NOW,
    });

    expect(links.length).toBeGreaterThan(0);
    expect(disciplineLinks).toEqual([]);
  });
});
