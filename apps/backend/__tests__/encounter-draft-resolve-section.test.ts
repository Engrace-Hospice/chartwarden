// S1 PR C2b1 — resolving one drafted section (VN-D7, VN-D8, VN-D12, VN-D18, design §3.2): confirm and deselect against the content
// the clinician saw, the care-plan link rules, and the deselect-hash trap. The seams are fakes, the store is in memory (its link
// rules are the production planners), so no database is involved; the live suite proves the Drizzle store.
import { describe, expect, it } from "vitest";
import { computeDraft } from "../src/modules/08-encounters/drafting/compute";
import { resolveSection } from "../src/modules/08-encounters/drafting/resolve-section";
import { sectionStates } from "../src/modules/08-encounters/drafting/section-state";
import { EncounterStateError } from "../src/modules/08-encounters/lifecycle/errors";
import {
  NOW,
  carePlan,
  change,
  fakePorts,
  honestSeries,
  viewer,
} from "./_encounter-draft-fixtures";
import { draftEncounterRow, memoryDraftStore } from "./_encounter-draft-memory-store";

const PREVIOUS_VISIT = new Date("2026-11-10T15:00:00.000Z");
const MEMBER = "00000000-0000-4000-8000-0000000000aa";
const encounter = draftEncounterRow();

/** A care plan (one goal -> `plan`, one intervention -> `interventions`) and, with a previous visit, a medication change -> `interventions`. */
const seams = () =>
  fakePorts({
    carePlanAsOf: async () => carePlan(),
    scaleSeries: honestSeries({}),
    medicationChangesBetween: async () => [
      change("started", "2026-11-12T16:00:00.000Z", { id: "order-a" }),
    ],
  });

const withPrevious = { previous: PREVIOUS_VISIT };

async function hashOf(sectionId: string, ...args: Parameters<typeof memoryDraftStore>) {
  const { store } = memoryDraftStore(...args);
  const { draft } = await computeDraft({ ...seams(), ...store }, encounter, viewer(), NOW);
  const section = draft.sections.find((s) => s.sectionId === sectionId);
  if (section?.state !== "drafted") throw new Error(`section ${sectionId} is not drafted`);
  return section;
}

const input = (over: Record<string, unknown> = {}) => ({
  encounter,
  viewer: viewer(),
  actorMembershipId: MEMBER,
  sectionId: "plan",
  resolution: "confirmed" as const,
  contentHash: "",
  corpusVersion: "",
  now: NOW,
  ...over,
});

async function resolveWith(
  store: ReturnType<typeof memoryDraftStore>["store"],
  sectionId: string,
  resolution: "confirmed" | "deselected",
  seen: { contentHash: string; corpusVersion: string },
) {
  return resolveSection(seams(), store, input({ sectionId, resolution, ...seen }));
}

const staleError = (p: Promise<unknown>) =>
  p.then(
    () => {
      throw new Error("expected DRAFT_SECTION_STALE");
    },
    (e: unknown) => e,
  );

