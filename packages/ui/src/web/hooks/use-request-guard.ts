// packages/ui/src/web/hooks — lets only the newest of several overlapping fetches write state.
//
//   const guard = useRequestGuard();
//   const load = useCallback(async () => {
//     const isCurrent = guard();          // marks this request as the newest
//     const { data } = await client.GET(...);
//     if (!isCurrent()) return;           // a newer request started meanwhile: drop this response
//     setRows(data);
//   }, [client, guard]);
//
// Also returns false once the component has unmounted, so a late response never writes into a dead screen.
import { useCallback, useEffect, useRef } from "react";

export function useRequestGuard(): () => () => boolean {
  const latest = useRef(0);
  useEffect(
    () => () => {
      latest.current = Number.POSITIVE_INFINITY;
    },
    [],
  );
  return useCallback(() => {
    const mine = ++latest.current;
    return () => latest.current === mine;
  }, []);
}
