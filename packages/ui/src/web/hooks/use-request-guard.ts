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
// Also returns false once the component has unmounted, so a late response never writes into a dead screen. "Mounted" is tracked
// separately from the request counter: React StrictMode runs mount -> cleanup -> mount in development, and a cleanup that
// poisoned the counter would leave every later request looking current.
import { useCallback, useEffect, useRef } from "react";

export function useRequestGuard(): () => () => boolean {
  const latest = useRef(0);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  return useCallback(() => {
    const mine = ++latest.current;
    return () => mounted.current && latest.current === mine;
  }, []);
}
