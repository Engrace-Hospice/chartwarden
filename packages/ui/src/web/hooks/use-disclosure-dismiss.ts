// packages/ui/src/web/hooks — dismissal for a show/hide popover (the account menu, an "Actions" menu).
//
// These are disclosures, not ARIA menus: a button with `aria-expanded` reveals a small panel of ordinary links/buttons. While open,
// a pointer press outside `containerRef` or Escape closes it, and Escape returns focus to the trigger.
import { type RefObject, useEffect } from "react";

export function useDisclosureDismiss(
  open: boolean,
  close: () => void,
  containerRef: RefObject<HTMLElement>,
  triggerRef?: RefObject<HTMLElement>,
): void {
  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent): void {
      if (!containerRef.current?.contains(event.target as Node)) close();
    }
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key !== "Escape") return;
      close();
      triggerRef?.current?.focus();
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, close, containerRef, triggerRef]);
}
