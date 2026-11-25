// apps/web/src/modules/08-encounters — the composer's late-entry reason: what the author typed, whether the box is on screen, and what
// the finalize call carries. See late-entry-reason.ts for the rule and the words. The reason is held in memory for ONE encounter (another
// note starts empty) and is never stored, logged or put in a URL.
import { useCallback, useEffect, useState } from "react";
import type { WriteResult } from "./encounters-api";
import {
  type LateEntryEstimate,
  estimateLateEntry,
  isLateEntryRefusal,
  localCalendarDay,
  reasonIsLongEnough,
  reasonLength,
  reasonToSend,
  tierNeedsReason,
} from "./late-entry-reason";

/** How often the device day is re-read (a composer left open across midnight moves to the next day within this). */
const DAY_CHECK_MS = 5 * 60_000;

/**
 * The device's calendar day, re-read on a timer. Only the day string is held, so a tick on the same day bails out of the render
 * (a `Date` per tick would re-render the whole composer every few minutes); a tick across midnight changes it.
 */
function useLocalCalendarDay(intervalMs: number): string {
  const [day, setDay] = useState(() => localCalendarDay(new Date()));
  useEffect(() => {
    const timer = window.setInterval(() => setDay(localCalendarDay(new Date())), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return day;
}

interface Held {
  readonly encounterId: string;
  readonly reason: string;
  /** The server refused a finalize for this note's reason: the box stays up whatever the device's own estimate says. */
  readonly refused: boolean;
  /** Counts refusals so each one moves focus to the box, even the second in a row. */
  readonly focusRequests: number;
}

export interface LateEntryReasonState {
  readonly reason: string;
  readonly setReason: (reason: string) => void;
  readonly estimate: LateEntryEstimate | null;
  /** The box is on screen: the note is editable and either late by the shared ladder or refused by the server. */
  readonly visible: boolean;
  /** The box is on screen and the reason is still too short to finalize on. */
  readonly pending: boolean;
  /** The server refused a finalize and the reason is still too short: the box says so. */
  readonly refusedAndShort: boolean;
  /**
   * Something is typed in the box on screen. Only Finalize sends the reason (Save draft never does), so this is not an unsaved change
   * of the draft; it is what leaving the page would lose, which the leave guard and the unload warning count.
   */
  readonly unsent: boolean;
  readonly focusRequests: number;
  /** What the finalize call carries: the trimmed reason once it is long enough, else nothing. */
  readonly reasonForFinalize: string | undefined;
  /** Records the server's late-entry refusal (true), or leaves any other result alone (false). */
  readonly absorbRefusal: (result: WriteResult<unknown>) => boolean;
  /** The reason goes once the note is finalized (nothing keeps a copy). */
  readonly clear: () => void;
}

export function useLateEntryReason(input: {
  readonly encounterId: string | undefined;
  readonly serviceDate: string | undefined;
  readonly editable: boolean;
}): LateEntryReasonState {
  const { encounterId, serviceDate, editable } = input;
  const today = useLocalCalendarDay(DAY_CHECK_MS);
  const [held, setHeld] = useState<Held | null>(null);
  // Another note (Back or Forward between composer URLs) starts empty, and coming back to this one finds nothing held either.
  const [heldFor, setHeldFor] = useState(encounterId);
  if (heldFor !== encounterId) {
    setHeldFor(encounterId);
    setHeld(null);
  }
  const mine = held !== null && held.encounterId === encounterId ? held : null;
  const reason = mine?.reason ?? "";
  const refused = mine?.refused ?? false;

  const update = useCallback(
    (change: (current: Held) => Held): void => {
      if (encounterId === undefined) return;
      setHeld((current) => {
        const base: Held =
          current !== null && current.encounterId === encounterId
            ? current
            : { encounterId, reason: "", refused: false, focusRequests: 0 };
        return change(base);
      });
    },
    [encounterId],
  );

  const setReason = useCallback(
    (next: string): void => update((current) => ({ ...current, reason: next })),
    [update],
  );
  const absorbRefusal = useCallback(
    (result: WriteResult<unknown>): boolean => {
      if (!isLateEntryRefusal(result)) return false;
      update((current) => ({
        ...current,
        refused: true,
        focusRequests: current.focusRequests + 1,
      }));
      return true;
    },
    [update],
  );
  const clear = useCallback((): void => setHeld(null), []);

  const estimate = estimateLateEntry(serviceDate, today);
  const visible = editable && (refused || (estimate !== null && tierNeedsReason(estimate.tier)));
  const short = !reasonIsLongEnough(reason);
  return {
    reason,
    setReason,
    estimate,
    visible,
    pending: visible && short,
    refusedAndShort: visible && refused && short,
    unsent: visible && reasonLength(reason) > 0,
    focusRequests: mine?.focusRequests ?? 0,
    reasonForFinalize: reasonToSend(reason),
    absorbRefusal,
    clear,
  };
}