describe("confirming a section", () => {
  it("keeps a confirmation bound to the hash and corpus the clinician saw, and reads back as confirmed", async () => {
    const mem = memoryDraftStore(withPrevious);
    const seen = await hashOf("plan", withPrevious);
    const out = await resolveWith(mem.store, "plan", "confirmed", seen);
    expect(out.view.state).toBe("confirmed");
    expect(mem.saved.get("plan")).toMatchObject({
      sectionId: "plan",
      resolution: "confirmed",
      contentHash: seen.contentHash,
      corpusVersion: seen.corpusVersion,
      resolvedByMembershipId: MEMBER,
      sourceRefs: [{ kind: "care_plan_goal", id: "goal-1" }],
    });
    const reopened = await computeDraft({ ...seams(), ...mem.store }, encounter, viewer(), NOW);
    expect(
      sectionStates(reopened.draft, await mem.store.confirmations(encounter.id)).find(
        (s) => s.sectionId === "plan",
      )?.state,
    ).toBe("confirmed");
  });

  it("writes a live link for each care-plan source of the section, once", async () => {
    const mem = memoryDraftStore(withPrevious);
    const seen = await hashOf("interventions", withPrevious);
    await resolveWith(mem.store, "interventions", "confirmed", seen);
    expect(mem.links.map((l) => [l.goalId, l.interventionId, l.removedAt])).toEqual([
      [null, "intervention-1", null],
    ]);
  });

  it("is idempotent: a repeated confirmation writes nothing and records no second event", async () => {
    const mem = memoryDraftStore(withPrevious);
    const seen = await hashOf("plan", withPrevious);
    const first = await resolveWith(mem.store, "plan", "confirmed", seen);
    const second = await resolveWith(mem.store, "plan", "confirmed", seen);
    expect(first.event).not.toBeNull();
    expect(second.event).toBeNull();
    expect(second.view.state).toBe("confirmed");
    expect(mem.store.saveConfirmation).toHaveBeenCalledTimes(1);
    expect(mem.links).toHaveLength(1);
  });

  it("re-confirms a section whose confirmation went stale, replacing the old binding", async () => {
    const mem = memoryDraftStore(withPrevious);
    const seen = await hashOf("plan", withPrevious);
    await resolveWith(mem.store, "plan", "confirmed", seen);
    // The goal's text changes in the care plan: the section's hash moves on.
    const changed = {
      ...seams(),
      carePlanAsOf: async () =>
        carePlan({
          goals: [
            {
              ...(carePlan().goals[0] as object),
              text: "Pain controlled at a lower level",
            } as never,
          ],
        }),
    };
    const { draft } = await computeDraft({ ...changed, ...mem.store }, encounter, viewer(), NOW);
    const now = draft.sections.find((s) => s.sectionId === "plan");
    if (now?.state !== "drafted") throw new Error("plan not drafted");
    expect(now.contentHash).not.toBe(seen.contentHash);
    const out = await resolveSection(
      changed,
      mem.store,
      input({ contentHash: now.contentHash, corpusVersion: now.corpusVersion }),
    );
    expect(out.view.state).toBe("confirmed");
    expect(mem.saved.get("plan")?.contentHash).toBe(now.contentHash);
  });

  it("records the section as edited exactly when it carried the clinician's own text", async () => {
    const plain = memoryDraftStore(withPrevious);
    const own = memoryDraftStore({ ...withPrevious, ownText: ["plan"] });
    const seen = await hashOf("plan", withPrevious);
    const a = await resolveWith(plain.store, "plan", "confirmed", seen);
    const b = await resolveWith(own.store, "plan", "confirmed", seen);
    expect(a.event?.edited).toBe(false);
    expect(plain.saved.get("plan")?.edited).toBe(false);
    expect(b.event?.edited).toBe(true);
    expect(own.saved.get("plan")?.edited).toBe(true);
  });

  it("reports the source ids and the link count in the event, never text", async () => {
    const mem = memoryDraftStore(withPrevious);
    const seen = await hashOf("interventions", withPrevious);
    const { event } = await resolveWith(mem.store, "interventions", "confirmed", seen);
    expect(event).toMatchObject({
      encounterId: encounter.id,
      sectionId: "interventions",
      resolution: "confirmed",
      contentHash: seen.contentHash,
      boundContentHash: seen.contentHash,
      carePlanElementsLinked: 1,
      carePlanElementsRemoved: 0,
    });
    expect(event?.sourceRefs).toEqual([
      { kind: "care_plan_intervention", id: "intervention-1" },
      { kind: "medication_change", id: "order-a:started" },
    ]);
    expect(JSON.stringify(event)).not.toContain("Repositioning");
  });
});

