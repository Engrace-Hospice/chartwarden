// S2 — `readDraftInputs` for the recertification and face-to-face visits (design §3.3, VN-D11, VN-D31 to VN-D33): the benefit period and
// its level of care, attested face-to-face and signed certification as of the visit DATE; the PPS baseline and the weight across the
// benefit period. Synthetic ids and values only.
import type {
  CertificationSummary,
  ElectionPeriodSummary,
  FaceToFaceSummary,
  LevelOfCare,
} from "@chartwarden/types";
import { describe, expect, it } from "vitest";
import { readDraftInputs } from "../src/modules/08-encounters/drafting/inputs";
import type { WeightRow } from "../src/modules/08-encounters/drafting/ports";
import {
  ADMISSION_ID,
  AS_OF,
  encounter,
  fakePorts,
  honestSeries,
  point,
  viewer,
} from "./_encounter-draft-fixtures";

const RECERT = encounter({ encounterType: "recert_visit" });
const F2F = encounter({ encounterType: "face_to_face", discipline: "np" });
const PREVIOUS_VISIT = new Date("2026-11-10T15:00:00.000Z");

const periodRow = (over: Partial<ElectionPeriodSummary>): ElectionPeriodSummary =>
  ({
    periodId: "period-3",
    admissionId: ADMISSION_ID,
    sequence: 3,
    periodKind: "sixty_day",
    status: "active",
    startDate: "2026-10-15",
    endDate: "2026-12-13",
    actualEndDate: null,
    ...over,
  }) as unknown as ElectionPeriodSummary;
const PERIOD_2 = periodRow({
  periodId: "period-2",
  sequence: 2,
  periodKind: "ninety_day",
  status: "completed",
  startDate: "2026-07-17",
  endDate: "2026-10-14",
});
const PERIOD_3 = periodRow({});

const f2fSummary = (over: Partial<FaceToFaceSummary> = {}): FaceToFaceSummary =>
  ({
    faceToFaceEncounterId: "f2f-1",
    electionPeriodId: "period-3",
    status: "attested",
    performerRole: "hospice_np",
    encounterDate: "2026-10-03",
    attestedAt: "2026-10-05",
    windowOverride: false,
    ...over,
  }) as unknown as FaceToFaceSummary;
const ctiSummary = (over: Partial<CertificationSummary> = {}): CertificationSummary =>
  ({
    certificationId: "cti-3",
    electionPeriodId: "period-3",
    status: "signed",
    hospiceMdSignedAt: "2026-10-14",
    signedLate: false,
    isRecert: true,
    ...over,
  }) as unknown as CertificationSummary;
const levelOn =
  (levels: Partial<Record<LevelOfCare, number>>) => async (admissionId: string, on: string) => ({
    admissionId: admissionId as never,
    range: { from: on as never, to: on as never },
    daysByLevel: {
      routine_home_care: 0,
      continuous_home_care: 0,
      inpatient_respite_care: 0,
      general_inpatient_care: 0,
      ...levels,
    },
  });

const W1: WeightRow = {
  id: "w-1",
  recordedAt: "2026-10-16T14:00:00.000Z",
  weight: "130",
  unit: "lb",
};
const W2: WeightRow = {
  id: "w-2",
  recordedAt: "2026-11-18T14:05:00.000Z",
  weight: "118.5",
  unit: "lb",
};

/** A recertification with everything in place; a test overrides the one thing it is about. */
const recertPorts = (over: Parameters<typeof fakePorts>[0] = {}) =>
  fakePorts({
    electionPeriods: async () => [PERIOD_2, PERIOD_3],
    levelOfCareOn: levelOn({ routine_home_care: 1 }),
    attestedFaceToFace: async () => f2fSummary(),
    activeCertification: async () => ctiSummary(),
    weightReadings: async () => [W1, W2],
    previousSignedVisitAt: async () => PREVIOUS_VISIT,
    scaleSeries: honestSeries({
      pps: [
        point("pps-0", "2026-09-01T14:00:00.000Z", 90),
        point("pps-1", "2026-10-16T14:00:00.000Z", 80),
        point("pps-2", "2026-11-10T15:00:00.000Z", 60),
        point("pps-3", "2026-11-18T14:00:00.000Z", 50),
      ],
    }),
    ...over,
  });

