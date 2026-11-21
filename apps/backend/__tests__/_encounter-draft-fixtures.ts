// Fakes for the draft computation core's ports (S1 PR C2a). Synthetic ids and names only: no SSN, MBI or value
// copied from a real record. A fake seam behaves like the real one where the real one has a contract a test
// depends on (M9's series filters on `captured_at` with inclusive bounds).
import { VOCAB_VERSION } from "@chartwarden/narrative-vocab";
import type {
  MedicationOrderChange,
  MedicationOrderDto,
  RelevantCarePlanElements,
  ScaleSeriesPoint,
  ScaleType,
} from "@chartwarden/types";
import { type Mock, vi } from "vitest";
import type {
  DraftEncounter,
  DraftPorts,
  DraftReader,
  DraftViewer,
} from "../src/modules/08-encounters/drafting/ports";

export const ORG_ID = "00000000-0000-4000-8000-000000000001";
export const PATIENT_ID = "00000000-0000-4000-8000-000000000002";
export const ADMISSION_ID = "00000000-0000-4000-8000-000000000003";
export const ENCOUNTER_ID = "00000000-0000-4000-8000-000000000004";
export const NEW_YORK = "America/New_York";

/** 15:00 EST on 2026-11-18: the default encounter's service date is still in progress, so its visit time is now. */
export const NOW = new Date("2026-11-18T20:00:00.000Z");
export const NOW_ISO = NOW.toISOString();
/** An arbitrary visit time for tests that hand `readDraftInputs` its `asOf` directly. */
export const AS_OF = "2026-11-18T14:30:00.000Z";

export const encounter = (over: Partial<DraftEncounter> = {}): DraftEncounter => ({
  id: ENCOUNTER_ID,
  organizationId: ORG_ID,
  patientId: PATIENT_ID,
  admissionId: ADMISSION_ID,
  encounterType: "routine_visit",
  discipline: "rn",
  serviceDate: "2026-11-18",
  ...over,
});

export const viewer = (over: Partial<DraftViewer> = {}): DraftViewer => ({
  roles: ["rn"],
  membershipId: "00000000-0000-4000-8000-0000000000aa",
  ...over,
});

/** A viewer with the permissions a draft RECOMPUTE (finalize, sign, an addendum's) asks for: none unless a test gives some. */
export const reader = (
  over: Partial<DraftViewer> & { readonly permissions?: ReadonlySet<string> } = {},
): DraftReader => ({ ...viewer(over), permissions: over.permissions ?? new Set<string>() });

export const point = (id: string, capturedAt: string, score: number | null): ScaleSeriesPoint => ({
  assessmentId: id as never,
  capturedAt,
  score,
  scoreInterpretation: null,
  significantChange: false,
});

/** M9's `series` contract: this patient's points of one scale, captured within `[from, to]`, ascending. */
export function honestSeries(points: Partial<Record<ScaleType, readonly ScaleSeriesPoint[]>>) {
  return async (patientId: string, scaleType: ScaleType, from: string, to: string) => ({
    scaleType,
    patientId: patientId as never,
    from,
    to,
    points: (points[scaleType] ?? [])
      .filter((p) => Date.parse(p.capturedAt) >= Date.parse(from))
      .filter((p) => Date.parse(p.capturedAt) <= Date.parse(to))
      .slice()
      .sort((a, b) => Date.parse(a.capturedAt) - Date.parse(b.capturedAt)),
  });
}

export const order = (over: Partial<MedicationOrderDto> = {}): MedicationOrderDto =>
  ({
    id: "order-1",
    organizationId: ORG_ID,
    patientId: PATIENT_ID,
    drugName: "Morphine sulfate",
    isSudTreatment: false,
    ...over,
  }) as unknown as MedicationOrderDto;

export const change = (
  kind: MedicationOrderChange["kind"],
  at: string,
  over: Partial<MedicationOrderDto> = {},
): MedicationOrderChange => ({ kind, at, order: order(over) });

export const carePlan = (
  over: Partial<RelevantCarePlanElements> = {},
): RelevantCarePlanElements => ({
  planId: "plan-1" as never,
  patientId: PATIENT_ID as never,
  problems: [
    {
      problemId: "problem-1" as never,
      icd10Code: null,
      snomedCode: null,
      description: "Pain",
      kind: "symptom" as never,
      status: "active" as never,
      sudRelated: false,
    },
  ],
  goals: [
    {
      goalId: "goal-1" as never,
      problemId: "problem-1" as never,
      text: "Pain controlled at an acceptable level",
      source: "clinician" as never,
      status: "active" as never,
    },
  ],
  interventions: [
    {
      interventionId: "intervention-1" as never,
      problemId: "problem-1" as never,
      scopeText: "Repositioning schedule review",
      frequencyText: "each visit",
      discipline: "rn" as never,
      status: "active" as never,
    },
  ],
  redacted: false,
  ...over,
});

export const EMPTY_SELECTION = {
  selection: {
    templateKey: "routine_visit:rn",
    vocabVersion: VOCAB_VERSION,
    encounterType: "routine_visit",
    discipline: "rn",
    sections: [],
  },
  context: { patient: "Patient", serviceDate: "2026-11-18" },
} as const;

/** The empty stored selection of another template than the routine visit's: it names the template it was made for. */
export const selectionFor = (encounterType: string, discipline: string) =>
  ({
    selection: {
      ...EMPTY_SELECTION.selection,
      templateKey: `${encounterType}:${discipline}`,
      encounterType,
      discipline,
    },
    context: EMPTY_SELECTION.context,
  }) as never;

type Spied = { readonly [K in keyof DraftPorts]: Mock<DraftPorts[K]> };

/** Every port, as a spy (an override is wrapped too, so a test can still assert on it) over a benign default
 * (no care plan, no readings, no vitals, no changes, no wounds, no Part 2, no previous visit). */
export function fakePorts(over: Partial<DraftPorts> = {}): Spied {
  const defaults: DraftPorts = {
    carePlanAsOf: async () => null,
    scaleSeries: honestSeries({}),
    medicationChangesBetween: async () => [],
    electionPeriods: async () => [],
    levelOfCareOn: async (admissionId, on) => ({
      admissionId: admissionId as never,
      range: { from: on as never, to: on as never },
      daysByLevel: {
        routine_home_care: 0,
        continuous_home_care: 0,
        inpatient_respite_care: 0,
        general_inpatient_care: 0,
      },
    }),
    attestedFaceToFace: async () => null,
    activeCertification: async () => null,
    weightReadings: async () => [],
    activeMedicationsAsOf: async () => [],
    caregiversOn: async () => [],
    advanceDirectiveAcknowledgment: async () => null,
    recordedWounds: async () => [],
    part2DisclosureAllowed: async () => false,
    organizationTimeZone: async () => NEW_YORK,
    previousSignedVisitAt: async () => null,
    latestVitals: async () => null,
    removedCarePlanElementIds: async () => new Set<string>(),
    loadSelection: async () => EMPTY_SELECTION,
  };
  const merged: DraftPorts = { ...defaults, ...over };
  return Object.fromEntries(
    Object.entries(merged).map(([name, impl]) => [name, vi.fn(impl as never)]),
  ) as unknown as Spied;
}