describe("a stale request (VN-D12)", () => {
  it("refuses a content hash that is no longer the draft with DRAFT_SECTION_STALE and writes nothing", async () => {
    const mem = memoryDraftStore(withPrevious);
    const seen = await hashOf("plan", withPrevious);
    const error = await staleError(
      resolveWith(mem.store, "plan", "confirmed", { ...seen, contentHash: "0".repeat(64) }),
    );
    expect(error).toBeInstanceOf(EncounterStateError);
    expect((error as EncounterStateError).code).toBe("DRAFT_SECTION_STALE");
    expect((error as EncounterStateError).statusCode).toBe(409);
    expect(mem.store.saveConfirmation).not.toHaveBeenCalled();
    expect(mem.store.linkCarePlan).not.toHaveBeenCalled();
    expect(mem.links).toEqual([]);
  });

  it("refuses a corpus version that is not the draft's", async () => {
    const mem = memoryDraftStore(withPrevious);
    const seen = await hashOf("plan", withPrevious);
    const error = await staleError(
      resolveWith(mem.store, "plan", "confirmed", { ...seen, corpusVersion: "1999.01.0" }),
    );
    expect((error as EncounterStateError).code).toBe("DRAFT_SECTION_STALE");
    expect(mem.saved.size).toBe(0);
  });

  it("refuses a deselect against a stale hash too, and removes no care-plan link", async () => {
    const mem = memoryDraftStore(withPrevious);
    const seen = await hashOf("plan", withPrevious);
    const error = await staleError(
      resolveWith(mem.store, "plan", "deselected", { ...seen, contentHash: "f".repeat(64) }),
    );
    expect((error as EncounterStateError).code).toBe("DRAFT_SECTION_STALE");
    expect(mem.store.removeCarePlan).not.toHaveBeenCalled();
    expect(mem.links).toEqual([]);
  });

  it("refuses a section that has nothing drafted now (the clinician saw content that is gone)", async () => {
    const mem = memoryDraftStore(withPrevious);
    const error = await staleError(
      resolveWith(mem.store, "chief_concern", "confirmed", {
        contentHash: "a".repeat(64),
        corpusVersion: (await hashOf("plan", withPrevious)).corpusVersion,
      }),
    );
    expect((error as EncounterStateError).code).toBe("DRAFT_SECTION_STALE");
  });

  it("names a section the template does not have as UNKNOWN_TEMPLATE_SECTION", async () => {
    const mem = memoryDraftStore(withPrevious);
    const error = await staleError(
      resolveWith(mem.store, "no_such_section", "confirmed", {
        contentHash: "a".repeat(64),
        corpusVersion: "x",
      }),
    );
    expect((error as EncounterStateError).code).toBe("UNKNOWN_TEMPLATE_SECTION");
  });
});

