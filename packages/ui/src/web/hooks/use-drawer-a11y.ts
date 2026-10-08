// packages/ui/src/web/hooks — keyboard and focus behaviour for the right-hand detail drawer (`aside.wx-admission-drawer`).
//
// Spread the result onto the `<aside>`: opening a drawer moves focus into it, Escape closes it, and closing returns focus
// to whatever opened it (the row or button), so a keyboard user is never dropped back at the top of the page.
//
// Escape is left alone while the keystroke belongs to something else: a text field, a native select, or a dialog stacked over the
// drawer (which handles its own Escape). And once the user has typed or chosen anything inside the drawer, Escape no longer closes
// it — a half-filled form must not vanish on a stray keypress; the Close button still works.
import {
  type FormEvent,
  type KeyboardEvent,
  type RefObject,
  useCallback,
  useEffect,
  useRef,
} from "react";

export interface DrawerA11yProps<T extends HTMLElement> {
  ref: RefObject<T>;
  tabIndex: -1;
  onKeyDown: (event: KeyboardEvent<T>) => void;
  onInput: (event: FormEvent<T>) => void;
  onChange: (event: FormEvent<T>) => void;
}

const OWN_ESCAPE =
  "input, textarea, select, [role='dialog'], [role='alertdialog'], [contenteditable='true']";

export function useDrawerA11y<T extends HTMLElement = HTMLElement>(
  onClose: () => void,
): DrawerA11yProps<T> {
  const ref = useRef<T>(null);
  const closeRef = useRef(onClose);
  const edited = useRef(false);
  useEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const node = ref.current;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    node?.focus({ preventScroll: true });
    return () => {
      // Hand focus back only if the opener is still on the page (a re-rendered row is a new element), and only if the user has
      // not already moved focus somewhere else: picking row B while row A's keyed drawer is open unmounts A's drawer, and
      // pulling focus back to row A there would make B's drawer remember the wrong opener.
      const active = document.activeElement;
      const focusMoved = active && active !== document.body && !node?.contains(active);
      if (focusMoved) return;
      if (opener && opener !== document.body && document.contains(opener)) {
        opener.focus({ preventScroll: true });
      }
    };
  }, []);

  const markEdited = useCallback(() => {
    edited.current = true;
  }, []);

  const onKeyDown = useCallback((event: KeyboardEvent<T>) => {
    if (event.key !== "Escape" || event.defaultPrevented || edited.current) return;
    if (event.target instanceof Element) {
      // A field or dialog the keystroke came from owns Escape — but only one that is NOT an ancestor of this drawer.
      const owner = event.target.closest(OWN_ESCAPE);
      if (owner && !owner.contains(ref.current)) return;
    }
    event.stopPropagation();
    closeRef.current();
  }, []);

  return { ref, tabIndex: -1, onKeyDown, onInput: markEdited, onChange: markEdited };
}
