// @chartwarden/assessments — the per-scale ITEM definitions the capture form is built from (F-067).
//
// `SCALE_CATALOG` (catalog.ts) has always carried a scale's label, family and license requirement, and
// its own header says it is "the single source the record-modal scale picker (T07) ... read". There was
// no record modal: the ITEMS a scale's `data` payload must carry — how many, what kind, what range,
// which option values — existed only as TypeScript interfaces in `scale-types.ts`. A client cannot read
// a type. So `POST /patients/:id/assessments` published `data` as a bare object and a capture form could
// only be a hand-copied duplicate of these shapes, free to drift from what `scoring.ts` computes over.
//
// This module is the shapes as DATA, so one definition drives the form and the scorer. It is pure and
// leaf-only: no IO, no route awareness. The route (M9) projects it; `scoring.ts` consumes the payload
// the form produces.
//
// TEN OF THE FOURTEEN SCALES ARE NOT RECORDABLE. `scoring.ts` registers four scorers (PPS / FAST /
// PAINAD / ESAS-r) and raises `SCALE_SCORER_UNAVAILABLE` — a **500** — for the other ten, which are all
// in the route's own `scaleType` enum. That is a legal request reaching an unhandled path, and it is why
// `items` is `null` rather than `[]` for them: a form cannot be built, and "no items" would read as
// "this scale takes no data" rather than "this scale cannot be captured yet".
import type { ScaleType } from "@chartwarden/types";
import { SCALE_CATALOG } from "../catalog";
import { hasScorer } from "../scoring";
import { esasrScorer } from "./esas-r";
import { fastScorer } from "./fast";
import { painadScorer } from "./painad";
import { ppsScorer } from "./pps";

/** How one item is captured. `choice` carries `options`; `number` carries an inclusive `[min, max]`. */
export type ScaleItemKind = "number" | "choice" | "text";

/** One capturable item of a scale's `data` payload. `key` is the exact `data` property name. */
export interface ScaleItemDefinition {
  readonly key: string;
  readonly label: string;
  readonly kind: ScaleItemKind;
  readonly required: boolean;
  /** `number` only — the inclusive range the instrument defines for this item. */
  readonly min?: number;
  readonly max?: number;
  /** `choice` only — the exact values the `data` property accepts, in instrument order. */
  readonly options?: readonly { readonly value: string; readonly label: string }[];
}

/** A scale as the capture form needs it: catalog metadata + whether it can be captured + its items. */
export interface ScaleDefinition {
  readonly scaleType: ScaleType;
  readonly label: string;
  readonly family: string;
  readonly licenseRequired: boolean;
  /** False for the ten scales whose scorer is unregistered — capture would raise a 500. */
  readonly recordable: boolean;
  /** The published inclusive score range, or null when the scale has no scorer. */
  readonly scoreRange: readonly [number, number] | null;
  /** Null (not empty) when the scale is not recordable — see the header. */
  readonly items: readonly ScaleItemDefinition[] | null;
}

/** One persisted response projected for the assessment-detail read surface. */
export interface ScaleResponseItem {
  readonly key: string;
  readonly label: string;
  readonly value: string | number | boolean;
  readonly displayValue: string;
}

export interface ScaleResponseDetail {
  readonly items: readonly ScaleResponseItem[];
  readonly notes: string | null;
}

const choice = (
  key: string,
  label: string,
  values: readonly (readonly [string, string])[],
): ScaleItemDefinition => ({
  key,
  label,
  kind: "choice",
  required: true,
  options: values.map(([value, optLabel]) => ({ value, label: optLabel })),
});

const zeroToTen = (key: string, label: string): ScaleItemDefinition => ({
  key,
  label,
  kind: "number",
  required: true,
  min: 0,
  max: 10,
});

const zeroToTwo = (key: string, label: string): ScaleItemDefinition => ({
  key,
  label,
  kind: "number",
  required: true,
  min: 0,
  max: 2,
});

const NOTES: ScaleItemDefinition = {
  key: "notes",
  label: "Notes",
  kind: "text",
  required: false,
};

/** PPS — five ordinal axes; the server computes the 0..100 decile from them (§4.3). */
const PPS_ITEMS: readonly ScaleItemDefinition[] = [
  choice("ambulation", "Ambulation", [
    ["full", "Full"],
    ["reduced", "Reduced"],
    ["mainly_sit_lie", "Mainly sit / lie"],
    ["mainly_in_bed", "Mainly in bed"],
    ["totally_bed_bound", "Totally bed bound"],
  ]),
  choice("activity", "Activity & evidence of disease", [
    ["normal", "Normal activity, no evidence of disease"],
    ["reduced", "Normal activity, some evidence of disease"],
    ["unable_normal_work", "Unable to do normal work"],
    ["unable_hobby_work", "Unable to do hobby / housework"],
    ["unable_any_work", "Unable to do any work"],
  ]),
  choice("selfCare", "Self-care", [
    ["full", "Full"],
    ["occasional_assist", "Occasional assistance"],
    ["considerable_assist", "Considerable assistance"],
    ["mainly_assist", "Mainly assistance"],
    ["total_care", "Total care"],
  ]),
  choice("intake", "Intake", [
    ["normal", "Normal"],
    ["reduced", "Reduced"],
    ["minimal_to_sips", "Minimal to sips"],
    ["mouth_care_only", "Mouth care only"],
  ]),
  choice("consciousness", "Conscious level", [
    ["full", "Full"],
    ["full_or_confusion", "Full or confusion"],
    ["full_or_drowsy_or_confusion", "Full, drowsy or confusion"],
    ["drowsy_or_coma", "Drowsy or coma"],
  ]),
  NOTES,
];

