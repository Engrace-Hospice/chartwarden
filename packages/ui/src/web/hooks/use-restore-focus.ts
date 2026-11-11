// packages/ui/src/web/hooks — keeps keyboard focus through a pending state that disables or unmounts the focused control.
import { useCallback, useEffect, useRef } from "react";

/**
 * Keeps keyboard focus through a pending state that disables or unmounts the focused control. Call the returned
 * `capture()` when the action starts; when `pending` clears, focus returns to the captured element (or `fallback`
 * if it is gone) provided focus was lost to the page body.
 */
export function useRestoreFocus(
  pending: boolean,
  fallback?: () => HTMLElement | null | undefined,
): () => void {
  const was = useRef(false);
  const captured = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (was.current && !pending) {
      const active = document.activeElement;
      const lost = !active || active === document.body || active.matches(":disabled");
      const previous = captured.current;
      const usable = previous?.isConnected && !previous.matches(":disabled");
      if (lost) (usable ? previous : fallback?.())?.focus();
    }
    was.current = pending;
  });
  return useCallback(() => {
    const active = document.activeElement;
    captured.current = active instanceof HTMLElement && active !== document.body ? active : null;
  }, []);
}
