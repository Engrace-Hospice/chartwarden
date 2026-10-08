// packages/ui/src/web/hooks — keyboard and focus behaviour for the right-hand detail drawer (`aside.wx-admission-drawer`).
//
// Spread the result onto the `<aside>`: opening a drawer moves focus into it, Escape closes it, and closing returns focus
// to whatever opened it (the row or button), so a keyboard user is never dropped back at the top of the page.
//
// Escape is ignored while the keystroke belongs to something else: a text field (the operator may be mid-edit), a native
// select, or a dialog stacked over the drawer (which handles its own Escape).
import { type KeyboardEvent, type RefObject, useCallback, useEffect, useRef } from "react";

export interface DrawerA11yProps<T extends HTMLElement> {
  ref: RefObject<T>;
  tabIndex: -1;
  onKeyDown: (event: KeyboardEvent<T>) => void;
}

const OWN_ESCAPE =
  "input, textarea, select, [role='dialog'], [role='alertdialog'], [contenteditable='true']";

export function useDrawerA11y<T extends HTMLElement = HTMLElement>(
  onClose: () => void,
): DrawerA11yProps<T> {
  const ref = useRef<T>(null);
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    ref.current?.focus({ preventScroll: true });
    return () => {
      // Hand focus back only if the opener is still on the page (a re-rendered row is a new element).
      if (opener && opener !== document.body && document.contains(opener)) {
        opener.focus({ preventScroll: true });
      }
    };
  }, []);

  const onKeyDown = useCallback((event: KeyboardEvent<T>) => {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    if (event.target instanceof Element && event.target.closest(OWN_ESCAPE)) return;
    event.stopPropagation();
    closeRef.current();
  }, []);

  return { ref, tabIndex: -1, onKeyDown };
}
