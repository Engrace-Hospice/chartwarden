// apps/web/src/modules/09-assessments/wounds — the wound panel's "No skin or wound concerns at this visit" statement: the button, the
// confirmed state with its Undo, and the lines that keep the statement from sitting beside a recorded wound.
//
// The panel holds no text of its own. The composer holds the section's free text, tells the panel what it says (`state`) and applies the
// two changes the panel asks for, so the sentence goes through the same draft, rail and save path as typing in the notes box.
import { Button, InlineAlert } from "@chartwarden/ui";
import { type ReactNode, useEffect, useRef, useState } from "react";
import {
  NO_WOUND_CONCERNS_SENTENCE,
  type NoWoundConcernsChange,
  type NoWoundConcernsState,
} from "./no-wound-concerns";

export interface NoWoundConcernsControl {
  /** What the section's free text says about it now. */
  readonly state: NoWoundConcernsState;
  readonly onChange: (change: NoWoundConcernsChange) => void;
  /**
   * Called with the removal's own words when the panel took the sentence out by itself (a wound is on file): that happens on load, with no
   * press, while this panel may be hidden, so the composer shows it too. Stable across renders, since the removal effect depends on it.
   */
  readonly onRemoved?: (message: string) => void;
}

interface Options {
  /** Absent: the composer offers no such statement and the panel shows nothing of it. */
  readonly control: NoWoundConcernsControl | undefined;
  /** The wounds have been read (an unread list says nothing about whether a wound is on file). */
  readonly loaded: boolean;
  /** A wound is on file for the patient (or was just saved from this panel). */
  readonly woundOnFile: boolean;
  /** The note cannot be changed (signed, locked or saving): the statement is shown, not offered, and nothing is removed. */
  readonly disabled: boolean;
  /** No write of this panel is in flight. */
  readonly idle: boolean;
}

export const RECORDED_NO_CONCERNS = "Recorded: no skin or wound concerns at this visit";
const REMOVED_NO_CONCERNS = `Removed '${NO_WOUND_CONCERNS_SENTENCE}' because a wound was recorded.`;

export function useNoWoundConcernsStatement({
  control,
  loaded,
  woundOnFile,
  disabled,
  idle,
}: Options): {
  /** The button, or the Undo that replaces it: for the empty state's action row. Null when nothing is to be offered. */
  readonly controls: ReactNode;
  /** The recorded, removed and warning lines: for below the wound list. */
  readonly notices: ReactNode;
} {
  const onChange = control?.onChange;
  const onRemoved = control?.onRemoved;
  const state = control?.state ?? "absent";
  const [removed, setRemoved] = useState(false);
  // Focus follows the press: the control that replaces the pressed one takes it, instead of <body>.
  const slot = useRef<HTMLSpanElement>(null);
  const focusWhen = useRef<NoWoundConcernsState | null>(null);
  useEffect(() => {
    const expected = focusWhen.current;
    focusWhen.current = null;
    if (expected === state) slot.current?.querySelector("button")?.focus();
  }, [state]);

  const contradiction = loaded && woundOnFile && state !== "absent";
  // A wound recorded after the sentence was added: take out exactly that sentence. A reworded one is the clinician's own text and stays.
  useEffect(() => {
    if (!onChange || !contradiction || state !== "stated" || disabled) return;
    onChange("undo");
    setRemoved(true);
    onRemoved?.(REMOVED_NO_CONCERNS);
  }, [onChange, onRemoved, contradiction, state, disabled]);

  if (!control || !loaded) return { controls: null, notices: null };

  const request = (change: NoWoundConcernsChange): void => {
    focusWhen.current = change === "state" ? "stated" : "absent";
    setRemoved(false);
    control.onChange(change);
  };
  const offered = !disabled && !woundOnFile;
  const controls = !offered ? null : (
    <span ref={slot} style={{ display: "contents" }}>
      {state === "absent" ? (
        <Button tone="secondary" size="sm" disabled={!idle} onClick={() => request("state")}>
          No skin or wound concerns at this visit
        </Button>
      ) : state === "stated" ? (
        <Button
          tone="tertiary"
          size="sm"
          disabled={!idle}
          aria-label="Undo: no skin or wound concerns at this visit"
          onClick={() => request("undo")}
        >
          Undo
        </Button>
      ) : null}
    </span>
  );

  // `stated` beside a wound while editable is removed in the effect above: no warning for the one render before it lands.
  const warn = contradiction && (state === "reworded" || disabled);
  const notices = (
    <>
      {state === "stated" && !woundOnFile ? (
        <InlineAlert tone="success">{RECORDED_NO_CONCERNS}</InlineAlert>
      ) : null}
      {state === "reworded" && !woundOnFile ? (
        <InlineAlert tone="info">
          Your notes already say there is no skin breakdown or wound, worded your own way.
        </InlineAlert>
      ) : null}
      {removed ? <InlineAlert tone="info">{REMOVED_NO_CONCERNS}</InlineAlert> : null}
      {warn ? (
        <InlineAlert tone="warning">
          The notes say there is no skin breakdown or wound, but a wound is recorded for this
          patient.
          {disabled ? "" : " Edit the notes below so they agree."}
        </InlineAlert>
      ) : null}
    </>
  );
  return { controls, notices };
}
