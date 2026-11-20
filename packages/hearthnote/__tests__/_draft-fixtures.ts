// packages/hearthnote/__tests__/_draft-fixtures.ts — a fixed, synthetic input for the draft compiler tests.
// Synthetic names and ids only: no SSN, MBI, or value copied from a real record.
import { createHash } from "node:crypto";
import { VOCAB_VERSION } from "@chartwarden/narrative-vocab";
import type { DraftDeps, DraftInputs } from "../src/index";

export const AS_OF = "2026-11-18T14:30:00Z";

/** The backend will inject Node crypto the same way; the package itself stays pure. */
export const DEPS: DraftDeps = {
  sha256Hex: (canonical) => createHash("sha256").update(canonical, "utf8").digest("hex"),
};

/** A fresh, mutable copy every call, so a test can change one field without touching another test. */
export function baseInputs(): DraftInputs {
  return {
    encounterType: "routine_visit",
    discipline: "rn",
    asOf: AS_OF,
    context: { patient: "Test Patient One", serviceDate: "2026-11-18" },
    selection: {
      templateKey: "routine_visit:rn",
      vocabVersion: VOCAB_VERSION,
      encounterType: "routine_visit",
      discipline: "rn",
      sections: [
        { sectionId: "chief_concern", entries: [{ code: "nv.cc.routine_visit" }] },
        { sectionId: "assessment", entries: [{ code: "nv.cv.stable" }] },
      ],
    },
    carePlan: {
      goals: [
        {
          id: "goal-b",
          goalText: "Pain controlled at a level the patient finds acceptable.",
          progressStatement: "Pain reported at 3 of 10 at the last two visits",
          sudRelated: false,
        },
        {
          id: "goal-a",
          goalText: "Caregiver demonstrates safe repositioning",
          progressStatement: null,
          sudRelated: false,
        },
      ],
      interventions: [
        {
          id: "intervention-1",
          interventionText: "Skin assessment and repositioning schedule review",
          sudRelated: false,
        },
      ],
    },
    scaleReadings: [
      {
        id: "scale-pps-2",
        scaleType: "pps",
        value: 50,
        recordedAt: "2026-11-18T14:10:00Z",
        previous: { value: 60, recordedOn: "2026-11-10" },
        sudRelated: false,
      },
      {
        id: "scale-esas-tiredness",
        scaleType: "esas_r",
        label: "tiredness",
        value: 5,
        recordedAt: "2026-11-18T14:12:00Z",
        previous: null,
        sudRelated: false,
      },
      {
        id: "scale-esas-pain",
        scaleType: "esas_r",
        label: "pain",
        value: 4,
        recordedAt: "2026-11-18T14:12:00Z",
        previous: { value: 6, recordedOn: "2026-11-10" },
        sudRelated: false,
      },
    ],
    vitals: {
      id: "vitals-1",
      recordedAt: "2026-11-18T14:05:00Z",
      bpSystolic: 118,
      bpDiastolic: 76,
      heartRate: 72,
      respiratoryRate: 16,
      temperature: "98.6",
      temperatureUnit: "f",
      spo2: 98,
      painScore: 3,
      sudRelated: false,
    },
    medicationChanges: [
      {
        id: "med-change-1",
        drugName: "morphine sulfate oral solution",
        change: "changed",
        changedAt: "2026-11-12T09:00:00Z",
        changedOn: "2026-11-12",
        sudRelated: false,
      },
    ],
  };
}

/** Freeze a value and everything under it. */
export function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/** The same data with every object's keys inserted in reverse order. */
export function reverseKeys<T>(value: T): T {
  if (Array.isArray(value)) return value.map(reverseKeys) as T;
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .reverse()
        .map(([k, v]) => [k, reverseKeys(v)]),
    ) as T;
  }
  return value;
}
