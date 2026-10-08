// packages/ui/src/web/hooks — dismissal for a show/hide popover (the account menu, an "Actions" menu).
//
// These are disclosures, not ARIA menus: a button with `aria-expanded` reveals a small panel of ordinary links/buttons. While open,
// a pointer press outside `containerRef` or Escape closes it, and Escape returns focus to the trigger.
import { type RefObject, useEffect, useRef } from "react";

export function useDisclosureDismiss(
  open: boolean,
  close: () => void,
  containerRef: RefObject<HTMLElement>,
  triggerRef?: RefObject<HTMLElement>,
): void {
  // `close` is usually an inline arrow (a new function each render); read it through a ref so the listeners are not torn down
  // and re-added on every parent render while the disclosure is open.
  const closeRef = useRef(close);
  useEffect(() => {
    closeRef.current = close;
  }, [close]);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent): void {
      if (!containerRef.current?.contains(event.target as Node)) closeRef.current();
    }
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key !== "Escape") return;
      closeRef.current();
      triggerRef?.current?.focus();
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, containerRef, triggerRef]);
}
