// apps/web/src/modules/25-remittance — a read that keeps the last good data on screen when a reload fails, and ignores a
// response that arrives after a newer read (or after the fetcher changed, or the component unmounted). The caller wraps
// the fetcher in `useCallback`; a new fetcher (another denial) clears the data and reads again.
import { useCallback, useEffect, useRef, useState } from "react";
import type { WriteResult } from "./remittance-api";

export interface GuardedLoad<T> {
  readonly data: T | null;
  /** The message of the last failed read; the last good `data` is kept alongside it. */
  readonly error: string | null;
  /** Reads again; resolves when the read has landed (or was superseded). */
  readonly load: () => Promise<void>;
}

export function useGuardedLoad<T>(fetcher: () => Promise<WriteResult<T>>): GuardedLoad<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const latest = useRef(0);

  const load = useCallback(async (): Promise<void> => {
    latest.current += 1;
    const mine = latest.current;
    const res = await fetcher();
    if (mine !== latest.current) return; // a newer read, a changed fetcher or an unmount superseded this one
    if (res.ok) {
      setData(res.value);
      setError(null);
    } else setError(res.message);
  }, [fetcher]);

  useEffect(() => {
    setData(null);
    setError(null);
    void load();
    return () => {
      latest.current += 1;
    };
  }, [load]);

  return { data, error, load };
}
