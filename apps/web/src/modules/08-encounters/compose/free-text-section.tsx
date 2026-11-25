// apps/web/src/modules/08-encounters/compose — the "Additional clinical notes" box under a section's statements in the composer: the
// author's own words, stored verbatim (moved out of encounter-compose.tsx unchanged).
import { TextAreaField } from "@chartwarden/ui";
import type { JSX } from "react";
import {
  freeTextHeading,
  freeTextHint,
  freeTextSection,
  freeTextTitle,
  verbatimBadge,
} from "../encounter-compose-styles";

export interface FreeTextSectionProps {
  /** What writing here means for this section (see `notesHint`). */
  readonly hint: string | null;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly disabled: boolean;
}

export function FreeTextSection({
  hint,
  value,
  onChange,
  disabled,
}: FreeTextSectionProps): JSX.Element {
  return (
    <div style={freeTextSection}>
      <div style={freeTextHeading}>
        <div>
          <strong style={freeTextTitle}>Additional clinical notes</strong>
          <p style={freeTextHint}>{hint}</p>
        </div>
        <span style={verbatimBadge}>Recorded verbatim</span>
      </div>

      <TextAreaField
        label="Additional notes"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={5}
        disabled={disabled}
      />
    </div>
  );
}
