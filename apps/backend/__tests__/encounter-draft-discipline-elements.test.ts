// ADR-0114 S4b (VN-D60, VN-D61) — the per-element keep and leave-out of a social-work or chaplain plan, through the draft service: the elements the plan in
// effect at the visit holds for the calling viewer with whether the visit keeps each, and one idempotent toggle that writes the same link rows a section
// confirmation does. The switch answers 404 first, the template's own read key is asked before any source, Part 2 is per viewer and an element the viewer
// is not handed is the same 404 as an absent one. Fakes only; the live suite proves the Drizzle unit. Synthetic ids only.
import type { DisciplinePlanElementsAsOf } from "@chartwarden/types";
import { describe, expect, it } from "vitest";
import { computeDraft } from "../src/modules/08-encounters/drafting/compute";
import { createDraftService } from "../src/modules/08-encounters/drafting/draft-service";
import { NOW, PATIENT_ID, fakePorts, selectionFor, viewer } from "./_encounter-draft-fixtures";
import { draftEncounterRow, memoryRunInOrg } from "./_encounter-draft-memory-store";

const MEMBER = "00000000-0000-4000-8000-0000000000aa";
const ENCOUNTER = "00000000-0000-4000-8000-000000000004";
const GOAL_1 = "00000000-0000-4000-8000-0000000000c1";
const GOAL_2 = "00000000-0000-4000-8000-0000000000c2";
const GOAL_SUD = "00000000-0000-4000-8000-0000000000c3";
const IV_1 = "00000000-0000-4000-8000-0000000000d1";
const UNKNOWN = "00000000-0000-4000-8000-0000000000ff";
const AUDIT = { organizationId: "o", userId: "u", correlationId: "c" } as const;
const caller = {
  organizationId: "00000000-0000-4000-8000-000000000001",
  userId: "00000000-0000-4000-8000-0000000000bb",
  roles: ["msw"],
  membershipId: MEMBER,
  permissions: new Set<string>(["discipline_plan.read"]),
};
const MSW = draftEncounterRow({ encounterType: "msw_followup", discipline: "msw" });
const RN_VISIT = {
  encounter: draftEncounterRow(),
  selection: selectionFor("routine_visit", "rn"),
};
/** An RN with every read key of the routine visit's sources, so only the template (not a key) refuses these routes. */
const rnCaller = {
  ...caller,
  roles: ["rn"],
  permissions: new Set(["care_plan.read", "prescribing.read", "assessment.read_trend"]),
};

const goal = (goalId: string, text: string, over: Record<string, unknown> = {}) => ({
  goalId,
  text,
  source: "clinical",
  revised: false,
  sudRelated: false,
  ...over,
});
const planOf = (over: Record<string, unknown> = {}): DisciplinePlanElementsAsOf =>
  ({
    planId: "plan-1",
    patientId: PATIENT_ID,
    goals: [goal(GOAL_1, "Name two ways to cope"), goal(GOAL_2, "Write a letter to the family")],
    interventions: [
      {
        interventionId: IV_1,
        scopeText: "Supportive counselling",
        frequencyText: "weekly",
        sudRelated: false,
      },
    ],
    redacted: false,
    ...over,
  }) as unknown as DisciplinePlanElementsAsOf;
const withPart2Goal = planOf({
  goals: [
    goal(GOAL_1, "Name two ways to cope"),
    goal(GOAL_SUD, "Discuss the treatment programme", { sudRelated: true }),
  ],
});
const withheldPlan = planOf({
  goals: [goal(GOAL_1, "Name two ways to cope")],
  redacted: true,
});

function service(
  over: {
    plan?: DisciplinePlanElementsAsOf;
    disclosed?: boolean;
    memory?: Parameters<typeof memoryRunInOrg>[0];
  } = {},
) {
  const mem = memoryRunInOrg({
    encounter: MSW,
    selection: selectionFor("msw_followup", "msw"),
    ...over.memory,
  });
  const seams = fakePorts({
    disciplinePlanAsOf: async () => over.plan ?? planOf(),
    part2DisclosureAllowed: async () => over.disclosed ?? false,
  });
  return {
    ...mem,
    seams,
    svc: createDraftService({ runInOrg: mem.runInOrg, seams: () => seams, now: () => NOW }),
  };
}

