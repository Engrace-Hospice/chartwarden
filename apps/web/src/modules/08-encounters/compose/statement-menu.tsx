// apps/web/src/modules/08-encounters/compose — the open section's statement menu in the composer: a single-choice select (with the reason's
// suggestion hint and the fall link), a grid of tickable statements with their detail slots, or the note that a section has no presets
// (moved out of encounter-compose.tsx).
import { isDyspneaAssessmentCode, isPainAssessmentCode } from "@chartwarden/types";
import { SelectField, StatusPill } from "@chartwarden/ui";
import type { JSX } from "react";
import { humanize } from "../compose-text";
import { DyspneaAssessmentHelper, showsDyspneaHelper } from "../dyspnea-assessment-helper";
import {
  emptyVocabulary,
  emptyVocabularyText,
  emptyVocabularyTitle,
  entryCard,
  entryCardSelected,
  entryCheckbox,
  entryContent,
  entryGrid,
  entryLabel,
  entryMetaRow,
  entryText,
  freeTextHint,
  slotGrid,
  slotPanel,
  slotPanelTitle,
} from "../encounter-compose-styles";
import {
  type DraftEntry,
  type DraftSections,
  type MenuEntry,
  type TemplateSection,
  isSingleChoice,
} from "../encounters-api";
import { FallLinkField, type FallLinkFieldProps } from "../fall-link-field";
import { PainAssessmentHelper, showsPainHelper } from "../pain-assessment-helper";
import { SlotInput } from "../slot-input";
import { PLAN_SECTION_ID, REASON_SECTION_ID, VITALS_SECTION_ID } from "./compose-model";

export interface StatementMenuProps {
  /** The open section. */
  readonly section: TemplateSection;
  /** Every section of the template: a statement already recorded in another one is locked here. */
  readonly sections: readonly TemplateSection[];
  readonly draft: DraftSections;
  readonly disabled: boolean;
  readonly discipline: string;
  readonly encounterType: string;
  /** The reason the scheduled visit's purpose suggested, held as an unsaved choice. */
  readonly suggestion: { readonly code: string; readonly from: string } | null;
  readonly selectionsDirty: boolean;
  /** The reason is "follow-up after a fall": the fall link shows beside it. */
  readonly reasonIsFall: boolean;
  readonly fallLink: Omit<FallLinkFieldProps, "disabled">;
  readonly onChooseOne: (section: TemplateSection, code: string) => void;
  readonly onToggleEntry: (sectionId: string, entry: MenuEntry) => void;
  readonly onSetSlot: (sectionId: string, code: string, slot: string, value: string) => void;
  readonly onOpenPlan: () => void;
}

