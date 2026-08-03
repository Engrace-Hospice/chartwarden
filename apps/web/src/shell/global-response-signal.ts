// apps/web/src/shell — global HTTP-status signal (TASK-033). The API client (`@wardenx/ui`,
// leaf-safe, no router access) reports every response's status via `onResponseStatus`; this module
// turns that into a tiny external store a router-connected component can subscribe to and act on
// (401 → /expired, 503 → /maintenance). Kept outside React so it can be fed from `main.tsx` before
// the router exists, and read with `useSyncExternalStore` from anywhere inside it.

export type GlobalResponseSignal = { kind: "session-expired" | "service-unavailable" } | null;

type Listener = () => void;

let current: GlobalResponseSignal = null;
const listeners = new Set<Listener>();

/** Map an observed HTTP status to a shell-level signal, or null for statuses the shell ignores. */
export function signalForStatus(status: number): GlobalResponseSignal {
  if (status === 401) return { kind: "session-expired" };
  if (status === 503) return { kind: "service-unavailable" };
  return null;
}

export function setGlobalResponseSignal(signal: GlobalResponseSignal): void {
  current = signal;
  for (const listener of listeners) listener();
}

export function getGlobalResponseSignal(): GlobalResponseSignal {
  return current;
}

export function subscribeGlobalResponseSignal(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