const expectCode = async (p: Promise<unknown>, code: string, status: number) => {
  const error = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeDefined();
  expect((error as { code: string }).code).toBe(code);
  expect((error as { statusCode: number }).statusCode).toBe(status);
};

const out = { included: false };
const kept = { included: true };

describe("getDisciplinePlanElements", () => {
  it("lists the plan in effect at the visit: goals then interventions, each with its words and whether the visit keeps it, and reads no M7 plan", async () => {
    const { svc, seams } = service();
    const view = await svc.getDisciplinePlanElements(caller, ENCOUNTER);

    expect(view).toEqual({
      patientId: PATIENT_ID,
      elements: [
        { elementId: GOAL_1, kind: "goal", text: "Name two ways to cope", kept: true },
        { elementId: GOAL_2, kind: "goal", text: "Write a letter to the family", kept: true },
        {
          elementId: IV_1,
          kind: "intervention",
          text: "Supportive counselling, weekly",
          kept: true,
        },
      ],
    });
    expect(seams.carePlanAsOf).not.toHaveBeenCalled();
  });

  it("reads only the zone and the removed links from the store: the stored selections (the clinician's free text) are neither loaded nor decrypted", async () => {
    const { svc, store } = service();
    await svc.getDisciplinePlanElements(caller, ENCOUNTER);

    expect(store.organizationTimeZone).toHaveBeenCalledOnce();
    expect(store.removedDisciplinePlanElementIds).toHaveBeenCalledOnce();
    expect(store.loadSelection).not.toHaveBeenCalled();
    expect(store.latestVitals).not.toHaveBeenCalled();
    expect(store.removedCarePlanElementIds).not.toHaveBeenCalled();
  });

  it("lists a chaplain's goals only: the chaplain's note drafts no interventions, so one could be neither kept nor left out in any way the note shows", async () => {
    const { svc } = service({
      memory: {
        encounter: draftEncounterRow({ encounterType: "chaplain_visit", discipline: "chaplain" }),
        selection: selectionFor("chaplain_visit", "chaplain"),
      },
    });
    const chaplain = { ...caller, roles: ["chaplain"] };
    const view = await svc.getDisciplinePlanElements(chaplain, ENCOUNTER);
    expect(view.elements.map((e) => [e.kind, e.elementId])).toEqual([
      ["goal", GOAL_1],
      ["goal", GOAL_2],
    ]);
    await expectCode(
      svc.setDisciplinePlanElement(chaplain, ENCOUNTER, IV_1, out, AUDIT),
      "NOT_FOUND",
      404,
    );
  });

  it("marks an element the visit left out as not kept, and a re-kept one as kept", async () => {
    const removed = {
      id: "l1",
      goalId: GOAL_2,
      interventionId: null,
      removedAt: new Date("2026-11-20T12:00:00Z"),
      removedByMembershipId: MEMBER,
      part2Derived: false,
    };
    const { svc } = service({ memory: { disciplineLinks: [removed] } });
    const view = await svc.getDisciplinePlanElements(caller, ENCOUNTER);
    expect(view.elements.map((e) => [e.elementId, e.kept])).toEqual([
      [GOAL_1, true],
      [GOAL_2, false],
      [IV_1, true],
    ]);

    const rekept = { ...removed, id: "l2", removedAt: null, removedByMembershipId: null };
    const again = service({ memory: { disciplineLinks: [removed, rekept] } });
    const rekeptView = await again.svc.getDisciplinePlanElements(caller, ENCOUNTER);
    expect(rekeptView.elements.map((e) => e.kept)).toEqual([true, true, true]);
  });

  it("answers 404 for a tenant with the switch off, before the encounter or any source is read", async () => {
    const { svc, seams, encounterCalls } = service({ memory: { enabled: false } });
    await expectCode(svc.getDisciplinePlanElements(caller, ENCOUNTER), "NOT_FOUND", 404);
    expect(encounterCalls).toEqual([]);
    expect(seams.disciplinePlanAsOf).not.toHaveBeenCalled();
  });

  it("answers 404 for an encounter that is not the caller's tenant's", async () => {
    const { svc, seams } = service({ memory: { encounter: null } });
    await expectCode(svc.getDisciplinePlanElements(caller, ENCOUNTER), "NOT_FOUND", 404);
    expect(seams.disciplinePlanAsOf).not.toHaveBeenCalled();
  });

  it("is refused 403 for a caller without discipline_plan.read, before any source is read", async () => {
    const { svc, seams } = service();
    await expectCode(
      svc.getDisciplinePlanElements({ ...caller, permissions: new Set() }, ENCOUNTER),
      "FORBIDDEN",
      403,
    );
    expect(seams.disciplinePlanAsOf).not.toHaveBeenCalled();
  });

  it("is 422 for a visit whose note is not drafted from a discipline plan, and reads no plan", async () => {
    const { svc, seams } = service({ memory: RN_VISIT });
    await expectCode(
      svc.getDisciplinePlanElements(rnCaller, ENCOUNTER),
      "UNKNOWN_TEMPLATE_SECTION",
      422,
    );
    expect(seams.disciplinePlanAsOf).not.toHaveBeenCalled();
  });

  it("hands a viewer without disclosure only what M15 handed them, and an entitled viewer the Part 2 goal too", async () => {
    const hidden = service({ plan: withheldPlan });
    const hiddenView = await hidden.svc.getDisciplinePlanElements(caller, ENCOUNTER);
    expect(hiddenView.elements.map((e) => e.elementId)).toEqual([GOAL_1, IV_1]);

    const entitled = service({ plan: withPart2Goal, disclosed: true });
    const entitledView = await entitled.svc.getDisciplinePlanElements(caller, ENCOUNTER);
    expect(entitledView.elements.map((e) => e.elementId)).toEqual([GOAL_1, GOAL_SUD, IV_1]);
  });
});

