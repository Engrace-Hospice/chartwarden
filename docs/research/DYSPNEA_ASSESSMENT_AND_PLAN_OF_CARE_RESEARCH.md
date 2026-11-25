# Dyspnea assessment at a hospice visit and when it should prompt a plan-of-care review: sourced research

Researched 2026-11-25 for the visit-note composer's dyspnea helper (M8, `packages/narrative-vocab`
`nv.sym.dyspnea_*`; rules in `packages/types/src/dyspnea-assessment.ts`). It closes the gap recorded in
[`PAIN_ASSESSMENT_AND_PLAN_OF_CARE_TRIGGERS_RESEARCH.md`](./PAIN_ASSESSMENT_AND_PLAN_OF_CARE_TRIGGERS_RESEARCH.md)
section 6 ("a dyspnea equivalent is not built: the research did not cover dyspnea assessment or triggers").

**This is research input, not clinical sign-off.** The wording built on it is section 7 of
[`CLINICAL_SIGNOFF_2026-11-VISIT_NOTE_COMPOSER.md`](../clinical-review/CLINICAL_SIGNOFF_2026-11-VISIT_NOTE_COMPOSER.md),
signed off by Lora, RN on 2026-11-25 as a whole, per-row boxes left blank. Anything a source did not confirm is marked
**NOT CONFIRMED** and is not in the code.

## Headline

**No dyspnea severity band, rise threshold or action trigger exists in the conditions of participation, in CMS
guidance or in any primary source that could be read.** What is sourced is a list of characteristics to assess
and a handful of generic plan-review reasons. So the helper records what the clinician enters, counts documented
characteristics, and offers reasons that compare only numbers the clinician typed. It builds no numeric threshold.
ESAS-calibration values for the dyspnea item do exist (Selby 2010: 6, second-hand and NOT CONFIRMED; Yamaguchi 2016,
ESAS-r, Japan: 3, which its authors call unreliable). They calibrate the patient's own "mild, moderate, severe"
words against the 0-10 score; they are not validated action thresholds, and none is used.

## Claim types

Regulation (42 CFR part 418), CMS guidance (interpretive guidance, HOPE and HQRP specifications; not the CoP text),
Guideline (published clinical guideline or statement), Common practice (industry or educational resource),
Research (a tool or a study). Status: **CONFIRMED** = read in the text; **CONFIRMED (fetch)** = publisher text read
through the fetch tool; **ABSTRACT ONLY** = full text blocked; **NOT CONFIRMED** = not read.

## Sources and findings

