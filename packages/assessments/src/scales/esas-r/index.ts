// @chartwarden/assessments — ESAS-r (Edmonton Symptom Assessment System, revised) scorer (§4.3, §7.2).
//
// Nine numeric symptom items (pain, tiredness, drowsiness, nausea, lack of appetite, shortness of
// breath, depression, anxiety, wellbeing), each 0..10. The total is the sum of the nine — the optional
// `other` symptom is NOT included in the total per ESAS-r convention. Total range 0..90. The
// `esas_symptom_ge_7` rule fires when any individual item ≥ 7; `esas_total_increase_20_in_7d` keys off
// the total. `interpret()` names the total burden and lists the severe (≥7) items.
import type { EsasrData } from "../../scale-types";
import type { ScaleScorer } from "../scorer";

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

export const esasrScorer: ScaleScorer<EsasrData> = {
  scaleType: "esas_r",
  scoreRange: [0, 90],
  score: esasrTotal,
  interpret(d) {
    const total = esasrTotal(d);
    const severe = ESASR_ITEMS.filter(([, get]) => get(d) >= 7).map(([label]) => label);
    const band =
      total === 0
        ? "no symptom burden"
        : total <= 30
          ? "mild burden"
          : total <= 60
            ? "moderate burden"
            : "high burden";
    const severeNote = severe.length > 0 ? `; severe (≥7): ${severe.join(", ")}` : "";
    return `ESAS-r total ${total}/90 — ${band}${severeNote}`;
  },
};
