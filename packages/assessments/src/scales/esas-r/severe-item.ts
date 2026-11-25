// @chartwarden/assessments — the ESAS-r item score at which a reading is called severe and the M9 alert fires.
//
// ONE place for the number. `interpret()` (scales/esas-r/index.ts: the record's "severe (≥7): pain" line) and the `esas_symptom_ge_7` rule
// (detector.ts) each carried a literal 7, so they could drift apart. The visit-note composer's advisory prompt
// (packages/types/src/esas-symptom-prompt.ts) uses a LOWER, separate benchmark (4) and says nothing about severity; this is not that.
//
// Type: guideline consensus plus research, applied by the product as a platform rule. A tenant cannot move it (detector.ts: floor = platform).
// Sources (research note: docs/research/ESAS_R_CUTOFFS_RESEARCH.md):
//   - Selby D et al., J Pain Symptom Manage 2010;39:241-249 (abstract read): severe on the verbal scale is 7 or more across items.
//   - Oldenmenger WH et al., J Pain Symptom Manage 2013;45:1083-93 (abstract read): pain 7, tiredness 7-8 are severe.
//   - Hui D, Bruera E, J Pain Symptom Manage 2017;53:630-643: consensus that severe distress is 7 or more (read through a summariser).
//   - Interior Health (BC) ESAS-r Guidelines 2016 (regional guideline): 7 or more is an unstable symptom that needs urgent attention.
//   - For the pain item, 7 to 10 is also CMS HOPE's severe band (HOPE Guidance Manual J0900, Table 4) and NCCN v2.2023 PAIN-A.
// LIMITS: these calibrate the patient's own word "severe" to the 0 to 10 score; none validates 7 as an action threshold. Per-item values
// differ (Selby's fatigue 8 and dyspnea 6 are second-hand; the one ESAS-r study, Yamaguchi 2016 in Japan, mostly gives 5 to 6) and no
// hospice-population study was found. So the alert asks for a look at the item, it says nothing about what to do, and the clinician decides.
export const ESAS_R_SEVERE_ITEM_MIN_SCORE = 7;
