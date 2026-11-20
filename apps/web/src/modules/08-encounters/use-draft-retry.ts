// apps/web/src/modules/08-encounters — the retry beside a draft that could not be read, for the person it keeps (S1 React review). When the
// read succeeds the retry button goes with the "could not be read" text, and the keyboard focus it held would fall to the page and the
// screen reader would hear "reading again" and then nothing. So the region that held the retry takes focus (it must be a focusable
// element that stays on the page), and says what happened in a status that was already there (a region mounted with its text is not
// announced). Focus is moved only when it is still where the person left it: someone who went elsewhere while it was reading is not
// taken back.
import { type RefObject, useCallback, useState } from "react";
import type { DraftLoad } from "./draft-model";
import { useFocusRequest } from "./use-focus-request";

export interface DraftRetryWords {
  /** The draft loaded. */
  readonly ready: string;
  /** The read was answered, but with no draft for this viewer (switched off, or not theirs): the region says so itself, or this does. */
  readonly closed: string;
}

export interface DraftRetry<T extends HTMLElement> {
  /** On the region that holds the retry: `tabIndex={-1}`, and it stays on the page whatever the draft turns out to be. */
  readonly anchor: RefObject<T>;
  /** What the last retry said, "" before one has been answered. Render it in an `<output>` that is always there. */
  readonly said: string;
  readonly retry: () => void;
}

export function useDraftRetry<T extends HTMLElement>(
  reload: () => Promise<DraftLoad | null>,
  words: DraftRetryWords,
): DraftRetry<T> {
  const [anchor, requestFocus] = useFocusRequest<T>();
  const [said, setSaid] = useState("");
  const { ready, closed } = words;
  const retry = useCallback(() => {
    void reload().then((answer) => {
      // Not answered (another read was out), or answered with the same failure: the retry is still there, and still has focus.
      if (answer === null || answer.status === "unavailable" || answer.status === "loading") return;
      setSaid(answer.status === "ready" ? ready : closed);
      const held = document.activeElement;
      if (held === null || held === document.body || anchor.current?.contains(held)) {
        requestFocus();
      }
    });
  }, [reload, ready, closed, anchor, requestFocus]);
  return { anchor, said, retry };
}
