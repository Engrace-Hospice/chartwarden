// apps/web/src/shell — one shared "resolve ids to display names" engine behind usePatientNames /
// usePhysicianNames. There is no batch endpoint, so every id is one request; to keep a worklist from
// fanning out, requests are (1) cached per api client + kind + id as a promise (remounts and sibling hook
// instances share one request), and (2) capped at NAME_LOOKUP_CONCURRENCY in flight at a time.
// The cache is a WeakMap keyed by the client instance, so it never outlives or crosses a session's client.
// A lookup that settles (even to `null`, "not readable") is cached; one that THROWS or times out is dropped
// from the cache, shown as unavailable, and retried once after NAME_RETRY_MS.
import type { ApiClient } from "@wardenx/ui";
import { useApiClient } from "@wardenx/ui";
import { useEffect, useRef, useState } from "react";

export const NAME_LOOKUP_CONCURRENCY = 6;
export const NAME_LOOKUP_TIMEOUT_MS = 15_000;
export const NAME_RETRY_MS = 5_000;

const FAILED: unique symbol = Symbol("name-lookup-failed");

function withTimeout<T>(task: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("name lookup timed out")), NAME_LOOKUP_TIMEOUT_MS);
  });
  return Promise.race([task, timeout]).finally(() => clearTimeout(timer));
}

type PerClient = Map<string, Promise<unknown>>;
let caches = new WeakMap<ApiClient, PerClient>();
const EMPTY: Readonly<Record<string, never>> = {};
let running = 0;
const waiting: (() => void)[] = [];

/** Tests only: forget every cached lookup and any queued work. */
export function resetResolvedNamesForTests(): void {
  caches = new WeakMap();
  running = 0;
  waiting.length = 0;
}

async function withSlot<T>(task: () => Promise<T>): Promise<T> {
  if (running >= NAME_LOOKUP_CONCURRENCY) await new Promise<void>((go) => waiting.push(go));
  running += 1;
  try {
    return await task();
  } finally {
    running -= 1;
    waiting.shift()?.();
  }
}

function lookup<T>(
  client: ApiClient,
  kind: string,
  id: string,
  fetchOne: (client: ApiClient, id: string) => Promise<T | null>,
): Promise<T | null | typeof FAILED> {
  let perClient = caches.get(client);
  if (!perClient) {
    perClient = new Map();
    caches.set(client, perClient);
  }
  const key = `${kind}:${id}`;
  const hit = perClient.get(key) as Promise<T | null | typeof FAILED> | undefined;
  if (hit) return hit;
  const mine = perClient;
  const pending = withSlot(() => withTimeout(fetchOne(client, id))).catch((): typeof FAILED => {
    mine.delete(key); // a failed lookup is not an answer: let a retry or later mount try again
    return FAILED;
  });
  mine.set(key, pending);
  return pending;
}

/**
 * Keyed by id: absent = still loading, `null` = the lookup settled with nothing readable (or failed; a failure
 * is retried once). `kind` namespaces the cache so two id spaces never collide.
 */
export function useResolvedNames<T>(
  kind: string,
  ids: readonly string[],
  fetchOne: (client: ApiClient, id: string) => Promise<T | null>,
): Readonly<Record<string, T | null>> {
  const client = useApiClient();
  // Names belong to the client that resolved them: a new client (re-login, tenant switch) starts empty.
  const [state, setState] = useState<{
    client: ApiClient;
    names: Readonly<Record<string, T | null>>;
  }>({
    client,
    names: {},
  });
  const retryTimers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const retried = useRef(new Set<string>());
  const names = state.client === client ? state.names : EMPTY;
  const missing = [...new Set(ids)]
    .filter((id) => id && !(id in names))
    .sort()
    .join(",");

  // biome-ignore lint/correctness/useExhaustiveDependencies: `fetchOne` is a stable module-level function per hook
  useEffect(() => {
    if (!missing) return;
    let active = true;
    const store = (id: string, value: T | null) =>
      setState((prev) => {
        const base = prev.client === client ? prev.names : EMPTY;
        return id in base ? prev : { client, names: { ...base, [id]: value } };
      });
    for (const id of missing.split(",")) {
      void lookup(client, kind, id, fetchOne).then((value) => {
        if (!active) return;
        if (value !== FAILED) return store(id, value);
        store(id, null);
        if (retried.current.has(`${kind}:${id}`)) return;
        retried.current.add(`${kind}:${id}`);
        // retry once: forget the failure so the id counts as missing again
        retryTimers.current.push(
          setTimeout(() => {
            setState((prev) => {
              if (prev.client !== client || !(id in prev.names)) return prev;
              const { [id]: _failed, ...rest } = prev.names;
              return { client, names: rest };
            });
          }, NAME_RETRY_MS),
        );
      });
    }
    return () => {
      active = false;
    };
  }, [client, kind, missing]);

  // retry timers outlive a single effect run (the failed id leaves `missing` at once); only unmount cancels them
  useEffect(() => {
    const timers = retryTimers.current;
    return () => {
      for (const t of timers) clearTimeout(t);
    };
  }, []);

  return names;
}
