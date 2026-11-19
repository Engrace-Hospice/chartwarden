// S1 PR C2a — `readDraftInputs` (VN-D5, VN-D9..VN-D11, design §3.2): the as-of, per-viewer reads behind a draft.
import { describe, expect, it } from "vitest";
import { readDraftInputs } from "../src/modules/08-encounters/drafting/inputs";
import { EncounterStateError } from "../src/modules/08-encounters/lifecycle/errors";
import {
  AS_OF,
  ORG_ID,
  PATIENT_ID,
  carePlan,
  change,
  encounter,
  fakePorts,
  honestSeries,
  point,
  viewer,
} from "./_encounter-draft-fixtures";

const PREVIOUS_VISIT = new Date("2026-11-10T15:00:00.000Z");
const EPOCH = "1970-01-01T00:00:00.000Z";

describe("readDraftInputs: care plan", () => {
  it("asks the as-of reader for this viewer, patient, discipline and instant", async () => {
    const ports = fakePorts();
    const v = viewer();
    await readDraftInputs(ports, encounter(), v, AS_OF);
    expect(ports.carePlanAsOf).toHaveBeenCalledOnce();
    expect(ports.carePlanAsOf).toHaveBeenCalledWith(
      encounter().patientId,
      "routine_visit",
      "rn",
      encounter().admissionId,
      { actor: { roles: v.roles, membershipId: v.membershipId } },
      AS_OF,
    );
  });

  it("answers carePlan null when the patient has no plan in effect", async () => {
    const inputs = await readDraftInputs(fakePorts(), encounter(), viewer(), AS_OF);
    expect(inputs.carePlan).toBeNull();
  });

  it("maps goals and interventions and lets them inherit the parent problem's SUD flag", async () => {
    const plan = carePlan({
      problems: [
        { ...carePlan().problems[0]!, problemId: "problem-sud" as never, sudRelated: true },
        carePlan().problems[0]!,
      ],
      goals: [
        { ...carePlan().goals[0]!, goalId: "goal-sud" as never, problemId: "problem-sud" as never },
        carePlan().goals[0]!,
      ],
      interventions: [
        {
          ...carePlan().interventions[0]!,
          interventionId: "intervention-orphan" as never,
          problemId: "problem-missing" as never,
        },
      ],
    });
    const ports = fakePorts({ carePlanAsOf: async () => plan });
    const { carePlan: out } = await readDraftInputs(ports, encounter(), viewer(), AS_OF);
    expect(out?.goals).toEqual([
      {
        id: "goal-sud",
        goalText: carePlan().goals[0]!.text,
        progressStatement: null,
        sudRelated: true,
      },
      {
        id: "goal-1",
        goalText: carePlan().goals[0]!.text,
        progressStatement: null,
        sudRelated: false,
      },
    ]);
    // A parent problem the reader did not return proves nothing: left undefined, which the compiler reads as Part 2.
    expect(out?.interventions).toEqual([
      {
        id: "intervention-orphan",
        interventionText: carePlan().interventions[0]!.scopeText,
        sudRelated: undefined,
      },
    ]);
  });

  it("leaves out goals and interventions whose link was removed for this encounter", async () => {
    const plan = carePlan({
      goals: [carePlan().goals[0]!, { ...carePlan().goals[0]!, goalId: "goal-2" as never }],
    });
    const ports = fakePorts({
      carePlanAsOf: async () => plan,
      removedCarePlanElementIds: async () => new Set(["goal-1", "intervention-1"]),
    });
    const { carePlan: out } = await readDraftInputs(ports, encounter(), viewer(), AS_OF);
    expect(out?.goals.map((g) => g.id)).toEqual(["goal-2"]);
    expect(out?.interventions).toEqual([]);
  });

  it("maps encounter disciplines onto the care-plan vocabulary", async () => {
    for (const [discipline, expected] of [
      ["md", "md_np"],
      ["np", "md_np"],
      ["slp", "st"],
      ["chaplain", "chaplain"],
    ] as const) {
      const ports = fakePorts();
      await readDraftInputs(ports, encounter({ discipline }), viewer(), AS_OF);
      expect(ports.carePlanAsOf.mock.calls[0]?.[2]).toBe(expected);
    }
  });

  it("refuses a plan that belongs to another patient", async () => {
    const ports = fakePorts({
      carePlanAsOf: async () => carePlan({ patientId: "other-patient" as never }),
    });
    await expect(readDraftInputs(ports, encounter(), viewer(), AS_OF)).rejects.toMatchObject({
      code: "DRAFT_UNAVAILABLE",
    });
  });
});

