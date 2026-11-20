// apps/web/src/modules/08-encounters — what the encounter detail screen reads: the encounter, then (once it is known) the cosignature, the
// patient, the care plan, the assessments and the stored note preview. No React state here; the screen applies the result. Moved out of
// encounter-read.tsx unchanged (S1 React review: that file is far over the size ceiling and may only shrink).
import type { ApiClient } from "@chartwarden/ui";
import type { AddendumRow } from "./addenda-api";
import { NOTE_VIEW_UNAVAILABLE_DESCRIPTION, isNoteViewUnavailable } from "./note-view-unavailable";
import type { FinalDocumentationView, NoteHistory } from "./signed-note-model";

export interface Encounter {
  id: string;
  patientId: string;
  admissionId: string;
  visitId: string | null;
  /** The note's author (membership id): the note's author cannot cosign an amendment of it. */
  authoredByUserId: string;
  encounterType: string;
  discipline: string;
  serviceDate: string;
  status: string;
  lateEntryTier: string;
  version: number;
  isF2f: boolean;
  signedAt: string | null;
  cosignedAt: string | null;
  /** How the visit was delivered, as seeded or confirmed; null = unknown. */
  visitModality?: string | null;
  /** True only once a clinician confirmed `visitModality`; an unconfirmed one is the scheduler's guess. */
  visitModalityConfirmed?: boolean;
  /** An M18 EVV bracket is on file, so the sign ceremony takes no typed times. */
  evvBracketPresent?: boolean;
  selections: Record<string, unknown> | null;
  finalDocumentation: string | null;
  /** The signed note as structured data for this viewer (a withheld part has no text); null = nothing pinned, absent = an older API. */
  finalDocumentationView?: FinalDocumentationView | null;
  noteHistory?: NoteHistory | null;
  vitals: Record<string, unknown> | null;
  mileage: Record<string, unknown> | null;
  carePlanLinks: CarePlanLink[];
  addenda: AddendumRow[];
}

export interface PatientSummary {
  mrn: string;
  lastName: string;
  firstName: string;
  dob: string;
  status: string;
}

export interface CarePlanProblem {
  problemId: string;
  description: string;
  status: string;
}

export interface CarePlanGoal {
  goalId: string;
  problemId: string;
  text: string;
  status: string;
}

export interface CarePlanIntervention {
  interventionId: string;
  problemId: string;
  scopeText: string;
  frequencyText: string;
  discipline: string;
  status: string;
}

export interface CarePlanRelevant {
  problems: CarePlanProblem[];
  goals: CarePlanGoal[];
  interventions: CarePlanIntervention[];
  redacted: boolean;
}

export interface CarePlanLink {
  linkId?: string;
  problemId: string | null;
  goalId: string | null;
  interventionId: string | null;
}

export interface AssessmentRow {
  id: string;
  assessmentId?: string;
  scaleType?: string;
  kind?: string;
  status: string;
  sourceEncounterId?: string | null;
  capturedAt?: string;
  assessmentIdLabel?: string;
}

/** The vitals form's fields, every one text (what an input holds). */
export interface VitalsForm {
  bpSystolic: string;
  bpDiastolic: string;
  heartRate: string;
  respiratoryRate: string;
  temperature: string;
  temperatureUnit: string;
  spo2: string;
  painScore: string;
  painScale: string;
}

/** The mileage form's fields, every one text. */
export interface MileageForm {
  odometerStart: string;
  odometerEnd: string;
  milesDriven: string;
  source: string;
  manualOverrideReason: string;
}

export type EncounterRead =
  | {
      readonly ok: false;
      /** The failed read is the Part 2 note view that could not be decided (503): the screen offers a retry. */
      readonly noteViewUnavailable: boolean;
      readonly message: string;
    }
  | {
      readonly ok: true;
      readonly encounter: Encounter;
      /** Null when the patient could not be read: the screen keeps the one it holds. */
      readonly patient: PatientSummary | null;
      readonly cosignStatus: string | null;
      readonly carePlan: CarePlanRelevant | null;
      readonly assessments: AssessmentRow[];
      readonly hopeAssessments: AssessmentRow[];
      readonly noteText: string;
      /** Null when the encounter holds none: the screen keeps the form as it is. */
      readonly vitals: VitalsForm | null;
      readonly mileage: MileageForm | null;
    };

