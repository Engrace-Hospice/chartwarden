// packages/ui/src/web/hooks — keyboard and focus behaviour for the right-hand detail drawer (`aside.wx-admission-drawer`).
//
// Spread the result onto the `<aside>`: opening a drawer moves focus into it, Escape closes it, and closing returns focus
// to whatever opened it (the row or button), so a keyboard user is never dropped back at the top of the page. When nothing
// was focused at opening (a deep link, Back/Forward) the list's selected row stands in as the opener; a drawer that opens while
// the user is typing in a field elsewhere leaves that field focused.
//
// Escape is left alone while the keystroke belongs to something else: a text field, a native select, or a dialog stacked over the
// drawer (which handles its own Escape). A native select only keeps its own Escape: it is not a text field, so it never stops the
// drawer taking focus when it opens. And once the user has typed or chosen anything inside the drawer, Escape no longer closes
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

/** A list's open row, which a drawer returns focus to when nothing better is known. The kit's `interactiveRowProps` marks the
 * open row `aria-pressed` (a `<tr role="button">`), so that matches as well as `aria-selected` / `aria-current` rows. */
const SELECTED_ROW = [
  "tr.is-selected",
  ...["aria-selected", "aria-pressed", "aria-current"].flatMap((attr) => [
    `tr[${attr}='true']`,
    `[role='row'][${attr}='true']`,
  ]),
].join(", ");
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

/** Text entry only (a text-like input, a textarea, a contenteditable): a native `<select>` is not typed into, so it is not here. */
const isTextEntry = (el: HTMLElement): boolean =>
  el instanceof HTMLTextAreaElement ||
  (el instanceof HTMLInputElement && !NON_TEXT_INPUTS.has(el.type)) ||
  el.closest("[contenteditable]:not([contenteditable='false'])") !== null;

/** The list the drawer belongs to: the row lookup stays inside it, so another list or a new route can never supply the opener. */
const listScope = (drawer: HTMLElement | null): HTMLElement | null =>
  drawer?.closest<HTMLElement>(".wx-list-drawer") ?? drawer?.parentElement ?? null;

/** The scope's selected row, ignoring anything inside the drawer itself. */
const selectedRow = (scope: HTMLElement | null, drawer: HTMLElement | null): HTMLElement | null =>
  Array.from(scope?.querySelectorAll<HTMLElement>(SELECTED_ROW) ?? []).find(
    (el) => !drawer?.contains(el),
  ) ?? null;

/** A row's stable identity (`data-row-id`, set by `interactiveRowProps`): it survives the list re-rendering the row's element. */
const rowIdOf = (el: Element | null): string | null =>
  el?.closest<HTMLElement>("[data-row-id]")?.dataset.rowId ?? null;

/**
 * Whether `selected` is a different row from the `opener` the drawer remembered. Ids decide when both rows carry one; without
 * them only a still-attached opener can be compared by element (a re-rendered list swaps every element, so a detached opener
 * says nothing about which row is open).
 */
const selectionMovedOn = (
  opener: HTMLElement | null,
  openerRowId: string | null,
  selected: HTMLElement | null,
): boolean => {
  if (!selected) return false;
  const selectedRowId = rowIdOf(selected);
  if (openerRowId !== null && selectedRowId !== null) return selectedRowId !== openerRowId;
  return opener?.isConnected === true && selected !== opener;
};

const rowById = (scope: HTMLElement | null, id: string | null): HTMLElement | null =>
  id === null
    ? null
    : (Array.from(scope?.querySelectorAll<HTMLElement>("[data-row-id]") ?? []).find(
        (el) => el.dataset.rowId === id,
      ) ?? null);

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
    // Captured while the drawer is attached: by cleanup the drawer is already out of the document.
    const scope = listScope(node);
    const active = document.activeElement;
    const focusedOutside = active instanceof HTMLElement && !node?.contains(active);
    // Focus the drawer — unless the user is typing in a field outside it (a filter box whose result opened this drawer).
    if (!(focusedOutside && isTextEntry(active))) node?.focus({ preventScroll: true });
    // Nothing focused (a deep link, or the previous drawer unmounted with focus inside it): the opener is the selected row.
    const opener = focusedOutside && active !== document.body ? active : selectedRow(scope, node);
    const openerRowId = rowIdOf(opener);
    const openerWasSelectedRow = opener !== null && opener === selectedRow(scope, node);
    return () => {
      // Hand focus back only if the opener is still on the page (a re-rendered row is a new element), and only if the user has
      // not already moved focus somewhere else: picking row B while row A's keyed drawer is open unmounts A's drawer, and
      // pulling focus back to row A there would make B's drawer remember the wrong opener.
      const current = document.activeElement;
      const focusMoved = current && current !== document.body && !node?.contains(current);
      if (focusMoved) return;
      // The list is gone (a route change): only the opener itself may still take focus, never a row in some other list.
      const listPresent = scope?.isConnected === true;
      const selected = listPresent ? selectedRow(scope, node) : null;
      // The selection moved to another row (Back/Forward between two records): this drawer is being replaced, not closed.
      if (openerWasSelectedRow && selectionMovedOn(opener, openerRowId, selected)) return;
      // A re-rendered list replaces the opener's element: find the same row again by its id, else use the selected row.
      const target = opener?.isConnected
        ? opener
        : ((listPresent ? rowById(scope, openerRowId) : null) ?? selected);
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
