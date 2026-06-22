// @wardenx/assessments — PAINAD (Pain Assessment in Advanced Dementia) scorer (§4.3).
//
// Five behavioral items (breathing, negative vocalization, facial expression, body language,
// consolability), each 0..2; the total is their sum, 0..10. The `painad_ge_4` significant-change rule
// fires at total ≥ 4 (moderate-to-severe pain). `interpret()` renders the standard severity band.
import type { PainadData } from "../../scale-types";
import type { ScaleScorer } from "../scorer";

function painadTotal(d: PainadData): number {
  return (
    d.breathing + d.negativeVocalization + d.facialExpression + d.bodyLanguage + d.consolability
  );
}

export const painadScorer: ScaleScorer<PainadData> = {
  scaleType: "painad",
  scoreRange: [0, 10],
  score: painadTotal,
  interpret(d) {
    const t = painadTotal(d);
    const band = t === 0 ? "no pain" : t <= 3 ? "mild pain" : t <= 6 ? "moderate pain" : "severe pain";
    return `PAINAD ${t}/10 — ${band}`;
  },
};
