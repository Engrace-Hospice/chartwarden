// packages/ui/src/web/hooks — one read: loading, the refusal as an `OpsFailure`, and a reload. A response that arrives after a newer
// request (or after the screen is gone) never writes state. `key` names the query: a new key loads again, and `reload(true)` refreshes
// quietly (the data stays on screen, no spinner). Hoisted from the admin onboarding wizard so the tenant wizard reads the same way;
// each caller passes its own `OpsErrorCopy` (operator voice in admin, tenant voice in web).
import { useCallback, useEffect, useRef, useState } from "react";
import {
  type OpsErrorCopy,
  type OpsFailure,
  describeOpsError,
} from "../../core/ops-write/ops-error";
import { useRequestGuard } from "./use-request-guard";

interface FetchResult<T> {
  readonly data?: T;
  readonly error?: unknown;
  readonly response?: { readonly status: number };
}

export interface Loaded<T> {
  readonly data: T | null;
  readonly failure: OpsFailure | null;
  /** The last QUIET refresh failed: the data on screen is what was loaded before, and may be out of date. Cleared by the next success. */
  readonly stale: boolean;
  readonly loading: boolean;
  readonly reload: (silent?: boolean) => Promise<void>;
}

export function useLoad<T>(
  key: string,
  load: () => Promise<FetchResult<T>>,
  copy: OpsErrorCopy,
): Loaded<T> {
  const guard = useRequestGuard();
  const loadRef = useRef(load);
  loadRef.current = load;
  const copyRef = useRef(copy);
  copyRef.current = copy;
  const keyRef = useRef(key);
  keyRef.current = key;
  // The data is stored WITH the key it was loaded for and shown only under that key: when `key` changes (another tenant, with no
  // remount) the old tenant's data is never rendered, not even for the one frame before the effect below clears it.
  const [loaded, setLoaded] = useState<{ key: string; data: T | null } | null>(null);
  const data = loaded !== null && loaded.key === key ? loaded.data : null;
  const [failure, setFailure] = useState<OpsFailure | null>(null);
  const [loading, setLoading] = useState(true);
  const [stale, setStale] = useState(false);

  const reload = useCallback(
    async (silent = false) => {
      const isCurrent = guard();
      const requestKey = keyRef.current;
      if (!silent) {
        setLoading(true);
        setFailure(null);
        setStale(false);
      }
      let result: FetchResult<T>;
      try {
        result = await loadRef.current();
      } catch {
        if (!isCurrent()) return;
        if (silent) setStale(true);
        else setFailure(describeOpsError(undefined, null, copyRef.current));
        setLoading(false);
        return;
      }
      if (!isCurrent()) return;
      if (result.error !== undefined) {
        // A quiet refresh that fails keeps what is already shown, and says it may be out of date.
        if (silent) setStale(true);
        else setFailure(describeOpsError(result.error, result.response ?? null, copyRef.current));
      } else {
        setLoaded({ key: requestKey, data: result.data ?? null });
        setStale(false);
      }
      setLoading(false);
    },
    [guard],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` is the intentional trigger; the loader is read through a ref.
  useEffect(() => {
    setLoaded(null);
    void reload();
  }, [key, reload]);

  return { data, failure, stale, loading, reload };
}
