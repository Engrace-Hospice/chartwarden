// apps/web/src/modules/08-encounters — the machinery the composer's list pickers share (the discipline plan picker, ADR-0114 S4b; the IDG action item picker,
// S5b): a list the server owns, read once, changed one request at a time, and read again when the server did not take a change. The picker supplies what the
// list IS (`classify`) and what a change says (`save`); this keeps the list honest and the keyboard user's place.
//
// ONE CHANGE AT A TIME. While a change is saved a second one does nothing (`save` returns at once), and a read that was served before a change settled never
// lands over it: it is dropped and the list is read again once the change has settled (`changeEpoch`, `saveInFlight`, `readOwed`).
//
// A READ NOBODY ASKED FOR (a draft resolve moved `readOn`) that fails leaves the list on the screen: a working picker is not replaced by an error because a
// refresh failed. A read someone WAITS on (a retry, a refused change read again) says so when it fails, and a retry that fails again counts up (`attempt`),
// so its words change and a reader hears the change.
//
// FOCUS. When an answer replaces the control that held the focus (a retry button that gives way to the list, a box whose item was withdrawn, the list that gives
// way to a note) the panel takes the focus, instead of it dropping to the page. Focus that was already elsewhere, or on a control that is still there, is never
// moved: `heldInside` says whether the focus sat inside the panel when the answer was taken, and is spent after the commit.
//
// A CHANGE WHOSE OUTCOME IS UNKNOWN (no answer, or a server fault) may have landed, so the caller is told (`onChanged`) as for a change that did. A list that
// reads differently afterwards than it did (`signatureOf`) tells the caller too: what the draft is built from changed under the person.
//
// A picker's own states must include a `ready` one (the list on screen, kept while it is read again); the hook adds `loading` and `error`.
import { type RefObject, useCallback, useEffect, useRef, useState } from "react";
import type { Outcome } from "./closure-api";
import { useFocusRequest } from "./use-focus-request";
import { useIsMounted } from "./use-is-mounted";

/** What a picker's own state looks like to the hook: a `status`, and a `ready` one that holds the list. */
export interface PickerState {
  readonly status: string;
}

export type PickerLoad<S extends PickerState> =
  | { readonly status: "loading" }
  /** `attempt`: 1 for the first failure; a retry that fails again counts up, so its words change and are announced. */
  | { readonly status: "error"; readonly attempt: number }
  | S;

/** A read a person is waiting on: "Try again" was pressed, or a change was refused (or left to be read) and the list is read again. */
type WaitedOn = "retry" | "reread" | null;

export interface SerializedListPickerOptions<V, S extends PickerState> {
  /** Reads the list. The latest closure is the one called. */
  readonly read: () => Promise<Outcome<V>>;
  /** What the read depends on (the client, the visit, a revision that moves): when one changes the list is read again. Constant in length. */
  readonly readOn: readonly unknown[];
  /**
   * What an answer is for the panel: the state it gives, or null when it is a failure to try again (not a list, a fault). `waited`: somebody is waiting on this
   * answer, so a "no list" answer must keep the panel (and the focus) instead of vanishing.
   */
  readonly classify: (outcome: Outcome<V>, waited: boolean) => S | null;
  /** The part of a state that the draft is built from, or undefined for a state that does not know it. A read that finds it changed tells `onChanged`. */
  readonly signatureOf?: (state: S) => string | undefined;
  /** The list changed here, or may have: the caller re-reads what is built from it. */
  readonly onChanged: () => void;
}

export interface SaveOptions<V, S extends PickerState> {
  /** What a refused change says. */
  readonly refusalWords: (failure: { readonly status: number; readonly error: unknown }) => string;
  /** What is said when the answer is not what was expected: the change is not taken as made and the list is read again. */
  readonly notConfirmedWords: string;
  /** What the status line says when the change was taken. */
  readonly savedWords: string;
  /** What the answer shows. By default the answer IS the new list (`classify`); undefined leaves what is on the screen, null is "not what was expected". */
  readonly settle?: (data: V) => S | null | undefined;
  /** The answer is not the whole list: it is read again after the change (quietly when a list is on the screen, else as a read someone waits on). */
  readonly rereadAfter?: boolean;
}

export interface SerializedListPicker<V, S extends PickerState> {
  readonly load: PickerLoad<S>;
  /** The panel the focus returns to; put it on the picker's fieldset. */
  readonly anchor: RefObject<HTMLFieldSetElement>;
  /** A read is out (the retry button waits). */
  readonly reading: boolean;
  /** A change is being saved. */
  readonly isSaving: boolean;
  /** What the last refused change said; kept on the page until the next change or a retry that settles it. */
  readonly problem: string | null;
  /** What the status line says (an empty string until a change was taken). */
  readonly said: string;
  /** The retry button's action; does nothing while a read is out. */
  readonly retry: () => void;
  readonly save: (send: () => Promise<Outcome<V>>, options: SaveOptions<V, S>) => Promise<void>;
}

const LOADING = { status: "loading" } as const;

/** Whether a failed change may have landed anyway: no answer at all, or a server fault. */
const outcomeUnknown = (status: number): boolean => status === 0 || status >= 500;

