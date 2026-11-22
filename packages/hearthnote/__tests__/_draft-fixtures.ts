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

/**
 * S2: the sources the recertification and face-to-face templates read beyond S1's: scale readings (a PPS with the benefit period's first
 * reading as its baseline), a weight with its baseline, and the benefit period with its attested face-to-face and signed certification.
 * Day 35 of a 60-day period on the 2026-11-18 service date. A fresh copy every call.
 */
export function recertSources(): Pick<DraftInputs, "scaleReadings" | "weight" | "benefitPeriod"> {
  return {
    scaleReadings: [
      {
        id: "scale-pps-2",
        scaleType: "pps",
        value: 50,
        recordedAt: "2026-11-18T14:10:00Z",
        previous: { value: 60, recordedOn: "2026-11-10" },
        baseline: { value: 80, recordedOn: "2026-10-16" },
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
    weight: {
      id: "weight-2",
      recordedAt: "2026-11-18T14:05:00Z",
      recordedOn: "2026-11-18",
      value: "118.5",
      unit: "lb",
      baseline: { value: "130", recordedOn: "2026-10-16" },
      sudRelated: false,
    },
    benefitPeriod: {
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
    },
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

/**
 * S4: the social-work and chaplain templates' source: the open goals and active interventions of the discipline's plan in effect at the visit.
 * Four goals (one of each way of being stated) and three interventions (a frequency, none, and a blank one). Fresh copy per call.
 */
export function disciplinePlanSources(): Pick<DraftInputs, "disciplinePlan"> {
  return {
    disciplinePlan: {
      goals: [
        {
          id: "goal-b",
          goalText: "Name two ways to cope with the diagnosis",
          statedBy: null,
          sudRelated: false,
        },
        { id: "goal-a", goalText: "See my grandson", statedBy: "patient", sudRelated: false },
        {
          id: "goal-d",
          goalText: "Keep the farm in the family",
          statedBy: "agent",
          sudRelated: false,
        },
        {
          id: "goal-c",
          goalText: "Plan the memorial together",
          statedBy: "family",
          sudRelated: false,
        },
      ],
      interventions: [
        {
          id: "iv-b",
          interventionText: "Supportive counselling",
          frequencyText: "weekly",
          sudRelated: false,
        },
        {
          id: "iv-a",
          interventionText: "Caregiver resource referral",
          frequencyText: null,
          sudRelated: false,
        },
        { id: "iv-c", interventionText: "Legacy work", frequencyText: "  ", sudRelated: false },
      ],
    },
  };
}

/**
 * S5b: the IDG follow-up's source: the one action item the author linked the visit to (the meeting's org-local date, the decision KIND and the due date).
 * Synthetic ids and dates. Fresh copy per call.
 */
export function idgFollowUpSource(): Pick<DraftInputs, "idgFollowUp"> {
  return {
    idgFollowUp: {
      id: "idg-item-1",
      meetingOn: "2026-11-02",
      decisionKind: "referral",
      dueOn: "2026-11-20",
      sudRelated: false,
    },
  };
}

/** S2b: the admission visit's own sources (the orders in effect, the caregivers on record, the acknowledgment on file). Fresh copy per call. */
export function admissionSources(): Pick<
  DraftInputs,
  "activeMedications" | "caregivers" | "advanceDirective"
> {
  return {
    activeMedications: [
      {
        id: "order-morphine",
        drugName: "Morphine sulfate",
        strength: "20 mg/mL",
        doseForm: "oral solution",
        route: "oral",
        asNeeded: true,
        sudRelated: false,
      },
      {
        id: "order-senna",
        drugName: "Senna",
        strength: "8.6 mg",
        doseForm: "tablet",
        route: "oral",
        asNeeded: false,
        sudRelated: false,
      },
    ],
    caregivers: [
      {
        id: "caregiver-link-2",
        displayName: "Sam Okafor",
        relationship: "friend",
        isPrimary: false,
        sudRelated: false,
      },
      {
        id: "caregiver-link-1",
        displayName: "Alex Rivera",
        relationship: "spouse",
        isPrimary: true,
        sudRelated: false,
      },
    ],
    advanceDirective: { id: "consent-ad-1", sudRelated: false },
  };
}