describe("the benefit period on the visit date (recertification)", () => {
  it("is the period covering the service date, with its level of care, attested face-to-face and signed certification", async () => {
    const ports = recertPorts();
    const inputs = await readDraftInputs(ports, RECERT, viewer(), AS_OF);
    expect(inputs.benefitPeriod).toEqual({
      id: "period-3",
      sequence: 3,
      periodKind: "sixty_day",
      startDate: "2026-10-15",
      endDate: "2026-12-13",
      levelOfCare: "routine_home_care",
      faceToFace: {
        id: "f2f-1",
        performerRole: "hospice_np",
        performedOn: "2026-10-03",
        attestedOn: "2026-10-05",
        sudRelated: false,
      },
      certification: { id: "cti-3", signedOn: "2026-10-14", sudRelated: false },
      sudRelated: false,
    });
    expect(ports.electionPeriods).toHaveBeenCalledWith(RECERT.admissionId);
    expect(ports.levelOfCareOn).toHaveBeenCalledWith(RECERT.admissionId, "2026-11-18");
    expect(ports.attestedFaceToFace).toHaveBeenCalledWith("period-3");
    expect(ports.activeCertification).toHaveBeenCalledWith("period-3");
  });

  it("skips a period an actual end date has closed, and takes the highest sequence when two cover the date", async () => {
    const closed = periodRow({
      periodId: "period-closed",
      sequence: 5,
      actualEndDate: "2026-11-17",
    });
    const overlapping = periodRow({
      periodId: "period-overlap",
      sequence: 4,
      startDate: "2026-11-18",
      endDate: "2027-01-16",
    });
    const inputs = await readDraftInputs(
      recertPorts({ electionPeriods: async () => [PERIOD_2, PERIOD_3, closed, overlapping] }),
      RECERT,
      viewer(),
      AS_OF,
    );
    expect(inputs.benefitPeriod?.id).toBe("period-overlap");
  });

  it("names the level of care only when exactly one level counted for the visit date", async () => {
    for (const levels of [{}, { routine_home_care: 1, general_inpatient_care: 1 }]) {
      const inputs = await readDraftInputs(
        recertPorts({ levelOfCareOn: levelOn(levels) }),
        RECERT,
        viewer(),
        AS_OF,
      );
      expect(inputs.benefitPeriod?.levelOfCare).toBeNull();
      expect(inputs.benefitPeriod?.id).toBe("period-3");
    }
    const inputs = await readDraftInputs(
      recertPorts({ levelOfCareOn: levelOn({ continuous_home_care: 1 }) }),
      RECERT,
      viewer(),
      AS_OF,
    );
    expect(inputs.benefitPeriod?.levelOfCare).toBe("continuous_home_care");
  });

  it("carries a face-to-face only when it is attested, and a certification only when it is signed", async () => {
    const inputs = await readDraftInputs(
      recertPorts({
        attestedFaceToFace: async () => f2fSummary({ attestedAt: null }),
        activeCertification: async () =>
          ctiSummary({ status: "awaiting_hospice_md", hospiceMdSignedAt: null }),
      }),
      RECERT,
      viewer(),
      AS_OF,
    );
    expect(inputs.benefitPeriod?.faceToFace).toBeNull();
    expect(inputs.benefitPeriod?.certification).toBeNull();
    const none = await readDraftInputs(
      recertPorts({ attestedFaceToFace: async () => null, activeCertification: async () => null }),
      RECERT,
      viewer(),
      AS_OF,
    );
    expect(none.benefitPeriod?.faceToFace).toBeNull();
    expect(none.benefitPeriod?.certification).toBeNull();
  });

  it("is null, and reads nothing else of module 6, when no period covers the service date", async () => {
    const ports = recertPorts({ electionPeriods: async () => [PERIOD_2] });
    const inputs = await readDraftInputs(ports, RECERT, viewer(), AS_OF);
    expect(inputs.benefitPeriod).toBeNull();
    expect(ports.levelOfCareOn).not.toHaveBeenCalled();
    expect(ports.attestedFaceToFace).not.toHaveBeenCalled();
    expect(ports.activeCertification).not.toHaveBeenCalled();
    // ...and with no period there is no baseline and no weight window: honest empty sections, never an invented start.
    expect(inputs.weight).toBeNull();
    expect(inputs.scaleReadings.find((r) => r.scaleType === "pps")?.baseline).toBeUndefined();
  });
});

