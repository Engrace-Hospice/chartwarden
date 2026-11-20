// apps/web/src/modules/05-patient — reading one recent note for the Clinical tab's "Recent Clinical Notes" (ADR-0114 VN-D30, S1 PR E3).
// Moved out of patient-clinical.tsx unchanged: the note's detail shape and the read that keeps a row whose Part 2 view could not be decided.
import type { ApiClient } from "@chartwarden/ui";
import type { SummarisedNote } from "./clinical-note-summary";
import type { PatientChartData } from "./patient-overview";

export interface Vitals {
  bpSystolic: number | null;
  bpDiastolic: number | null;
  heartRate: number | null;
  respiratoryRate: number | null;
  temperature: string | null;
  temperatureUnit: string | null;
  spo2: number | null;
  weight: string | null;
  weightUnit: string | null;
  capturedAt: string;
}
export interface EncounterDetail extends SummarisedNote {
  id: string;
  serviceDate: string;
  encounterType: string | null;
  discipline: string | null;
  status: string | null;
  authoredByUserId: string;
  vitals: Vitals | null;
}

/** The refusal of an encounter read whose Part 2 disclosure check could not be decided (M8; its own helper lives in 08-encounters). */
const NOTE_VIEW_UNAVAILABLE = "NOTE_VIEW_UNAVAILABLE";
const errorCodeOf = (error: unknown): string | undefined =>
  (error as { error?: { code?: string } } | null)?.error?.code;

type ListedEncounter = NonNullable<PatientChartData["encounters"]>[number];

/**
 * One recent note. A read refused 503 NOTE_VIEW_UNAVAILABLE (the Part 2 check could not be decided) keeps its row, from the chart's own
 * list, marked so the row can say so and offer a retry; any other failure is dropped as before.
 */
export async function readNote(
  client: ApiClient,
  listed: ListedEncounter,
): Promise<EncounterDetail | undefined> {
  try {
    const { data, error } = await client.GET("/api/v1/encounters/{encounterId}", {
      params: { path: { encounterId: listed.id } },
    });
    if (!error) return data as unknown as EncounterDetail;
    return errorCodeOf(error) === NOTE_VIEW_UNAVAILABLE
      ? { ...listed, finalDocumentation: null, vitals: null, viewUnavailable: true }
      : undefined;
  } catch {
    return undefined;
  }
}
