// @chartwarden/ui — keep keyboard focus across a Retry. A screen that stays mounted while it reloads loses the
// focused Retry button when the read succeeds (the button is replaced by the data); this hands focus to the
// returned container (give it `tabIndex={-1}`) once, and only when focus was dropped to <body>.
import { type RefObject, useEffect, useRef } from "react";

export function useReloadFocus<T extends HTMLElement>(loading: boolean): RefObject<T> {
  const ref = useRef<T>(null);
  const settledOnce = useRef(false);
  const reloading = useRef(false);
  useEffect(() => {
    if (loading) {
      reloading.current = settledOnce.current;
      return;
    }
    settledOnce.current = true;
    if (!reloading.current) return;
    reloading.current = false;
    if (document.activeElement === document.body || document.activeElement === null) {
      ref.current?.focus();
    }
  }, [loading]);
  return ref;
}