describe("the PPS against the benefit period's first reading", () => {
  it("is the first reading on or after the period start that is earlier than the latest, never one from an earlier period", async () => {
    const inputs = await readDraftInputs(recertPorts(), RECERT, viewer(), AS_OF);
    expect(inputs.scaleReadings.find((r) => r.scaleType === "pps")).toMatchObject({
      id: "pps-3",
      value: 50,
      previous: { value: 60, recordedOn: "2026-11-10" },
      baseline: { value: 80, recordedOn: "2026-10-16" },
      sudRelated: false,
    });
  });

  it("is null when the latest reading is itself the first of the period", async () => {
    const inputs = await readDraftInputs(
      recertPorts({
        scaleSeries: honestSeries({
          pps: [
            point("pps-0", "2026-09-01T14:00:00.000Z", 90),
            point("pps-3", "2026-11-18T14:00:00.000Z", 50),
          ],
        }),
      }),
      RECERT,
      viewer(),
      AS_OF,
    );
    expect(inputs.scaleReadings.find((r) => r.scaleType === "pps")?.baseline).toBeNull();
  });

  it("is never set on an ESAS-r reading", async () => {
    const inputs = await readDraftInputs(
      recertPorts({
        scaleSeries: honestSeries({
          esas_r: [
            point("esas-1", "2026-10-16T14:00:00.000Z", 40),
            point("esas-2", "2026-11-18T14:00:00.000Z", 30),
          ],
        }),
      }),
      RECERT,
      viewer(),
      AS_OF,
    );
    const esas = inputs.scaleReadings.find((r) => r.scaleType === "esas_r");
    expect(esas).toBeDefined();
    expect(esas).not.toHaveProperty("baseline");
  });
});

describe("the weight across the benefit period", () => {
  it("is the latest weight at or before the visit with the period's first beside it, read from the day before the period starts", async () => {
    const ports = recertPorts();
    const inputs = await readDraftInputs(ports, RECERT, viewer(), AS_OF);
    expect(inputs.weight).toEqual({
      id: "w-2",
      recordedAt: "2026-11-18T14:05:00.000Z",
      recordedOn: "2026-11-18",
      value: "118.5",
      unit: "lb",
      baseline: { value: "130", recordedOn: "2026-10-16" },
      sudRelated: false,
    });
    expect(ports.weightReadings).toHaveBeenCalledWith(RECERT, "2026-10-14T00:00:00.000Z", AS_OF);
  });

  it("has no baseline when there is only one weight in the period, and none before the period start counts", async () => {
    const before: WeightRow = {
      id: "w-0",
      recordedAt: "2026-10-01T14:00:00.000Z",
      weight: "150",
      unit: "lb",
    };
    const inputs = await readDraftInputs(
      recertPorts({ weightReadings: async () => [before, W2] }),
      RECERT,
      viewer(),
      AS_OF,
    );
    expect(inputs.weight).toMatchObject({ id: "w-2", baseline: null });
  });

  it("leaves out a weight after the visit time and a row from before the period starts, whatever they hold", async () => {
    const after: WeightRow = {
      id: "w-9",
      recordedAt: "2026-11-19T14:00:00.000Z",
      weight: "100",
      unit: "lb",
    };
    const beforePeriod: WeightRow = {
      id: "w-0",
      recordedAt: "2026-10-01T14:00:00.000Z",
      weight: "heavy",
      unit: null,
    };
    const inputs = await readDraftInputs(
      recertPorts({ weightReadings: async () => [beforePeriod, W1, W2, after] }),
      RECERT,
      viewer(),
      AS_OF,
    );
    expect(inputs.weight).toMatchObject({
      id: "w-2",
      baseline: { value: "130", recordedOn: "2026-10-16" },
    });
  });

  it.each([
    ["text that is not a number", { weight: "heavy", unit: "lb" }],
    ["a zero", { weight: "0", unit: "lb" }],
    ["a negative", { weight: "-3", unit: "lb" }],
    ["a number with its unit in the text", { weight: "150 lb", unit: "lb" }],
    ["no unit", { weight: "120", unit: null }],
    ["a unit that is not kg or lb", { weight: "120", unit: "stone" }],
  ] as const)(
    "is not drafted when one weight inside the period cannot be used (%s): the sentences say 'first' and 'only', and a skipped row would make them false",
    async (_name, bad) => {
      const row: WeightRow = { id: "w-x", recordedAt: "2026-11-01T14:00:00.000Z", ...bad };
      const inputs = await readDraftInputs(
        recertPorts({ weightReadings: async () => [W1, row, W2] }),
        RECERT,
        viewer(),
        AS_OF,
      );
      expect(inputs.weight).toBeNull();
    },
  );

  it.each([
    ["an empty text", ""],
    ["blanks", "   "],
  ])(
    "does not count a weight that holds %s: it was never captured, so it neither silences the period's weights nor is one of them",
    async (_name, blank) => {
      const row: WeightRow = {
        id: "w-x",
        recordedAt: "2026-11-01T14:00:00.000Z",
        weight: blank,
        unit: null,
      };
      const inputs = await readDraftInputs(
        recertPorts({ weightReadings: async () => [W1, row, W2] }),
        RECERT,
        viewer(),
        AS_OF,
      );
      expect(inputs.weight).toMatchObject({
        id: "w-2",
        baseline: { value: "130", recordedOn: "2026-10-16" },
      });
    },
  );

  it("is not drafted when a weight's time cannot be read", async () => {
    const row: WeightRow = { id: "w-x", recordedAt: "yesterday", weight: "120", unit: "lb" };
    const inputs = await readDraftInputs(
      recertPorts({ weightReadings: async () => [W1, row, W2] }),
      RECERT,
      viewer(),
      AS_OF,
    );
    expect(inputs.weight).toBeNull();
  });

  it("is not drafted when the period's weights are in more than one unit: no conversion, no false 'only weight'", async () => {
    const kg: WeightRow = {
      id: "w-kg",
      recordedAt: "2026-10-20T14:00:00.000Z",
      weight: "59",
      unit: "kg",
    };
    const inputs = await readDraftInputs(
      recertPorts({ weightReadings: async () => [W1, kg, W2] }),
      RECERT,
      viewer(),
      AS_OF,
    );
    expect(inputs.weight).toBeNull();
  });

  it("is null when there is no weight in the period", async () => {
    const inputs = await readDraftInputs(
      recertPorts({ weightReadings: async () => [] }),
      RECERT,
      viewer(),
      AS_OF,
    );
    expect(inputs.weight).toBeNull();
  });
});

