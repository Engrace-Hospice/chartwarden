# ESAS-r item cut-offs: sourced research

Researched 2026-11-25 for the visit-note composer's ESAS-r item prompt (M8 composer Right Panel; rule in
`packages/types/src/esas-symptom-prompt.ts`). It closes the gap "ESAS-r cut-offs were not researched" recorded in
[`PAIN_ASSESSMENT_AND_PLAN_OF_CARE_TRIGGERS_RESEARCH.md`](./PAIN_ASSESSMENT_AND_PLAN_OF_CARE_TRIGGERS_RESEARCH.md)
section 6.

**This is research input, not clinical sign-off.** Anything a source did not confirm is marked **NOT CONFIRMED**. The composer prompt built on it is
section 8 of [`CLINICAL_SIGNOFF_2026-11-VISIT_NOTE_COMPOSER.md`](../clinical-review/CLINICAL_SIGNOFF_2026-11-VISIT_NOTE_COMPOSER.md), signed off by Lora, RN on 2026-11-25, not item by item.

## Headline

Published ESAS cut-offs are **calibrations of the patient's own "mild, moderate, severe" against the 0-10 score**, not
validated action thresholds. The one review that says what to do at a score (Oldenmenger 2013) recommends a score of
4 or more only as a **prompt for a more comprehensive symptom assessment**, finds evidence missing for 7 of 9 items,
and advises caution about fixed cut-offs in guidelines and quality indicators. So the composer builds that one prompt
and nothing else: no severity tier, no "notify the physician" wording, no total-score band. Separately, the sources
agree on 7 as the severe cut-off (comparison table below), with the same limits; using it for an M9 alert and the
assessment record line is a proposal, not in this change (see "Where 7 could be used").

## Corrections to the starting leads

Selby is 2010, not 2011. Oldenmenger's cut-off review is 2013, not 2018 (no 2018 paper found). Watanabe 2011 is the
ESAS-r revision paper, not a cut-off paper. The only ESAS-r cut-off study found is Yamaguchi 2016 (Japanese). No
cut-off study from a hospice-specific population turned up.

## Sources

| Claim | Source | Where | Type | Status |
|---|---|---|---|---|
| ESAS 0-10 against a verbal none/mild/moderate/severe scale, n = 400 cancer and palliative patients, ROC. Severe: 7 or more across items (six items best at 7; the other three above 80% sensitivity). Moderate or severe: 4 or 5 (4 more sensitive, 5 more specific). | Selby D et al., "A single set of numerical cutpoints ...", J Pain Symptom Manage 2010;39:241-249, doi 10.1016/j.jpainsymman.2009.06.010 | Abstract | Research | CONFIRMED (abstract); per-item values NOT CONFIRMED (full text 403) |
| Selby exceptions: fatigue 8, dyspnea 6. | Relayed by Hui and Bruera 2017 | | Research | NOT CONFIRMED against Selby |
| Systematic review of 18 studies. Pain: 5 moderate, 7 severe. Tiredness: 4 moderate, 7-8 severe. "Lack of evidence" for nausea, depression, anxiety, drowsiness, appetite, well-being and dyspnea. Included studies anchored to interference, other symptom methods or verbal scales. | Oldenmenger WH et al., J Pain Symptom Manage 2013;45:1083-1093, doi 10.1016/j.jpainsymman.2012.06.007 | Abstract | Research | CONFIRMED (abstract) |
| "A symptom score of 4 or more is recommended as a trigger for a more comprehensive symptom assessment." Hold cut-offs back in quality indicators; be cautious in guidelines. | same | Abstract, conclusion | Research | CONFIRMED |
| Narrative review restating Selby, Oldenmenger and Yamaguchi. Consensus: severe distress is 7 or more. "Any automatic referral should complement rather than override clinician judgement." Cut-offs may vary by institution. | Hui D, Bruera E, J Pain Symptom Manage 2017;53:630-643, PMC5337174 | Score-interpretation and use-to-trigger-actions sections | Research | CONFIRMED (PMC text, via a fetch summariser; verify before quoting) |
| ESAS-r, Japanese, n = 292 palliative cancer patients (77% inpatient), anchored to a 4-point verbal scale. Severe: pain, tiredness, appetite, depression 5; anxiety, well-being 6; drowsiness 7; nausea 1; dyspnea 3. Moderate or severe: pain, appetite, dyspnea, depression, anxiety 3; tiredness, well-being 4; nausea 2; drowsiness 5. Authors call nausea and dyspnea unreliable (few cases). | Yamaguchi T et al., J Pain Symptom Manage 2016;51:292-297 | Results, Tables 3-4 | Research | CONFIRMED (primary text read) |
| ESAS-r against ESAS in 160 palliative patients: easier to understand and preferred. No cut-offs attributed to it. | Watanabe SM et al., J Pain Symptom Manage 2011;41:456-468 | Via the AHS manual and Hui and Bruera | Research | Paper not read; "no cut-offs inside" NOT CONFIRMED |
| Utrecht Symptom Diary, 3,913 cancer patients, anchored to "is it a problem": optimal cut-off 3 or 4, differs per symptom. No action thresholds. | Van der Baan FH et al., Cancer Med 2020;9:6111-6121 | Abstract, results | Research | CONFIRMED (fetch) |
| Action ladder: 3 or less usual care; 4-6 further assessment, may need physician consultation; 7 or more "unstable symptom ... requires urgent attention". Page 1 of the same document says 5 or more should be assessed in depth, inconsistent with its 4-6 band. | Interior Health (BC) ESAS-r Guidelines, Dec 2016, adapted from Covenant Health, Alberta | p. 3 | Guideline (regional, non-peer-reviewed, nursing) | CONFIRMED (read) |
| ESAS-r is "one valuable part of a holistic clinical assessment"; it has no severity cut-offs or actions, only a minimal clinically important difference of 1 point. | Alberta Health Services ESAS-r Administration Manual, Nov 2019 | Sections 3.2, 4.17, Appendix C | Guideline | CONFIRMED |
| HOPE names ESAS only as an example numeric pain-screening tool; the 0 / 1-3 / 4-6 / 7-10 pain bands are CMS's own mapping; J2051 is impact, not severity, so ESAS does not feed it. | CMS HOPE Guidance Manual (cover v1.00; footer v1.02) | J0900 Tables 4-5; J2051 | CMS guidance | CONFIRMED |
| SOM Appendix M, the Medicare Benefit Policy Manual and 42 CFR 418 mention ESAS. | | | | NOT CONFIRMED (one search found nothing) |

