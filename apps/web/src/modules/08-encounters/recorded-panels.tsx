// apps/web/src/modules/08-encounters — the recorded-finding panels of the visit-note composer (WF09): ADLs, nutrition and wounds, each
// the form of a template section whose statements come from a saved record rather than from the section's own menu.
//
// Every panel of the template stays mounted and the others are only hidden: a panel holds its own unsaved form, so switching sections
// must not drop what was typed. Each loads its record once (no second fetch on a switch back) and tells the composer, through
// `onStatusChange`, whether it holds unsaved input, has a write in flight, and has a saved record.
import { type JSX, memo } from "react";
import type { PanelStatus } from "../../shell/panel-status";
import { VisitWoundsPanel } from "../09-assessments";
import type { TemplateSection } from "./encounters-api";
import { AdlPanel, NutritionPanel } from "./findings";

export type RecordedPanelKind = NonNullable<TemplateSection["recordedPanel"]>;

export interface RecordedPanelsProps {
  readonly sections: readonly TemplateSection[];
  /** The section the author has open; every other section's panel is hidden. */
  readonly activeSectionId: string | undefined;
  readonly encounterId: string;
  readonly patientId: string;
  /** The note cannot take a write right now (finalized, being edited, or busy): every panel is read-only. */
  readonly disabled: boolean;
  /** A panel saved something the note states: re-read the note. The kind says which panel, since only some records are a source of the draft. */
  readonly onChanged: (panel: RecordedPanelKind) => void;
  readonly onStatusChange: (panel: RecordedPanelKind, status: PanelStatus) => void;
}

function RecordedPanelsView({
  sections,
  activeSectionId,
  encounterId,
  patientId,
  disabled,
  onChanged,
  onStatusChange,
}: RecordedPanelsProps): JSX.Element {
  return (
    <>
      {sections.map((section) => {
        const kind = section.recordedPanel;
        if (!kind) return null;
        const report = (status: PanelStatus): void => onStatusChange(kind, status);
        return (
          <div key={section.sectionId} hidden={section.sectionId !== activeSectionId}>
            {kind === "adl" ? (
              <AdlPanel
                encounterId={encounterId}
                disabled={disabled}
                onSaved={() => onChanged(kind)}
                onStatusChange={report}
              />
            ) : kind === "nutrition" ? (
              <NutritionPanel
                encounterId={encounterId}
                disabled={disabled}
                onSaved={() => onChanged(kind)}
                onStatusChange={report}
              />
            ) : (
              <VisitWoundsPanel
                encounterId={encounterId}
                patientId={patientId}
                disabled={disabled}
                onChanged={() => onChanged(kind)}
                onStatusChange={report}
              />
            )}
          </div>
        );
      })}
    </>
  );
}

/** Memoised: with stable callbacks from the composer, a keystroke in the note's free text does not re-render the panels. */
export const RecordedPanels = memo(RecordedPanelsView);