export async function readEncounter(
  client: ApiClient,
  encounterId: string,
  patientId: string | undefined,
): Promise<EncounterRead> {
  const { data, error: err } = await client.GET("/api/v1/encounters/{encounterId}", {
    params: {
      path: {
        encounterId,
      },
    },
  });

  if (err || !data?.id) {
    const noteViewUnavailable = isNoteViewUnavailable(err);
    return {
      ok: false,
      noteViewUnavailable,
      message: noteViewUnavailable
        ? NOTE_VIEW_UNAVAILABLE_DESCRIPTION
        : "Could not load the encounter.",
    };
  }

  const selections =
    (
      data as {
        selections?: Record<string, unknown> | null;
      }
    ).selections ?? null;

  const loadedVitals = (
    data as {
      vitals?: Record<string, unknown> | null;
    }
  ).vitals;

  const loadedMileage = (
    data as {
      mileage?: Record<string, unknown> | null;
    }
  ).mileage;

  const encounter: Encounter = {
    id: data.id,
    patientId: data.patientId,
    admissionId: data.admissionId,
    visitId: data.visitId ?? null,
    authoredByUserId: data.authoredByUserId,
    encounterType: data.encounterType,
    discipline: data.discipline,
    serviceDate: data.serviceDate,
    status: data.status,
    lateEntryTier: data.lateEntryTier,
    version: data.version,
    isF2f: data.isF2f,
    signedAt: data.signedAt ?? null,
    cosignedAt: data.cosignedAt ?? null,
    visitModality: data.visitModality ?? null,
    visitModalityConfirmed: data.visitModalityConfirmed === true,
    evvBracketPresent: data.evvBracketPresent === true,
    selections,
    finalDocumentation:
      (
        data as {
          finalDocumentation?: string | null;
        }
      ).finalDocumentation ?? null,
    finalDocumentationView: data.finalDocumentationView,
    noteHistory: data.noteHistory,
    vitals: loadedVitals ?? null,
    mileage: loadedMileage ?? null,
    carePlanLinks:
      (
        data as {
          carePlanLinks?: CarePlanLink[];
        }
      ).carePlanLinks ?? [],
    addenda: (data as { addenda?: AddendumRow[] }).addenda ?? [],
  };

  const pid = patientId ?? data.patientId;

  const [cos, pat, cp, ass, hope, sel] = await Promise.all([
    client.GET("/api/v1/encounters/{encounterId}/cosignature", {
      params: {
        path: {
          encounterId,
        },
      },
    }),

    client.GET("/api/v1/patients/{id}", {
      params: {
        path: {
          id: pid,
        },
      },
    }),

    client.GET(
      "/api/v1/internal/care-plan/relevant-elements" as never,
      {
        params: {
          query: {
            patientId: data.patientId,
            admissionId: data.admissionId,
            encounterType: data.encounterType,
            discipline: data.discipline,
          },
        },
      } as never,
    ),

    client.GET("/api/v1/patients/{patientId}/assessments", {
      params: {
        path: {
          patientId: data.patientId,
        },
      },
    } as never),

    client.GET("/api/v1/patients/{patientId}/hope/assessments", {
      params: {
        path: {
          patientId: data.patientId,
        },
      },
    } as never),

    // #114 — the stored HearthNote tree, assembled (Layer-1). The note is authored in the composer;
    // this screen shows what it currently reads as.
    client.GET("/api/v1/encounters/{encounterId}/selections", {
      params: { path: { encounterId } },
    }),
  ]);

  return {
    ok: true,
    encounter,
    patient: pat.data ? (pat.data as PatientSummary) : null,
    cosignStatus: cos.data?.status ?? null,
    carePlan: (cp.data ?? null) as CarePlanRelevant | null,
    assessments: (
      (
        ass.data as
          | {
              assessments?: AssessmentRow[];
            }
          | undefined
      )?.assessments ?? []
    ).filter((row) => row.sourceEncounterId === encounterId),
    hopeAssessments: ((
      hope.data as
        | {
            assessments?: AssessmentRow[];
          }
        | undefined
    )?.assessments ?? []) as AssessmentRow[],
    // A preview only once something is documented — an empty tree still assembles the template's
    // headings, which would read as a note that says nothing.
    noteText: sel.data?.sections?.some((s) => s.entries.length > 0 || Boolean(s.freeText))
      ? (sel.data?.layer1Preview ?? "")
      : "",
    vitals: loadedVitals
      ? {
          bpSystolic: String(loadedVitals.bpSystolic ?? ""),
          bpDiastolic: String(loadedVitals.bpDiastolic ?? ""),
          heartRate: String(loadedVitals.heartRate ?? ""),
          respiratoryRate: String(loadedVitals.respiratoryRate ?? ""),
          temperature: String(loadedVitals.temperature ?? ""),
          temperatureUnit: String(loadedVitals.temperatureUnit ?? "f"),
          spo2: String(loadedVitals.spo2 ?? ""),
          painScore: String(loadedVitals.painScore ?? ""),
          painScale: String(loadedVitals.painScale ?? "nrs_0_10"),
        }
      : null,
    mileage: loadedMileage
      ? {
          odometerStart: String(loadedMileage.odometerStart ?? ""),
          odometerEnd: String(loadedMileage.odometerEnd ?? ""),
          milesDriven: String(loadedMileage.milesDriven ?? ""),
          source: String(loadedMileage.source ?? "manual_override"),
          manualOverrideReason: String(loadedMileage.manualOverrideReason ?? ""),
        }
      : null,
  };
}
