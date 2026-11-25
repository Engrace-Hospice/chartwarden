// @chartwarden/assessments — ESAS-r (Edmonton Symptom Assessment System, revised) scorer (§4.3, §7.2).
//
// Nine numeric symptom items (pain, tiredness, drowsiness, nausea, lack of appetite, shortness of
// breath, depression, anxiety, wellbeing), each 0..10. The total is the sum of the nine — the optional
// `other` symptom is NOT included in the total per ESAS-r convention. Total range 0..90. The
// `esas_symptom_ge_7` rule fires when any individual item ≥ 7 (`ESAS_R_SEVERE_ITEM_MIN_SCORE`, sourced in
// ./severe-item.ts); `esas_total_increase_20_in_7d` keys off the total. `interpret()` states the total and lists the severe items;
// it names no total-score band, because no source gives one.
import { esasrItemScoresFrom } from "@chartwarden/types";
import { AssessmentStateError } from "../../errors";
import type { EsasrData } from "../../scale-types";
import type { ScaleScorer } from "../scorer";
import { ESAS_R_SEVERE_ITEM_MIN_SCORE } from "./severe-item";

/** The nine scored items in canonical ESAS-r order (label → accessor); `other` is excluded from total. */
const ESASR_ITEMS: ReadonlyArray<readonly [label: string, get: (d: EsasrData) => number]> = [
  ["pain", (d) => d.pain],
  ["tiredness", (d) => d.tiredness],
  ["drowsiness", (d) => d.drowsiness],
  ["nausea", (d) => d.nausea],
  ["lack of appetite", (d) => d.lackOfAppetite],
  ["shortness of breath", (d) => d.shortnessOfBreath],
  ["depression", (d) => d.depression],
  ["anxiety", (d) => d.anxiety],
  ["wellbeing", (d) => d.wellbeing],
];

function esasrTotal(d: EsasrData): number {
  return ESASR_ITEMS.reduce((sum, [, get]) => sum + get(d), 0);
}

/**
 * The record body is untyped (`data` is a free record at the route), so the scorer is the first place the nine items are read. All nine
 * must be whole numbers from 0 to 10: a 0-90 total can look fine while an item is not (pain 11, the rest 0), and a stored item the
 * `esas_symptom_ge_7` rule cannot read leaves the record saying "severe" with no alert. Fail closed here, so what is stored always
 * agrees across the total, `interpret()`, the detector and the series `itemScores`.
 */
function assertValidItems(d: EsasrData): void {
  const items = esasrItemScoresFrom(d);
  if (items === undefined || !Object.values(items).every(Number.isInteger)) {
    throw new AssessmentStateError(
      "INVALID_ITEM_SCORE",
      "ESAS-r needs all nine symptom items, each a whole number from 0 to 10.",
    );
  }
}

export const esasrScorer: ScaleScorer<EsasrData> = {
  scaleType: "esas_r",
  scoreRange: [0, 90],
  score(d) {
    assertValidItems(d);
    return esasrTotal(d);
  },
  interpret(d) {
    const total = esasrTotal(d);
    const severe = ESASR_ITEMS.filter(([, get]) => get(d) >= ESAS_R_SEVERE_ITEM_MIN_SCORE).map(
      ([label]) => label,
    );
    // The total is a number only: no source gives cut-offs for the 0 to 90 total, so no band names it (research note, ESAS_R_CUTOFFS_RESEARCH.md).
    const severeNote =
      severe.length > 0 ? `; severe (≥${ESAS_R_SEVERE_ITEM_MIN_SCORE}): ${severe.join(", ")}` : "";
    return `ESAS-r total ${total}/90${severeNote}`;
  },
};