describe("readDraftInputs: scale readings", () => {
  const pps = [
    point("pps-old", "2026-11-03T15:00:00.000Z", 70),
    point("pps-prev", "2026-11-10T15:00:00.000Z", 60),
    point("pps-now", "2026-11-18T14:10:00.000Z", 50),
    point("pps-after", "2026-11-18T16:00:00.000Z", 30),
  ];

  it("reads PPS and ESAS-r only, with `to` set to the visit time", async () => {
    const ports = fakePorts();
    await readDraftInputs(ports, encounter(), viewer(), AS_OF);
    expect(ports.scaleSeries.mock.calls.map((c) => [c[1], c[2], c[3]])).toEqual([
      ["pps", EPOCH, AS_OF],
      ["esas_r", EPOCH, AS_OF],
    ]);
  });

  it("never drafts a reading captured after the visit (the seam honours `to`)", async () => {
    const ports = fakePorts({ scaleSeries: honestSeries({ pps }) });
    const { scaleReadings } = await readDraftInputs(ports, encounter(), viewer(), AS_OF);
    expect(scaleReadings.map((r) => [r.id, r.value])).toEqual([["pps-now", 50]]);
  });

  it("never drafts a reading captured after the visit even if the seam returns one", async () => {
    const ports = fakePorts({
      scaleSeries: async (patientId, scaleType) => ({
        scaleType,
        patientId: patientId as never,
        from: EPOCH,
        to: AS_OF,
        points: scaleType === "pps" ? pps : [],
      }),
    });
    const { scaleReadings } = await readDraftInputs(ports, encounter(), viewer(), AS_OF);
    expect(scaleReadings.map((r) => r.id)).toEqual(["pps-now"]);
  });

  it("includes a reading captured exactly at the visit time and excludes one a millisecond later", async () => {
    const edge = [point("pps-at", AS_OF, 40), point("pps-later", "2026-11-18T14:30:00.001Z", 20)];
    const ports = fakePorts({ scaleSeries: honestSeries({ pps: edge }) });
    const { scaleReadings } = await readDraftInputs(ports, encounter(), viewer(), AS_OF);
    expect(scaleReadings.map((r) => r.id)).toEqual(["pps-at"]);
  });

  it("describes the visit-time state for a late entry, not today's", async () => {
    const lateAsOf = "2026-11-10T15:30:00.000Z";
    const ports = fakePorts({ scaleSeries: honestSeries({ pps }) });
    const { scaleReadings } = await readDraftInputs(ports, encounter(), viewer(), lateAsOf);
    expect(scaleReadings.map((r) => [r.id, r.value])).toEqual([["pps-prev", 60]]);
  });

  it("sets `previous` to the latest reading at or before the previous visit", async () => {
    const ports = fakePorts({
      scaleSeries: honestSeries({ pps }),
      previousSignedVisitAt: async () => PREVIOUS_VISIT,
    });
    const { scaleReadings } = await readDraftInputs(ports, encounter(), viewer(), AS_OF);
    expect(scaleReadings[0]).toMatchObject({
      id: "pps-now",
      value: 50,
      recordedAt: "2026-11-18T14:10:00.000Z",
      previous: { value: 60, recordedOn: "2026-11-10" },
    });
  });

  it("does not draft a reading the previous visit already had: nothing is new since then", async () => {
    // The one reading predates the previous visit, so it is both the latest and the one "before" it: drafting it would
    // put the same reading in `previous` and read as "unchanged from itself" (it was already in the previous note).
    const ports = fakePorts({
      scaleSeries: honestSeries({ pps: [point("pps-old", "2026-11-03T15:00:00.000Z", 60)] }),
      previousSignedVisitAt: async () => PREVIOUS_VISIT,
    });
    const { scaleReadings } = await readDraftInputs(ports, encounter(), viewer(), AS_OF);
    expect(scaleReadings).toEqual([]);
  });

  it("treats a reading captured exactly at the previous visit time as already seen", async () => {
    const ports = fakePorts({
      scaleSeries: honestSeries({
        pps: [point("pps-at", PREVIOUS_VISIT.toISOString(), 60)],
      }),
      previousSignedVisitAt: async () => PREVIOUS_VISIT,
    });
    const { scaleReadings } = await readDraftInputs(ports, encounter(), viewer(), AS_OF);
    expect(scaleReadings).toEqual([]);
  });

  it("drafts a reading a millisecond after the previous visit, against the one before it", async () => {
    const ports = fakePorts({
      scaleSeries: honestSeries({
        pps: [
          point("pps-prev", PREVIOUS_VISIT.toISOString(), 60),
          point("pps-new", "2026-11-10T15:00:00.001Z", 55),
        ],
      }),
      previousSignedVisitAt: async () => PREVIOUS_VISIT,
    });
    const { scaleReadings } = await readDraftInputs(ports, encounter(), viewer(), AS_OF);
    expect(scaleReadings[0]).toMatchObject({
      id: "pps-new",
      previous: { value: 60, recordedOn: "2026-11-10" },
    });
  });

  it("sets `previous` to null when there is no previous visit", async () => {
    const ports = fakePorts({ scaleSeries: honestSeries({ pps }) });
    const { scaleReadings } = await readDraftInputs(ports, encounter(), viewer(), AS_OF);
    expect(scaleReadings[0]?.previous).toBeNull();
  });

  it("sets `previous` to null when no reading existed by the previous visit", async () => {
    const ports = fakePorts({
      scaleSeries: honestSeries({ pps: [point("pps-now", "2026-11-18T14:10:00.000Z", 50)] }),
      previousSignedVisitAt: async () => PREVIOUS_VISIT,
    });
    const { scaleReadings } = await readDraftInputs(ports, encounter(), viewer(), AS_OF);
    expect(scaleReadings[0]?.previous).toBeNull();
  });

  it("dates `previous` in the organization's zone, not UTC", async () => {
    // 03:00 UTC on Nov 11 is 22:00 on Nov 10 in New York.
    const ports = fakePorts({
      scaleSeries: honestSeries({
        pps: [point("pps-prev", "2026-11-11T03:00:00.000Z", 60), pps[2]!],
      }),
      previousSignedVisitAt: async () => new Date("2026-11-11T04:00:00.000Z"),
    });
    const { scaleReadings } = await readDraftInputs(ports, encounter(), viewer(), AS_OF);
    expect(scaleReadings[0]?.previous?.recordedOn).toBe("2026-11-10");
    expect(ports.organizationTimeZone).toHaveBeenCalledWith(ORG_ID);
  });

  it("does not fall back to an older reading when the latest one has no score", async () => {
    const ports = fakePorts({
      scaleSeries: honestSeries({
        pps: [point("pps-old", "2026-11-03T15:00:00.000Z", 70), point("pps-null", AS_OF, null)],
      }),
    });
    const { scaleReadings } = await readDraftInputs(ports, encounter(), viewer(), AS_OF);
    expect(scaleReadings).toEqual([]);
  });

  it("labels an ESAS-r reading as the total score, since the series carries one score", async () => {
    const ports = fakePorts({
      scaleSeries: honestSeries({ esas_r: [point("esas-1", "2026-11-18T14:12:00.000Z", 22)] }),
    });
    const { scaleReadings } = await readDraftInputs(ports, encounter(), viewer(), AS_OF);
    expect(scaleReadings).toMatchObject([
      { id: "esas-1", scaleType: "esas_r", label: "total", value: 22 },
    ]);
  });

  it("marks readings as not SUD-related (M9 redacts only AIMS in a SUD context)", async () => {
    const ports = fakePorts({ scaleSeries: honestSeries({ pps }) });
    const { scaleReadings } = await readDraftInputs(ports, encounter(), viewer(), AS_OF);
    expect(scaleReadings[0]?.sudRelated).toBe(false);
  });
});

