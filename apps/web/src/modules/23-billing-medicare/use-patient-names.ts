// apps/web/src/modules/23-billing-medicare — display names for the patients on a worklist. There is no batch patient
// endpoint, so names are fetched one by one with a small concurrency cap (never one burst per row), each id at most
// once, and a failed lookup falls back to a short id. The "already asked" set lives in a ref, so the effect depends
// only on the ids on screen, never on the names it fills in (no effect loop).
import type { ApiClient } from "@wardenx/ui";
import { useEffect, useRef, useState } from "react";

export interface PatientName {
  firstName?: string | null;
  lastName?: string | null;
}

const CONCURRENCY = 4;

export function patientLabel(p: PatientName | undefined, id: string): string {
  return p && (p.firstName || p.lastName)
    ? [p.lastName, p.firstName].filter(Boolean).join(", ")
    : `Patient ${id.slice(0, 8)}`;
}

export function usePatientNames(
  client: ApiClient,
  ids: readonly string[],
): Record<string, PatientName> {
  const [names, setNames] = useState<Record<string, PatientName>>({});
  const asked = useRef(new Set<string>());
  const key = [...new Set(ids)].sort().join(",");

  useEffect(() => {
    const missing = key.split(",").filter((id) => id && !asked.current.has(id));
    if (missing.length === 0) return;
    for (const id of missing) asked.current.add(id);
    let active = true;
    void (async () => {
      for (let i = 0; i < missing.length; i += CONCURRENCY) {
        const batch = missing.slice(i, i + CONCURRENCY);
        const settled = await Promise.allSettled(
          batch.map(async (id) => {
            const r = await client.GET("/api/v1/patients/{id}", { params: { path: { id } } });
            return [id, (r.data as PatientName | undefined) ?? {}] as const;
          }),
        );
        if (!active) return;
        const found = settled.flatMap((s) => (s.status === "fulfilled" ? [s.value] : []));
        if (found.length > 0) setNames((prev) => ({ ...prev, ...Object.fromEntries(found) }));
      }
    })();
    return () => {
      active = false;
    };
  }, [client, key]);

  return names;
}
