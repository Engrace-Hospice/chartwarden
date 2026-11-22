// S4 — `readDraftInputs` for the social-work and chaplain visits (design §3.6, VN-D11, VN-D45 to VN-D49): the open goals and active interventions
// of the discipline's own plan (M15) in the signed version in effect at the visit time, for this viewer. Synthetic ids and values only.
import type { DisciplinePlanElementsAsOf } from "@chartwarden/types";
import { describe, expect, it, vi } from "vitest";
import { readDraftInputs } from "../src/modules/08-encounters/drafting/inputs";
import { DRAFT_SOURCE_READ_TIMEOUT_MS } from "../src/modules/08-encounters/drafting/unavailable";
import { AS_OF, PATIENT_ID, encounter, fakePorts, viewer } from "./_encounter-draft-fixtures";

const MSW = encounter({ encounterType: "msw_followup", discipline: "msw" });
const CHAPLAIN = encounter({ encounterType: "chaplain_visit", discipline: "chaplain" });
const ROUTINE = encounter({ encounterType: "routine_visit", discipline: "rn" });
const AIDE = encounter({ encounterType: "chha_visit", discipline: "chha" });

const goal = (over: Record<string, unknown> = {}) => ({
  goalId: "goal-1",
  text: "Name two ways to cope with the diagnosis",
  source: "clinical",
  revised: false,
  sudRelated: false,
  ...over,
});
const intervention = (over: Record<string, unknown> = {}) => ({
  interventionId: "iv-1",
  scopeText: "Supportive counselling",
  frequencyText: "weekly",
  sudRelated: false,
  ...over,
});
const plan = (over: Partial<DisciplinePlanElementsAsOf> = {}): DisciplinePlanElementsAsOf =>
  ({
    planId: "plan-1",
    patientId: PATIENT_ID,
    goals: [goal()],
    interventions: [intervention()],
    redacted: false,
    ...over,
  }) as unknown as DisciplinePlanElementsAsOf;

const portsWith = (answer: DisciplinePlanElementsAsOf | null = plan()) =>
  fakePorts({ disciplinePlanAsOf: async () => answer });