describe("the face-to-face visit", () => {
  it("reads the benefit periods and the PPS baseline and weight, and nothing else of module 6; it carries no benefit period", async () => {
    const ports = recertPorts();
    const inputs = await readDraftInputs(ports, F2F, viewer(), AS_OF);
    expect(ports.electionPeriods).toHaveBeenCalledOnce();
    expect(ports.levelOfCareOn).not.toHaveBeenCalled();
    expect(ports.attestedFaceToFace).not.toHaveBeenCalled();
    expect(ports.activeCertification).not.toHaveBeenCalled();
    expect(inputs).not.toHaveProperty("benefitPeriod");
    expect(inputs.weight).toMatchObject({ id: "w-2", baseline: { value: "130" } });
    expect(inputs.scaleReadings.find((r) => r.scaleType === "pps")?.baseline).toEqual({
      value: 80,
      recordedOn: "2026-10-16",
    });
  });
});

describe("the routine visit is read exactly as before S2", () => {
  it("reads none of the new sources and returns none of the new fields", async () => {
    const ports = recertPorts();
    const inputs = await readDraftInputs(ports, encounter(), viewer(), AS_OF);
    for (const name of [
      "electionPeriods",
      "levelOfCareOn",
      "attestedFaceToFace",
      "activeCertification",
      "weightReadings",
    ] as const) {
      expect(ports[name], name).not.toHaveBeenCalled();
    }
    expect(inputs).not.toHaveProperty("weight");
    expect(inputs).not.toHaveProperty("benefitPeriod");
    for (const reading of inputs.scaleReadings) expect(reading).not.toHaveProperty("baseline");
  });
});

describe("a module-6 or weight read that fails", () => {
  const failing = async (): Promise<never> => {
    throw new Error("synthetic upstream outage");
  };

  it.each([
    ["electionPeriods", "the benefit periods"],
    ["levelOfCareOn", "the level of care"],
    ["attestedFaceToFace", "the face-to-face encounter"],
    ["activeCertification", "the certification"],
    ["weightReadings", "the weights"],
  ] as const)(
    "%s is DRAFT_UNAVAILABLE (503) naming the read, never a draft short of that source",
    async (port, read) => {
      const error = await readDraftInputs(
        recertPorts({ [port]: failing }),
        RECERT,
        viewer(),
        AS_OF,
      ).catch((e: unknown) => e);
      expect(error).toMatchObject({ code: "DRAFT_UNAVAILABLE", statusCode: 503 });
      expect((error as Error).message).toContain(read);
      // The upstream message may carry PHI: it stays on the error's cause, never in the message that reaches a response.
      expect((error as Error).message).not.toContain("synthetic upstream outage");
    },
  );
});