/** ESAS-r — nine 0..10 symptom items; `other` is captured but excluded from the total (§4.3). */
const ESASR_ITEMS: readonly ScaleItemDefinition[] = [
  zeroToTen("pain", "Pain"),
  zeroToTen("tiredness", "Tiredness"),
  zeroToTen("drowsiness", "Drowsiness"),
  zeroToTen("nausea", "Nausea"),
  zeroToTen("lackOfAppetite", "Lack of appetite"),
  zeroToTen("shortnessOfBreath", "Shortness of breath"),
  zeroToTen("depression", "Depression"),
  zeroToTen("anxiety", "Anxiety"),
  // 0 = best, 10 = worst — the ESAS-r convention, and the opposite of a naive reading.
  zeroToTen("wellbeing", "Wellbeing (0 best — 10 worst)"),
  choice("reportedBy", "Reported by", [
    ["patient", "Patient"],
    ["caregiver", "Caregiver"],
    ["clinician_observed", "Clinician observed"],
  ]),
  { key: "otherSymptomText", label: "Other symptom (free text)", kind: "text", required: false },
];

/** PAINAD — five 0..2 observational items (§4.3). */
const PAINAD_ITEMS: readonly ScaleItemDefinition[] = [
  zeroToTwo("breathing", "Breathing independent of vocalization"),
  zeroToTwo("negativeVocalization", "Negative vocalization"),
  zeroToTwo("facialExpression", "Facial expression"),
  zeroToTwo("bodyLanguage", "Body language"),
  zeroToTwo("consolability", "Consolability"),
  NOTES,
];

/** FAST — one discrete stage (§4.3). The stage strings ARE the instrument's own labels. */
const FAST_ITEMS: readonly ScaleItemDefinition[] = [
  choice("stage", "Stage", [
    ["1", "1 — No difficulty"],
    ["2", "2 — Subjective deficit"],
    ["3", "3 — Deficit in demanding employment"],
    ["4", "4 — Needs help with complex tasks"],
    ["5", "5 — Needs help choosing clothing"],
    ["6a", "6a — Needs help dressing"],
    ["6b", "6b — Needs help bathing"],
    ["6c", "6c — Needs help toileting"],
    ["6d", "6d — Urinary incontinence"],
    ["6e", "6e — Faecal incontinence"],
    ["7a", "7a — Speech ≤ 6 words"],
    ["7b", "7b — Speech 1 intelligible word"],
    ["7c", "7c — Non-ambulatory"],
    ["7d", "7d — Cannot sit up"],
    ["7e", "7e — Cannot smile"],
    ["7f", "7f — Cannot hold head up"],
  ]),
  NOTES,
];

const ITEMS_BY_SCALE: { readonly [K in ScaleType]?: readonly ScaleItemDefinition[] } = {
  pps: PPS_ITEMS,
  esas_r: ESASR_ITEMS,
  painad: PAINAD_ITEMS,
  fast: FAST_ITEMS,
};

const RANGE_BY_SCALE: { readonly [K in ScaleType]?: readonly [number, number] } = {
  pps: ppsScorer.scoreRange,
  esas_r: esasrScorer.scoreRange,
  painad: painadScorer.scoreRange,
  fast: fastScorer.scoreRange,
};

/**
 * Every scale, with its items when it has a scorer. Derived from `SCALE_CATALOG` so the definition set
 * and the catalog cannot disagree about which scales exist, and from each scorer's own `scoreRange` so
 * the published range is the one the dispatcher enforces.
 */
export function scaleDefinitions(): readonly ScaleDefinition[] {
  return Object.values(SCALE_CATALOG).map((entry) => {
    const recordable = hasScorer(entry.scaleType);
    return {
      scaleType: entry.scaleType,
      label: entry.label,
      family: entry.family,
      licenseRequired: entry.licenseRequired,
      recordable,
      scoreRange: RANGE_BY_SCALE[entry.scaleType] ?? null,
      items: recordable ? (ITEMS_BY_SCALE[entry.scaleType] ?? null) : null,
    };
  });
}

/**
 * Project a stored `clinical_assessment.data` payload through the same definition that built the
 * capture form. Unknown/legacy properties are not exposed as raw JSON; missing properties simply
 * produce no item. Free-text `notes` is returned separately from the ordered instrument responses.
 */
export function scaleResponseDetail(
  scaleType: ScaleType,
  data: Readonly<Record<string, unknown>>,
): ScaleResponseDetail {
  const definition = scaleDefinitions().find((entry) => entry.scaleType === scaleType);
  const notes = typeof data.notes === "string" ? data.notes : null;
  if (!definition?.items) return { items: [], notes };

  const items: ScaleResponseItem[] = [];
  for (const item of definition.items) {
    if (item.key === "notes") continue;
    const value = data[item.key];
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
      continue;
    }
    const option = item.options?.find((candidate) => candidate.value === String(value));
    items.push({
      key: item.key,
      label: item.label,
      value,
      displayValue:
        option?.label ?? (typeof value === "boolean" ? (value ? "Yes" : "No") : String(value)),
    });
  }
  return { items, notes };
}
