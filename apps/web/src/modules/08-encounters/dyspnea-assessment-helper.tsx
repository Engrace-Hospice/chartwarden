// apps/web/src/modules/08-encounters — the "Dyspnea assessment" helper under the dyspnea statement of the Symptom Management section.
//
// When "Symptom impact — dyspnea limiting function" is picked, this lists what a dyspnea assessment is made of so the clinician can
// record it: the intensity the patient reports, onset, when it occurs, what brings it on and what relieves it, what it feels like, the
// distress with it, its effect on function, the non-drug measures tried and the response, the signs observed in a patient who cannot
// self-report, the patient's own acceptable level, the score at the last visit and the change since, and the decision about the plan
// of care. Every field is OPTIONAL. Each one the clinician fills in becomes one corpus statement (`nv.sym.dyspnea_*`) and one
// deterministic sentence of the note, in the clinician's own words; nothing is pre-filled (the last visit's score is typed, never
// carried over).
//
// A field with a value is a selected statement; clearing it unselects the statement (every dyspnea statement has exactly one field).
// "One statement, one place": a statement already recorded in another section of the note is locked here and says where. The count
// and the plan-of-care prompt are advisory: they read the selected statements through the rules in `@chartwarden/types`
// (`dyspnea-assessment.ts`), where each reason carries its source, and they never block a save, a finalize or a sign. NO SOURCE
// DEFINES A DYSPNEA CUT-OFF, so nothing here names a severity range, an observation scale, an oxygen or opioid step or a time to
// act. Same shape as `pain-assessment-helper.tsx`.
import {
  DYSPNEA_ASSESSMENT_CODES as D,
  DYSPNEA_CHARACTERISTICS,
  DYSPNEA_CHARACTERISTIC_LABELS,
  DYSPNEA_STATEMENT_CODE,
  DYSPNEA_SLOTS as S,
  dyspneaCompleteness,
  dyspneaPlanReviewReasons,
  isDyspneaAssessmentCode,
} from "@chartwarden/types";
import { Fragment } from "react";
import type { JSX } from "react";
import {
  CharacteristicChips,
  type GroupDef,
  GroupFields,
  body,
  changeField,
  panel,
  small,
  summaryStyle,
} from "./assessment-helper-fields";
import type { DraftEntry, MenuEntry, TemplateSection } from "./encounters-api";
import { PlanReviewPrompt } from "./plan-review-prompt";

const PLAN_GROUP_TITLE = "Plan of care";

const INTRO =
  "Record what you assessed. Every field is optional; the note states only what you enter, in your own words. This helper lists eight characteristics; none of the sources reviewed sets how many are required.";

const GROUPS: readonly GroupDef[] = [
  {
    title: "Characteristics",
    note: "Intensity is the 0 to 10 score the patient reports. No validated dyspnea cut-off was found, and the published ESAS values differ, so none is used here.",
    rows: [
      {
        code: D.score,
        fields: [
          {
            slot: S.score,
            label: "Intensity (0 to 10)",
            hint: "Ask the patient to rate shortness of breath now, 0 is none and 10 is worst.",
          },
        ],
      },
      { code: D.onset, fields: [{ slot: S.onset, label: "Onset" }] },
      { code: D.setting, fields: [{ slot: S.setting, label: "When it occurs" }] },
      {
        code: D.triggers,
        fields: [{ slot: S.triggers, label: "What brings it on or worsens it" }],
      },
      { code: D.relievedBy, fields: [{ slot: S.relievedBy, label: "What relieves it" }] },
      { code: D.quality, fields: [{ slot: S.quality, label: "Quality (what it feels like)" }] },
      { code: D.distress, fields: [{ slot: S.distress, label: "Distress or anxiety" }] },
      { code: D.function, fields: [{ slot: S.function, label: "Effect on function" }] },
    ],
  },
  {
    title: "Measures tried",
    rows: [
      {
        code: D.nonDrug,
        fields: [
          {
            slot: S.nonDrug,
            label: "Non-drug measures",
            hint: "For example positioning, a fan, relaxation techniques.",
          },
        ],
      },
      {
        code: D.response,
        fields: [{ slot: S.response, label: "Response to the measures tried" }],
      },
    ],
  },
  {
    title: "If the patient cannot self-report",
    rows: [
      {
        code: D.nonverbal,
        fields: [
          {
            slot: S.nonverbal,
            label: "Signs observed",
            hint: "Ask the patient first, then the caregiver. An observation score is not a 0 to 10 dyspnea rating.",
          },
        ],
      },
    ],
  },
  {
    title: "Compared with before",
    rows: [
      {
        code: D.goal,
        fields: [
          {
            slot: S.goal,
            label: "The patient's own acceptable dyspnea level",
            hint: "The level at which the patient is comfortable enough, for the same situation (rest or activity) in which you rated the intensity above.",
          },
        ],
      },
      {
        code: D.lastScore,
        fields: [{ slot: S.lastScore, label: "Dyspnea score at the last visit" }],
      },
      { code: D.change, fields: [{ slot: S.change, label: "Change since the last visit" }] },
    ],
  },
  {
    title: PLAN_GROUP_TITLE,
    rows: [
      {
        code: D.planDecision,
        fields: [{ slot: S.planDecision, label: "Your decision about the plan of care" }],
      },
    ],
  },
];

