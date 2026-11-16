// apps/web/src/modules/10-hope — keeps keyboard focus inside a dialog after a write fails. The button that was pressed is
// disabled while the write is out, and a browser that fixes up focus on a disabled control (Firefox, Safari) drops it to
// the page: the dialog's Escape and Tab handlers then never see a key, Escape does nothing and Tab walks into the page
// behind it. The refusal takes focus instead (put the returned ref on the alert, with `tabIndex={-1}`).
//
// An error already showing when the dialog opened does not take focus: its role announces it, and the kit's own first
// focus stands. Each attempt clears the error first, so a second failure with the same words is still "new".
import { type RefObject, useEffect, useRef } from "react";

export function useFocusOnNewError<T extends HTMLElement>(error: string | null): RefObject<T> {
  const ref = useRef<T>(null);
  const errorAtOpen = useRef(error);
  useEffect(() => {
    if (!error) {
      errorAtOpen.current = null;
      return;
    }
    if (error !== errorAtOpen.current) ref.current?.focus();
  }, [error]);
  return ref;
}