describe("readDraftInputs: vitals", () => {
  const vitals = { id: "vitals-1", recordedAt: "2026-11-18T14:20:00.000Z", heartRate: 72 };

  it("asks for the encounter's own latest row as of the visit time", async () => {
    const ports = fakePorts({ latestVitals: async () => vitals });
    const out = await readDraftInputs(ports, encounter(), viewer(), AS_OF);
    expect(out.vitals).toMatchObject({ id: "vitals-1", heartRate: 72, sudRelated: false });
    expect(ports.latestVitals).toHaveBeenCalledWith(encounter().id, AS_OF);
  });

  it("answers null when the encounter has no vitals", async () => {
    const out = await readDraftInputs(fakePorts(), encounter(), viewer(), AS_OF);
    expect(out.vitals).toBeNull();
  });

  it("drops a row captured after the visit even if the store returned it", async () => {
    const late = { ...vitals, recordedAt: "2026-11-18T14:30:00.001Z" };
    const ports = fakePorts({ latestVitals: async () => late });
    const out = await readDraftInputs(ports, encounter(), viewer(), AS_OF);
    expect(out.vitals).toBeNull();
  });
});

describe("readDraftInputs: medication changes", () => {
  const during = change("started", "2026-11-12T16:00:00.000Z", { id: "order-a" });

  it("drafts nothing, and asks nothing, when there is no previous signed visit", async () => {
    const ports = fakePorts({ medicationChangesBetween: async () => [during] });
    const out = await readDraftInputs(ports, encounter(), viewer(), AS_OF);
    expect(out.medicationChanges).toEqual([]);
    expect(ports.part2DisclosureAllowed).not.toHaveBeenCalled();
  });

  it("asks for the changes between the previous visit and the visit time", async () => {
    const ports = fakePorts({
      previousSignedVisitAt: async () => PREVIOUS_VISIT,
      medicationChangesBetween: async () => [during],
    });
    const out = await readDraftInputs(ports, encounter(), viewer(), AS_OF);
    expect(ports.medicationChangesBetween).toHaveBeenCalledWith(
      ORG_ID,
      PATIENT_ID,
      PREVIOUS_VISIT.toISOString(),
      AS_OF,
    );
    expect(out.medicationChanges).toEqual([
      {
        id: "order-a:started",
        drugName: "Morphine sulfate",
        change: "started",
        changedAt: "2026-11-12T16:00:00.000Z",
        changedOn: "2026-11-12",
        sudRelated: false,
      },
    ]);
  });

  it("dates a change in the organization's zone", async () => {
    const lateNight = change("changed", "2026-11-13T03:30:00.000Z", { id: "order-b" });
    const ports = fakePorts({
      previousSignedVisitAt: async () => PREVIOUS_VISIT,
      medicationChangesBetween: async () => [lateNight],
    });
    const out = await readDraftInputs(ports, encounter(), viewer(), AS_OF);
    expect(out.medicationChanges[0]?.changedOn).toBe("2026-11-12");
  });

  it("keeps a started and a discontinued change of one order as two sources with distinct ids", async () => {
    const ports = fakePorts({
      previousSignedVisitAt: async () => PREVIOUS_VISIT,
      medicationChangesBetween: async () => [
        change("started", "2026-11-12T16:00:00.000Z", { id: "order-a" }),
        change("discontinued", "2026-11-14T16:00:00.000Z", { id: "order-a" }),
      ],
    });
    const out = await readDraftInputs(ports, encounter(), viewer(), AS_OF);
    expect(out.medicationChanges.map((m) => m.id)).toEqual([
      "order-a:started",
      "order-a:discontinued",
    ]);
  });

  it("drafts a completed course as discontinued (the corpus has no 'completed' phrase)", async () => {
    const ports = fakePorts({
      previousSignedVisitAt: async () => PREVIOUS_VISIT,
      medicationChangesBetween: async () => [change("completed", "2026-11-14T16:00:00.000Z")],
    });
    const out = await readDraftInputs(ports, encounter(), viewer(), AS_OF);
    expect(out.medicationChanges[0]).toMatchObject({
      id: "order-1:completed",
      change: "discontinued",
    });
  });

  it("drops a change after the visit time even if the seam returned it", async () => {
    const ports = fakePorts({
      previousSignedVisitAt: async () => PREVIOUS_VISIT,
      medicationChangesBetween: async () => [change("started", "2026-11-18T14:30:00.001Z")],
    });
    const out = await readDraftInputs(ports, encounter(), viewer(), AS_OF);
    expect(out.medicationChanges).toEqual([]);
  });
});

