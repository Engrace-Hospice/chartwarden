// apps/web/src/modules/08-encounters — the "Pain assessment" helper under the pain statements of the Symptom Management section.
//
// When "Symptom impact — pain limiting function" (or "pain controlled") is picked, this lists what a pain assessment is made of so the
// clinician can record it: the HOPE characteristics, the response to medication, side effects and bowel regimen, an inability to take
// oral medicine, nonverbal cues and the observation scale, the patient's own acceptable pain level, the score at the last visit and
// the change since, and the decision about the plan of care. Every field is OPTIONAL. Each one the clinician fills in becomes one
// corpus statement (`nv.sym.pain_*`) and one deterministic sentence of the note, in the clinician's own words; nothing is pre-filled.
//
// A field with a value is a selected statement; clearing it unselects the statement. The count and the plan-of-care prompt are
// advisory: they read the selected statements through the rules in `@chartwarden/types` (`pain-assessment.ts`), where each number
// carries its source, and they never block a save, a finalize or a sign.
import {
  PAIN_ASSESSMENT_CODES as PAIN,
  PAIN_CHARACTERISTICS,
  PAIN_CHARACTERISTIC_LABELS,
  PAIN_HQRP_MIN_CHARACTERISTICS,
  PAIN_PRN_REASSESS_HINT,
  PAIN_STATEMENT_CODES,
  isPainAssessmentCode,
  painCompleteness,
  painPlanReviewReasons,
} from "@chartwarden/types";
import { StatusPill, TextField } from "@chartwarden/ui";
import { Fragment } from "react";
import type { CSSProperties, JSX } from "react";
import { hairline, slotGrid } from "./encounter-compose-styles";
import type { DraftEntry, MenuEntry, TemplateSection } from "./encounters-api";
import { PlanReviewPrompt } from "./plan-review-prompt";
import { MAX_TEXT_LENGTH, SlotInput } from "./slot-input";

/** One field of a statement: its slot, and a hint for free text (a choice or a number carries its own bounds). */
interface FieldDef {
  readonly slot: string;
  readonly label: string;
  readonly hint?: string;
}

/** One statement of the helper, as the clinician sees it. */
interface RowDef {
  readonly code: string;
  readonly fields: readonly FieldDef[];
}

interface GroupDef {
  readonly title: string;
  readonly note?: string;
  readonly rows: readonly RowDef[];
}

// The hints name what the sources name: the descriptors and the nonverbal indicators are CMS's own examples (State Operations
// Manual, Appendix M, 418.54(c); HOPE v1.03 J0910 "Nonverbal Indicators"); the bowel regimen is National Consensus Project 2.3.2.
const PLAN_GROUP_TITLE = "Plan of care";

