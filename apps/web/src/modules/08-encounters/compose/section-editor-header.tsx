// apps/web/src/modules/08-encounters/compose — the heading of the open section in the composer: its title and chip, what to do in it, and how
// many statements are selected (moved out of encounter-compose.tsx unchanged).
import type { JSX, RefObject } from "react";
import {
  editorDescription,
  editorHeader,
  editorTitle,
  editorTitleRow,
  eyebrow,
  optionalBadge,
  requiredBadge,
  selectionCounter,
} from "../encounter-compose-styles";
import { type TemplateSection, isSingleChoice } from "../encounters-api";
import type { SectionChip } from "../section-status";
import { PLAN_SECTION_ID, VITALS_SECTION_ID } from "./compose-model";

/** What the author does in the section, said under its title. */
function describeSection(active: TemplateSection): string {
  return isSingleChoice(active.entries)
    ? "Choose one. Anything the choice cannot say goes in the notes below, stored verbatim."
    : active.sectionId === VITALS_SECTION_ID && active.entries.length === 0
      ? "Record the visit's vitals below; the note states them here. Anything else goes in the free-text field, stored verbatim."
      : active.sectionId === PLAN_SECTION_ID && active.entries.length === 0
        ? "Say what the plan is and when the next visit will be. The guide and the schedule below show what an entry usually covers; what you write is stored verbatim."
        : active.entries.length === 0
          ? "This section has no preset statements. Write it in the free-text field below; it is stored verbatim."
          : "Select the statements that describe this visit. Additional free text is stored verbatim.";
}

export interface SectionEditorHeaderProps {
  readonly section: TemplateSection;
  readonly chip: SectionChip | null;
  readonly selectionCount: number;
  /** Takes focus when a drafted section is opened from the strip (see `useFocusRequest`). */
  readonly headingRef: RefObject<HTMLHeadingElement>;
}

export function SectionEditorHeader({
  section,
  chip,
  selectionCount,
  headingRef,
}: SectionEditorHeaderProps): JSX.Element {
  return (
    <header className="wx-encounter-compose-editor-header" style={editorHeader}>
      <div style={{ minWidth: 0 }}>
        <div style={eyebrow}>Current section</div>
        <div style={editorTitleRow}>
          <h2 ref={headingRef} tabIndex={-1} style={editorTitle}>
            {section.heading}
          </h2>
          {chip?.blocksFinalize ? (
            <span className="wx-encounter-required-badge" style={requiredBadge}>
              {chip.label}
            </span>
          ) : (
            <span style={optionalBadge}>{chip?.label}</span>
          )}
        </div>
        <p style={editorDescription}>{describeSection(section)}</p>
      </div>

      <div style={selectionCounter}>
        <strong>{selectionCount}</strong>
        <span>{selectionCount === 1 ? "statement selected" : "statements selected"}</span>
      </div>
    </header>
  );
}