| Claim | Source | Where | Type | Status |
|---|---|---|---|---|
| HOPE J2030 (admission only): screen for presence or absence of shortness of breath and, if present, rate its severity. No tool named, no severity bands, no look-back period. | CMS HOPE Guidance Manual v1.03 (eff. 2026-10-01), https://www.cms.gov/files/document/hope-guidance-manual-v-1-03-508c-pdf.pdf | pp. 66-68 | CMS guidance (quality reporting) | CONFIRMED |
| HOPE J2040 (admission only): treatment initiated or declined; non-drug measures (fans, positioning, education) count; an opioid order counts only if it names shortness of breath. | same | pp. 69-71 | CMS guidance | CONFIRMED |
| HOPE J2051 B: the EFFECT of shortness of breath on the patient over the past 2 days (not at all, slight, moderate, severe), "not an assessment of the severity, intensity, frequency". | same | pp. 72-74 | CMS guidance | CONFIRMED |
| HOPE J2052: a moderate or severe impact calls for an in-person follow-up visit within 2 calendar days. | same | pp. 74-75; section 1.3.3 | CMS guidance | CONFIRMED |
| HOPE items "do not replace a thorough and ongoing assessment". HOPE is a pay-for-reporting item set. | same | sections 1.3, 1.7.1 | CMS guidance | CONFIRMED |
| HQRP dyspnea measures: screened within 2 days of admission; among positive screens, treatment started within 1 day or declined. | CMS HQRP Quality Measure Manual v1.04, CBE #3235 components 5 and 6 | pp. 13-14, 37-38 | CMS guidance (measure specification) | CONFIRMED |
| The text of 42 CFR 418.54 and 418.56 does not contain the word "dyspnea". 418.54(c)(5) severity of symptoms; 418.54(d), 418.56(d) every 15 days at least; 418.56(c)(1) interventions to manage pain and symptoms. | 42 CFR 418.54, 418.56 | | Regulation | CONFIRMED (word absence via fetch) |
| SOM Appendix M IG 418.54(c): the assessment includes screening for "pain, dyspnea, nausea ..."; the detailed content list is given for pain only. Survey procedures: the hospice treats dyspnea "using accepted professional standards of practice"; ongoing assessment "using measurable/quantifiable tools". IG 418.56(c)(1): "re-evaluating the effectiveness of the current plan of care". | CMS SOM Appendix M (TOC Rev. 222; L-tags Rev. 210) | PDF pp. 36, 91-92, 96, 100 | CMS guidance | CONFIRMED |
| General inpatient care: "pain control or acute or chronic symptom management that cannot feasibly be provided in other settings". Continuous home care: only a "period of crisis". Dyspnea examples in the CHC text are payment illustrations, "not all-inclusive". | Medicare Benefit Policy Manual ch. 9, 40.1.5 and 40.2.1 | PDF pp. 31, 34-37 | CMS guidance | CONFIRMED |
| Assess onset, quality, severity, provoking and relieving factors, response to prior treatment, burden, impact on function and quality of life. Reassess promptly after treatment starts. A symptom goal is a level "acceptable to the patient". Opioid care in "pain and dyspnea": document functional and symptom goals and reassessment intervals. Dyspnea is named only in 2.3.10; the rest is generic to symptoms. | National Consensus Project guidelines 4th ed. (2018) | 2.1.1, 2.2.2, 2.2.4, 2.2.5, 2.3.4, 2.3.10 | Guideline | CONFIRMED |
| Dyspnea has sensory-perceptual, affective-distress and impact domains. "Adequate assessment of dyspnea depends on self-report." A 0-10 rating and the Borg scale are sensory ratings. No severity categories are defined. Cool airflow: patients report relief, no large trial. Oxygen: "conflicting data". | Parshall MB et al., ATS statement, Am J Respir Crit Care Med 2012;185:435-452 | Definition, Measurement, Management | Guideline | CONFIRMED (fetch; first ~100k characters) |
| Self-report is the gold standard. Screening includes intensity on a unidimensional tool (NRS) and functional impact. When the patient cannot self-report, vital signs may assist. | Crawford GB et al., ESMO Open 2021;6(4):100225 | Breathlessness | Guideline | CONFIRMED |
| Assessment at every encounter; an observation measure when the patient cannot self-report; a fan directed at the cheek; a comprehensive evaluation of severity, chronicity, causes, triggers and associated symptoms. | Hui D et al., ASCO guideline, J Clin Oncol 2021;39:1389-1411 | | Guideline (advanced cancer) | ABSTRACT ONLY (recommendations via ASCO Post) |
| Patients "should be asked to rate the intensity of their breathlessness as part of a comprehensive care plan". | Mahler DA et al., ACCP, Chest 2010;137:674-691 | | Guideline | ABSTRACT ONLY |
| Dyspnea (self-report) is distinct from observable respiratory distress. Heart rate, respiratory rate and SpO2 are "unreliable" as dyspnea measures. RDOS is "likely the best available tool" when the patient cannot self-report. | Fast Facts and Concepts #453 (2022) | | Common practice | CONFIRMED |
| Check the simple things first (oxygen on, tubing, anxiety, pain, constipation, retention, fluid). Positioning, a fan, relaxation. An oxygen trial is judged by symptom relief, not oximetry. "Patient self-report is the only reliable indicator." | Fast Facts and Concepts #27 (2024), #376 (2025) | | Common practice | CONFIRMED |
| Dyspnea goal "at patient goal of mild"; a case assessing dyspnea each visit "using a verbal scale of mild, moderate, distressing & notify CM if greater than mild"; the IDG asks "is it the right plan?"; the hospice "should choose its own scale". | NHPCO Care Planning Primer (Jan 2023) | pp. 3, 6, 8-9 | Common practice | CONFIRMED |
| RDOS: eight items scored 0-2, total 0-16. Cut-points disagree: 3 or more (2015, anchored to self-report, sensitivity 0.68, specificity 0.77, "further substantiation is needed"); 0-2 none, 3 any, 4-6 mild-moderate, 7 or more severe (2017, anchored to a nurse practitioner ranking); 4 or more (2019, AUC 0.874). Agreement with self-report is only moderate (rho 0.37 to 0.53; r = 0.70 in 2019). | Campbell and Templin, Palliat Med 2015;29:436-442; Campbell, Kero, Templin, Heart Lung 2017; Zhuang Q et al., J Pain Symptom Manage 2019;57:304-310 | | Research (tool) | CONFIRMED (2015); ABSTRACT ONLY (2017, 2019) |
| 0-10 dyspnea cut-points: "a lack of evidence exists for ... shortness of breath"; a score of 4 or more is suggested only as a trigger for fuller symptom assessment. For ESAS, 7 or more is severe across symptoms (see [`ESAS_R_CUTOFFS_RESEARCH.md`](./ESAS_R_CUTOFFS_RESEARCH.md)). | Oldenmenger 2013; Selby 2010 | | Research (cancer) | ABSTRACT ONLY |
| Borg CR10 needs a licence and fee. The MRC dyspnoea scale permission excludes modified versions; the mMRC range was not confirmed. | ATS outcome-measures page; UKRI MRC page | | Research (tools) | CONFIRMED (page); mMRC range NOT CONFIRMED |
| NCCN Palliative Care; ESMO 2015 dyspnoea guideline (Kloke and Cherny) | | | | NOT CONFIRMED (login or 403) |

