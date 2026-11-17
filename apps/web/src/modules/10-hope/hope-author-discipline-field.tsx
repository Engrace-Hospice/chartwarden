// apps/web/src/modules/10-hope — the control that says which discipline a write is attributed to. The server binds the
// attribution to the caller's OWN role keys (403 M10_DISCIPLINE_NOT_PERMITTED otherwise), so only those are offered: one
// is preselected by the caller, two or more make the clinician choose, none says so. Shared by every dialog that sends an
// `authorDiscipline` (the SFV completion, a correction, an inactivation) so they cannot drift apart.
import type { JSX } from "react";
import { type SfvAuthorDiscipline, authorDisciplineLabel } from "./hope-api";
import { sfvField, sfvFieldLabel, sfvInput, sfvSectionDescription } from "./hope-dialog-styles";

export function AuthorDisciplineField(props: {
  /** The caller's own disciplines for this write (`authorDisciplinesForRoles`). */
  readonly disciplines: readonly SfvAuthorDiscipline[];
  readonly value: SfvAuthorDiscipline | "";
  readonly onChange: (value: SfvAuthorDiscipline | "") => void;
  readonly disabled: boolean;
  /** What to say when none of the caller's roles may be the author of this write. */
  readonly noneMessage: string;
}): JSX.Element {
  const { disciplines, value, onChange, disabled, noneMessage } = props;
  if (disciplines.length === 0) {
    return (
      <div style={sfvField}>
        <span style={sfvFieldLabel}>Author discipline</span>
        <p style={sfvSectionDescription}>{noneMessage}</p>
      </div>
    );
  }
  return (
    <label style={sfvField}>
      <span style={sfvFieldLabel}>Author discipline</span>
      <select
        value={value}
        style={sfvInput}
        disabled={disabled}
        onChange={(event) => onChange(disciplines.find((d) => d === event.target.value) ?? "")}
      >
        {disciplines.length > 1 ? <option value="">Choose a discipline</option> : null}
        {disciplines.map((discipline) => (
          <option key={discipline} value={discipline}>
            {authorDisciplineLabel(discipline)}
          </option>
        ))}
      </select>
    </label>
  );
}
