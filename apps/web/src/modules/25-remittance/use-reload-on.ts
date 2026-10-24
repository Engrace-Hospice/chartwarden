// apps/web/src/modules/25-remittance — read again whenever `key` changes (a version or counter the parent bumps after a write).
// The previous key is tracked, so a StrictMode double-mount (which re-runs effects with an unchanged key) reads nothing extra:
// `useGuardedLoad` already reads on mount.
import { useEffect, useRef } from "react";

export function useReloadOn(reload: () => Promise<void>, key: string | number | undefined): void {
  const previous = useRef(key);
  useEffect(() => {
    if (previous.current === key) return;
    previous.current = key;
    void reload();
  }, [key, reload]);
}
