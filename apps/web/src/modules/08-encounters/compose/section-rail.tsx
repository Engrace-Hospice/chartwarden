// apps/web/src/modules/08-encounters/compose — the composer's section rail: one button per template section, with where the section stands
// and the state of its drafted text (moved out of encounter-compose.tsx).
import type { JSX } from "react";
import type { DraftView } from "../draft-api";
import { STATE_LABEL, draftedStateOf } from "../draft-model";
import {
  eyebrow,
  railCount,
  railHeader,
  railTitle,
  readOnlyHint,
  sectionIndex,
  sectionIndexActive,
  sectionIndexComplete,
  sectionNav,
  sectionNavButton,
  sectionNavButtonActive,
  sectionNavCopy,
  sectionNavMeta,
  sectionNavMetaRequired,
  sectionNavTitle,
  sectionNavTitleActive,
  sectionRail,
} from "../encounter-compose-styles";
import { stateLabel } from "../encounter-status";
import type { EncounterView, TemplateSection } from "../encounters-api";
import { type SectionFacts, sectionState } from "../section-status";

export interface SectionRailProps {
  readonly sections: readonly TemplateSection[];
  readonly activeSectionId: string | undefined;
  readonly drafted: DraftView | null;
  readonly factsOf: (section: TemplateSection) => SectionFacts;
  readonly onOpenSection: (sectionId: string) => void;
  readonly editable: boolean;
  readonly encounterStatus: EncounterView["status"];
}

export function SectionRail({
  sections,
  activeSectionId,
  drafted,
  factsOf,
  onOpenSection,
  editable,
  encounterStatus,
}: SectionRailProps): JSX.Element {
  return (
    <aside
      className="wx-encounter-compose-section-rail"
      style={sectionRail}
      aria-label="Visit note sections"
    >
      <div style={railHeader}>
        <div>
          <div style={eyebrow}>Note sections</div>
          <strong style={railTitle}>Document the visit</strong>
        </div>
        <span style={railCount}>{sections.length}</span>
      </div>

      <nav style={sectionNav}>
        {sections.map((section, index) => {
          // "Documented" means finalize will take it: a statement with an empty slot is not that.
          const state = sectionState(factsOf(section));
          const filled = state === "Documented";
          const isActive = section.sectionId === activeSectionId;
          const needsAttention = state === "Needs details" || state === "Required";
          const draftedState = draftedStateOf(drafted, section.sectionId);

          return (
            <button
              key={section.sectionId}
              type="button"
              onClick={() => onOpenSection(section.sectionId)}
              aria-current={isActive ? "step" : undefined}
              aria-label={`${section.heading}: ${state}${
                draftedState ? `, draft ${STATE_LABEL[draftedState].toLowerCase()}` : ""
              }`}
              style={{
                ...sectionNavButton,
                ...(isActive ? sectionNavButtonActive : null),
              }}
            >
              <span
                style={{
                  ...sectionIndex,
                  ...(filled ? sectionIndexComplete : null),
                  ...(isActive && !filled ? sectionIndexActive : null),
                }}
                aria-hidden
              >
                {filled ? "✓" : index + 1}
              </span>

              <span style={sectionNavCopy}>
                <span
                  style={{
                    ...sectionNavTitle,
                    ...(isActive ? sectionNavTitleActive : null),
                  }}
                >
                  {section.heading}
                </span>

                <span
                  style={{
                    ...sectionNavMeta,
                    ...(needsAttention ? sectionNavMetaRequired : null),
                  }}
                >
                  {state}
                </span>
                {draftedState ? (
                  <span style={sectionNavMeta}>Draft: {STATE_LABEL[draftedState]}</span>
                ) : null}
              </span>
            </button>
          );
        })}
      </nav>

      {!editable ? (
        <div style={readOnlyHint}>
          This note is read-only because the encounter is{" "}
          {stateLabel(encounterStatus).toLowerCase()}.
        </div>
      ) : null}
    </aside>
  );
}