const GROUPS: readonly GroupDef[] = [
  {
    title: "Characteristics",
    note: "Severity and the effect on function come from the statement above.",
    rows: [
      {
        code: PAIN.location,
        fields: [
          { slot: "pain_location", label: "Location", hint: "Where it is, and where it spreads." },
        ],
      },
      {
        code: PAIN.character,
        fields: [
          {
            slot: "pain_character",
            label: "Character",
            hint: "For example burning, stabbing, tingling, aching; constant or intermittent.",
          },
        ],
      },
      {
        code: PAIN.duration,
        fields: [
          {
            slot: "pain_duration",
            label: "Duration",
            hint: "How long an episode lasts, or how long the pain has been present.",
          },
        ],
      },
      {
        code: PAIN.frequency,
        fields: [{ slot: "pain_frequency", label: "Frequency", hint: "How often it comes." }],
      },
      {
        code: PAIN.worsenedBy,
        fields: [
          {
            slot: "pain_worsened_by",
            label: "What makes it worse",
            hint: "Activities, care or treatment that bring it on or worsen it.",
          },
        ],
      },
      {
        code: PAIN.relievedBy,
        fields: [
          {
            slot: "pain_relieved_by",
            label: "What relieves it",
            hint: "Strategies and factors that ease it.",
          },
        ],
      },
    ],
  },
  {
    title: "Medication and treatment",
    rows: [
      {
        code: PAIN.prnRelief,
        fields: [
          {
            slot: "pain_prn_relief",
            label: "Response to the last as-needed dose",
            hint: PAIN_PRN_REASSESS_HINT,
          },
        ],
      },
      {
        code: PAIN.sideEffects,
        fields: [
          {
            slot: "pain_side_effects",
            label: "Medication side effects",
            hint: "What the patient or caregiver reports; write none reported if there are none.",
          },
        ],
      },
      {
        code: PAIN.bowelRegimen,
        fields: [
          {
            slot: "bowel_regimen",
            label: "Bowel regimen with an opioid",
            hint: "Is one in place, and is it working?",
          },
        ],
      },
      {
        code: PAIN.oralBarrier,
        fields: [
          {
            slot: "oral_barrier",
            label: "Cannot take oral pain medicine: why",
            hint: "For example, cannot swallow. Another route will need an order.",
          },
        ],
      },
    ],
  },
  {
    title: "If the patient cannot self-report",
    note: "Ask the patient first, then the caregiver. An observation scale score is not a 0 to 10 pain rating.",
    rows: [
      {
        code: PAIN.nonverbal,
        fields: [
          {
            slot: "nonverbal_cues",
            label: "Nonverbal cues observed",
            hint: "Sounds such as crying or groaning; grimacing or clenching the jaw; guarding, bracing or rubbing a body part.",
          },
        ],
      },
      {
        code: PAIN.observationScale,
        fields: [
          { slot: "observation_tool", label: "Observation scale" },
          { slot: "observation_score", label: "Observation scale score" },
        ],
      },
    ],
  },
  {
    title: "Compared with before",
    rows: [
      {
        code: PAIN.goal,
        fields: [
          {
            slot: "pain_goal",
            label: "The patient's own acceptable pain level",
            hint: "The level at which the patient is comfortable enough to do what matters to them.",
          },
        ],
      },
      {
        code: PAIN.lastScore,
        fields: [{ slot: "pain_last_score", label: "Pain score at the last visit" }],
      },
      {
        code: PAIN.change,
        fields: [{ slot: "pain_change", label: "Change since the last visit" }],
      },
    ],
  },
  {
    title: PLAN_GROUP_TITLE,
    rows: [
      {
        code: PAIN.planDecision,
        fields: [{ slot: "pain_plan_decision", label: "Your decision about the plan of care" }],
      },
    ],
  },
];

const PAIN_STATEMENT_CODE_LIST: readonly string[] = Object.values(PAIN_STATEMENT_CODES);

/** Whether a section shows the helper: it offers the pain statement, and one is picked (or a helper statement already is). */
export function showsPainHelper(
  menu: readonly MenuEntry[],
  selected: readonly DraftEntry[],
): boolean {
  return (
    menu.some((e) => e.code === PAIN_STATEMENT_CODES.limiting) &&
    selected.some((e) => PAIN_STATEMENT_CODE_LIST.includes(e.code) || isPainAssessmentCode(e.code))
  );
}

export interface PainAssessmentHelperProps {
  /** The section's menu; the helper lists the pain assessment statements it finds there. */
  readonly menu: readonly MenuEntry[];
  /** What is selected in this section. */
  readonly selected: readonly DraftEntry[];
  /** The note cannot take a write right now (finalized, being edited, or busy). */
  readonly disabled: boolean;
  /**
   * The other section a statement is already recorded in, if any ("one statement, one place", as the statement cards apply it): such a
   * row is locked here, so the note cannot state the same pain finding in two sections.
   */
  readonly recordedElsewhere: (code: string) => TemplateSection | undefined;
  /** Select or unselect a statement. */
  readonly onToggle: (entry: MenuEntry) => void;
  readonly onSlot: (code: string, slot: string, value: string) => void;
  /** Bring the Plan of care step into view. */
  readonly onOpenPlan: () => void;
}