describe("readDraftInputs: the discipline plan", () => {
  it("asks M15 for a social worker's msw_plan, for this viewer, admission and instant", async () => {
    const ports = portsWith();
    const v = viewer({ roles: ["msw"] });
    await readDraftInputs(ports, MSW, v, AS_OF);
    expect(ports.disciplinePlanAsOf).toHaveBeenCalledOnce();
    expect(ports.disciplinePlanAsOf).toHaveBeenCalledWith(
      MSW.organizationId,
      MSW.patientId,
      MSW.admissionId,
      "msw_plan",
      { roles: v.roles, membershipId: v.membershipId },
      AS_OF,
    );
  });

  it("asks for a chaplain's spiritual_plan", async () => {
    const ports = portsWith();
    await readDraftInputs(ports, CHAPLAIN, viewer({ roles: ["chaplain"] }), AS_OF);
    expect(ports.disciplinePlanAsOf).toHaveBeenCalledWith(
      CHAPLAIN.organizationId,
      CHAPLAIN.patientId,
      CHAPLAIN.admissionId,
      "spiritual_plan",
      expect.anything(),
      AS_OF,
    );
  });

  it("reads no other source: not the M7 care plan, the scales, the vitals, nor the medication changes", async () => {
    const ports = portsWith();
    const inputs = await readDraftInputs(ports, MSW, viewer(), AS_OF);
    expect(ports.carePlanAsOf).not.toHaveBeenCalled();
    expect(ports.scaleSeries).not.toHaveBeenCalled();
    expect(ports.medicationChangesBetween).not.toHaveBeenCalled();
    expect(ports.latestVitals).not.toHaveBeenCalled();
    expect(ports.removedCarePlanElementIds).not.toHaveBeenCalled();
    expect(inputs.carePlan).toBeNull();
    expect(inputs.scaleReadings).toEqual([]);
    expect(inputs.vitals).toBeNull();
    expect(inputs.medicationChanges).toEqual([]);
  });

  it("is read by no other visit, which returns no disciplinePlan field", async () => {
    for (const other of [ROUTINE, AIDE]) {
      const ports = portsWith();
      const inputs = await readDraftInputs(ports, other, viewer(), AS_OF);
      expect(ports.disciplinePlanAsOf, other.encounterType).not.toHaveBeenCalled();
      expect(inputs, other.encounterType).not.toHaveProperty("disciplinePlan");
    }
  });

  it("answers disciplinePlan null when no plan is in effect", async () => {
    const inputs = await readDraftInputs(portsWith(null), MSW, viewer(), AS_OF);
    expect(inputs.disciplinePlan).toBeNull();
  });

  it("maps a goal to its words and its flag, and an intervention to its scope and frequency", async () => {
    const inputs = await readDraftInputs(portsWith(), MSW, viewer(), AS_OF);
    expect(inputs.disciplinePlan).toEqual({
      goals: [
        {
          id: "goal-1",
          goalText: "Name two ways to cope with the diagnosis",
          statedBy: null,
          sudRelated: false,
        },
      ],
      interventions: [
        {
          id: "iv-1",
          interventionText: "Supportive counselling",
          frequencyText: "weekly",
          sudRelated: false,
        },
      ],
    });
  });

  it.each([
    ["clinical", false, null],
    ["patient_stated", false, "patient"],
    ["family_stated", false, "family"],
    ["agent_stated", false, "agent"],
    // A clinician's revision is no longer the words of whoever stated the goal: it is listed without the attribution.
    ["patient_stated", true, null],
    ["family_stated", true, null],
    ["agent_stated", true, null],
  ])("a %s goal (revised: %s) is stated by %s", async (source, revised, statedBy) => {
    const ports = portsWith(plan({ goals: [goal({ source, revised })] as never }));
    const inputs = await readDraftInputs(ports, MSW, viewer(), AS_OF);
    expect(inputs.disciplinePlan?.goals.map((g) => g.statedBy)).toEqual([statedBy]);
  });

  it("carries the Part 2 flag as the seam gave it, never clearing one", async () => {
    const ports = portsWith(
      plan({
        goals: [goal({ sudRelated: true })] as never,
        interventions: [intervention({ sudRelated: true })] as never,
      }),
    );
    const inputs = await readDraftInputs(ports, MSW, viewer(), AS_OF);
    expect(inputs.disciplinePlan?.goals.map((g) => g.sudRelated)).toEqual([true]);
    expect(inputs.disciplinePlan?.interventions.map((i) => i.sudRelated)).toEqual([true]);
  });

  it("is DRAFT_UNAVAILABLE for a plan of another patient", async () => {
    const ports = portsWith(plan({ patientId: "someone-else" as never }));
    await expect(readDraftInputs(ports, MSW, viewer(), AS_OF)).rejects.toMatchObject({
      code: "DRAFT_UNAVAILABLE",
    });
  });

  it("is DRAFT_UNAVAILABLE when the seam never answers, once the read's bound has passed", async () => {
    vi.useFakeTimers();
    try {
      const ports = fakePorts({ disciplinePlanAsOf: () => new Promise<never>(() => undefined) });
      const pending = readDraftInputs(ports, MSW, viewer(), AS_OF).catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(DRAFT_SOURCE_READ_TIMEOUT_MS + 1);
      expect(await pending).toMatchObject({ code: "DRAFT_UNAVAILABLE", statusCode: 503 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("is DRAFT_UNAVAILABLE when the seam fails, naming the read and not the cause", async () => {
    const ports = fakePorts({
      disciplinePlanAsOf: async () => {
        throw new Error("patient Jane Doe, record 123");
      },
    });
    const error = await readDraftInputs(ports, MSW, viewer(), AS_OF).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "DRAFT_UNAVAILABLE", statusCode: 503 });
    expect((error as Error).message).toContain("the discipline plan");
    expect((error as Error).message).not.toContain("Jane Doe");
  });
});

describe("readDraftInputs: a discipline plan withheld from the viewer (`redacted`)", () => {
  const redacted = () =>
    plan({ goals: [], interventions: [], redacted: true }) as DisciplinePlanElementsAsOf;

  it("is the viewer's reduced plan when the viewer is not entitled to Part 2 content", async () => {
    const ports = fakePorts({
      disciplinePlanAsOf: async () => redacted(),
      part2DisclosureAllowed: async () => false,
    });
    const inputs = await readDraftInputs(ports, MSW, viewer(), AS_OF);
    expect(inputs.disciplinePlan).toEqual({ goals: [], interventions: [] });
  });

  it("is DRAFT_UNAVAILABLE when the viewer IS entitled: an entitled viewer is never silently given a reduced plan", async () => {
    const ports = fakePorts({
      disciplinePlanAsOf: async () => redacted(),
      part2DisclosureAllowed: async () => true,
    });
    const error = await readDraftInputs(ports, MSW, viewer(), AS_OF).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "DRAFT_UNAVAILABLE", statusCode: 503 });
  });

  it("is DRAFT_UNAVAILABLE when the Part 2 verdict itself fails", async () => {
    const ports = fakePorts({
      disciplinePlanAsOf: async () => redacted(),
      part2DisclosureAllowed: async () => {
        throw new Error("M39 down");
      },
    });
    await expect(readDraftInputs(ports, MSW, viewer(), AS_OF)).rejects.toMatchObject({
      code: "DRAFT_UNAVAILABLE",
    });
  });

  it("asks no Part 2 verdict when nothing was withheld", async () => {
    const ports = portsWith();
    await readDraftInputs(ports, MSW, viewer(), AS_OF);
    expect(ports.part2DisclosureAllowed).not.toHaveBeenCalled();
  });
});