## Comparison

| Source | Moderate or worse | Severe |
|---|---|---|
| Selby 2010 (ESAS) | 4 or 5 | 7 (fatigue 8, dyspnea 6, from a secondary source) |
| Oldenmenger 2013 (review) | 4-5 (pain 5, tiredness 4) | 7-8 |
| Yamaguchi 2016 (ESAS-r, Japan) | 2-5 by item (mostly 3) | 1-7 by item (mostly 5-6) |
| Van der Baan 2020 (Utrecht diary) | 3 or 4 | not given |
| Interior Health 2016 | 4-6 assess further | 7 or more urgent |

They agree that 4 is a defensible moderate-or-worse cut-off and 7 a defensible severe cut-off. They differ by item and
population, and the one ESAS-r study runs lower. No source gives cut-offs for the total score.

## Items and anchors

The nine items, rated "now" 0-10 (AHS form 07903, Rev 2015-08): Pain; Tiredness (lack of energy); Drowsiness (feeling
sleepy); Nausea; Lack of appetite; Shortness of breath; Depression (feeling sad); Anxiety (feeling nervous);
Wellbeing (how you feel overall), plus an optional "Other problem". Eight are anchored "No X" at 0 and "Worst possible
X" at 10; Wellbeing is anchored "Best wellbeing" at 0. The repo's M9 item set, order and direction match. Gaps: the
generated form drops the published parenthetical definitions and the anchors, the "other" item is free text only
although `EsasrData` carries `otherSymptom`, and `reportedBy` has three values against the form's four.

## What the product builds

One advisory line per ESAS-r item at 4 or more in the latest reading up to the visit: "consider a fuller assessment of
this symptom", labelled as a research benchmark (Oldenmenger 2013) with a caution that cut-offs vary by symptom and
population. It is not a severity rating and blocks nothing.

## Not built

In the composer prompt: a severity tier at 7 (the sources agree on 7, but Selby's per-item exceptions are second-hand
and the ESAS-r study differs, so 7 is not used in the composer; the M9 proposal is below), any "notify the physician"
wording (no source validates a score as an escalation trigger; the one escalation ladder is unreferenced regional
guidance that disagrees with itself), and any total-score band anywhere (no source gives one).

## Where 7 could be used (M9; a proposal, not in this change)

Nothing in M9 is changed by this change. A cut-off of 7 applied there would serve two things: the existing
`esas_symptom_ge_7` change rule (an alert asking for a look at the item; a tenant cannot move it) and the assessment
record's line ("severe (≥7): pain"). For the pain item 7 to 10 is also CMS HOPE's severe band and NCCN v2.2023 PAIN-A, the
band the pain helper already uses (`PAIN_SEVERE_MIN_SCORE`). It is a calibration of the patient's own word "severe", not a
validated action threshold, and per-item values differ (dyspnea 6 and fatigue 8 from a secondary source; the ESAS-r study in
Japan mostly 5 to 6), so such an alert would say nothing about what to do.

## Repo state found during the research (not part of this change)

M9 already has two ESAS-r rules in `packages/assessments/src/detector.ts`: `esas_symptom_ge_7` and
`esas_total_increase_20_in_7d`. `esas_symptom_ge_7` can never fire: the recording path
(`assessments-route-service-db.ts`, `detectSignificantChanges` call) does not pass `maxSymptomScore`, which the rule
reads. Passing the worst of the nine item scores is a proposal, not in this change. The rule is the platform's own Module 9
rule at 7 and a tenant cannot move it; the sources for 7 are under "Where 7 could be used". The total-score bands that
`interpret()` prints (30 or less mild, 60 or less moderate, above 60 high, zero "no symptom burden") have no published
source; the only published total-score evidence found is change thresholds (Hui 2015: +3 / -4). Removing them, and giving
the record line the total as a number plus "severe (≥7): items", is likewise a proposal, not in this change.
