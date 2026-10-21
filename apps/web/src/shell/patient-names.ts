// apps/web/src/shell — patient display names for a worklist whose rows carry only a `patientId`. One
// `GET /api/v1/patients/{id}` per distinct id on screen (the same read the census, discharge and transfer-notice
// worklists make), so the M5 patient read stays the only place a name comes from and the caller's own scope applies:
// a patient the caller cannot read resolves to `null` and callers show a neutral "Patient" label (never the id).
import type { ApiClient } from "@chartwarden/ui";
import { useResolvedNames } from "./resolved-names";

export interface PatientNameEntry {
  /** "Last, First". */
  readonly name: string;
  readonly mrn: string | null;
}

/** Keyed by patient id: absent = still loading, `null` = not readable (callers show "Patient"). */
export type PatientNames = Readonly<Record<string, PatientNameEntry | null>>;

interface PatientNameWire {
  readonly firstName?: string | null;
  readonly lastName?: string | null;
  readonly mrn?: string | null;
}

export function toPatientNameEntry(p: PatientNameWire | null | undefined): PatientNameEntry | null {
  const name = [p?.lastName, p?.firstName].filter((s) => s && s.trim().length > 0).join(", ");
  return name ? { name, mrn: p?.mrn || null } : null;
}

async function fetchPatientName(client: ApiClient, id: string): Promise<PatientNameEntry | null> {
  const r = await client.GET("/api/v1/patients/{id}", { params: { path: { id } } });
  return toPatientNameEntry(r.data);
}

export function usePatientNames(ids: readonly string[]): PatientNames {
  return useResolvedNames("patient", ids, fetchPatientName);
}