Behavioural dyspnea scores: no source says, as the ASPMN statement says for pain, that a behavioural dyspnea score is
"not comparable" with self-report. Three findings support the same caution (ATS: dyspnea "can only be perceived by
the person experiencing it"; Fast Facts #453 separates dyspnea from respiratory distress; the RDOS studies show only
moderate agreement and three different cut-points).

Triggers: no source ties a dyspnea score or presentation to a plan review, a physician call or a higher level of care.
The only sourced triggers are generic: update "as often as the condition requires" and at least every 15 days
(418.54(d), 418.56(d)); re-evaluate the current plan (SOM 418.56(c)(1)); a goal that is not met means the plan is
reviewed (NHPCO); a moderate or severe HOPE impact leads to a follow-up visit within 2 days.

## What the product builds from this

Advisory only; nothing blocks finalize or sign and nothing changes a plan of care by itself. The helper appears
under the existing statement "Symptom impact — dyspnea limiting function" (`nv.sym.dyspnea_impact`, unchanged).

1. **Fifteen optional statements**, each the clinician's own words unless a choice or a 0-10 number is shown:
   intensity, onset, when it occurs, what brings it on or worsens it, what relieves it, quality, distress or anxiety,
   effect on function, non-drug measures, response to measures tried, the patient's own acceptable level, the score at
   the last visit, the change since then, signs observed when the patient cannot self-report, and the plan-of-care
   decision.
2. **"n of 8 characteristics documented"** (intensity, onset, setting, triggers, relief, quality, distress, function;
   intensity also counts when signs observed are recorded, because a patient who cannot self-report has no 0-10 score).
   The eight is the product's own list; no source gives a dyspnea count, so there is no benchmark line.
3. **A plan-of-care prompt** with five reasons, each labelled by type and source: dyspnea limiting function; above the
   patient's own level; worse than at the last visit; new since the last visit; the measures tried gave no relief.
   Static notes: the IDG cadence and the HOPE two-day follow-up (an impact, not an intensity; no 0-10 score converts to
   it). There is no level-of-care pointer: no source ties dyspnea to a level-of-care change, and "no relief" from
   non-drug measures alone is not "cannot be managed at home". Every number in a reason is one the clinician typed.
   Only "limiting function" needs the existing impact statement; the other four reasons come from the helper's own rows.
   Known limit: the helper's only entry point is that impact statement ("Dyspnea limits the patient's ability to
   ambulate beyond N feet", N from 5 to 100), so dyspnea that is not limiting function has no way in; adding an entry
   statement is a wording decision for the clinical reviewer (sign-off row 7.1).

Deliberate differences from the pain helper: no severity reason, no rise reason; the worsened and new reasons carry
the basis "CMS guidance", not "CMS rule" (the clinical reviewer flagged the "CMS rule" badge on the pain equivalents,
sign-off rows 2.12 and 2.13).

## Not built, and why

- A **severity band** on the 0-10 score: HOPE's slight/moderate/severe is impact, not intensity; Selby 2010 gives 7
  across items and 6 for dyspnea (second-hand), Yamaguchi 2016 gives 3 and calls it unreliable, Oldenmenger finds no
  evidence for dyspnea; the pain bands are not borrowed.
- A **rise threshold**: the minimal important differences found are Borg values for rehabilitation or a 2-point RDOS
  change, on other scales and populations.
- **RDOS** (any statement, score or cut-point): three conflicting cut-points, small samples, different reference
  standards, a copyright notice whose terms were not researched. A clinician can write the tool name and total in the
  "signs observed" statement.
- A trigger on **heart rate, respiratory rate or SpO2** (Fast Facts #453 calls them unreliable).
- "Dyspnea at rest" leading to a physician call or a level-of-care change; any fixed score that forces a call.
- A HOPE impact category computed from the score.
- An **oxygen, opioid or titration** suggestion or flow target (dose-like). Oxygen use and caregiver teaching are not
  new statements: `nv.resp.dyspnea` and `nv.cp.caregiver_taught` already exist.
- mMRC (range unverified, modifications excluded), Borg CR10 (licence fee; the 0-10 rating does the same job),
  ESAS-style verbal words, a "constant or intermittent" item (pain guidance only), ASCO's referral prompt (second-hand;
  hospice patients already have an IDG), a **required** count.

## Still unread

ASCO 2021, ACCP 2010, ESMO 2015, NCCN Palliative Care, Selby 2010 and Oldenmenger 2013 in full text; the 2017 and 2019
RDOS papers. The helper's wording is section 7 of
[`CLINICAL_SIGNOFF_2026-11-VISIT_NOTE_COMPOSER.md`](../clinical-review/CLINICAL_SIGNOFF_2026-11-VISIT_NOTE_COMPOSER.md),
signed off 2026-11-25 as above.