describe("deselecting a section: the care-plan links and the hash it is bound to", () => {
  it("a care-plan-only section ends empty: the never-linked goal gets a removed tombstone, no row is kept, state is not_drafted", async () => {
    const mem = memoryDraftStore(withPrevious);
    const seen = await hashOf("plan", withPrevious);
    const out = await resolveWith(mem.store, "plan", "deselected", seen);
    expect(out.view).toMatchObject({ sectionId: "plan", state: "not_drafted", text: null });
    expect(mem.saved.size).toBe(0);
    expect(mem.links).toEqual([
      expect.objectContaining({ goalId: "goal-1", removedAt: NOW, removedByMembershipId: MEMBER }),
    ]);
    expect(out.event).toMatchObject({
      resolution: "deselected",
      contentHash: seen.contentHash,
      boundContentHash: null,
      carePlanElementsRemoved: 1,
    });
  });

  it("a mixed section (care plan + medication change) is bound to the hash recomputed AFTER the links change", async () => {
    const mem = memoryDraftStore(withPrevious);
    const seen = await hashOf("interventions", withPrevious);
    const out = await resolveWith(mem.store, "interventions", "deselected", seen);
    const after = await computeDraft({ ...seams(), ...mem.store }, encounter, viewer(), NOW);
    const remaining = after.draft.sections.find((s) => s.sectionId === "interventions");
    if (remaining?.state !== "drafted") throw new Error("the medication change should remain");
    expect(remaining.contentHash).not.toBe(seen.contentHash);
    expect(remaining.text).not.toContain("Repositioning");
    expect(mem.saved.get("interventions")).toMatchObject({
      resolution: "deselected",
      contentHash: remaining.contentHash,
      sourceRefs: [{ kind: "medication_change", id: "order-a:started" }],
    });
    expect(out.view.state).toBe("deselected");
    expect(out.event).toMatchObject({
      contentHash: seen.contentHash,
      boundContentHash: remaining.contentHash,
      carePlanElementsRemoved: 1,
    });
  });

  it("a re-open after the deselect does not bring the elements back and reads the mixed section as deselected", async () => {
    const mem = memoryDraftStore(withPrevious);
    await resolveWith(mem.store, "plan", "deselected", await hashOf("plan", withPrevious));
    await resolveWith(
      mem.store,
      "interventions",
      "deselected",
      await hashOf("interventions", withPrevious),
    );
    // A fresh computation, as another device or a later open would make it.
    const reopened = await computeDraft({ ...seams(), ...mem.store }, encounter, viewer(), NOW);
    const states = sectionStates(reopened.draft, await mem.store.confirmations(encounter.id));
    expect(states.find((s) => s.sectionId === "plan")?.state).toBe("not_drafted");
    expect(states.find((s) => s.sectionId === "interventions")?.state).toBe("deselected");
    const texts = reopened.draft.sections.map((s) => (s.state === "drafted" ? s.text : ""));
    expect(texts.join(" ")).not.toContain("Pain controlled");
    expect(texts.join(" ")).not.toContain("Repositioning");
  });

  it("soft-removes a live link (who and when) instead of adding a tombstone", async () => {
    const mem = memoryDraftStore({
      ...withPrevious,
      links: [
        {
          id: "link-0",
          goalId: "goal-1",
          interventionId: null,
          removedAt: null,
          removedByMembershipId: null,
        },
      ],
    });
    await resolveWith(mem.store, "plan", "deselected", await hashOf("plan", withPrevious));
    expect(mem.links).toEqual([
      {
        id: "link-0",
        goalId: "goal-1",
        interventionId: null,
        removedAt: NOW,
        removedByMembershipId: MEMBER,
      },
    ]);
  });

  it("a repeated deselect of a section that is already deselected and current changes nothing", async () => {
    const mem = memoryDraftStore(withPrevious);
    const seen = await hashOf("interventions", withPrevious);
    await resolveWith(mem.store, "interventions", "deselected", seen);
    const linksBefore = structuredClone(mem.links);
    const retry = await resolveWith(mem.store, "interventions", "deselected", seen);
    expect(retry.view.state).toBe("deselected");
    expect(retry.event).toBeNull();
    expect(mem.links).toEqual(linksBefore);
    expect(mem.store.saveConfirmation).toHaveBeenCalledTimes(1);
  });

  it("confirming after a deselect re-binds the section to what remains and links none of the removed elements", async () => {
    const mem = memoryDraftStore(withPrevious);
    await resolveWith(
      mem.store,
      "interventions",
      "deselected",
      await hashOf("interventions", withPrevious),
    );
    const now = await computeDraft({ ...seams(), ...mem.store }, encounter, viewer(), NOW);
    const remaining = now.draft.sections.find((s) => s.sectionId === "interventions");
    if (remaining?.state !== "drafted") throw new Error("the medication change should remain");
    const out = await resolveWith(mem.store, "interventions", "confirmed", remaining);
    expect(out.view.state).toBe("confirmed");
    expect(mem.links.filter((l) => l.removedAt === null)).toEqual([]);
  });
});

describe("whose draft it is", () => {
  it("computes for the viewer it is given, and the care plan is read as that viewer", async () => {
    const mem = memoryDraftStore(withPrevious);
    const ports = seams();
    const seen = await hashOf("plan", withPrevious);
    await resolveSection(
      ports,
      mem.store,
      input({ ...seen, viewer: viewer({ roles: ["rn_case_manager"], membershipId: "m-9" }) }),
    );
    expect(ports.carePlanAsOf.mock.calls[0]?.[4]).toEqual({
      actor: { roles: ["rn_case_manager"], membershipId: "m-9" },
    });
  });
});