describe("readDraftInputs: 42 CFR Part 2 on medication changes", () => {
  const sud = change("started", "2026-11-12T16:00:00.000Z", {
    id: "order-sud",
    drugName: "Buprenorphine",
    isSudTreatment: true,
  });
  const plain = change("started", "2026-11-12T17:00:00.000Z", { id: "order-plain" });
  const withChanges = (disclosure: boolean, changes = [sud, plain]) =>
    fakePorts({
      previousSignedVisitAt: async () => PREVIOUS_VISIT,
      medicationChangesBetween: async () => changes,
      part2DisclosureAllowed: async () => disclosure,
    });

  it("drops an SUD-treatment order for a viewer without disclosure", async () => {
    const out = await readDraftInputs(withChanges(false), encounter(), viewer(), AS_OF);
    expect(out.medicationChanges.map((m) => m.id)).toEqual(["order-plain:started"]);
    expect(JSON.stringify(out)).not.toContain("Buprenorphine");
  });

  it("keeps an SUD-treatment order for a viewer with disclosure, flagged so the section is Part 2", async () => {
    const out = await readDraftInputs(withChanges(true), encounter(), viewer(), AS_OF);
    expect(out.medicationChanges.map((m) => [m.id, m.sudRelated])).toEqual([
      ["order-sud:started", true],
      ["order-plain:started", false],
    ]);
  });

  it("asks the verdict for this viewer and patient", async () => {
    const ports = withChanges(true);
    const v = viewer({ roles: ["rn_case_manager"], membershipId: null });
    await readDraftInputs(ports, encounter(), v, AS_OF);
    expect(ports.part2DisclosureAllowed).toHaveBeenCalledWith({
      organizationId: ORG_ID,
      patientId: PATIENT_ID,
      viewer: v,
    });
  });

  it("does not ask for a verdict when no change is SUD-related", async () => {
    const ports = withChanges(true, [plain]);
    await readDraftInputs(ports, encounter(), viewer(), AS_OF);
    expect(ports.part2DisclosureAllowed).not.toHaveBeenCalled();
  });

  it("fails closed on a flag that is not the literal false", async () => {
    for (const isSudTreatment of [undefined, null, "false", 0, "no"]) {
      const unknown = change("started", "2026-11-12T16:00:00.000Z", {
        id: "order-unknown",
        isSudTreatment: isSudTreatment as never,
      });
      const denied = await readDraftInputs(
        withChanges(false, [unknown]),
        encounter(),
        viewer(),
        AS_OF,
      );
      expect(denied.medicationChanges).toEqual([]);
      const allowed = await readDraftInputs(
        withChanges(true, [unknown]),
        encounter(),
        viewer(),
        AS_OF,
      );
      expect(allowed.medicationChanges.map((m) => m.sudRelated)).toEqual([true]);
    }
  });
});