/** Whether a section shows the helper: it offers the dyspnea statement, and one is picked (or a helper statement already is). */
export function showsDyspneaHelper(
  menu: readonly MenuEntry[],
  selected: readonly DraftEntry[],
): boolean {
  return (
    menu.some((e) => e.code === DYSPNEA_STATEMENT_CODE) &&
    selected.some((e) => e.code === DYSPNEA_STATEMENT_CODE || isDyspneaAssessmentCode(e.code))
  );
}

export interface DyspneaAssessmentHelperProps {
  /** The section's menu; the helper lists the dyspnea assessment statements it finds there. */
  readonly menu: readonly MenuEntry[];
  /** What is selected in this section. */
  readonly selected: readonly DraftEntry[];
  /**
   * Every statement selected anywhere in the note, which is what the one-place lock reads. The count, the chips and the reasons read these,
   * so a finding recorded in another section still counts here and in the card, the same as in the Plan section's card. Defaults to `selected`.
   */
  readonly allSelected?: readonly DraftEntry[];
  /** The note cannot take a write right now (finalized, being edited, or busy). */
  readonly disabled: boolean;
  /**
   * The other section a statement is already recorded in, if any ("one statement, one place", as the statement cards apply it): such a
   * row is locked here, so the note cannot state the same dyspnea finding in two sections.
   */
  readonly recordedElsewhere: (code: string) => TemplateSection | undefined;
  /** Select or unselect a statement. */
  readonly onToggle: (entry: MenuEntry) => void;
  readonly onSlot: (code: string, slot: string, value: string) => void;
  /** Bring the Plan of care step into view. */
  readonly onOpenPlan: () => void;
}

export function DyspneaAssessmentHelper({
  menu,
  selected,
  allSelected = selected,
  disabled,
  recordedElsewhere,
  onToggle,
  onSlot,
  onOpenPlan,
}: DyspneaAssessmentHelperProps): JSX.Element {
  const completeness = dyspneaCompleteness(allSelected);
  const reasons = dyspneaPlanReviewReasons(allSelected);

  const change = (entry: MenuEntry, slot: string, value: string): void =>
    changeField({ selected, onToggle, onSlot }, entry, slot, value);

  return (
    // `details` is a group; the pain helper beside it uses the same field names and legends, so this one is named by its subject.
    <details open style={panel} aria-label="Dyspnea assessment">
      <summary style={summaryStyle}>
        {`Dyspnea assessment: ${completeness.count} of ${completeness.total} characteristics documented`}
      </summary>
      <div style={body}>
        <p style={small}>{INTRO}</p>
        <CharacteristicChips
          label="Characteristics of a dyspnea assessment"
          characteristics={DYSPNEA_CHARACTERISTICS}
          names={DYSPNEA_CHARACTERISTIC_LABELS}
          documented={completeness.documented}
        />

        {GROUPS.map((group) => {
          const entries = group.rows.flatMap((row) => menu.filter((e) => e.code === row.code));
          // The prompt does not depend on the section offering the decision statement: it comes before the plan group either way.
          const isPlanGroup = group.title === PLAN_GROUP_TITLE;
          if (entries.length === 0 && !isPlanGroup) return null;
          return (
            <Fragment key={group.title}>
              {isPlanGroup ? (
                <PlanReviewPrompt
                  kind="dyspnea"
                  reasons={reasons}
                  onOpenPlan={onOpenPlan}
                  disabled={disabled}
                />
              ) : null}
              {entries.length === 0 ? null : (
                <GroupFields
                  group={group}
                  entries={entries}
                  selected={selected}
                  disabled={disabled}
                  recordedElsewhere={recordedElsewhere}
                  onChange={change}
                />
              )}
            </Fragment>
          );
        })}
      </div>
    </details>
  );
}
