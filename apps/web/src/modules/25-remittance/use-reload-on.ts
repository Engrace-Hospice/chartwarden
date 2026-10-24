// apps/web/src/modules/25-remittance — read again whenever `key` changes (a version or counter the parent bumps after a write).
// The first render is skipped: `useGuardedLoad` already reads on mount.
import { useEffect, useRef } from "react";

export function useReloadOn(reload: () => Promise<void>, key: string | number | undefined): void {
  const first = useRef(true);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` is the explicit "read again" trigger
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    void reload();
  }, [key]);
}
