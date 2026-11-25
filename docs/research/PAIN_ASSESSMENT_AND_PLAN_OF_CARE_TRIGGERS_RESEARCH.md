# Pain assessment at a hospice visit and when pain should prompt a plan-of-care review: sourced research

Researched 2026-11-24 for the visit-note composer's "Symptom impact: pain limiting function" statement
(M8, `packages/narrative-vocab` `nv.sym.pain_uncontrolled`). Every claim below carries its source, the
section or page, and a type. Anything a source did not confirm is marked **NOT CONFIRMED** and is not in
the code.

**This is research input, not clinical sign-off.** The wording and thresholds built on it are section 2 of
[`CLINICAL_SIGNOFF_2026-11-VISIT_NOTE_COMPOSER.md`](../clinical-review/CLINICAL_SIGNOFF_2026-11-VISIT_NOTE_COMPOSER.md),
signed off by Lora, RN on 2026-11-25 with sections 1-6, not item by item.

## Claim types

| Type | Meaning |
|---|---|
| **Regulation** | Text of 42 CFR part 418 (binding on the hospice). |
| **CMS guidance** | CMS interpretive guidance, coverage policy or quality-reporting specification. It binds surveyors or defines a reporting item; it is not the CoP text. |
| **Guideline** | A published clinical guideline or position statement. |
| **Common practice** | An industry resource or agency example. Useful, not binding. |
| **Research** | A research benchmark (for example a minimal clinically important difference). |

## Retrieval notes

All fetched 2026-11-24. PDFs were downloaded and read as text; web pages were read as text. Two sources
could not be read in full and are marked: the NCCN Adult Cancer Pain guideline (JNCCN returned HTTP 403, so
its numbers are second-hand) and the ESMO 2018 cancer pain guideline (read through a summarising fetch,
not the PDF).

