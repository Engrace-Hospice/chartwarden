// apps/web/src/modules/08-encounters — what the pain and the dyspnea assessment helpers share: the row/field/group definitions, the styles,
// the rule for a field that changes, the characteristic chips, and the labelled, described field controls. The two helpers read the same
// way on screen and for a screen reader, so there is ONE copy of that (they had drifted apart: the pain helper did not link its hints and
// its "Already recorded in ..." note to the controls). The words stay in each helper; the one sentence here, "Already recorded in ...",
// is the signed copy both helpers always showed, unchanged.
import { StatusPill, TextField } from "@chartwarden/ui";
import { Fragment, useId } from "react";
import type { CSSProperties, JSX } from "react";
import { hairline, slotGrid } from "./encounter-compose-styles";
import type { DraftEntry, MenuEntry, TemplateSection } from "./encounters-api";
import { MAX_TEXT_LENGTH, SlotInput } from "./slot-input";

/** One field of a statement: its slot, and a hint (a free-text field shows it; a choice or a number also carries its own bounds). */
export interface FieldDef {
  readonly slot: string;
  readonly label: string;
  readonly hint?: string;
}

/** One statement of a helper, as the clinician sees it. */
export interface RowDef {
  readonly code: string;
  readonly fields: readonly FieldDef[];
}

export interface GroupDef {
  readonly title: string;
  readonly note?: string;
  readonly rows: readonly RowDef[];
}

export const panel: CSSProperties = {
  border: hairline,
  borderRadius: "0.7rem",
  background: "var(--color-surface)",
  padding: "0.6rem 0.8rem 0.8rem",
};
export const summaryStyle: CSSProperties = {
  cursor: "pointer",
  fontSize: "0.82rem",
  fontWeight: 650,
};
export const body: CSSProperties = { display: "grid", gap: "0.8rem", marginTop: "0.6rem" };
export const small: CSSProperties = {
  margin: 0,
  fontSize: "0.72rem",
  lineHeight: 1.45,
  color: "var(--color-on-surface-variant)",
};
const chips: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: "0.35rem",
  margin: 0,
  padding: 0,
};
const groupTitle: CSSProperties = { fontSize: "0.74rem", fontWeight: 700 };
const rowStyle: CSSProperties = { display: "grid", gap: "0.2rem" };
const fieldsetStyle: CSSProperties = {
  border: 0,
  margin: 0,
  padding: 0,
  display: "grid",
  gap: "0.5rem",
};

export interface FieldChangeContext {
  /** What is selected in this section. */
  readonly selected: readonly DraftEntry[];
  /** Select or unselect a statement. */
  readonly onToggle: (entry: MenuEntry) => void;
  readonly onSlot: (code: string, slot: string, value: string) => void;
}

/**
 * A field of a statement changed. A field with a value is a selected statement; a statement with nothing left in any of its fields is
 * unselected, so the note never carries an empty one (a statement of two fields stays while either still holds a value).
 */
export function changeField(
  { selected, onToggle, onSlot }: FieldChangeContext,
  entry: MenuEntry,
  slot: string,
  value: string,
): void {
  const held = selected.find((e) => e.code === entry.code);
  const othersFilled = entry.slots.some(
    (s) => s !== slot && String(held?.params[s] ?? "").trim() !== "",
  );
  if (value.trim() === "" && !othersFilled) {
    if (held) onToggle(entry);
    return;
  }
  if (!held) onToggle(entry);
  onSlot(entry.code, slot, value);
}

interface CharacteristicChipsProps<C extends string> {
  /** The accessible name of the list. */
  readonly label: string;
  readonly characteristics: readonly C[];
  readonly names: Readonly<Record<C, string>>;
  readonly documented: readonly C[];
}

/** The characteristics of an assessment, each as a pill that says whether it is documented. */
export function CharacteristicChips<C extends string>({
  label,
  characteristics,
  names,
  documented,
}: CharacteristicChipsProps<C>): JSX.Element {
  return (
    <ul
      // biome-ignore lint/a11y/noRedundantRoles: Safari/VoiceOver drops list semantics when list-style is none
      // biome-ignore lint/a11y/useSemanticElements: it already is a <ul>; the role only restores the semantics Safari drops
      role="list"
      style={chips}
      aria-label={label}
    >
      {characteristics.map((c) => {
        const done = documented.includes(c);
        return (
          <li key={c} style={{ listStyle: "none" }}>
            <StatusPill
              label={`${names[c]}${done ? ": documented" : ""}`}
              tone={done ? "success" : "neutral"}
            />
          </li>
        );
      })}
    </ul>
  );
}

