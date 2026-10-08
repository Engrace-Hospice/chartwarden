// apps/web/src/shell — patient display names for a worklist whose rows carry only a `patientId`. One
// `GET /api/v1/patients/{id}` per distinct id on screen (the same read the census, discharge and transfer-notice
// worklists make), so the M5 patient read stays the only place a name comes from and the caller's own scope applies:
// a patient the caller cannot read resolves to `null` and the screen falls back to a short id.
import { useApiClient } from "@wardenx/ui";
import { useEffect, useState } from "react";

export interface PatientNameEntry {
  /** "Last, First". */
  readonly name: string;
  readonly mrn: string | null;
}

/** Keyed by patient id: absent = still loading, `null` = not readable (fall back to the id). */
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

export function usePatientNames(ids: readonly string[]): PatientNames {
  const client = useApiClient();
  const [names, setNames] = useState<PatientNames>({});
  const missing = [...new Set(ids)]
    .filter((id) => id && !(id in names))
    .sort()
    .join(",");

  useEffect(() => {
    if (!missing) return;
    let active = true;
    void Promise.all(
      missing.split(",").map((id) =>
        client
          .GET("/api/v1/patients/{id}", { params: { path: { id } } })
          .then((r) => [id, toPatientNameEntry(r.data)] as const)
          .catch(() => [id, null] as const),
      ),
    ).then((pairs) => {
      if (active) setNames((prev) => ({ ...prev, ...Object.fromEntries(pairs) }));
    });
    return () => {
      active = false;
    };
  }, [client, missing]);

  return names;
}
