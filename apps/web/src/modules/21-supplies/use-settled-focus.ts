// apps/web/src/modules/21-supplies — keep keyboard focus on the page once a reload settles.
//
// After a ceremony's write the page refetches, and the status it advances to usually switches the opener that launched
// the step OFF (a cancelled request offers no Cancel, a deployed kit no Deploy). The modal hands focus back to that
// opener when it closes, and the opener is then disabled: a focused-then-disabled button can stay `document.activeElement`
// (browser-dependent), so waiting for focus to fall to <body>, as the kit's `useReloadFocus` does, never fires.
// This hook looks at where focus actually is when the reload settles, and when it is stranded (nowhere, detached, or on
// something disabled) it hands focus to the returned container (give it `tabIndex={-1}`). Focus anywhere live — a
// field the responder is typing in — is left alone.
import { type RefObject, useEffect, useRef } from "react";

function isStranded(active: Element | null): boolean {
  if (active === null || active === document.body || !active.isConnected) return true;
  return active.matches(':disabled, [aria-disabled="true"]');
}

export function useSettledFocus<T extends HTMLElement>(loading: boolean): RefObject<T> {
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
    if (isStranded(document.activeElement)) ref.current?.focus({ preventScroll: true });
  }, [loading]);
  return ref;
}