const slotText = (held: DraftEntry | undefined, slot: string): string =>
  String(held?.params[slot] ?? "");

interface FieldInputProps {
  readonly entry: MenuEntry;
  readonly def: FieldDef;
  readonly value: string;
  readonly disabled: boolean;
  /** The id of the "Already recorded in ..." paragraph of a locked row; the control's description includes it. */
  readonly lockNoteId?: string;
  readonly onChange: (value: string) => void;
}

function FieldInput({
  entry,
  def,
  value,
  disabled,
  lockNoteId,
  onChange,
}: FieldInputProps): JSX.Element {
  const hintId = useId();
  const spec = entry.slotSpecs[def.slot];
  if (spec === undefined) {
    // TextField ties its own hint to the control and keeps this id after it.
    return (
      <TextField
        label={def.label}
        hint={def.hint}
        maxLength={MAX_TEXT_LENGTH}
        aria-describedby={lockNoteId}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }
  const describedBy = [def.hint ? hintId : null, lockNoteId].filter(Boolean).join(" ") || undefined;
  return (
    <div style={rowStyle}>
      <SlotInput
        slot={def.slot}
        spec={spec}
        label={def.label}
        value={value}
        disabled={disabled}
        describedBy={describedBy}
        onChange={onChange}
      />
      {def.hint ? (
        <p id={hintId} style={small}>
          {def.hint}
        </p>
      ) : null}
    </div>
  );
}

interface GroupFieldsProps {
  readonly group: GroupDef;
  /** The group's statements the section's menu offers, in the group's order. */
  readonly entries: readonly MenuEntry[];
  readonly selected: readonly DraftEntry[];
  readonly disabled: boolean;
  readonly recordedElsewhere: (code: string) => TemplateSection | undefined;
  readonly onChange: (entry: MenuEntry, slot: string, value: string) => void;
  /** A note under an unlocked statement's fields (the pain helper's "fill in every field"); null for none. */
  readonly rowNote?: (entry: MenuEntry) => JSX.Element | null;
}

/**
 * One group of statements as a fieldset. "One statement, one place": a statement already recorded in another section of the note is
 * locked here and says where, and that note is part of the description of every control in the row.
 */
export function GroupFields({
  group,
  entries,
  selected,
  disabled,
  recordedElsewhere,
  onChange,
  rowNote,
}: GroupFieldsProps): JSX.Element {
  const idBase = useId();
  return (
    <fieldset style={fieldsetStyle}>
      <legend style={groupTitle}>{group.title}</legend>
      {group.note ? <p style={small}>{group.note}</p> : null}
      <div style={slotGrid}>
        {entries.flatMap((entry) => {
          const row = group.rows.find((r) => r.code === entry.code);
          const held = selected.find((e) => e.code === entry.code);
          const elsewhere = recordedElsewhere(entry.code);
          const lockNoteId =
            elsewhere === undefined ? undefined : `${idBase}-${entry.code}-elsewhere`;
          const fields = (row?.fields ?? []).map((def) => (
            <FieldInput
              key={def.slot}
              entry={entry}
              def={def}
              value={slotText(held, def.slot)}
              disabled={disabled || elsewhere !== undefined}
              lockNoteId={lockNoteId}
              onChange={(value) => onChange(entry, def.slot, value)}
            />
          ));
          if (elsewhere !== undefined) {
            return [
              ...fields,
              <p key={`${entry.code}-elsewhere`} id={lockNoteId} style={small}>
                Already recorded in {elsewhere.heading}
              </p>,
            ];
          }
          const note = rowNote?.(entry) ?? null;
          return note === null
            ? fields
            : [...fields, <Fragment key={`${entry.code}-note`}>{note}</Fragment>];
        })}
      </div>
    </fieldset>
  );
}
