// packages/ui/src/web/hooks — keyboard and focus behaviour for the right-hand detail drawer (`aside.wx-admission-drawer`).
//
// Spread the result onto the `<aside>`: opening a drawer moves focus into it, Escape closes it, and closing returns focus
// to whatever opened it (the row or button), so a keyboard user is never dropped back at the top of the page. When nothing
// was focused at opening (a deep link, Back/Forward) the list's selected row stands in as the opener; a drawer that opens while
// the user is typing in a field elsewhere leaves that field focused.
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

/** A list's open row, which a drawer returns focus to when nothing better is known. */
const SELECTED_ROW = "tr.is-selected, tr[aria-selected='true'], [role='row'][aria-selected='true']";
const NON_TEXT_INPUTS = new Set([
  "button",
  "checkbox",
  "color",
  "file",
  "image",
  "radio",
  "range",
  "reset",
  "submit",
]);

const isTextEntry = (el: HTMLElement): boolean =>
  el instanceof HTMLTextAreaElement ||
  el instanceof HTMLSelectElement ||
  (el instanceof HTMLInputElement && !NON_TEXT_INPUTS.has(el.type)) ||
  el.closest("[contenteditable]:not([contenteditable='false'])") !== null;

/** The page's selected row, ignoring anything inside the drawer itself. */
const selectedRow = (drawer: HTMLElement | null): HTMLElement | null =>
  Array.from(document.querySelectorAll<HTMLElement>(SELECTED_ROW)).find(
    (el) => !drawer?.contains(el),
  ) ?? null;

const OWN_ESCAPE =
  "input, textarea, select, [role='dialog'], [role='alertdialog'], [contenteditable='true']";

export function useDrawerA11y<T extends HTMLElement = HTMLElement>(
  onClose: () => void,
  /** When this changes the drawer's content was reset (a form closed, the record reloaded): Escape closes it again. */
  resetKey?: unknown,
): DrawerA11yProps<T> {
  const ref = useRef<T>(null);
  const closeRef = useRef(onClose);
  const edited = useRef(false);
  useEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const node = ref.current;
    const active = document.activeElement;
    const focusedOutside = active instanceof HTMLElement && !node?.contains(active);
    // Focus the drawer — unless the user is typing in a field outside it (a filter box whose result opened this drawer).
    if (!(focusedOutside && isTextEntry(active))) node?.focus({ preventScroll: true });
    // Nothing focused (a deep link, or the previous drawer unmounted with focus inside it): the opener is the selected row.
    const opener = focusedOutside && active !== document.body ? active : selectedRow(node);
    const openerWasSelectedRow = opener !== null && opener === selectedRow(node);
    return () => {
      // Hand focus back only if the opener is still on the page (a re-rendered row is a new element), and only if the user has
      // not already moved focus somewhere else: picking row B while row A's keyed drawer is open unmounts A's drawer, and
      // pulling focus back to row A there would make B's drawer remember the wrong opener.
      const current = document.activeElement;
      const focusMoved = current && current !== document.body && !node?.contains(current);
      if (focusMoved) return;
      // The selection moved to another row (Back/Forward between two records): this drawer is being replaced, not closed.
      const selected = selectedRow(node);
      if (openerWasSelectedRow && selected && selected !== opener) return;
      const target = opener?.isConnected ? opener : selected;
      target?.focus({ preventScroll: true });
    };
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `resetKey` is the trigger, not a value read inside.
  useEffect(() => {
    edited.current = false;
  }, [resetKey]);

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
