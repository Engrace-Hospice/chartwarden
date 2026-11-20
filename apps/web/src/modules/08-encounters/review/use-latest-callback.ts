// apps/web/src/modules/08-encounters/review — a callback whose identity never changes and that always runs the latest one given. The
// composer's memoised panels take it, so the closures it rebuilds on every render do not re-render them.
import { useCallback, useLayoutEffect, useRef } from "react";

export function useLatestCallback<Args extends readonly unknown[], Result>(
  callback: (...args: Args) => Result,
): (...args: Args) => Result {
  const latest = useRef(callback);
  useLayoutEffect(() => {
    latest.current = callback;
  });
  return useCallback((...args: Args) => latest.current(...args), []);
}
