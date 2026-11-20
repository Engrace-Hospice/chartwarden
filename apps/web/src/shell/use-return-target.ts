// apps/web/src/shell — the React side of `return-target.ts`: a reader for a screen that offers "Back to ...", and a writer for a screen
// that links out of itself.
import { useCallback, useMemo } from "react";
import { useLocation, useSearchParams } from "react-router-dom";
import {
  RETURN_PARAM,
  type ReturnTarget,
  parseReturnTarget,
  withParsedReturnTarget,
  withReturnTarget,
} from "./return-target";

/**
 * The origin this screen was opened from (`?from=`), validated; null when it carries none or one that is not a known screen. Parsed
 * again only when the value changes, not on every render of a screen that re-renders on each keystroke.
 */
export function useReturnTarget(): ReturnTarget | null {
  const [params] = useSearchParams();
  const raw = params.get(RETURN_PARAM);
  return useMemo(() => parseReturnTarget(raw), [raw]);
}

/** Adds the way back to this screen to a link that leaves it (My Visits, the calendar, a queue). */
export function useReturnHere(): (href: string) => string {
  const { pathname, search } = useLocation();
  return useCallback((href) => withReturnTarget(href, `${pathname}${search}`), [pathname, search]);
}

/** Carries the origin this screen was opened from onto a link to a sibling screen (record to composer and back). */
export function useForwardReturn(): (href: string) => string {
  const target = useReturnTarget();
  return useCallback((href) => withParsedReturnTarget(href, target), [target]);
}
