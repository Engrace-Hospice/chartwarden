// apps/web/src/modules/23-billing-medicare — display names for the patients on a worklist. There is no batch patient
// endpoint, so names are fetched one by one with a small concurrency cap (never one burst per row). Bookkeeping lives
// in refs and is tied to the ids, NOT to any one effect run: an id is "in flight" while its fetch is pending, "have"
// once a name arrived, and goes back to "wanted" if the fetch failed (retried on a later render, a few times at most).
// Results are always applied; only an unmount stops the loop — so StrictMode's mount/unmount/mount and a change of the
// ids mid-fetch can never strand a name. A failed lookup falls back to a short id label.
import type { ApiClient } from "@wardenx/ui";
import { useEffect, useRef, useState } from "react";

export interface PatientName {
  firstName?: string | null;
  lastName?: string | null;
}

const CONCURRENCY = 4;
const MAX_ATTEMPTS = 3;

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
  const have = useRef(new Set<string>());
  const inFlight = useRef(new Set<string>());
  const attempts = useRef(new Map<string, number>());
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // Runs after every render: cheap (it only looks at refs) and it is what retries a failed lookup.
  useEffect(() => {
    const todo = [...new Set(ids)].filter(
      (id) =>
        !have.current.has(id) &&
        !inFlight.current.has(id) &&
        (attempts.current.get(id) ?? 0) < MAX_ATTEMPTS,
    );
    if (todo.length === 0) return;
    for (const id of todo) inFlight.current.add(id);
    void (async () => {
      for (let i = 0; i < todo.length; i += CONCURRENCY) {
        if (!alive.current) {
          for (const id of todo.slice(i)) inFlight.current.delete(id);
          return;
        }
        const batch = todo.slice(i, i + CONCURRENCY);
        const settled = await Promise.allSettled(
          batch.map(async (id) => {
            const r = await client.GET("/api/v1/patients/{id}", { params: { path: { id } } });
            if (!r.data) throw new Error("patient lookup failed");
            return [id, r.data as PatientName] as const;
          }),
        );
        const found: (readonly [string, PatientName])[] = [];
        settled.forEach((s, k) => {
          const id = batch[k] as string;
          inFlight.current.delete(id);
          if (s.status === "fulfilled") {
            have.current.add(id);
            found.push(s.value);
          } else {
            attempts.current.set(id, (attempts.current.get(id) ?? 0) + 1);
          }
        });
        if (alive.current && found.length > 0) {
          setNames((prev) => ({ ...prev, ...Object.fromEntries(found) }));
        }
      }
    })();
  });

  return names;
}