describe("setDisciplinePlanElement", () => {
  it("leaves an element out, and the next draft does not state it", async () => {
    const { svc, store, disciplineLinks, seams } = service();
    const view = await svc.setDisciplinePlanElement(caller, ENCOUNTER, GOAL_2, out, AUDIT);

    expect(view.elements.find((e) => e.elementId === GOAL_2)?.kept).toBe(false);
    expect(view.elements.find((e) => e.elementId === GOAL_1)?.kept).toBe(true);
    expect(disciplineLinks.filter((r) => r.removedAt !== null).map((r) => r.goalId)).toEqual([
      GOAL_2,
    ]);

    const { draft } = await computeDraft(
      { ...seams, ...store },
      MSW,
      viewer({ roles: ["msw"] }),
      NOW,
    );
    const plan = draft.sections.find((s) => s.sectionId === "plan");
    expect(plan?.state).toBe("drafted");
    expect(plan?.state === "drafted" && plan.text).toContain("Name two ways to cope");
    expect(plan?.state === "drafted" && plan.text).not.toContain("letter to the family");
  });

  it("keeps an element again, and a repeat of either writes no further row", async () => {
    const { svc, disciplineLinks } = service();
    await svc.setDisciplinePlanElement(caller, ENCOUNTER, GOAL_1, out, AUDIT);
    const afterOut = disciplineLinks.length;
    await svc.setDisciplinePlanElement(caller, ENCOUNTER, GOAL_1, out, AUDIT);
    expect(disciplineLinks).toHaveLength(afterOut);

    const view = await svc.setDisciplinePlanElement(caller, ENCOUNTER, GOAL_1, kept, AUDIT);
    expect(view.elements.find((e) => e.elementId === GOAL_1)?.kept).toBe(true);
    expect(disciplineLinks.filter((r) => r.removedAt === null).map((r) => r.goalId)).toEqual([
      GOAL_1,
    ]);
    const afterIn = disciplineLinks.length;
    await svc.setDisciplinePlanElement(caller, ENCOUNTER, GOAL_1, kept, AUDIT);
    expect(disciplineLinks).toHaveLength(afterIn);
  });

  it("works on an intervention as on a goal", async () => {
    const { svc, disciplineLinks } = service();
    await svc.setDisciplinePlanElement(caller, ENCOUNTER, IV_1, out, AUDIT);
    expect(disciplineLinks.map((r) => [r.interventionId, r.removedAt !== null])).toEqual([
      [IV_1, true],
    ]);
  });

  it("files the row with the ELEMENT's own Part 2 flag", async () => {
    const entitled = service({ plan: withPart2Goal, disclosed: true });
    await entitled.svc.setDisciplinePlanElement(caller, ENCOUNTER, GOAL_SUD, kept, AUDIT);
    await entitled.svc.setDisciplinePlanElement(caller, ENCOUNTER, GOAL_1, kept, AUDIT);
    expect(entitled.disciplineLinks.map((r) => [r.goalId, r.part2Derived])).toEqual([
      [GOAL_SUD, true],
      [GOAL_1, false],
    ]);
  });

  it("answers 404 for an element the plan does not hold, and writes nothing", async () => {
    const { svc, disciplineLinks } = service();
    await expectCode(
      svc.setDisciplinePlanElement(caller, ENCOUNTER, UNKNOWN, out, AUDIT),
      "NOT_FOUND",
      404,
    );
    expect(disciplineLinks).toEqual([]);
  });

  it("answers an element withheld from the viewer exactly as an absent one (no Part 2 oracle)", async () => {
    const hidden = service({ plan: withheldPlan });
    const absent = hidden.svc.setDisciplinePlanElement(caller, ENCOUNTER, UNKNOWN, out, AUDIT);
    const withheld = hidden.svc.setDisciplinePlanElement(caller, ENCOUNTER, GOAL_SUD, out, AUDIT);
    await expectCode(absent, "NOT_FOUND", 404);
    await expectCode(withheld, "NOT_FOUND", 404);
    expect(hidden.disciplineLinks).toEqual([]);
  });

  it("locks the encounter row first and refuses a signed note's change (an addendum is the way)", async () => {
    const locked = service();
    await locked.svc.setDisciplinePlanElement(caller, ENCOUNTER, GOAL_1, out, AUDIT);
    expect(locked.encounterCalls).toEqual([{ id: ENCOUNTER, forUpdate: true }]);

    const signed = service({
      memory: { encounter: draftEncounterRow({ ...MSW, status: "signed" }) },
    });
    await expect(
      signed.svc.setDisciplinePlanElement(caller, ENCOUNTER, GOAL_1, out, AUDIT),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(signed.disciplineLinks).toEqual([]);
  });

  it("asks the same switch, read key and template as the read, and writes nothing when refused", async () => {
    const off = service({ memory: { enabled: false } });
    await expectCode(
      off.svc.setDisciplinePlanElement(caller, ENCOUNTER, GOAL_1, out, AUDIT),
      "NOT_FOUND",
      404,
    );
    const keyless = service();
    await expectCode(
      keyless.svc.setDisciplinePlanElement(
        { ...caller, permissions: new Set() },
        ENCOUNTER,
        GOAL_1,
        out,
        AUDIT,
      ),
      "FORBIDDEN",
      403,
    );
    const rn = service({ memory: RN_VISIT });
    await expectCode(
      rn.svc.setDisciplinePlanElement(rnCaller, ENCOUNTER, GOAL_1, out, AUDIT),
      "UNKNOWN_TEMPLATE_SECTION",
      422,
    );
    expect([off, keyless, rn].flatMap((s) => s.disciplineLinks)).toEqual([]);
  });
});