describe("readDraftInputs: previous visit", () => {
  it("passes the encounter to the previous-visit port", async () => {
    const ports = fakePorts();
    const e = encounter();
    await readDraftInputs(ports, e, viewer(), AS_OF);
    expect(ports.previousSignedVisitAt).toHaveBeenCalledWith(e);
  });

  it("refuses a previous visit later than the visit time", async () => {
    const ports = fakePorts({
      previousSignedVisitAt: async () => new Date("2026-11-19T00:00:00.000Z"),
    });
    await expect(readDraftInputs(ports, encounter(), viewer(), AS_OF)).rejects.toMatchObject({
      code: "DRAFT_UNAVAILABLE",
    });
  });
});

describe("readDraftInputs: seam failure is DRAFT_UNAVAILABLE, never a partial draft", () => {
  const boom = new Error("upstream down: patient 123");
  const failing: Array<[string, () => ReturnType<typeof fakePorts>]> = [
    ["care plan", () => fakePorts({ carePlanAsOf: async () => Promise.reject(boom) })],
    ["scale series", () => fakePorts({ scaleSeries: async () => Promise.reject(boom) })],
    [
      "medication changes",
      () =>
        fakePorts({
          previousSignedVisitAt: async () => PREVIOUS_VISIT,
          medicationChangesBetween: async () => Promise.reject(boom),
        }),
    ],
    [
      "Part 2 verdict",
      () =>
        fakePorts({
          previousSignedVisitAt: async () => PREVIOUS_VISIT,
          medicationChangesBetween: async () => [
            change("started", "2026-11-12T16:00:00.000Z", { isSudTreatment: true }),
          ],
          part2DisclosureAllowed: async () => Promise.reject(boom),
        }),
    ],
    ["vitals", () => fakePorts({ latestVitals: async () => Promise.reject(boom) })],
    [
      "previous visit",
      () => fakePorts({ previousSignedVisitAt: async () => Promise.reject(boom) }),
    ],
    [
      "removed elements",
      () => fakePorts({ removedCarePlanElementIds: async () => Promise.reject(boom) }),
    ],
    ["time zone", () => fakePorts({ organizationTimeZone: async () => Promise.reject(boom) })],
  ];

  it.each(failing)("when the %s read fails", async (_name, build) => {
    const error = await readDraftInputs(build(), encounter(), viewer(), AS_OF).catch((e) => e);
    expect(error).toBeInstanceOf(EncounterStateError);
    expect(error).toMatchObject({ code: "DRAFT_UNAVAILABLE", statusCode: 503 });
    expect(error.cause).toBe(boom);
    // The response message names the failing read, never the upstream message (which may carry PHI).
    expect(error.message).not.toContain("patient 123");
  });

  it("when a synchronous throw escapes a port", async () => {
    const ports = fakePorts({
      scaleSeries: () => {
        throw boom;
      },
    });
    await expect(readDraftInputs(ports, encounter(), viewer(), AS_OF)).rejects.toMatchObject({
      code: "DRAFT_UNAVAILABLE",
    });
  });

  it("when a seam returns an instant that is not an instant", async () => {
    const ports = fakePorts({
      scaleSeries: async (patientId, scaleType) => ({
        scaleType,
        patientId: patientId as never,
        from: EPOCH,
        to: AS_OF,
        points: [point("pps-bad", "not-a-time", 50)],
      }),
    });
    await expect(readDraftInputs(ports, encounter(), viewer(), AS_OF)).rejects.toMatchObject({
      code: "DRAFT_UNAVAILABLE",
    });
  });
});

describe("readDraftInputs: determinism", () => {
  it("answers equal inputs for equal calls and keeps no state between them", async () => {
    const ports = fakePorts({
      carePlanAsOf: async () => carePlan(),
      scaleSeries: honestSeries({ pps: [point("pps-now", "2026-11-18T14:10:00.000Z", 50)] }),
      latestVitals: async () => ({
        id: "vitals-1",
        recordedAt: "2026-11-18T14:20:00.000Z",
        heartRate: 72,
      }),
    });
    const first = await readDraftInputs(ports, encounter(), viewer(), AS_OF);
    const second = await readDraftInputs(ports, encounter(), viewer(), AS_OF);
    expect(second).toEqual(first);
    expect(ports.carePlanAsOf).toHaveBeenCalledTimes(2);
  });

  it("does not mutate what the seams returned", async () => {
    const plan = carePlan();
    const before = JSON.stringify(plan);
    await readDraftInputs(
      fakePorts({ carePlanAsOf: async () => plan }),
      encounter(),
      viewer(),
      AS_OF,
    );
    expect(JSON.stringify(plan)).toBe(before);
  });
});
