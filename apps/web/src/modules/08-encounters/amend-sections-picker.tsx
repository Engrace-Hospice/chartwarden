// apps/web/src/modules/08-encounters — choosing the sections of a signed note an addendum amends (ADR-0114 VN-D30, S1 PR E3).
//
// Offered beside the free addendum, never instead of it: choosing none is a free addendum, exactly as before. At most twelve (the API's
// limit); a section the viewer cannot read (withheld) is shown but cannot be chosen, since nobody amends text they cannot see. The choice
// is the order it was made in; what is amended is decided later, section by section, when the author confirms each redraft.
import type { JSX } from "react";
import { MAX_AMENDED_SECTIONS } from "./amendment-model";
import { humanizeSection } from "./sign-draft-notice";
import { type AmendableSection, WITHHELD_LABEL } from "./signed-note-model";

const HINT_ID = "amend-sections-hint";
const WITHHELD_REASON = `${WITHHELD_LABEL}: protected by 42 CFR Part 2, your access does not include it`;

export interface AmendSectionsPickerProps {
  readonly sections: readonly AmendableSection[];
  readonly chosen: readonly string[];
  readonly onChange: (chosen: readonly string[]) => void;
  readonly disabled?: boolean;
}

export function AmendSectionsPicker({
  sections,
  chosen,
  onChange,
  disabled = false,
}: AmendSectionsPickerProps): JSX.Element {
  const atLimit = chosen.length >= MAX_AMENDED_SECTIONS;
  const toggle = (sectionId: string): void =>
    onChange(
      chosen.includes(sectionId) ? chosen.filter((id) => id !== sectionId) : [...chosen, sectionId],
    );

  return (
    <fieldset className="wx-form-stack wx-fieldset-reset" aria-describedby={HINT_ID}>
      <legend>Amend sections of this note (optional)</legend>
      <p id={HINT_ID} className="wx-row-sub">
        Choose the sections this addendum corrects. You will confirm a redraft of each before it can
        be signed; a section you do not confirm stays as signed. Leave all unchosen for a free
        addendum.
      </p>
      {sections.map(({ sectionId, selectable }) => {
        const inputId = `amend-section-${sectionId}`;
        const isChosen = chosen.includes(sectionId);
        return (
          <div key={sectionId} className="wx-action-check">
            <input
              id={inputId}
              type="checkbox"
              checked={isChosen}
              disabled={disabled || !selectable || (atLimit && !isChosen)}
              onChange={() => toggle(sectionId)}
            />
            <label htmlFor={inputId}>
              {humanizeSection(sectionId)}
              {selectable ? "" : ` (${WITHHELD_REASON})`}
            </label>
          </div>
        );
      })}
      <output className="wx-row-sub">
        {chosen.length} of {MAX_AMENDED_SECTIONS} chosen
      </output>
      {atLimit ? (
        <p className="wx-row-sub">
          At most {MAX_AMENDED_SECTIONS} sections can be amended in one addendum.
        </p>
      ) : null}
    </fieldset>
  );
}
