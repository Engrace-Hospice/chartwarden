// apps/web/src/modules/10-hope — keeps the keyboard user's place when "Try again" is pressed. The button lives inside the
// error message, and pressing it replaces the message with the loading state: the button leaves the page and focus drops to
// the document, so the next Tab starts again from the top. So the loading region takes focus (the kit's spinner is not
// focusable itself, so it sits in a focusable, labelled region), and if the load fails again the error takes it back, so
// that the Try again button is the next Tab stop. (The error is announced by its own alert role; this only keeps the place.)
import { LoadingSpinner } from "@chartwarden/ui";
import { type RefObject, useEffect, useRef } from "react";
import type { JSX } from "react";

export function useRetryFocus(
  loading: boolean,
  error: string | null,
): {
  /** Put on the `LoadingRegion` the screen shows while `loading`. */
  readonly loadingRef: RefObject<HTMLElement>;
  /** Put on a `tabIndex={-1}` element wrapping the error and its Try again button. */
  readonly errorRef: RefObject<HTMLDivElement>;
  /** Call from the Try again handler: the loading state that follows takes focus. */
  readonly retried: () => void;
} {
  const loadingRef = useRef<HTMLElement>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  // Try again was pressed and the loading state has not shown yet / focus is on the loading region until the load ends.
  const wanted = useRef(false);
  const holding = useRef(false);
  useEffect(() => {
    if (loading) {
      if (!wanted.current) return;
      wanted.current = false;
      holding.current = true;
      loadingRef.current?.focus();
      return;
    }
    if (!holding.current) return;
    holding.current = false;
    if (error) errorRef.current?.focus();
  }, [loading, error]);
  return {
    loadingRef,
    errorRef,
    retried: () => {
      wanted.current = true;
    },
  };
}

export function LoadingRegion(props: {
  readonly label: string;
  readonly regionRef: RefObject<HTMLElement>;
}): JSX.Element {
  return (
    <section ref={props.regionRef} tabIndex={-1} aria-label={props.label}>
      <LoadingSpinner label={props.label} />
    </section>
  );
}