export function useSerializedListPicker<V, S extends PickerState>(
  options: SerializedListPickerOptions<V, S>,
): SerializedListPicker<V, S> {
  const mounted = useIsMounted();
  const [load, setLoad] = useState<PickerLoad<S>>(LOADING);
  const [readKey, setReadKey] = useState(0);
  // A read is out. After a failure the panel stays (waiting) while it is read again; the first read shows nothing.
  const [reading, setReading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [said, setSaid] = useState("");
  const [anchor, focusAnchor] = useFocusRequest<HTMLFieldSetElement>();
  // The picker's latest closures: the effects below must not be re-run by a new function every render.
  const latest = useRef(options);
  useEffect(() => {
    latest.current = options;
  });
  // What is on the screen, for a read nobody asked for that fails.
  const shown = useRef<PickerLoad<S>>(LOADING);
  // Moves when a change begins and again when it settles, so a read that began in between is told apart from the one held.
  const changeEpoch = useRef(0);
  const saveInFlight = useRef(false);
  const readOwed = useRef(false);
  // Set when a read is being waited on, and spent by the read that settles (whatever it finds): a later read that nobody waits on never moves the focus.
  const waitedOn = useRef<WaitedOn>(null);
  const failedReads = useRef(0);
  const signature = useRef<string | undefined>(undefined);
  // Whether the focus sat inside the panel when the answer that replaces its content was taken; spent after the commit.
  const heldInside = useRef(false);
  const showLoad = useCallback(
    (next: PickerLoad<S>): void => {
      heldInside.current = anchor.current?.contains(document.activeElement) ?? false;
      shown.current = next;
      setLoad(next);
    },
    [anchor],
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: `load` is the commit this runs after, not read in the body.
  useEffect(() => {
    if (!heldInside.current) return;
    heldInside.current = false;
    if (!anchor.current?.contains(document.activeElement)) focusAnchor();
  }, [load, anchor, focusAnchor]);

  /** Takes the state's signature as the one known; true when it differs from the one known before (a state that knows none changes nothing). */
  const learn = useCallback((state: S): boolean => {
    const now = latest.current.signatureOf?.(state);
    if (now === undefined) return false;
    const before = signature.current;
    signature.current = now;
    return before !== undefined && before !== now;
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `readKey` and the values `readOn` names are the re-read triggers, not read in the body.
  useEffect(() => {
    let active = true;
    const begunAt = changeEpoch.current;
    // The list known stays known while it is read again, and so does the failure (its retry button keeps the focus); the first time nothing is known.
    if (shown.current.status !== "ready" && shown.current.status !== "error") {
      shown.current = LOADING;
      setLoad(LOADING);
    }
    setReading(true);
    void latest.current.read().then((outcome) => {
      if (!active) return;
      if (saveInFlight.current || changeEpoch.current !== begunAt) {
        // Read before a change committed, answered after it: older than the list held. Read again once the change has settled.
        if (saveInFlight.current) readOwed.current = true;
        else setReadKey((key) => key + 1);
        return;
      }
      setReading(false);
      const waited = waitedOn.current;
      waitedOn.current = null;
      const found = latest.current.classify(outcome, waited !== null);
      if (found === null) {
        // A refresh nobody asked for must not take a working list off the screen.
        if (waited === null && shown.current.status === "ready") return;
        failedReads.current = waited === "retry" ? failedReads.current + 1 : 1;
        showLoad({ status: "error", attempt: failedReads.current });
        return;
      }
      failedReads.current = 0;
      // A retry that was answered settles a refusal that stood beside the failure: the list shown now is the truth about it.
      if (waited === "retry") setProblem(null);
      const changed = learn(found);
      showLoad(found);
      if (changed) latest.current.onChanged();
    });
    return () => {
      active = false;
    };
  }, [showLoad, learn, readKey, ...options.readOn]);

  const retry = (): void => {
    if (reading) return;
    waitedOn.current = "retry";
    setReadKey((key) => key + 1);
  };

  const save = useCallback(
    async (send: () => Promise<Outcome<V>>, saveOptions: SaveOptions<V, S>): Promise<void> => {
      if (saveInFlight.current) return;
      setIsSaving(true);
      setProblem(null);
      setSaid("");
      changeEpoch.current += 1;
      saveInFlight.current = true;
      const outcome = await send();
      saveInFlight.current = false;
      changeEpoch.current += 1;
      if (!mounted.current) return;
      setIsSaving(false);
      if (readOwed.current) {
        readOwed.current = false;
        setReadKey((key) => key + 1);
      }
      if (!outcome.ok) {
        // The server did not take the change: what it holds may differ from the control (an item withdrawn since), so the list is read again.
        setProblem(saveOptions.refusalWords(outcome));
        waitedOn.current = "reread";
        setReadKey((key) => key + 1);
        // No answer, or a fault: the change may have landed, and what is built from the list may be out of date.
        if (outcomeUnknown(outcome.status)) latest.current.onChanged();
        return;
      }
      const next = saveOptions.settle
        ? saveOptions.settle(outcome.data)
        : latest.current.classify(outcome, true);
      if (next === null) {
        setProblem(saveOptions.notConfirmedWords);
        waitedOn.current = "reread";
        setReadKey((key) => key + 1);
      } else {
        if (next !== undefined) {
          learn(next);
          showLoad(next);
        }
        setSaid(saveOptions.savedWords);
        if (saveOptions.rereadAfter) {
          waitedOn.current = shown.current.status === "ready" ? null : "reread";
          setReadKey((key) => key + 1);
        }
      }
      latest.current.onChanged();
    },
    [mounted, learn, showLoad],
  );

  return { load, anchor, reading, isSaving, problem, said, retry, save };
}
