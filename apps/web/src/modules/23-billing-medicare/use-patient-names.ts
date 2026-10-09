// apps/web/src/modules/23-billing-medicare — display names for the patients on a worklist. There is no batch patient
// endpoint, so names are fetched one per request through ONE queue per hook with a hard concurrency cap, however many
// renders ask. Bookkeeping lives in refs tied to the ids, not to any effect run: an id is "in flight" from the moment it
// is queued until it has a name or has used up its attempts. A failed lookup is retried by a timer with exponential
// backoff (so it needs no re-render and a burst of renders cannot burn the attempts), at most MAX_ATTEMPTS times, then
// falls back to a short id label. Results are always applied; only an unmount stops the work. StrictMode's
// mount/unmount/mount and a change of the ids mid-fetch can never strand a name.
import type { ApiClient } from "@wardenx/ui";
import { useEffect, useRef, useState } from "react";

export interface PatientName {
  firstName?: string | null;
  lastName?: string | null;
}

export const PATIENT_NAME_CONCURRENCY = 4;
export const PATIENT_NAME_MAX_ATTEMPTS = 3;
export const PATIENT_NAME_BACKOFF_MS = 400;

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
  const inFlight = useRef(new Set<string>()); // queued, running, or waiting out a backoff
  const attempts = useRef(new Map<string, number>());
  const queue = useRef<string[]>([]);
  const running = useRef(0);
  const timers = useRef(new Map<ReturnType<typeof setTimeout>, string>());
  const alive = useRef(true);
  const pump = useRef<() => void>(() => undefined);

  pump.current = () => {
    while (
      alive.current &&
      running.current < PATIENT_NAME_CONCURRENCY &&
      queue.current.length > 0
    ) {
      const id = queue.current.shift() as string;
      running.current += 1;
      void (async () => {
        let name: PatientName | null = null;
        try {
          const r = await client.GET("/api/v1/patients/{id}", { params: { path: { id } } });
          name = (r.data as PatientName | undefined) ?? null;
        } catch {
          name = null;
        }
        running.current -= 1;
        if (name) {
          have.current.add(id);
          inFlight.current.delete(id);
          if (alive.current) {
            const found = name;
            setNames((prev) => ({ ...prev, [id]: found }));
          }
        } else {
          const n = (attempts.current.get(id) ?? 0) + 1;
          attempts.current.set(id, n);
          if (n >= PATIENT_NAME_MAX_ATTEMPTS || !alive.current) {
            inFlight.current.delete(id);
          } else {
            const timer = setTimeout(
              () => {
                timers.current.delete(timer);
                if (!alive.current) {
                  inFlight.current.delete(id);
                  return;
                }
                queue.current.push(id);
                pump.current();
              },
              PATIENT_NAME_BACKOFF_MS * 2 ** (n - 1),
            );
            timers.current.set(timer, id);
          }
        }
        pump.current();
      })();
    }
  };

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      for (const [timer, id] of timers.current) {
        clearTimeout(timer);
        inFlight.current.delete(id);
      }
      timers.current.clear();
      // Queued ids are released so a remount asks again; running fetches settle on their own.
      for (const id of queue.current) inFlight.current.delete(id);
      queue.current = [];
    };
  }, []);

  // After every render: queue whatever is wanted and not yet known, in flight, or out of attempts.
  useEffect(() => {
    for (const id of new Set(ids)) {
      if (have.current.has(id) || inFlight.current.has(id)) continue;
      if ((attempts.current.get(id) ?? 0) >= PATIENT_NAME_MAX_ATTEMPTS) continue;
      inFlight.current.add(id);
      queue.current.push(id);
    }
    pump.current();
  });

  return names;
}
