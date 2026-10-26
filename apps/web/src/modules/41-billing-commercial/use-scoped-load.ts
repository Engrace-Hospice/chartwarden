// apps/web/src/modules/41-billing-commercial — one scoped read with stale-while-revalidate, shared by the screens that read per scope
// (entity + patient + plan). The load is keyed by its scope: another scope's rows never render, not even for the render before the
// effect runs. A reload of the SAME scope keeps its data on screen, and a failed one keeps it with `failed` set (the caller shows a
// non-destructive alert); only a first load that fails is an `error`.
import { useEffect, useRef, useState } from "react";

export type ScopedLoad<T> =
  | { readonly status: "idle" }
  | { readonly status: "loading" }
  | { readonly status: "error" }
  | { readonly status: "ready"; readonly key: string; readonly data: T; readonly failed: boolean };

export interface ReadResult<T> {
  readonly data?: T | undefined;
  readonly error?: unknown;
}

const failedLoad = <T>(prev: ScopedLoad<T>, scopeKey: string): ScopedLoad<T> =>
  prev.status === "ready" && prev.key === scopeKey
    ? { ...prev, failed: true }
    : { status: "error" };

/** `scopeKey` null means "nothing chosen yet": idle, and no request is made. `reloadKey` is a retry trigger. */
export function useScopedLoad<T>(
  scopeKey: string | null,
  read: () => Promise<ReadResult<T>>,
  reloadKey: number,
): ScopedLoad<T> {
  const [raw, setRaw] = useState<ScopedLoad<T>>({ status: "idle" });
  const readRef = useRef(read);
  readRef.current = read;

  // biome-ignore lint/correctness/useExhaustiveDependencies: reloadKey is a retry trigger, not a value the effect reads.
  useEffect(() => {
    if (scopeKey === null) {
      setRaw({ status: "idle" });
      return;
    }
    let active = true;
    setRaw((prev) =>
      prev.status === "ready" && prev.key === scopeKey
        ? { ...prev, failed: false }
        : { status: "loading" },
    );
    void readRef
      .current()
      .then(({ data, error }) => {
        if (!active) return;
        setRaw((prev) =>
          error || !data
            ? failedLoad(prev, scopeKey)
            : { status: "ready", key: scopeKey, data, failed: false },
        );
      })
      .catch(() => {
        if (active) setRaw((prev) => failedLoad(prev, scopeKey));
      });
    return () => {
      active = false;
    };
  }, [scopeKey, reloadKey]);

  if (scopeKey === null) return { status: "idle" };
  return raw.status === "ready" && raw.key !== scopeKey ? { status: "loading" } : raw;
}