**Follow-up read, 2026-11-25** (closes the NCCN and ASPMN gaps; the findings are marked "2026-11-25" below):
the 403 was specific to the fetch tool, so NCCN was re-read with a browser User-Agent. Read in full: the JNCCN v3.2019
article and the NCCN v2.2023 guideline (both as third-party copies of NCCN-copyrighted PDFs, not checked against
nccn.org) and the open JNCCN v2.2025 article (its text names the bands without numerals; the algorithm figures are
images and were not read). The current NCCN version is 2.2026 and its text needs a login, so nothing of it was read
beyond the version label. ASPMN: the 2011 position statement (the board-accepted copy, not the journal's final text)
and the 2024 recommendations were read; the 2019 papers and the 2024 position-statement body were abstract only.
The other lead in this note is researched in [`ESAS_R_CUTOFFS_RESEARCH.md`](./ESAS_R_CUTOFFS_RESEARCH.md).

## Sources

| Ref | Source | URL |
|---|---|---|
| CFR-54 | 42 CFR 418.54, initial and comprehensive assessment | https://www.law.cornell.edu/cfr/text/42/418.54 |
| CFR-56 | 42 CFR 418.56, interdisciplinary group, care planning, coordination | https://www.law.cornell.edu/cfr/text/42/418.56 |
| CFR-204 | 42 CFR 418.204(a), continuous home care (periods of crisis) | https://www.law.cornell.edu/cfr/text/42/418.204 |
| SOM-M | CMS State Operations Manual, Appendix M, Hospice (Rev. 210, 2023-02-03), interpretive guidelines and survey procedures | https://www.cms.gov/Regulations-and-Guidance/Guidance/Manuals/downloads/som107ap_m_hospice.pdf |
| MBPM-9 | Medicare Benefit Policy Manual, ch. 9 (Rev. 13664, 2026-03-05), sections 40.1.5 and 40.2.1 | https://www.cms.gov/Regulations-and-Guidance/Guidance/Manuals/Downloads/bp102c09.pdf |
| HOPE | CMS HOPE Guidance Manual v1.03, effective 2026-10-01 (v1.00 of 2025-10-01 read as well; the pain items are the same in substance, v1.03 adds that a mild, moderate or severe J0900 makes J0905 "yes") | https://www.cms.gov/files/document/hope-guidance-manual-v-1-03-508c-pdf.pdf |
| QM | CMS HQRP Quality Measure Specifications User's Manual v1.04 (effective 2025-10-01, posted 2026-02-26) | https://www.cms.gov/files/document/hqrp-qm-users-manual-v1-04-508c.pdf |
| NCP4 | National Consensus Project, Clinical Practice Guidelines for Quality Palliative Care, 4th ed. (2018), Domain 2 | https://www.nationalcoalitionhpc.org/wp-content/uploads/2020/07/NCHPC-NCPGuidelines_4thED_web_FINAL.pdf |
| NHPCO | NHPCO (now National Alliance for Care at Home), Care Planning Primer, Jan 2023 | https://allianceforcareathome.org/wp-content/uploads/NHPCO_Care_Planning_Primer.pdf |
| WHO | WHO guidelines for the pharmacological and radiotherapeutic management of cancer pain in adults and adolescents (2018), sections 5.2 and 5.6 | https://iris.who.int/server/api/core/bitstreams/809a021b-e75c-4f9c-b002-6fb13bf1a0f5/content |
| FF70 | Gordon DB, "PRN Range Analgesic Orders", Fast Facts and Concepts #70 (4th ed., 2025-05-30), Palliative Care Network of Wisconsin | https://www.mypcnow.org/fast-fact/prn-range-analgesic-orders/ |
| ASPMN | Herr K et al., "Pain Assessment in the Nonverbal Patient: Position Statement with Clinical Practice Recommendations", Pain Manag Nurs 2006;7(2):44-52 (the ASPMN has since issued 2011, 2019 and 2024 versions; 2026-11-25: the 2011 statement and the 2024 recommendations, Pain Manag Nurs 2024;25(6):551-568, were read, the 2019 papers 20(5):402-417 abstract only) | https://geriatricpain.org/sites/geriatricpain.org/files/2021-03/aspmn_position_statement_pain_assesement_nonverbal.pdf |
| PAINAD | Warden V, Hurley AC, Volicer L, J Am Med Dir Assoc 2003;4:9-15; tool text as reprinted by AMDA | https://geriatrictoolkit.missouri.edu/cog/painad.pdf |
| FLACC | Merkel SI et al., Pediatr Nurs 1997;23:293-297; tool text as published by Starship Children's Hospital (five categories each scored 0-2, total 0-10, for non-verbal or pre-verbal patients unable to self-report) | https://media.starship.org.nz/flacc/flacc.pdf |
| AFP | Albert RH, "End-of-Life Care: Managing Common Symptoms", Am Fam Physician 2017;95(6):356-361 | https://medicine.vumc.org/sites/default/files/2023-10/10-23-Albert%20-%20EOL%20Care%20-%20AFP%202017.pdf |
| ESMO | Fallon M et al., ESMO Clinical Practice Guidelines: management of cancer pain in adult patients, Ann Oncol 2018;29(Suppl 4):iv166-iv191 (read via summarising fetch) | https://academic.oup.com/annonc/article/29/Supplement_4/iv166/5046945 |
| NCCN | NCCN Adult Cancer Pain, v3.2019 (JNCCN 17(8):977-1007), first read from search summaries only (403). **2026-11-25:** the 2019 article and the full guideline v2.2023 were read as third-party copies, and the open JNCCN v2.2025 article (doi 10.6004/jnccn.2025.0032, https://jnccn.org/view/journals/jnccn/23/7/article-e250032.xml); the current version is 2.2026 (login, unread) | https://jnccn.org/view/journals/jnccn/17/8/article-p977.xml; https://www.nccn.org/guidelines/guidelines-detail?category=3&id=1413 |
| FARRAR | Farrar JT et al., Pain 2001;94:149-158 (about 2 points or 30% on a 0-10 scale). **Secondary citations only**; the paper was not opened | https://www.researchgate.net/publication/11662892 |

## 1. The unverified "AI Overview" claims, checked

| Claim as pasted | Verdict | Source |
|---|---|---|
| Notes must document a standardized pain screening | **Partly.** A pain screening is part of the comprehensive assessment (CMS guidance) and a HOPE admission item. It is not a per-visit rule. | SOM-M IG 418.54(c) (pain is first in the screening list); HOPE J0900 |
| When pain is present, a comprehensive pain assessment covering at least 5 of 7 characteristics | **Partly, and mis-scoped.** "5 of 7" is the numerator of a quality measure for the admission assessment: assessment done within 1 day of a positive pain screen with 5 or more of the 7 items checked. It is not a CoP, not a visit-note rule, and HOPE itself codes the assessment as done if the clinician attempted even one characteristic. | QM ch. 2, composite measure CBE #3235 (pain component); HOPE J0910 and its examples |
| The 7 characteristics: location, severity, character, duration, frequency, what relieves or worsens, effect on function or quality of life | **Confirmed** for HOPE J0910C. The CoP guidance lists the same content without a count. | HOPE J0910C and Table 6; QM; SOM-M IG 418.54(c) |
| Standard tools: NRS 0-10, Wong-Baker FACES, FLACC, PAINAD for patients unable to self-report | **Confirmed** (HOPE lists them as examples by tool type; PAINAD and FLACC are the staff-observation examples, with CPOT and CNPI). | HOPE Table 5 |
| Active pain status; non-verbal cues | **Confirmed.** "Pain active problem" counts a patient taking pain medication or with historical pain, even if pain-free at the visit. Nonverbal indicators are defined (sounds, facial expression, protective movements). | HOPE J0905, "Nonverbal Indicators", Table 6 |
| Medication and treatment response, side effects, bowel regimen, education | **Confirmed as CoP guidance.** Drug effectiveness and side effects are reviewed at each assessment update; note a bowel regimen when opioids are used; confirm the physician was notified of medication concerns. | SOM-M survey procedures for 418.54(c)(6); NCP4 2.3.2 |
| Changes since the last visit | **Confirmed.** The assessment update must consider changes since the initial assessment and reassess the patient's response to care. | CFR-54 (d); SOM-M IG 418.54(d) |

## 2. What the regulation and CMS guidance require

| # | Finding | Type | Source and section |
|---|---|---|---|
| 2.1 | The comprehensive assessment must consider the **severity of symptoms** (c)(5) and a **drug profile** including effectiveness and side effects (c)(6). | Regulation | CFR-54 (c)(5), (c)(6) |
| 2.2 | Update the comprehensive assessment as often as the condition requires and **at least every 15 days**; it must consider changes since the initial assessment, progress toward desired outcomes and a reassessment of response to care. | Regulation | CFR-54 (d) |
| 2.3 | The plan of care must include **interventions to manage pain and symptoms**, a scope and frequency of services, and **measurable outcomes**. | Regulation | CFR-56 (c)(1)-(3) |
| 2.4 | The IDG, with the attending physician if any, must **review, revise and document the plan of care as frequently as the patient's condition requires, and at least every 15 calendar days**. A revised plan must carry the updated assessment and note progress toward goals. | Regulation | CFR-56 (d) |
| 2.5 | Screening covers pain first; a comprehensive pain assessment "based on accepted clinical standards" may gather: pain history and treatment; intensity on a standardized scale; descriptors (burning, stabbing, tingling, aching); pattern (constant or intermittent); location and radiation; frequency, timing, duration; impact on quality of life (sleep, function, appetite, mood); precipitating or exacerbating factors; strategies that reduce pain; associated symptoms (nausea, anxiety); the patient and family's goals and satisfaction with pain control. | CMS guidance | SOM-M IG 418.54(c), pp. 91-92 of the PDF |
| 2.6 | Survey procedure: monitor medication effectiveness and side effects at each assessment update **and as needed as the patient's condition changes**; note preventive measures such as a bowel regimen when opioids are used; if medication concerns were identified, confirm the physician was notified. | CMS guidance | SOM-M survey procedures, comprehensive assessment |
| 2.7 | Effective pain management includes **"re-evaluating the effectiveness of the current plan of care"**. | CMS guidance | SOM-M IG 418.56(c)(1) |
| 2.8 | The IDG should plan ahead for anticipated changes rather than respond only to a crisis. Frequent PRN visits mean the plan of care should be updated to include additional visits. | CMS guidance | SOM-M IG 418.56(c)(2) |
| 2.9 | Each update must be done within 15 days of the previous one; the hospice must document if there were **no** changes. | CMS guidance | SOM-M IG 418.54(d) |
| 2.10 | HOPE records pain as a screening (J0900: severity, tool type), an "active problem" flag (J0905), and a comprehensive pain assessment (J0910) with the seven characteristics. For non-verbal patients a caregiver report and clinical notes on nonverbal indicators are acceptable for any characteristic. For J0910 the clinician need only have **attempted** to gather a characteristic. | CMS guidance | HOPE J0900, J0905, J0910, Tables 4-6 |
| 2.11 | HOPE severity bands on a 10-point numeric scale: 0 none, **1-3 mild, 4-6 moderate, 7-10 severe**. | CMS guidance | HOPE Table 4 |
| 2.12 | HOPE symptom impact (J2051) is the effect of the symptom on the patient (sleep, concentration, day-to-day activities), rated not at all, slight, moderate, severe over the past two days. **It is explicitly not an intensity rating.** A **moderate or severe** impact at admission or a HOPE update visit calls for an in-person **symptom follow-up visit within 2 calendar days**. | CMS guidance (quality reporting, not the CoP) | HOPE J2051, J2052; QM ch. 5 |
| 2.13 | Continuous home care is only for a **period of crisis**: continuous care, predominantly nursing, to achieve palliation or management of **acute medical symptoms**, minimum 8 hours in a 24-hour day. | Regulation and CMS guidance | CFR-204 (a); MBPM-9 40.2.1 |
| 2.14 | General inpatient care is allowed when the condition warrants a short-term stay for **pain control or acute or chronic symptom management that cannot feasibly be provided in other settings**; if the IDG including the hospice physician judges symptoms not effectively managed at home, the patient is eligible. | CMS guidance | MBPM-9 40.1.5; SOM-M (levels of care) |

## 3. Guidelines and practice

| # | Finding | Type | Source and section |
|---|---|---|---|
| 3.1 | Assess onset, quality, severity, provoking and relieving factors, response to prior treatment, burden, **impact on function and quality of life** and the patient's goals; use validated tools; document ongoing assessments; after treatment starts, perform a **timely reassessment**; attend to patients who cannot communicate; assess whether a bowel regimen is needed and effective whenever opioids are prescribed; re-evaluate response to treatment regularly; document functional and symptom goals and reassessment intervals for opioid care. | Guideline | NCP4 criteria 2.2.2-2.2.5, 2.3.2, 2.3.4, 2.3.10 |
| 3.2 | The goal of symptom management is to improve function and quality of life **to a level acceptable to the patient** (or the surrogate if the patient cannot report). | Guideline | NCP4 criterion 2.1.1; WHO 5.6 ("the dose that relieves the patient's pain to a level acceptable to the patient") |
| 3.3 | Care-plan pain goal as a **patient-defined acceptable level (example: 3 or less)**; assess pain every visit; the RN is told if the level is above the goal; at each IDG review ask whether the goal was met in the past 2 weeks; **if the goal is not met (example: pain at 5, goal 3) the interventions need to be reviewed and possibly changed.** | Common practice (an industry primer's worked example) | NHPCO case 1 and FAQ 1 |
| 3.4 | After an as-needed dose, reassess pain relief, side effects and the effect on function once the peak effect has had time: **15 to 30 minutes after a parenteral dose, 1 hour after an oral dose**. | Guideline | FF70 "Document patient response to PRN dosing" |
| 3.5 | In a patient who cannot self-report: try self-report first and say why it cannot be used; look for causes of pain; observe behaviors; use caregiver report; consider an analgesic trial. **A behavioral tool's score "is not the same as a pain intensity rating nor can the scores be compared with standard pain intensity ratings or categories of pain severity."** **2026-11-25:** the rule stands in the later versions. 2011 says "intensity"; the 2024 recommendations say a behavioural score cannot be used interchangeably with self-reported intensity and give the example that a behavioural 4/10 "does not equal a self-report of pain intensity of 4/10". Since 2019 the hierarchy starts with awareness of potential pain sources, then self-report, observed behaviours, proxy report, analgesic trial; document why self-report was not possible and which method was used. Tools help detect pain, monitor change and evaluate treatment; behaviours can also signal other distress (delirium, air hunger). No ASPMN version gives a score threshold for any behavioural scale. | Guideline | ASPMN 2006, general recommendations 1 and 3; 2011 and 2024 general recommendations 1c and 2 (2024: Herr K et al., Pain Manag Nurs 2024;25(6):551-568) |
| 3.6 | PAINAD: five behaviors (breathing, negative vocalization, facial expression, body language, consolability) each 0-2, total 0-10. FLACC: five categories (face, legs, activity, cry, consolability) each 0-2, total 0-10. The PAINAD text gives **no official severity bands**; the 1-3, 4-6, 7-10 bands in circulation are not substantiated for it. The product offers only these two scales (both 0-10); the other HOPE staff-observation examples (CPOT, CNPI) are not offered because their score ranges were not verified. | Guideline (tool) | PAINAD (AMDA reprint); FLACC (Starship tool text); band caveat from NSW ACI as summarised by search, **not confirmed in the tool itself** |
| 3.7 | As swallowing declines, medications are typically given sublingually, transdermally or rectally. WHO: analgesics "by mouth" whenever possible. | Guideline | AFP 2017 abstract and text; WHO 5.6 |
| 3.8 | Laxatives must be routinely prescribed for the prophylaxis and management of opioid-induced constipation (level I, grade A). | Guideline | ESMO 2018, side effects (via summarising fetch) |
| 3.9 | A change of about **2 points, or about 30%**, on a 0-10 numeric scale is, on average, a clinically important change in chronic pain trials. Sources disagree on the exact minimum (1 to 2 points are quoted for acute pain). | Research | FARRAR and IMMPACT (secondary citations) |
| 3.10 | NCCN: pain that is severe, not improved or increased calls for re-evaluation and a comprehensive pain assessment; oral opioid effect is reassessed at 60 minutes and IV at 15; if the score is unchanged after 2 to 3 titration cycles, consider another route or strategy and specialist help; for a pain crisis consider inpatient care. **2026-11-25, read in the text (third-party copies):** the 60 and 15 minute figures are in the JNCCN 2019 article (p. 993) and in v2.2023 PAIN-5; the "2 to 3 cycles" step is worded differently in the two (2019: after an inadequate response, changing the route or strategy "can be considered"; 2023: "consider IV titration and/or see PAIN-4 and Ongoing Care", with specialist consultation on PAIN-4 and PAIN-6); inpatient admission for a pain crisis may be considered (2019 p. 982; 2023 PAIN-3, PAIN-4). The 60 and 15 minute figures do not appear in the JNCCN v2.2025 article text. | Guideline (read; v2.2026 unread) | NCCN v3.2019 (JNCCN 2019;17(8):977-1007), v2.2023 PAIN-3 to PAIN-6, JNCCN v2.2025 |
| 3.10a | **2026-11-25:** severity bands. NCCN v2.2023 PAIN-A: none 0, mild 1-3, moderate 4-6, **severe 7-10**, the same as HOPE. The JNCCN 2019 article text says mild 1-3, moderate 4-7, severe 8-10 (and elsewhere "decreases to 4 to 6", so it is internally inconsistent). v2.2025 names the bands without numerals in its text. Other primary sources: Serlin 1995 (cancer, graded by interference) mild 1-4, moderate 5-6, severe 7-10; Woo 2015 review (seven cancer studies) most often severe from 7, range 4-7 for the moderate-to-severe cut point so severe from 8 also occurs; Boonstra 2016 (2,854 chronic musculoskeletal patients, not cancer) severe 8 or more (7 or more in the low-catastrophizing subgroup); Paul 2005 (bone-metastasis outpatients) did not confirm Serlin's moderate-severe boundary. | Guideline and research | NCCN v2.2023; Serlin RC et al., Pain 1995;61:277-284 (abstract); Woo A et al., Ann Palliat Med 2015;4:176-183; Boonstra AM et al., Front Psychol 2016;7:1466; Paul SM et al., Pain 2005;113:37-44 (abstract) |
| 3.10b | **2026-11-25:** current NCCN reassessment wording (JNCCN v2.2025): "Pain should be reassessed regularly" at opioid-naive initiation; "formal pain re-evaluation is required at each contact"; "pain should be assessed during each outpatient contact or at least each day for inpatients"; intensity ratings "may be obtained frequently during analgesic titration". | Guideline | JNCCN v2.2025, 23(7), doi 10.6004/jnccn.2025.0032 |
| 3.10c | **2026-11-25:** behavioural cut-offs that exist in other populations: PAINAD 2 or more for probable pain (nursing-home dementia, Zwakhalen 2012, abstract only); FLACC 2 in children 6-42 months (Crellin 2018, abstract only); CPOT above 2 in intubated cardiac-surgery adults (Gélinas 2009, abstract only). All are presence-of-pain screens in other populations; none is validated in hospice or is a severity band, and ASPMN does not endorse a threshold. ASPMN 2024 lists FLACC and FLACC-R only in its paediatric tables; for adults at end of life it lists PAINAD (older adults, long-term care), MOPAT (adults, hospice) and REPOS, and its 2011 critically-ill table had a FLACC row that 2024 dropped. | Research | Zwakhalen SM et al., J Am Med Dir Assoc 2012;13:384-389; Crellin D et al., J Pain 2018;19:862-872; Gélinas C et al., J Pain Symptom Manage 2009; ASPMN 2024 Tables 2, 4, 6, 7 |
| 3.11 | ESMO: use a 0-10 NRS or VAS; worst pain of 3 or more, or a distressed patient, warrants a more detailed assessment; reassess "regularly and consistently" without an interval. | Guideline | ESMO 2018 (via summarising fetch) |

## 4. Where sources differ

| Topic | Difference | What the product does |
|---|---|---|
| "Severe" on the 0-10 scale | HOPE Table 4: 7-10 (moderate 4-6). NCCN v3.2019 article text: 8-10 (moderate 4-7). **2026-11-25:** the full NCCN guideline v2.2023 (PAIN-A) says 7-10 (moderate 4-6), the same as HOPE; the 2019 figure is from that article's narrative text only. Serlin 1995 (cancer) 7-10; Woo 2015 most often 7; Boonstra 2016 (non-cancer) 8. | Uses the CMS HOPE band (`PAIN_SEVERE_MIN_SCORE = 7`) because this corpus is HOPE-aligned, and labels it "CMS HOPE scale" so nobody reads it as a clinical cut-off. The 7 stays (HOPE, NCCN 2023 and Serlin agree); the reason's visible source text still says "NCCN v3.2019 puts severe at 8 to 10", which is true of that article but no longer the whole picture (sign-off row 2.1). |
| How many characteristics | CoP guidance: a list with no count. HOPE coding: one attempted characteristic is enough. Quality measure: 5 of 7 at admission. | Shows "n of 7 documented" with the 5-of-7 benchmark named as a quality-reporting measure for the admission assessment; advisory at every other visit. Never blocks. |
| Reassessment interval after an as-needed dose | FF70 and NCCN: 1 hour oral. A hospice caregiver handout seen in search: call the team if no relief half an hour after a second dose. | Shows the FF70 hour as a prompt only. No agency-specific call rule is built (those belong to the agency's policy). |
| Score of a behavioral scale | HOPE lists PAINAD and FLACC as pain severity tools. ASPMN says behavioral scores are not comparable with 0-10 intensity categories. | Records a behavioral scale and its score as its own statement and never feeds it into the 0-10 thresholds. |
| Minimum meaningful change | About 2 points (Farrar) versus 1 to 2 points in other populations. | `PAIN_MEANINGFUL_RISE_POINTS = 2`, labelled "research benchmark". |

## 5. What the product builds from this

Advisory only; nothing here blocks finalize or sign, and nothing changes a plan of care by itself.

1. **Pain assessment helper** under the pain statements in the Symptom Management section: the seven HOPE characteristics (severity and effect on function come from the pain statement itself), medication response, side effects, bowel regimen, inability to take oral medication, nonverbal cues and a behavioral scale, the patient's own acceptable pain level, the score at the last visit and the change since then. Each is an optional statement the clinician fills in their own words. Items 2.5, 2.6, 2.10, 3.1, 3.5.
2. **Plan-of-care prompt** with the reasons that apply, each labelled by type and source: pain limiting function (2.7, 3.1, 3.2); above the patient's own level (3.3); severe by the CMS HOPE scale (2.11); a rise of 2 or more points since the last visit (3.9); worsened or new pain since the last visit (2.2, 2.4, 2.6); no relief from the last as-needed dose (3.4, 3.1); cannot take oral medication (3.7). It points to the Plan of care step and to physician notification and an IDG review (2.4, 2.6). Static notes carry the HOPE two-day follow-up (2.12, only at a HOPE admission or update visit) and the level-of-care pointer (2.13, 2.14; the decision is the hospice physician's and the IDG's).
3. **Assembled note**: each recorded item is one deterministic sentence in Symptom Management, and the clinician's plan-of-care decision is one more sentence.

## 6. Not built, because no source supports it

- A **fixed numeric score that must trigger a physician call** (for example "7 or more means call"). HOPE's 7-10 band is a reporting band, hospital policies that use 7 are acute-care policies, and no hospice rule was found. The score is one advisory reason among others.
- A **required** count of characteristics, or a block on finalize for a short assessment (none of the sources makes it a visit-note rule).
- An **auto-filled** characteristic or an automatic read of the last visit's pain score (needs a backend read; the clinician types the last score).
- Any **automatic** plan-of-care change or notification.
- A **dose or titration** suggestion (a prescriber decision; NCCN and FF70 figures are not reproduced in the product).
- An **agency-specific** notification time (agency policy).
- A numeric trigger for a **behavioral scale** (3.5, 3.6). Re-checked 2026-11-25 against ASPMN 2011 and 2024: the non-comparability rule stands and no ASPMN version gives a threshold; the low presence-of-pain cut-offs that exist (3.10c) are from other populations and are not hospice-validated, so none is built. ASPMN 2024 lists FLACC only as a paediatric tool, which weakens offering it to adults (sign-off row 2.31).
- **ESAS-r** cut-offs: researched 2026-11-25 in [`ESAS_R_CUTOFFS_RESEARCH.md`](./ESAS_R_CUTOFFS_RESEARCH.md). The only sourced prompt (a score of 4 or more as a trigger for a fuller assessment, Oldenmenger 2013) is built as an item prompt in the composer; a severity tier, any "notify the physician" wording and any total-score band are not built.