export function StatementMenu({
  section,
  sections,
  draft,
  disabled,
  discipline,
  encounterType,
  suggestion,
  selectionsDirty,
  reasonIsFall,
  fallLink,
  onChooseOne,
  onToggleEntry,
  onSetSlot,
  onOpenPlan,
}: StatementMenuProps): JSX.Element | null {
  if (
    section.entries.length === 0 &&
    (section.recordedPanel ||
      section.sectionId === VITALS_SECTION_ID ||
      section.sectionId === PLAN_SECTION_ID)
  ) {
    return null;
  }
  if (section.entries.length === 0) {
    return (
      <div style={emptyVocabulary}>
        <strong style={emptyVocabularyTitle}>No preset statements for this section</strong>
        <p style={emptyVocabularyText}>
          Add the documentation for this {humanize(discipline)} {humanize(encounterType)} in the
          free-text field below.
        </p>
      </div>
    );
  }
  if (isSingleChoice(section.entries)) {
    return (
      <>
        <SelectField
          label={section.heading}
          value={draft[section.sectionId]?.entries[0]?.code ?? ""}
          disabled={disabled}
          onChange={(e) => onChooseOne(section, e.target.value)}
          options={[
            { value: "", label: "Select…" },
            ...section.entries.map((e) => ({ value: e.code, label: e.label })),
          ]}
        />
        {section.sectionId === REASON_SECTION_ID &&
        suggestion !== null &&
        selectionsDirty &&
        draft[section.sectionId]?.entries[0]?.code === suggestion.code ? (
          <p style={freeTextHint}>
            Suggested from the scheduled visit ({suggestion.from}). Save to keep it, or choose
            another.
          </p>
        ) : null}
        {section.sectionId === REASON_SECTION_ID && reasonIsFall ? (
          <FallLinkField {...fallLink} disabled={disabled} />
        ) : null}
      </>
    );
  }
  // One statement, one place: a statement already recorded in another section is locked here so the note cannot carry it twice with
  // different values. The statement cards and the pain and dyspnea helpers' rows read the same rule.
  const recordedElsewhere = (code: string): TemplateSection | undefined =>
    draft[section.sectionId]?.entries.some((e) => e.code === code)
      ? undefined
      : sections.find(
          (s) =>
            s.sectionId !== section.sectionId &&
            draft[s.sectionId]?.entries.some((e) => e.code === code),
        );
  return (
    <div style={entryGrid}>
      {section.entries
        .filter(
          (entry) => !isPainAssessmentCode(entry.code) && !isDyspneaAssessmentCode(entry.code),
        )
        .map((entry) => {
          const picked = draft[section.sectionId]?.entries.find((e) => e.code === entry.code);
          const elsewhere = recordedElsewhere(entry.code);

          return (
            <StatementCard
              key={entry.code}
              sectionId={section.sectionId}
              entry={entry}
              picked={picked}
              elsewhere={elsewhere}
              disabled={disabled}
              onToggleEntry={onToggleEntry}
              onSetSlot={onSetSlot}
            />
          );
        })}
      {showsPainHelper(section.entries, draft[section.sectionId]?.entries ?? []) ? (
        <PainAssessmentHelper
          menu={section.entries}
          selected={draft[section.sectionId]?.entries ?? []}
          allSelected={Object.values(draft).flatMap((s) => s.entries)}
          disabled={disabled}
          recordedElsewhere={recordedElsewhere}
          onToggle={(entry) => onToggleEntry(section.sectionId, entry)}
          onSlot={(code, slot, value) => onSetSlot(section.sectionId, code, slot, value)}
          onOpenPlan={onOpenPlan}
        />
      ) : null}
      {showsDyspneaHelper(section.entries, draft[section.sectionId]?.entries ?? []) ? (
        <DyspneaAssessmentHelper
          menu={section.entries}
          selected={draft[section.sectionId]?.entries ?? []}
          allSelected={Object.values(draft).flatMap((s) => s.entries)}
          disabled={disabled}
          recordedElsewhere={recordedElsewhere}
          onToggle={(entry) => onToggleEntry(section.sectionId, entry)}
          onSlot={(code, slot, value) => onSetSlot(section.sectionId, code, slot, value)}
          onOpenPlan={onOpenPlan}
        />
      ) : null}
    </div>
  );
}

interface StatementCardProps {
  readonly sectionId: string;
  readonly entry: MenuEntry;
  /** The author's selection of this statement, with the details they filled in; undefined when it is not ticked. */
  readonly picked: DraftEntry | undefined;
  /** The other section this statement is already recorded in, if any. */
  readonly elsewhere: TemplateSection | undefined;
  readonly disabled: boolean;
  readonly onToggleEntry: (sectionId: string, entry: MenuEntry) => void;
  readonly onSetSlot: (sectionId: string, code: string, slot: string, value: string) => void;
}

function StatementCard({
  sectionId,
  entry,
  picked,
  elsewhere,
  disabled,
  onToggleEntry,
  onSetSlot,
}: StatementCardProps): JSX.Element {
  const selected = picked !== undefined;
  return (
    <div
      style={{
        ...entryCard,
        ...(selected ? entryCardSelected : null),
      }}
    >
      <label style={entryLabel}>
        <input
          type="checkbox"
          checked={selected}
          disabled={disabled || elsewhere !== undefined}
          onChange={() => onToggleEntry(sectionId, entry)}
          style={entryCheckbox}
        />

        <span style={entryContent}>
          <span style={entryText}>{entry.label}</span>

          {entry.bodySystem ? (
            <span style={entryMetaRow}>
              <StatusPill label={humanize(entry.bodySystem)} tone="neutral" />
            </span>
          ) : null}

          {elsewhere ? (
            <span style={entryMetaRow}>Already recorded in {elsewhere.heading}</span>
          ) : null}
        </span>
      </label>

      {picked && entry.slots.length > 0 ? (
        <div style={slotPanel}>
          <div style={slotPanelTitle}>Complete selected details</div>

          <div style={slotGrid}>
            {entry.slots.map((slot) => (
              <SlotInput
                key={slot}
                slot={slot}
                spec={entry.slotSpecs[slot]}
                value={String(picked.params[slot] ?? "")}
                onChange={(value) => onSetSlot(sectionId, entry.code, slot, value)}
                disabled={disabled}
              />
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