const panel: CSSProperties = {
  border: hairline,
  borderRadius: "0.7rem",
  background: "var(--color-surface)",
  padding: "0.6rem 0.8rem 0.8rem",
};
const summaryStyle: CSSProperties = { cursor: "pointer", fontSize: "0.82rem", fontWeight: 650 };
const body: CSSProperties = { display: "grid", gap: "0.8rem", marginTop: "0.6rem" };
const small: CSSProperties = {
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

export function PainAssessmentHelper({
  menu,
  selected,
  disabled,
  recordedElsewhere,
  onToggle,
  onSlot,
  onOpenPlan,
}: PainAssessmentHelperProps): JSX.Element {
  const completeness = painCompleteness(selected);
  const reasons = painPlanReviewReasons(selected);

  function change(entry: MenuEntry, slot: string, value: string): void {
    const held = selected.find((e) => e.code === entry.code);
    const othersFilled = entry.slots.some(
      (s) => s !== slot && String(held?.params[s] ?? "").trim() !== "",
    );
    // A statement with nothing left in it is unselected, so the note never carries an empty one.
    if (value.trim() === "" && !othersFilled) {
      if (held) onToggle(entry);
      return;
    }
    if (!held) onToggle(entry);
    onSlot(entry.code, slot, value);
  }

  /** A statement of several fields that is only part filled: the note cannot state it until every field is. */
  function isHalfFilled(entry: MenuEntry): boolean {
    const held = selected.find((e) => e.code === entry.code);
    return (
      held !== undefined &&
      entry.slots.length > 1 &&
      entry.slots.some((s) => String(held.params[s] ?? "").trim() === "")
    );
  }

  function field(entry: MenuEntry, def: FieldDef, locked: boolean): JSX.Element {
    const value = String(selected.find((e) => e.code === entry.code)?.params[def.slot] ?? "");
    const spec = entry.slotSpecs[def.slot];
    if (spec === undefined) {
      return (
        <TextField
          key={def.slot}
          label={def.label}
          hint={def.hint}
          maxLength={MAX_TEXT_LENGTH}
          value={value}
          disabled={disabled || locked}
          onChange={(e) => change(entry, def.slot, e.target.value)}
        />
      );
    }
    return (
      <div key={def.slot} style={rowStyle}>
        <SlotInput
          slot={def.slot}
          spec={spec}
          label={def.label}
          value={value}
          disabled={disabled || locked}
          onChange={(v) => change(entry, def.slot, v)}
        />
        {def.hint ? <p style={small}>{def.hint}</p> : null}
      </div>
    );
  }

  return (
    <details open style={panel}>
      <summary style={summaryStyle}>
        Pain assessment: {completeness.count} of {completeness.total} characteristics documented
      </summary>
      <div style={body}>
        <p style={small}>
          Record what you assessed. Every field is optional; the note states only what you enter, in
          your own words. A comprehensive pain assessment covers seven characteristics.
        </p>
        <ul style={chips} aria-label="Characteristics of a comprehensive pain assessment">
          {PAIN_CHARACTERISTICS.map((c) => (
            <li key={c} style={{ listStyle: "none" }}>
              <StatusPill
                label={`${PAIN_CHARACTERISTIC_LABELS[c]}${completeness.documented.includes(c) ? ": documented" : ""}`}
                tone={completeness.documented.includes(c) ? "success" : "neutral"}
              />
            </li>
          ))}
        </ul>
        <p style={small}>
          {completeness.meetsQualityMeasureBenchmark
            ? `That reaches the CMS quality measure's ${PAIN_HQRP_MIN_CHARACTERISTICS} of 7 for an admission pain assessment.`
            : `CMS's admission quality measure counts a comprehensive pain assessment at ${PAIN_HQRP_MIN_CHARACTERISTICS} of 7. At a routine visit this is a guide, not a requirement.`}
        </p>

        {GROUPS.map((group) => {
          const rows = group.rows.filter((r) => menu.some((e) => e.code === r.code));
          // The prompt does not depend on the section offering the decision statement: it comes before the plan group either way.
          const isPlanGroup = group.title === PLAN_GROUP_TITLE;
          if (rows.length === 0 && !isPlanGroup) return null;
          return (
            <Fragment key={group.title}>
              {isPlanGroup ? (
                <PlanReviewPrompt reasons={reasons} onOpenPlan={onOpenPlan} disabled={disabled} />
              ) : null}
              {rows.length === 0 ? null : (
                <fieldset
                  style={{ border: 0, margin: 0, padding: 0, display: "grid", gap: "0.5rem" }}
                >
                  <legend style={groupTitle}>{group.title}</legend>
                  {group.note ? <p style={small}>{group.note}</p> : null}
                  <div style={slotGrid}>
                    {rows.flatMap((row) => {
                      const entry = menu.find((e) => e.code === row.code);
                      if (entry === undefined) return [];
                      const elsewhere = recordedElsewhere(entry.code);
                      const fields = row.fields.map((def) =>
                        field(entry, def, elsewhere !== undefined),
                      );
                      if (elsewhere !== undefined) {
                        return [
                          ...fields,
                          <p key={`${entry.code}-elsewhere`} style={small}>
                            Already recorded in {elsewhere.heading}
                          </p>,
                        ];
                      }
                      return isHalfFilled(entry)
                        ? [
                            ...fields,
                            <output
                              key={`${entry.code}-incomplete`}
                              style={{ ...small, display: "block" }}
                            >
                              Fill in every field here, or clear them, before this note is
                              finalized.
                            </output>,
                          ]
                        : fields;
                    })}
                  </div>
                </fieldset>
              )}
            </Fragment>
          );
        })}
      </div>
    </details>
  );
}
