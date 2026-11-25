// apps/web/src/modules/08-encounters/slot-input.tsx — one `${slot}` input, rendered from the SERVER's
// constraint on that slot (WF09 step 1).
//
// The composer and the addendum panel both rendered every slot as a free text box, so "oxygen at 79 L/min"
// and "requires 14 assistance" were one keystroke away. The menu now publishes each slot's spec; this
// renders the matching control. It is a convenience, not the rule: the server re-validates every write, so
// a client that skips this still cannot store an out-of-range value.
import { SelectField, TextField } from "@chartwarden/ui";
import type { JSX } from "react";
import type { MenuEntry } from "./encounters-api";

export type SlotSpecView = MenuEntry["slotSpecs"][string];

/** Mirrors `MAX_TEXT_SLOT_LENGTH` in `@chartwarden/narrative-vocab` (the web app does not import the corpus). */
export const MAX_TEXT_LENGTH = 200;

const humanize = (slot: string): string =>
  slot.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

interface SlotInputProps {
  readonly slot: string;
  /** Absent for a free-text slot. */
  readonly spec: SlotSpecView | undefined;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly disabled: boolean;
  /** Overrides the spec's label (the addendum panel prefixes the statement it belongs to). */
  readonly label?: string;
  /** The id of text beside the control that describes it (a hint the caller renders); the control's `aria-describedby` points at it. */
  readonly describedBy?: string;
}

export function SlotInput({
  slot,
  spec,
  value,
  onChange,
  disabled,
  label,
  describedBy,
}: SlotInputProps): JSX.Element {
  const text = label ?? spec?.label ?? humanize(slot);

  if (spec?.kind === "choice") {
    return (
      <SelectField
        label={text}
        value={value}
        aria-describedby={describedBy}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        options={[
          { value: "", label: "Select…" },
          ...spec.options.map((option) => ({ value: option, label: option })),
        ]}
      />
    );
  }

  if (spec !== undefined) {
    const whole = spec.kind === "integer";
    return (
      <TextField
        label={text}
        type="number"
        inputMode={whole ? "numeric" : "decimal"}
        min={spec.min}
        max={spec.max}
        step={whole ? 1 : "any"}
        hint={`${spec.min}–${spec.max}${spec.unit ? ` ${spec.unit}` : ""}`}
        aria-describedby={describedBy}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }

  return (
    <TextField
      label={text}
      maxLength={MAX_TEXT_LENGTH}
      aria-describedby={describedBy}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}
