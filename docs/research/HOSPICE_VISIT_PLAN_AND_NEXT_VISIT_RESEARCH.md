# Hospice visit plan and next visit: sourced research behind the "Plan and Next Visit" section

Researched 2026-11-24 for the visit-note composer's last section, "Plan and Next Visit" (M8, `plan` in
`packages/hearthnote/src/templates/registry.ts`), and its link to scheduling (M17) and the plan of care (M7). Every
external claim carries its source (URL, section or page) and a type. A claim a source did not confirm is marked
**NOT SOURCED** and is not in the code.

**This is research input, not clinical sign-off.** The guide wording and the advisory rules built on it are section 3 of
[`CLINICAL_SIGNOFF_2026-11-VISIT_NOTE_COMPOSER.md`](../clinical-review/CLINICAL_SIGNOFF_2026-11-VISIT_NOTE_COMPOSER.md),
signed off by Lora, RN on 2026-11-25 with sections 1-6, not item by item.

## Claim types

| Type | Meaning |
|---|---|
| **Regulation** | Text of 42 CFR part 418 (binding on the hospice). |
| **CMS guidance** | CMS manuals, the State Operations Manual (SOM), HOPE and HQRP documents, rule preambles. They bind surveyors or define a reporting item; they are not the CoP text. |
| **Guideline** | A published professional-body guideline or standard (NCP, NHPCO Standards of Practice, HPNA, AAWC, NCCN, WHO). |
| **Common practice** | An agency, vendor, educational or federal-toolkit resource. Useful, not binding. |
| **Evidence** | Peer-reviewed research. |

Part C was written with its own labels (GUIDELINE, REGULATORY, COMMON PRACTICE, EVIDENCE); its **REGULATORY** label covers CMS
regulation and CMS guidance documents together (the SOM and HOPE manuals are CMS guidance in the table above).

## Retrieval notes

All sources were fetched on 2026-11-24 and read as text (eCFR XML, CMS PDFs, publisher PDFs and pages). Not retrieved: Palmetto GBA
hospice documentation tips (HTTP 403), the WOCN pressure-injury guideline (cited second-hand only), HPNA POLARIS modules, any AAHPM
position statement on continuity (none found), Hospice Foundation of America material. State hospice licensure and Medicaid hospice
rules were not researched. The NHPCO Standards of Practice 2018 were read from a copy hosted by one hospice, not from NHPCO.

## 1. The five findings that decided the design

1. **No federal minimum visit frequency; the plan of care is the authority.** (Regulation + CMS guidance + Guideline agree.)
   42 CFR 418.56(c)(2) requires "a detailed statement of the scope and frequency of services"; nothing sets a number of nursing,
   social-work, chaplain or aide visits. Surveyors check that services began and continue "at the frequency ordered" (SOM Appendix M,
   418.56 clinical record review), NHPCO's Standards of Practice (PFC 5.1) say the record should reflect visits "in accordance with the
   visit frequency stated in the plan of care", and the NHPCO Care Planning Primer (Jan 2023) answers "there is not a prescriptive visit
   frequency" except aide supervision, adding that RN gaps of 14 days or more draw scrutiny (Common practice, and it says it is not
   official CMS guidance). **Used:** the schedule advisory compares the schedule with the plan's *own* ordered frequency and never
   invents a minimum.
2. **Missed or changed visits: guidance, not a rule.** (CMS guidance + Guideline + Common practice; the CFR is silent.) The SOM asks
   whether the record gives "substantial evidence to describe why visits were missed and what efforts by the clinician have been made",
   whether missed visits and schedule changes are communicated to the patient and caregiver, and whether the patient knows the visit
   schedule. An NHPCO compliance tip sheet (2012) says to document why the plan's frequency was not followed. **Used:** a guide item,
   labelled CMS guidance, and the next-visit field.
3. **No federal or professional rule requires the next-visit date, a visit duration or an escalation block in each note.** (NOT
   SOURCED.) 418.56(c)(2) says "scope and frequency", not "frequency and duration"; 418.104 requires "clinical notes", authenticated
   and dated, and defines no fields. The best-anchored plan elements are: a change to scope or frequency and its reason, teaching given
   and the understanding shown, orders and supplies, who was notified, follow-up and reassessment, after-hours access, missed visits.
   **Used:** every field is optional, the next-visit item is labelled Common practice, and the section's required status is untouched.
4. **The only fixed visit clocks are narrow.** (Regulation for the 14-day aide visit; CMS guidance for HOPE.) An RN on-site
   supervisory visit at least every 14 days when an aide serves the patient (418.76(h)(1)(i), a CoP); in HOPE, an in-person symptom
   follow-up visit within two calendar days of a moderate or severe symptom impact found at admission or at the HOPE update visit
   (HOPE Guidance Manual v1.03 section 1.3.3; quality reporting, not a CoP); HUV1 on days 6-15 and HUV2 on days 16-30. The SIA is a
   payment add-on for RN and social-work care in the last seven days of life (418.302(b)(1)), and HVLDL is a quality measure ("not
   given minimum visit mandates at the end-of-life"). **Used:** the aide-supervision and symptom-follow-up prompts are in the guide
   only. **Not built:** a last-days-of-life visit expectation, because no rule sets one and the repo's SIA computation is retrospective
   billing.
5. **Reassessment after an intervention is expected, with no universal interval.** (Guideline.) NCP 2.2.4 says "timely" and does not
   quantify it; the SOM, NHPCO, HPNA/ASPMN and WHO give no number. The one-hour oral-opioid figure is NCCN 2019 for titrating
   short-acting opioids in opioid-naive patients and was dropped from NCCN 2025. For wounds, HPNA's resource guide and the AAWC
   guideline of guidelines (2010) agree on weekly assessment and a review of the plan after 2-4 weeks without improvement.
   **Used:** no pain interval appears anywhere in the code; the wound line is a guide item only.

Corrections to the brief this research was given: the plan of care states "scope and frequency", not "visit frequency and duration"
(duration is NOT SOURCED); hospice survey tags in the SOM are **L-tags**, not V-tags; the SIA is 42 CFR 418.302(b)(1)(i)-(ii), not (g).

## 2. What the repo's own specs say (read first)

| Topic | Where | What it says | Used for |
|---|---|---|---|
| Plan of care content | `docs/modules/CHARTWARDEN_MODULE_07_CARE_PLAN_SPEC_v0_3.md` (lines 52, 83, 203-204, 296) | The IPOC is the 42 CFR 418.56 plan of care. An intervention carries a discipline, a scope sentence and a frequency: `frequency_text` (human, "2 visits/week") and `frequency_value` (machine, "for scheduling", `count:unit:period`, e.g. `2:visit:week`). | The ordered visit frequency the section shows. |
| Machine form is not enforced | `apps/backend/src/modules/07-care-plan/routes/care-plan-typebox.ts:147` (`minLength: 1`); `apps/backend/src/modules/15-discipline-care-plans/lifecycle/validation.ts:179` (`checkInterventionFrequency` only requires a non-empty string) | The spec says "regex on machine form"; the code accepts any 1-64 character string. | The web reader treats anything that is not `count:visit:day|week|month` as "not comparable": it shows the plan's own words and never counts it. |
| Frequency grammar | `packages/scheduling/src/frequency.ts`; `docs/modules/CHARTWARDEN_MODULE_17_SCHEDULING_SPEC_v0_2.md` D5 (line 68) | `count:unit:period`; `prn`/`continuous`/`episode` are non-cadenced; M17's nightly proposal worker spaces visits by `round(periodDays / count)` days. Proposals are advisory; nothing auto-publishes. | The grammar copy (pinned to this source by a test) and the suggested day for the scheduler. |
| Scheduling API and permissions | `docs/implementation/evidence/08-visit-scheduling-current-state.md` section 3; `packages/ui/src/core/api/schema.ts` (`GET /api/v1/visits`, `POST /api/v1/visits`) | List: `visit.read`, caseload/org scope applied by the server, PHI list audit. Create: `visit.create`, with credential, discipline, time-off and caseload gates and idempotency. Creation is an M17 form (four steps), not something a note can do. | Read-only schedule from `GET /api/v1/visits?patient=&from=&to=`; booking is a link to the scheduler, not a write from the note. |
| Existing deep link | `apps/web/src/modules/05-patient/patient-overview.tsx:1428,1616` | The patient chart already links to `/calendar?patient=<id>&newVisit=1`; `calendar-page.tsx` opens the New Visit form for that patient. | The "Schedule next visit" link reuses this route and adds `newVisitPurpose` and `newVisitDate` (validated, optional). |
| "Next visit" seam | `apps/backend/src/modules/17-scheduling/seams/store.ts:131` | The seam's own meaning of "the patient's next scheduled visit": status `published` or `en_route`, start at or after now. | Which visits count as upcoming. |
| Plan section template | `packages/hearthnote/src/templates/registry.ts` | `plan` is `prose("plan", "Plan and Next Visit")`: required, no categories, "until structured reasons exist". With the tenant's draft wording on, the RN routine, recert and admission visits add the `plan` and `care_plan_element` categories (`nv.plan.continue`, `nv.plan.next_visit` "Next visit is planned for ${next_visit_date}" in `packages/narrative-vocab/src/draft-entries.ts`). | Why a tenant with the draft switch off sees "no preset statements". The section stays as it is; nothing here changes the corpus. |
| Plan-of-care step | `apps/web/src/modules/07-care-plan/change-proposals/plan-of-care-step.tsx`, `proposal-labels.ts` | A visit proposes plan changes as author-only drafts, released to the case manager's review list when the note is finalized; a proposal never edits the signed plan. | The follow-up block counts this visit's open proposals and points at that step. |
| HOPE symptom follow-up | `apps/backend/src/modules/10-hope` (SFV lifecycle `hope_sfv_status`, `POST /api/v1/admissions/:admissionId/hope/sfv`, org-wide worklist `GET /api/v1/hope/sfv`) | M10 owns the SFV record and its worklist. | Named in the guide only; the worklist is org-wide and needs its own permission, so the note does not read it. |
| SIA and last days of life | `packages/billing/src/sia/sia-units.ts` | The repo's SIA computation is retrospective billing (`[death - 6, death]` once death is known). No forward-looking last-days visit tracker exists on this branch. | Not built (see section 7). |
| Encounters without visits | `docs/cartography/audit_encounters_visits.md` | An encounter can exist without a scheduled visit (`encounter.visit_id` is nullable). | The panel treats `visitId` as optional. |
| Screen specs | `docs/design/screens/clinical/CHARTWARDEN_UI_ENCOUNTER_VISIT_DOCUMENTATION.md` | Describes the composer; had no Plan section. No scheduling-from-note screen spec exists. | A "Plan and Next Visit" section was added to that spec. |


## 3. Regulation and CMS guidance (Part B)

Section numbers cited inside Parts B and C refer to that Part's own numbering (B0 to B10, C0 to C8).

### B0. Sources fetched

| Short name | URL | Version seen |
|---|---|---|
| eCFR 42 CFR 418.xx | https://www.ecfr.gov/current/title-42/section-418.56 (same pattern for 418.52, .54, .64, .76, .100, .104, .114, .22, .24, .106, .202, .204, .302, .312). Fetched as XML via https://www.ecfr.gov/api/versioner/v1/full/2026-11-20/title-42.xml?part=418&section=418.56 (needs an Accept-Encoding header) | eCFR as of 2026-11-20. 418.56 last amended 88 FR 79539 (Nov. 16, 2023). 418.24 already contains the election-statement addendum text effective for elections on or after Oct. 1, 2026 |
| Medicare Benefit Policy Manual (Pub 100-02) Ch. 9 | https://www.cms.gov/regulations-and-guidance/guidance/manuals/downloads/bp102c09.pdf | Table of contents "Rev. 13664; Issued: 03-05-26"; each section carries its own revision date |
| SOM (Pub 100-07) Appendix M | https://www.cms.gov/regulations-and-guidance/guidance/manuals/downloads/som107ap_m_hospice.pdf (link taken from https://www.cms.gov/medicare/health-safety-standards/certification-compliance/hospices) | "Rev. 222; Issued: 06-07-24". Most tag text is still "Rev. 210; Issued 02-03-23" |
| Medicare Claims Processing Manual (Pub 100-04) Ch. 11 | https://www.cms.gov/regulations-and-guidance/guidance/manuals/downloads/clm104c11.pdf | "Rev.13190, Issued: 04-24-25"; §30.2.2 is "Rev. 3502, Issued: 04-28-16" |
| HOPE Guidance Manual v1.03 | https://www.cms.gov/files/document/hope-guidance-manual-v-1-03-508c-pdf.pdf (listed at https://www.cms.gov/medicare/quality/hospice/hope) | "v1.03, Effective October 1, 2026" (current on the retrieval date) |
| HOPE HUV item set v1.03 | https://www.cms.gov/files/document/hope-v1-03-hope-update-visit-508c-pdf.pdf | v1.03, effective Oct. 1, 2026 |
| HOPE v1.02 to v1.03 change table | https://www.cms.gov/files/document/hope-v1-02-hope-v1-03-guidance-manual-item-set-change-table-508c-pdf.pdf | effective 10-1-2026 |
| HQRP QM User's Manual v1.03 (HVLDL chapter) | https://www.cms.gov/files/document/hqrp-qm-users-manual-v103-hope508.pdf | "Version 1.03, Effective October 1, 2025" |
| HQRP draft HOPE timely-follow-up measures chapter | https://www.cms.gov/files/document/hqrp-qm-user-manual-chapter-hope-measures-508c.pdf | Marked "DRAFT" in the file itself |
| FY 2016 Hospice final rule | https://www.federalregister.gov/documents/2015/08/06/2015-19033/ (80 FR 47142, Aug. 6, 2015) | SIA origin |
| FY 2027 Hospice final rule | https://www.federalregister.gov/documents/full_text/html/2026/08/03/2026-15686.html (91 FR 49118, Aug. 3, 2026) | latest rule |

Correction to the brief: hospice survey tags in SOM Appendix M are **L-tags** (L500 to L7xx). A text search for V-tags in Appendix M returned zero hits.
Correction to the brief: the SIA is in **42 CFR 418.302(b)(1)(i)-(ii)**. 418.302(g) is the geographic-location payment rule.

---

### B1. 42 CFR 418.56 Interdisciplinary group, care planning, coordination of services (REGULATION)

URL: https://www.ecfr.gov/current/title-42/section-418.56 . SOM tags L536 to L558. The section sits in Subpart C (patient care), not subpart D.

**Lead-in (who prepares, what it must specify)**
> The hospice must designate an interdisciplinary group or groups as specified in paragraph (a) of this section which, in consultation with the patient's attending physician, must prepare a written plan of care for each patient. The plan of care must specify the hospice care and services necessary to meet the patient and family-specific needs identified in the comprehensive assessment as such needs relate to the terminal illness and related conditions.

**(a)(1) RN coordinator and IDG composition**
> The hospice must designate a registered nurse that is a member of the interdisciplinary group to provide coordination of care and to ensure continuous assessment of each patient's and family's needs and implementation of the interdisciplinary plan of care.

IDG must include (i) a doctor of medicine or osteopathy (employee or under contract), (ii) a registered nurse, (iii) a social worker, marriage and family therapist, or a mental health counselor, (iv) a pastoral or other counselor.
Also (a)(1): "Interdisciplinary group members must provide the care and services offered by the hospice, and the group, in its entirety, must supervise the care and services."

**(b) Standard: Plan of care (who establishes it, patient/representative involvement)**
> All hospice care and services furnished to patients and their families must follow an individualized written plan of care established by the hospice interdisciplinary group in collaboration with the attending physician (if any), the patient or representative, and the primary caregiver in accordance with the patient's needs if any of them so desire. The hospice must ensure that each patient and the primary care giver(s) receive education and training provided by the hospice as appropriate to their responsibilities for the care and services identified in the plan of care.

**(c) Standard: Content of the plan of care** (full list; this is the "must include" list)
> The hospice must develop an individualized written plan of care for each patient. The plan of care must reflect patient and family goals and interventions based on the problems identified in the initial, comprehensive, and updated comprehensive assessments. The plan of care must include all services necessary for the palliation and management of the terminal illness and related conditions, including the following:
> (1) Interventions to manage pain and symptoms.
> (2) A detailed statement of the scope and frequency of services necessary to meet the specific patient and family needs.
> (3) Measurable outcomes anticipated from implementing and coordinating the plan of care.
> (4) Drugs and treatment necessary to meet the needs of the patient.
> (5) Medical supplies and appliances necessary to meet the needs of the patient.
> (6) The interdisciplinary group's documentation of the patient's or representative's level of understanding, involvement, and agreement with the plan of care, in accordance with the hospice's own policies, in the clinical record.

Note: the rule says "scope and frequency of services". The words "duration" of a visit and "DME" are not in 418.56(c); DME is covered by "Medical supplies and appliances" (418.106 covers DME "as identified in the hospice plan of care"). Visit duration is NOT SOURCED in the CoP.

**(d) Standard: Review of the plan of care (review/revision frequency)**
> The hospice interdisciplinary group (in collaboration with the individual's attending physician, if any) must review, revise and document the individualized plan as frequently as the patient's condition requires, but no less frequently than every 15 calendar days. A revised plan of care must include information from the patient's updated comprehensive assessment and must note the patient's progress toward outcomes and goals specified in the plan of care.

**(e) Standard: Coordination of services**
> The hospice must develop and maintain a system of communication and integration, in accordance with the hospice's own policies and procedures, to-
> (1) Ensure that the interdisciplinary group maintains responsibility for directing, coordinating, and supervising the care and services provided.
> (2) Ensure that the care and services are provided in accordance with the plan of care.
> (3) Ensure that the care and services provided are based on all assessments of the patient and family needs.
> (4) Provide for and ensure the ongoing sharing of information between all disciplines providing care and services in all settings, whether the care and services are provided directly or under arrangement.
> (5) Provide for an ongoing sharing of information with other non-hospice healthcare providers furnishing services unrelated to the terminal illness and related conditions.

**Aide / RN supervision links** are in 418.76(g)-(h) (section 3 below) and 418.56(e)(2) ("care and services are provided in accordance with the plan of care").

### SOM interpretive guidance under 418.56 (GUIDANCE; PDF pp. 97-103 of Appendix M)

- L543 / L545 (418.56(b), (c)). No guidance text beyond the CFR.
- **L547 (418.56(c)(2) scope and frequency), PDF p. 100. Quoted in full on visit ranges:**
> The use of visit ranges in the patient plan of care should follow these parameters:
> - The plan of care may include a range of visits and 'provide as needed' orders for visit frequencies to ensure the most appropriate level of service is provided to the patient.
> - A range of visits is acceptable as long as it continues to meet the identified needs of the patient/family.
> - Visit ranges with small intervals are acceptable (i.e., 1-3 visits/week; 2-4 visits/week) but ranges that include "0" as a frequency are not allowed.
> - The IDG may exceed the number of visits in the range to address patient/family's needs. There should be documentation in the record to support the need for the extra visit(s).
>
> If the patient requires frequent use of PRN visits, the plan of care should be updated to include the need for additional visits.
>
> Standing orders or routine orders must be individualized to address the specific patient's needs and signed by the patient's physician.
> (p. 101) The IDG should be proactive in developing each patient's plan of care by planning ahead for anticipated patient changes and needs. Decisions should reflect the patient/family preferences rather than be solely a response to a crisis.
- **L548 (c)(3) measurable outcomes:** "The hospice should be using data elements as a part of the plan of care to see if they are meeting the goals of care. Are the outcomes documented and measurable? Look for movement towards the expected outcome(s) and revisions to the plan of care that have been made to achieve the outcomes."
- **L546 (c)(1):** pain and symptom management includes "the ongoing assessment of the patient's physical, psychosocial, emotional and spiritual needs and re-evaluating the effectiveness of the current plan of care".
- **L551 (c)(6), PDF p. 102:** "While the patient/family must be included in developing/updating the plan of care, they do not need to be present during IDG meetings."
- **L552 (d), PDF p. 102:** "Communication with the attending physician may be through phone calls, electronic methods, orders received, or other means according to hospice policy and patient needs."
- L553 (d, second sentence), L554-L558 (e): CFR text only.
- **L536 intro, PDF p. 97:** "There should be a direct link between the needs identified in the patient/family assessment and the plan of care developed by the hospice." Needs unrelated to the terminal illness: hospice "should document that they are aware of these needs and note who is addressing them."
- **Surveyor procedure for 418.56 (Part I, Task 4, PDF pp. 34-36), plan followed, missed visits (see section 7 for the quotes).**

---

### B2. 42 CFR 418.54 Initial and comprehensive assessment (REGULATION; SOM tags L520-L535)

URL: https://www.ecfr.gov/current/title-42/section-418.54

- **(a) Initial assessment, timing:** "The hospice registered nurse must complete an initial assessment within 48 hours after the election of hospice care in accordance with § 418.24 is complete (unless the physician, patient, or representative requests that the initial assessment be completed in less than 48 hours.)"
- **(b) Comprehensive assessment, timing:** "The hospice interdisciplinary group, in consultation with the individual's attending physician (if any), must complete the comprehensive assessment no later than 5 calendar days after the election of hospice care in accordance with § 418.24."
- **(c) Content:** must "identify the physical, psychosocial, emotional, and spiritual needs related to the terminal illness that must be addressed in order to promote the hospice patient's well-being, comfort, and dignity throughout the dying process" and take into consideration: (1) nature and condition causing admission, (2) complications and risk factors that affect care planning, (3) functional status including ability to understand and participate in own care, (4) imminence of death, (5) severity of symptoms, (6) drug profile (all prescription and OTC drugs, herbal remedies, other alternative treatments; effectiveness, side effects, interactions, duplicate therapy, drugs associated with laboratory monitoring), (7) bereavement (initial bereavement assessment; must be incorporated into the plan of care and bereavement plan of care), (8) need for referrals and further evaluation by appropriate health professionals.
- **(d) Update frequency:**
> The update of the comprehensive assessment must be accomplished by the hospice interdisciplinary group (in collaboration with the individual's attending physician, if any) and must consider changes that have taken place since the initial assessment. It must include information on the patient's progress toward desired outcomes, as well as a reassessment of the patient's response to care. The assessment update must be accomplished as frequently as the condition of the patient requires, but no less frequently than every 15 days.
- **(e) Outcome measures:** assessment "must include data elements that allow for measurement of outcomes"; the hospice "must measure and document data in the same way for all patients"; data elements "must be used in individual patient care planning and in the coordination of services".

SOM guidance (GUIDANCE):
- L522 (a), PDF p. 90: "The assessment needs to take place in the location where hospice services are being delivered. The initial assessment is not a 'meet and greet' visit..." "The RN must conduct this initial assessment."
- L523 (b), PDF p. 91: the IDG "determines who should visit the patient/family during the first 5 days of hospice care in accordance with patient/family needs and desires and the hospice's own policies and procedures". The comprehensive assessment may be done earlier, e.g. at the same time as the initial assessment.
- **L533 (d), PDF pp. 95-96:** "Hospices are required to update the comprehensive assessment as frequently as the condition of the patient requires, which may be more frequently than every 15 days. The hospice must ensure that each update is completed no later than 15 days from the previous one. Hospices are not required to complete, in full, those documents that they identified as comprising their comprehensive assessment every 15 days, although hospices are free to do so if they so choose. They are required to identify and document if there were no changes in the patient/family condition or needs." Also: "Assessment updates should be easily identified in the clinical record."
- L524 (c), PDF pp. 91-92: assessment "would include, but not be limited to, screening for the following: pain, dyspnea, nausea, vomiting, constipation, restlessness, anxiety, sleep disorders, skin integrity, confusion, emotional distress, spiritual needs, support systems, and family need for counseling and education."
- Part I, PDF p. 32: "Confirm that the comprehensive assessment is updated by the hospice IDG in collaboration with the patient's attending physician, if any, as frequently as the condition of the patient requires, but no less frequently than every 15 days."

---

### B3. Core services, aide, organization, rights, clinical records (REGULATION + GUIDANCE)

**42 CFR 418.64(b) Nursing services (L591-L593)**
> (1) The hospice must provide nursing care and services by or under the supervision of a registered nurse. Nursing services must ensure that the nursing needs of the patient are met as identified in the patient's initial assessment, comprehensive assessment, and updated assessments.

418.64(c) medical social services "must be provided by a qualified social worker, under the direction of a physician. Social work services must be based on the patient's psychosocial assessment and the patient's and family's needs and acceptance of these services." 418.64(d)(3) spiritual counseling: provide counseling "in accordance with the patient's and family's acceptance of this service". 418.64(d)(1)(iv): bereavement plan of care "notes the kind of bereavement services to be offered and the frequency of service delivery". No visit-frequency number appears in 418.64.

**42 CFR 418.76 Hospice aide and homemaker services (L607-L640)**
- (g)(1): "Hospice aides are assigned to a specific patient by a registered nurse that is a member of the interdisciplinary group. Written patient care instructions for a hospice aide must be prepared by a registered nurse who is responsible for the supervision of a hospice aide as specified under paragraph (h) of this section."
- (g)(2): aide provides services that are "(i) Ordered by the interdisciplinary group. (ii) Included in the plan of care. (iii) Permitted to be performed under State law by such hospice aide. (iv) Consistent with the hospice aide training."
- (g)(4): "Hospice aides must report changes in the patient's medical, nursing, rehabilitative, and social needs to a registered nurse, as the changes relate to the plan of care and quality assessment and improvement activities. Hospice aides must also complete appropriate records in compliance with the hospice's policies and procedures."
- **(h)(1)(i) RN supervisory visit:** "A registered nurse must make an on-site visit to the patient's home: (i) No less frequently than every 14 days to assess the quality of care and services provided by the hospice aide and to ensure that services ordered by the hospice interdisciplinary group meet the patient's needs. The hospice aide does not have to be present during this visit." (ii)-(iii): if an area of concern is noted, an on-site visit to observe the aide while performing care, then a competency evaluation if verified. (h)(2): annual on-site observation of each aide. (h)(3): RN assesses outcome criteria including "Following the patient's plan of care for completion of tasks assigned to the hospice aide by the registered nurse."
- (k): homemaker services "must be coordinated and supervised by a member of the interdisciplinary group"; instructions "prepared by a member of the interdisciplinary group".
- SOM (GUIDANCE): L625 (418.76(g)(1), PDF p. 131): "Hospice aide written instructions for patient care prepared by the RN responsible for the supervision of the aide must be patient specific and not generic." L629, PDF pp. 132-133: "If the RN makes a supervisory visit on a Tuesday, the next supervisory visit is due by the Tuesday which occurs 14 days later." and "The supervisory visits must be documented in the patient's clinical record." L633, PDF p. 134: "Supervisory visits may be made in conjunction with a professional visit to provide services. Documentation of RN supervision should include, but not be limited to, if the aide is following the plan of care, is competent in performing required tasks and is satisfactory to the patient/family." Part I, PDF p. 40: aides' "participation in furnishing services should be reflected in the visit notes of the clinical record"; "Look for hospice aide documentation that describes changes in the patient's medical, nursing, rehabilitative, and social needs and to whom he or she reported the information. Clinical notations should be dated and signed."

**42 CFR 418.100 Organization and administration (L648-L663)**
- (c)(2) availability: "Nursing services, physician services, and drugs and biologicals (as specified in § 418.106) must be made routinely available on a 24-hour basis 7 days a week. Other covered services must be available on a 24-hour basis when reasonable and necessary to meet the needs of the patient and family." (tag L653, PDF p. 140)
- (a): hospice care must be "Consistent with patient and family needs and goals, with patient needs and goals as priority."
- (e)(3): services under arrangement must be "Delivered in accordance with the patient's plan of care."
- (f)(2): hospice must monitor all locations "to ensure that each patient and family receives the necessary care and services outlined in the plan of care".
- SOM Part I (PDF p. 62): surveyor checks that "The on-call system is operational on a 24-hour basis so that patients can contact the hospice as necessary".

**42 CFR 418.52 Patient's rights (L500-L519)**
- (c)(2): the patient has a right to "Be involved in developing his or her hospice plan of care". (c)(3): "Refuse care or treatment". (c)(1): "Receive effective pain management and symptom control from the hospice for conditions related to the terminal illness". (c)(8): "Receive information about the scope of services that the hospice will provide and specific limitations on those services." (b)(2)-(3): rights are exercised by a court-appointed person, or a legal representative the patient designated under state law.
- SOM Part I, PDF p. 29: surveyors check the patient was informed of the right to "Be involved in developing the plan of care" and "if patient/caregiver was encouraged to provide input into the plan of care and the type of services they receive".

**42 CFR 418.104 Clinical records (L670-L685)**
- (a) record must include: "(1) The initial plan of care, updated plans of care, initial assessment, comprehensive assessment, updated comprehensive assessments, and clinical notes. ... (3) Responses to medications, symptom management, treatments, and services. (4) Outcome measure data elements, as described in § 418.54(e) of this subpart. ... (7) Physician orders." Also (2) signed notice of rights and election statement, (5) certification/recertification, (6) advance directives.
- (b): "All entries must be legible, clear, complete, and appropriately authenticated and dated in accordance with hospice policy and currently accepted standards of practice."
- The CFR does not define "clinical notes" or prescribe a visit-note format (NOT SOURCED).
- SOM Part I, PDF pp. 64-65 (GUIDANCE): record should include "Treatments and interventions by all disciplines (418.56 related to the multidisciplinary, individualized plan of care)"; "The clinical record should be person-centered and address the goals of care identified by the IDG and patient"; clinical notes "should be individualized, i.e., adapted to the needs or special circumstances of the patient"; "Every entry, both written and electronic, must be signed and dated by the person performing the service."

---

### B4. Medicare Benefit Policy Manual, Pub 100-02, Chapter 9 (GUIDANCE)

URL: https://www.cms.gov/regulations-and-guidance/guidance/manuals/downloads/bp102c09.pdf (PDF page numbers from my extraction).

- **§40 Benefit Coverage (Rev. 188), PDF pp. 23-24.** Coverage requires, among others: "A plan of care must be established and periodically reviewed by the attending physician, the medical director, and the interdisciplinary group of the hospice program; and That plan of care must be established before hospice care is provided; and The services provided must be consistent with the plan of care". Also: "The individualized plan of care is a continually evolving document. As such, Medicare expects the plan of care to be initiated based upon the information gathered in the patient's initial assessment, and the plan of care will be expanded upon, as appropriate, based on the information that is gathered during the comprehensive assessment." And (p. 25): "Hospices are expected to furnish the following services to the extent specified by the plan of care for the individual."
- **§40.1 (Rev. 1), p. 25:** "Appropriately qualified personnel must perform all services, but it is the nature of the service, rather than the qualification of the person who provides it, that determines the coverage category of the service."
- **§40.1.1 Nursing Care (Rev. 12400, eff. 01-01-24), pp. 25-26:** nursing services "must require the skills of a registered nurse (RN), or a licensed practical nurse (LPN) or a licensed vocational nurse (LVN) under the supervision of a registered nurse, and must be reasonable and necessary for the palliation and management of the patient's terminal illness and related conditions." NP services (non-attending) "are included under nursing care".
- **§40.1.2 Medical Social Services, p. 26:** qualification per 418.114(b)(3); covered services include assessment of social and emotional factors, community resources, counseling; short-term family/caregiver intervention (two or three visits) only to remove "a clear and direct impediment" to palliation.
- **§40.1.4 Counseling, §40.1.6 Supplies:** "Medical supplies include those that are part of the written plan of care and that are for palliation and management of the terminal illness or related conditions." (p. 32)
- **§40.1.7 Hospice Aide and Homemaker, p. 32:** "Hospice aides are assigned to a specific patient by a registered nurse who is a member of the interdisciplinary group. Written patient care instructions for a hospice aide must be prepared by a registered nurse who is responsible for the supervision of a hospice aide." Homemaker services "enable the individual to carry out the plan of care".
- **§40.1.9 Other Items and Services, p. 33:** "The hospice is responsible for providing any and all services indicated in the plan of care as reasonable and necessary for the palliation and management of the terminal illness and related conditions." Also repeats that the initial assessment is done "in the location where hospice services will be provided".
- **§40.2.1 Continuous Home Care, pp. 33-37:** minimum 8 hours of nursing, aide and/or homemaker care in a midnight-to-midnight day, "predominantly nursing care"; documentation must support that services "were in compliance with an established plan of care in order to meet a particular crisis situation". Example (Situation B) shows a nurse who "revises the plan of care after conferring with the patient's attending physician and with the hospice physician". "Documentation of care, modification of the plan of care, and supervision of aides or homemakers would not qualify as direct care" for CHC hours.
- **§40.4 Core Services, pp. 38-39:** nursing is "routinely available and/or on call on a 24-hour basis, 7 days a week" and works "within a plan of care developed by the hospice IDG in consultation with the patient's attending physician".
- **What Chapter 9 does not contain:** a text search of the whole chapter for "missed", and for visit-frequency requirements, found nothing. "Frequen" appears only in CHC examples, bereavement and "infrequently" (NOT SOURCED for any visit-frequency rule in Chapter 9).

---

### B5. HOPE, SIA, and related quality measures

#### B5a. HOPE Update Visit, Symptom Follow-up Visit (GUIDANCE under a REGULATION that defers to guidance)

**REGULATION: 42 CFR 418.312(b)(1)** (Hospice Quality Reporting Program, a pay-for-reporting rule, not a Condition of Participation):
> Hospices are required to complete and submit a standardized set of items for each patient to capture patient-level data, regardless of payer or patient age. The standardized set of items must be completed no less frequently than at admission, the hospice update visit (HUV), and discharge, as directed in the associated guidance manual and required by the Hospice Quality Reporting Program. Definitions for changes in patient condition that warrant updated assessment, as well as the data elements to be completed for each applicable change in patient condition, are to be provided in sub-regulatory guidance for the current standardized hospice instrument.

418.312(j)(1): hospices "must meet or exceed data submission threshold set at 90 percent of all required HIS or successor instrument records within 30-days of the beneficiary's admission or discharge"; (j)(2): miss it and take "a 4-percentage point reduction to its annual payment update".

**GUIDANCE: HOPE Guidance Manual v1.03 (eff. Oct. 1, 2026), Ch. 1, PDF pp. 6-14.**
- Table 1 timepoints: Admission "No later than five calendar days after the effective date of the hospice election, or the date recorded in A0220. Admission Date." HUV1: "The data for HUV1 are collected via an in-person visit to inform updates to the plan of care. HUV1 is required on or between days six and 15 of the hospice stay and should not be conducted within the first five days after the hospice election". HUV2: "collected via an in-person visit to inform updates to the plan of care. HUV2 is required on or between days 16 and 30 after the hospice election". "The date of the hospice election or the date recorded in A0220. Admission Date would be considered 'Day 0.'" Footnote 2 for HUV cites 42 CFR 418.56.
- §1.3.2: "The HUV timepoints are designed to inform updates to the patient's written plan of care." Missed or late: "If an HUV is missed or late for any reason (e.g., HUV1 conducted on day 17 or HUV2 conducted on day 33), you may still conduct the visit as appropriate and submit the record once it is completed, including any SFV, if applicable. Late HUV records will still be accepted. HUV records, if submitted (and accepted) timely, will count positively towards your hospice's compliance rate."
- Table 2: death/discharge on days 0-5 means HUV1 not required; death/discharge day 10, HUV1 not required (accepted if submitted); death/discharge day 25, HUV1 required, HUV2 not required.
- §1.3.3 **Symptom Follow-up Visit (SFV):** "The SFV is an in-person visit expected within two calendar days as a follow-up for any pain or non-pain symptom impact rated as moderate or severe. The SFV must be a separate visit (or encounter in an inpatient setting) from the Admission or HUV, and may occur any time within two calendar days, or later on the same day as the assessment where the initial finding of a moderate or severe symptom was determined." Up to three SFVs per stay. Trigger: item J2051 Symptom Impact A-H (pain, shortness of breath, anxiety, nausea, vomiting, diarrhea, constipation, agitation) coded 2 (moderate) or 3 (severe).
- Item J2052 (PDF pp. 78-79): "Unlike the assessment visits, the SFV item for symptom follow-up may be conducted by either an RN or LPN/LVN." J2052A was an in-person SFV completed (0/1), J2052B date, **J2052C reason SFV not completed: 1 patient/caregiver declined an in-person visit; 2 patient unavailable; 3 attempts to contact unsuccessful; 9 none of the above.** Example E (missed SFV because of "a scheduling issue") is coded J2052C = 9.
- J0050 Death is Imminent (HUV and admission): "Code 1, Yes, if clinical assessment and judgment determine the patient is expected to live three (3) days or less."
- §1.6.1 who may complete: "HOPE may be completed by any appropriate hospice staff member, based on the data being collected, such as the registered nurse (RN) for HOPE items requiring a skilled nursing assessment." Each person completing a portion signs in Section Z.
- §1.6.2: "If a particular HOPE care process is not documented in the hospice clinical record, the care process is considered not to have occurred."
- HUV item set v1.03 (8 pages): sections A, J (J0050, J2050-J2053), M (skin), N (medications: scheduled opioid, PRN opioid, bowel regimen), Z.
- v1.02 to v1.03 change table, row 8: wording on missed/late HUV changed from "conduct the visit as appropriate and submit the record once completed" to the "you may still conduct the visit ... Late HUV records will still be accepted" text above.
- Draft QM chapter (marked DRAFT): measures "Timely Follow-up for Pain Impact (#01795-02-C-HQR)" and "Timely Follow-up for Non-Pain Symptom Impact (#01796-01-C-HQR)" count a symptom follow-up visit "within two (2) days" of a moderate/severe impact finding.

#### B5b. Service Intensity Add-on (SIA) (REGULATION, then claims manual, then rule preamble)

- **REGULATION: 42 CFR 418.302(b)(1)(i)-(ii):**
> (i) Service intensity add-on. Routine home care days that occur during the last 7 days of a hospice election ending with a patient discharged due to death are eligible for a service intensity add-on payment.
> (ii) The service intensity add-on payment shall be equal to the continuous home care hourly payment rate, as described in paragraph (e)(4) of this section, multiplied by the amount of direct patient care actually provided by a RN and/or social worker, up to 4 hours total per day.

Also 418.302(e)(1): "Payment is made to the hospice for each day during which the beneficiary is eligible and under the care of the hospice, regardless of the amount of services furnished on any given day (except as set out in paragraph (b)(1)(i) of this section)."
The CFR does NOT say "in person", "15 minutes", or exclude telephone contact. Those come from the next two sources.
- **GUIDANCE: Claims Processing Manual Ch. 11 §30.2.2 (Rev. 3502, 04-28-16):**
> a service intensity add-on payment will be made for the social worker visits and nursing visits provided by a registered nurse (RN), when provided during routine home care in the last seven days of life. The SIA payment is in addition to the routine home care rate. The SIA payment is provided for visits of a minimum of 15 minutes and a maximum of 4 hours per day, i.e. from 1 unit to a maximum of 16 units combined for both nursing visit time and/or social worker visit time per day. In addition, the time of a social worker's phone calls is not eligible for an SIA payment.
- **GUIDANCE: Claims Manual §30.3 visit reporting (PDF pp. 43-48):** hospices report visits in 15-minute increments by revenue code and HCPCS: nursing 055x with G0299 (RN) or G0300 (LPN); social work 056x with G0155; aide 057x with G0156; social work phone calls 0569 with G0155 (separate lines). "When recording any visit or social worker phone call time, providers should sum the time for each visit or call, rounding to the nearest 15-minute increment. Providers should not include travel time or documentation time in the time recorded for any visit or call. Additionally, hospices may not include interdisciplinary group time in time and visit reporting." Also: "documentation in the medical/clinical record, interdisciplinary group meetings, obtaining physician orders, rounds in a facility or any other activity that is not related to the provision of items or services to a beneficiary, do not count towards a visit", and "the visit must be reasonable and necessary for the palliation and management of the terminal illness and related conditions as described in the patient's plan of care." Also: "It is recommended that this information be documented as close to the time of the assessment or intervention as possible." Charges on visit lines are bundled; "No additional payment is made on the visit revenue lines."
- **GUIDANCE: FY 2016 final rule preamble, 80 FR 47142:** "To qualify for the SIA payment, the following criteria must be met: (1) The day is a RHC level of care day; (2) the day occurs during the last 7 days of life (and the beneficiary is discharged dead); and, (3) direct patient care is provided by a RN or a social worker (as defined by § 418.114(c) and § 418.114(b)(3), respectively) that day." "CMS will only pay an SIA for those social work services provided by means of in-person visits." Response to comments: "CMS will only be paying the SIA payment for those services provided directly to the patient in his/her last week of life by an RN or SW in his or her home setting." LPN, aide, therapist, counseling visits are not SIA-eligible ("visits by LPNs, hospice aides, and therapists ... will still be covered by the existing RHC payment amount"). "No additional documentation will be required in order to receive the SIA payment."
- **FY 2027 final rule (91 FR 49118, Aug. 3, 2026):** restates the SIA unchanged (RN or social worker, last 7 days, up to 4 hours) and sets the SIA budget-neutrality factor at 0.9999. No structural SIA change found.

#### B5c. Hospice Visits in the Last Days of Life, HVLDL (GUIDANCE, quality measure, not a payment or coverage rule)
HQRP QM User's Manual v1.03, Ch. 3, PDF pp. 16-18: measures "the hospice provider's proportion of Medicare Fee-for-Service patients who received in-person visits from a registered nurse (RN) or medical social worker (MSW) on at least two out of the final three days of the patient's life." The manual states: "Although Medicare-certified hospices are not given minimum visit mandates at the end-of-life, hospices should be equipped to meet the higher symptom and caregiving burdens". Exclusions: any continuous home care, respite or general inpatient care in the final three days; enrolled fewer than three calendar days. Numerator: RN visits = revenue code 055x with HCPCS G0299 ("For HVLDL, only RN visits are included."); MSW = 056x (other than 0569) with G0155; post-mortem ("PM" modifier) visits do not count.

---

### B6. SOM Appendix M tag map for the sections of interest (GUIDANCE)

Appendix M uses L-tags. Tag numbers below are the ones printed in the Part II tag list (PDF pp. 80-150).

| CFR | L-tag(s) | Notes |
|---|---|---|
| 418.52(c)(2) involved in plan of care | L513 | CFR text only |
| 418.52(c)(3) refuse care | L514 | |
| 418.54 intro / (a) / (b) | L520 / L522 / L523 | |
| 418.54(c) and (c)(2)-(8) | L524-L532 (L528 imminence of death) | |
| 418.54(d) update every 15 days | L533 | guidance quoted in section 2 |
| 418.54(e) outcome measures | L534-L535 | |
| 418.56 intro | L536 | |
| 418.56(a) | L539-L542 | |
| 418.56(b) plan of care; education/training | L543; L544 | |
| 418.56(c) content; (c)(1) to (c)(6) | L545; L546-L551 | visit range guidance at L547 |
| 418.56(d) review | L552; L553 | |
| 418.56(e)(1)-(5) | L554-L558 | |
| 418.64 intro; (a); (b) nursing; (c) MSW | L587; L590; L591-L593; L594 | |
| 418.76 intro; (a); (g) assignments; (h) supervision | L607; L609; L625-L628; L629-L633 | 14-day visit is L629 |
| 418.100 intro; (a); (c); (c)(2) 24-hour; (e) | L648; L650; L652; L653; L655 | |
| 418.104 intro; (a)(1) to (a)(7); (b) | L670; L672-L678; L679 | |

### Surveyor investigative procedure (Part I, Task 4 "Information Gathering"; GUIDANCE)

**418.56 (PDF pp. 34-36)**
> Home Visit Observations. Verify that the care provided during observation is consistent with the plan of care.
> IDG Meeting Observation ... "Is the plan of care being reviewed and revised as needed? How are documented missed visits being addressed?"
> Patient/Caregiver Interview: "How does the hospice team keep you informed about when they will arrive to care for you?" "When there is an unexpected delay or re-scheduling of a visit, how does the hospice notify you? How often do either of these situations occur?"
> Clinical Record Review: "Verify that the plan of care is established timely and updated as necessary, that the patient is informed of changes, and that the hospice provides all of the care and services that are identified in the plan." "Verify that the hospice began services as ordered, within the specified time frame, and at the frequency ordered." "If a surveyor detects a pattern of missed visits by any discipline, determine how the IDG and RN coordinator are tracking these missed visits. How are missed visits communicated to the patient/caregiver? Is there evidence that visit frequencies are reduced due to staffing shortages? If the missed visits occur on weekends and holidays, conduct additional interviews with the RN coordinator and administrator to determine if the hospice employs sufficient staff to meet patients' needs." "Verify that the patient (representative or caregiver as appropriate) is receiving education and training as planned, and patient comprehension is documented."

**418.64 (PDF pp. 58-60)**
> "Does the patient/caregiver know the visit schedule of the clinician and are visits made as scheduled. If home visits are missed does the patient/caregiver know why and are they able to easily contact the hospice if a need arises?"
> Clinical Record Review: "The clinical record should indicate what core services are being provided with person-centered and specific visit schedules defined in the plan of care." "If the clinical record identifies missed visits is there substantial evidence to describe why visits were missed and what efforts by the clinician have been made to resolve missed visits?" "Does the clinical record include measurable and outcome-oriented goals of care that are person-centered and individualized?"

**418.76 (PDF pp. 39-41)**
> "Determine if the patient is aware of the aide's visit schedule if the visits are made as scheduled, and if the hospice communicates any changes to that schedule in advance."
> "Review supervisory visit documentation to confirm that a RN makes an on-site supervisory visit at least every 14 days; this documentation must be present in the clinical record."

**Closed-record review, care in the last days of life (PDF p. 23)**
> "Review the record to confirm that the agency was responsive and available to provide care and services in the last three days of life. Examples of situations that would require more investigation would be: 1) no visits made in the last week of life; 2) missed visits in the last week of life; 3) pain and symptom management not addressed; or 4) hospice not addressing patient's or caregivers' concerns. Consider citing findings with non-compliance regarding care in the last three days of life, under §418.52 or §418.56."

Also (Part I, 418.54, PDF pp. 32-33): "Ask the patient/family if they were involved in identifying goals of care"; "Does the comprehensive assessment include the patient/caregiver goals of care? Are the goals of care measurable/quantifiable where appropriate?"

---

### B7. Missed or changed visits, and notice of plan changes

**REGULATION (what the CFR actually requires)**
- No CoP text addresses a missed or late visit directly. NOT SOURCED in 418.56, 418.54, 418.64, 418.76 or 418.104.
- Plan changes: 418.56(d), the IDG must "review, revise and document the individualized plan as frequently as the condition requires" and at least every 15 calendar days; a revised plan "must include information from the patient's updated comprehensive assessment and must note the patient's progress toward outcomes and goals". 418.54(d) likewise requires "a reassessment of the patient's response to care".
- Patient/representative involvement: 418.56(b) (plan established "in collaboration with ... the patient or representative, and the primary caregiver in accordance with the patient's needs if any of them so desire"); 418.56(c)(6) (IDG documents "level of understanding, involvement, and agreement with the plan of care, in accordance with the hospice's own policies, in the clinical record"); 418.52(c)(2) and (c)(3) (right to be involved, right to refuse care). None of these says that a change to visit frequency needs the patient's signature or a separate notice.
- **Written notice when a plan change alters unrelated-condition determinations: 42 CFR 418.24(d)(2)** (elections beginning on or after Oct. 1, 2026): "If there are any changes to the plan of care during the course of hospice care that impact the addendum determinations, the hospice must update the addendum, within 3 days, with the contents described in paragraph (c) of this section, and provide these updates, in writing, to the individual (or representative)". This concerns related/unrelated conditions and non-covered items, not visit frequency.
- Aide scheduling: 418.76(g)(2)(ii) aide services must be "Included in the plan of care"; 418.76(g)(4) aides report changes to an RN.
- Services under arrangement must be "Delivered in accordance with the patient's plan of care" (418.100(e)(3)).

**GUIDANCE (SOM Appendix M, quoted in sections 1 and 6)**
- Extra visits beyond a range: "There should be documentation in the record to support the need for the extra visit(s)." Frequent PRN visits: "the plan of care should be updated to include the need for additional visits." (L547, p. 100)
- Missed visits: surveyors look for "substantial evidence to describe why visits were missed and what efforts by the clinician have been made to resolve missed visits" (p. 60); for IDG tracking of missed visits and how they are "communicated to the patient/caregiver" (p. 36); for whether the patient knows "why" a visit was missed (p. 58-59); and for whether the hospice "communicates any changes to [the aide's visit] schedule in advance" (p. 39).
- Plan changes: the record should show "that the patient is informed of changes" (p. 36); a revised plan shows progress toward outcomes (L553).
- Last week of life: "no visits made" or "missed visits" in the last week of life trigger further investigation under 418.52 or 418.56 (p. 23).
- HOPE (GUIDANCE, quality reporting only): missed or late HUV may still be done and submitted; a missed SFV is coded with a reason on J2052C (1 declined, 2 unavailable, 3 contact unsuccessful, 9 none of the above).
- FY 2027 final rule preamble (91 FR 49118, section IV.B.1, information-collection burden for the election statement addendum): "The hospice plan of care is established, reviewed, and updated by the hospice IDG and must include all services necessary for the palliation and management of the terminal illness and related conditions"; and "the hospice must document the services and treatments that address how they will meet the patient and family-specific needs related to the terminal illness and related conditions in the plan of care".

---

### B8. Quick reference of fixed clocks found in the sources (derived summary; each row cites its source)

| Clock | Value | Source type |
|---|---|---|
| RN initial assessment | within 48 hours after election (earlier if requested) | REGULATION 418.54(a) |
| Comprehensive assessment complete | no later than 5 calendar days after election | REGULATION 418.54(b) |
| Comprehensive assessment update | as condition requires, at least every 15 days | REGULATION 418.54(d); GUIDANCE L533: "no later than 15 days from the previous one" |
| IDG review/revise/document plan of care | as condition requires, at least every 15 calendar days | REGULATION 418.56(d) |
| RN on-site supervisory visit (aide) | at least every 14 days; annual on-site aide observation | REGULATION 418.76(h)(1)(i), (h)(2) |
| HOPE HUV1 / HUV2 | days 6-15 / days 16-30 after election (day 0 = election or A0220), in person | GUIDANCE HOPE manual v1.03; 418.312(b)(1) names the HUV but defers timing to the manual |
| HOPE Symptom Follow-up Visit | in person within 2 calendar days after a moderate/severe symptom impact at Admission or HUV | GUIDANCE HOPE manual v1.03 |
| SIA | RHC days in the last 7 days of a death-discharge election; RN and/or social worker direct patient care; up to 4 hours/day; visits at least 15 minutes; social worker phone calls excluded; in-person per preamble | REGULATION 418.302(b)(1) for days, hours, disciplines; GUIDANCE claims manual 30.2.2 and 80 FR 47142 for the rest |
| Nursing/physician/drug availability | 24 hours, 7 days a week | REGULATION 418.100(c)(2) |
| CHC | at least 8 hours, predominantly nursing, in a midnight-to-midnight day | REGULATION 418.302(b)(2), (e)(4); GUIDANCE Ch. 9 §40.2.1 |
| Recertification face-to-face encounter | within 30 calendar days before the 3rd benefit period recertification and each one after | REGULATION 418.22(a)(4) |

---

### B9. Disagreements and ambiguities between sources

1. **Tag type.** The brief says V-tags. Appendix M uses L-tags. (GUIDANCE)
2. **SIA citation.** The brief guessed 418.302(g). The SIA is 418.302(b)(1)(i)-(ii); (g) is geographic payment. (REGULATION)
3. **SIA scope differs by layer.** CFR: "direct patient care actually provided by a RN and/or social worker, up to 4 hours total per day". Claims manual adds: nursing visits by an RN, visits of a minimum of 15 minutes, no SW phone calls. The 2015 preamble adds: SW must be in-person; "in his or her home setting"; LPN, aide, therapist visits excluded. The claims-manual text does not literally say "in-person" for RN visits; the "in-person" wording is only in the preamble (and in HVLDL). Which layer binds a payment dispute is not stated in any source; CMS applies the claims logic through the claims processing system.
4. **HVLDL wording.** The QM manual describes the measure as RN or MSW visits on 2 of the last 3 days, but the RN bullet says "For HVLDL, only RN visits are included." Read with the next bullet (MSW counted via 056x/G0155), the sentence appears to exclude LPN visits (G0300), not social workers. The manual does not say so explicitly. HVLDL is a quality measure, not a visit mandate.
5. **15-day clocks are rolling, HOPE windows are fixed.** 418.54(d) and 418.56(d) run "no less frequently than every 15" days from the previous update/review (SOM L533: "no later than 15 days from the previous one"). HOPE HUV1/HUV2 are fixed windows counted from election (days 6-15, 16-30). A HUV does not replace the IDG review. HOPE manual §1.2: HOPE items "do not replace a thorough and ongoing assessment of each patient". That a HUV visit can double as the 15-day update visit is an inference; no source says so.
6. **CoP versus quality-reporting force.** The HUV and SFV are "required" only in the HQRP sense (418.312, pay-for-reporting; consequence is a 4 percentage point payment-update reduction if under 90 percent timely submission). The 15-day review and 14-day aide visit are Conditions of Participation (survey-enforced). The HOPE manual footnote ties HUV to 418.56 but does not make a missed HUV a CoP violation.
7. **Who may do which visit.** Nursing may be RN or LPN/LVN under RN supervision (418.64(b)(1); Ch. 9 §40.1.1). The initial assessment must be by an RN (418.54(a)). The HUV is an "assessment visit" typically by an RN (HOPE §1.6.1 says "such as the registered nurse (RN) for HOPE items requiring a skilled nursing assessment"), while the SFV may be RN or LPN/LVN (J2052). SIA and HVLDL count RN visits only.
8. **RN supervisory visit condition.** 418.76(h)(1)(i) and SOM L629 state the 14-day visit without saying "only when an aide is assigned"; the purpose clause refers to aide services. Neither the CFR nor SOM Rev. 222 text states how it applies when no aide is assigned. NOT SOURCED.
9. **Visit ranges.** The SOM L547 bar on a "0" lower bound and the rule that extra visits need documentation are guidance; the CFR only says "A detailed statement of the scope and frequency of services".
10. **SOM revision dates.** Appendix M is Rev. 222 (2024) but nearly all tag text shown is Rev. 210 (2023); the HOPE manual v1.03 is dated one year after the QM User's Manual v1.03 (Oct. 1, 2026 versus Oct. 1, 2025). The HQRP HOPE timely-follow-up chapter is still labelled DRAFT.
11. **HOPE v1.02 to v1.03.** Missed/late HUV language changed (change table row 8); the v1.03 text is the current one.

---

### B10. What the sources do NOT say

1. **No federal minimum visit frequency for routine home care.** CONFIRMED. 418.56(c)(2) leaves "scope and frequency" to the plan of care; no CFR section in the sections read sets a number of nursing, social work, chaplain or aide visits per week. Evidence: QM manual v1.03 ("not given minimum visit mandates at the end-of-life"); 418.302(e)(1) (payment "regardless of the amount of services furnished on any given day", other than the SIA exception); FY 2027 final rule preamble, section III.B.1.a ("Under the current payment system, hospices are paid for each day that a beneficiary is enrolled in hospice care, regardless of whether services are rendered on any given day"). The only fixed clocks are in section 8 (assessments, reviews, the 14-day aide-supervision visit, HOPE timepoints). (REGULATION and GUIDANCE agree)
2. **No federal visit-note template or required fields.** 418.104 requires "clinical notes", authentication and dating, but defines no fields. Time-recording rules (15-minute rounding, no travel or documentation time) are claims-manual billing rules. (NOT SOURCED for a note format)
3. **No federal requirement for a visit duration in the plan of care.** 418.56(c)(2) says "scope and frequency". (NOT SOURCED)
4. **No CFR rule requiring notice to the patient when a visit is missed or frequency changes, and no CFR requirement for a missed-visit reason.** Only SOM survey probes (section 7). (NOT SOURCED as a regulation)
5. **No source says a 15-day assessment update or IDG review needs an in-person visit by a nurse.** 418.54(d) and 418.56(d) assign these to the IDG. The HUV is in person; the CoPs are silent. (NOT SOURCED)
6. **No source requires a physician signature on each plan-of-care revision.** Chapter 9 says the plan is "established and periodically reviewed by the attending physician, the medical director, and the interdisciplinary group"; SOM L547 requires physician signature on standing or routine orders; 418.104(a)(7) lists "Physician orders". Whether a revised visit frequency needs a new order is not stated. (NOT SOURCED)
7. **No telehealth rule for routine plan-of-care visits found.** The only telecommunications text I saw is the recertification face-to-face encounter (418.22(a)(4)(ii)). HOPE HUV and SFV are "in-person". (NOT SOURCED for other visits)
8. **State law.** State licensure or Medicaid hospice rules may add requirements; none were researched. (NOT SOURCED)
9. **Chapter 9 of the Benefit Policy Manual** has no visit-frequency or missed-visit text. (NOT SOURCED)
10. **418.76(h) wording** gives no exception to the 14-day RN visit and no rule on counting a visit made for another purpose; SOM L633 only says supervisory visits "may be made in conjunction with a professional visit to provide services".

## 4. Clinical guidelines, standards and agency practice (Part C)

### C0. Sources

| ID | Source (URL) | Label |
|---|---|---|
| S1 | NCP Clinical Practice Guidelines for Quality Palliative Care, 4th ed. (2018). Still current; 5th ed. "in development" (nationalcoalitionhpc.org/our-work/5th-edition-update/). https://www.nationalcoalitionhpc.org/wp-content/uploads/2020/07/NCHPC-NCPGuidelines_4thED_web_FINAL.pdf | GUIDELINE |
| S2 | NHPCO Standards of Practice for Hospice Programs (2018), read from a Mountain Valley Hospice-hosted copy. https://mountainvalleycares.org/wp-content/uploads/2020/01/nhpco_standards_of_practice_2018.pdf | GUIDELINE |
| S3 | NHPCO Care Planning Primer (Jan 2023; "should not be viewed as official guidance from CMS"). https://allianceforcareathome.org/wp-content/uploads/NHPCO_Care_Planning_Primer.pdf | COMMON PRACTICE |
| S4 | 42 CFR 418.54, .56, .76, .100, .106, .302 (eCFR, as of 2026-11-01). https://www.ecfr.gov/current/title-42/part-418 | REGULATORY |
| S5 | CMS State Operations Manual App. M, hospice (TOC Rev. 222; L-tag text Rev. 210). https://www.cms.gov/Regulations-and-Guidance/Guidance/Manuals/downloads/som107ap_m_hospice.pdf (page refs below are PDF pages) | REGULATORY |
| S6 | CMS HOPE Guidance Manual v1.03, "Effective October 1, 2026". https://www.cms.gov/files/document/hope-guidance-manual-v-1-03-508c-pdf.pdf | REGULATORY |
| S7 | CMS HQRP Current Measures page (modified 11/03/2026) https://www.cms.gov/medicare/quality/hospice/current-measures ; QM User's Manual v1.04 https://www.cms.gov/files/document/hqrp-qm-users-manual-v1-04-508c.pdf | REGULATORY |
| S8 | CAHPS Hospice Survey QA Guidelines V13.0 (Oct 2026). https://hospicecahpssurvey.org/globalassets/hospice-cahps4/quality-assurance-guidelines/cahps-hospice-survey-quality-assurance-guideline-v13.0.pdf | REGULATORY |
| S9 | AHRQ Health Literacy Universal Precautions Toolkit, 3rd ed., Tool 5 (reviewed Apr 2024), 6, 7. https://www.ahrq.gov/health-literacy/improve/precautions/tool5.html (tool6, tool7) | COMMON PRACTICE (primary-care toolkit) |
| S10 | OIG OEI-02-17-00020 (July 2019). https://www.oig.hhs.gov/oei/reports/oei-02-17-00020.pdf | REGULATORY (oversight data) |
| S11 | NCCN Adult Cancer Pain v3.2019 (JNCCN 17(8), doi 10.6004/jnccn.2019.0038) https://jnccn.org/view/journals/jnccn/17/8/article-p977.xml ; v2.2025 (JNCCN 23(7), doi 10.6004/jnccn.2025.0032) https://jnccn.org/view/journals/jnccn/23/7/article-e250032.xml | GUIDELINE (oncology) |
| S12 | WHO cancer pain guideline (2018), UNODC-hosted copy. https://iris.who.int/handle/10665/279700 (text read from a UNODC-hosted copy) | GUIDELINE |
| S13 | HPNA/ASPMN Position Statement, Pain Management at the End of Life (Jan 2024). https://www.advancingexpertcare.org/wp-content/uploads/2024/02/ASPMN-HPNA-Joint-Position-Statement-on-Pain-Management-at-EOL-HPNA-FINAL.pdf | GUIDELINE |
| S14 | AAWC Guideline of Pressure Ulcer Guidelines (2010). https://s3.amazonaws.com/aawc-new/memberclicks/AAWCPressureUlcerGuidelineofGuidelinesAug11.pdf ; HPNA Nursing Resource Guide: Palliative Wound Care https://www.advancingexpertcare.org/wp-content/uploads/2023/08/Palliative-Wound-Care-2.pdf | GUIDELINE |
| S15 | NHPCO compliance tip sheet, CMS FY2011 Top Ten Survey Deficiencies (2012). https://www.hospicetools.com/wp-content/uploads/2019/06/CMS_TopTenHospiceSurveyDeficiencies-Compliance-Recommendations.pdf | COMMON PRACTICE |
| S16 | Mountain Valley Hospice, Documentation Standards (July 2020; one agency). https://mountainvalleycares.org/wp-content/uploads/2020/09/Documentation-Standards-7.2020.pdf | COMMON PRACTICE |
| S17 | ACHC webinar slides, Hospice Documentation: Painting the Picture (undated; sample dates 2016). https://www.achc.org/wp-content/uploads/2022/04/hospice-webinar-painting-the-picture.pdf | COMMON PRACTICE |
| S18 | Alabama Dept of Public Health, Picture Perfect Documentation Part 2 (May 2014), HOME HEALTH. http://www.adph.org/ALPHTN/assets/Part2Mary.pdf | COMMON PRACTICE |
| S19 | MAC tip sheets: CGS J15 Hospice Documentation Checklist Tool (rev. 12/5/2022) https://www.cgsmedicare.com/hhh/education/materials/pdf/j15_hospice_doc_checklistre.pdf ; NGS Hospice Documentation Checklist (1522_0120) https://www.calhospice.org/assets/docs/Handout%208_Hospice%20documentation%20checklist.pdf | COMMON PRACTICE (payer) |
| S20 | Ryan-Madonna, Levin, Lauder. J Hosp Palliat Nurs 2019;21(1):61-70. https://pubmed.ncbi.nlm.nih.gov/30608359/ | EVIDENCE |
| S21 | Robinson et al. Palliat Med 2022;36(10):1522-31. https://pmc.ncbi.nlm.nih.gov/articles/PMC9749007/ | EVIDENCE (qualitative) |
| S22 | Systematic mixed studies review, BMC Palliat Care 2019;18:18. https://www.ncbi.nlm.nih.gov/pmc/articles/PMC6368799/ | EVIDENCE |
| S23 | AAHPM comments on 2027 Medicare PFS (14 Sep 2026). https://aahpm.org/wp-content/uploads/2026/09/AAHPM-Comments-2027-Medicare-PFS.pdf | advocacy, not a guideline |

NOT RETRIEVED: Palmetto GBA Hospice Documentation Tips (HTTP 403); NCBI Bookshelf WHO copy; WOCN pressure-injury guideline (cited only second-hand in S14); HPNA POLARIS modules and HPNA/ANA Scope and Standards (not found); any AAHPM continuity position statement (none found); Hospice Foundation of America.

---

### C1. NCP 4th ed. (S1), criterion and printed page

No stand-alone "continuity" or "caregiver" domain; they run through Domains 1, 2, 4, 6, 7.
- **1.1.7 (p.2):** "The patient and family have access to palliative care staff 24 hours a day, seven days a week by phone or telehealth applications."
- **1.2.7 (p.3):** "The IDT performs subsequent assessments at regularly defined intervals and whenever the patient's status significantly changes, new problems are identified, or the patient experiences a transition in health care setting or provider."
- **1.3.1 (p.4):** "The patient's preferences, needs, values, expectations, and goals, as well as the family's concerns, provide the foundation and framework for the plan of care."
- **1.3.5:** "The care plan is updated and reviewed at regular intervals and when the patient experiences a significant change in status..."
- **1.3.7:** the IDT ensures "a. The patient and family have access to medications and treatments; b. New medications, medical equipment, tests, and therapies are authorized by payers; c. The patient and family can safely and effectively manage and administer medications."
- **1.4 (p.5):** "The IDT has defined processes to ensure access, quality, and continuity of care, especially during transitions of care."
- **1.7.3-1.7.4 (p.7):** "Before, during, and after transitions of care, the IDT coordinates with the patient and family and other providers to ensure continuity of care."
- **2.2.4 (p.14):** "After treatment is initiated, the IDT performs a timely reassessment to ascertain the effectiveness of the treatment." "Timely" is never quantified in S1.
- **2.3.4 (p.15):** "The patient's response to treatments is regularly re-evaluated."
- **2.3.6:** "Caregivers are assessed, trained, and supported to provide safe and appropriate care to the patient, including medication administration, safe transfers, and use of medical equipment."
- **2.3.13:** the IDT educates "the patient and family regarding proper medication administration"; "Consideration is given as to whether patients and families can access and afford the medications."
- **6.2.1 (p.39):** "Palliative care staff tailor their communication to the patient and family's level of health literacy."
- **7.1.1(a) (p.45):** training includes "Ensuring frequent telephone and in-person contact with patient and family caregivers in the days before death."
- **7.3.1 (p.47):** "Reassessment and revision of the plan occurs regularly, with the frequency identified in agency or program policies."
- **7.3.4:** "The IDT ensures access to medications, supplies, and equipment that may be needed."
- **7.3.5:** family education "with emphasis on whom to notify, and what to expect when symptoms change and after the patient dies," matched to health literacy and culture.
- **7.3.6:** "Family expectations regarding IDT availability during the dying process are identified in advance so that staff can alleviate concerns and communicate realistic expectations."

### C2. Visit frequency, missed visits, on-call, last days (S2, S3, S4, S5, S7, S10, S15)

**Plan of care is the frequency authority**
- 418.56(c)(2): the plan includes "A detailed statement of the scope and frequency of services necessary to meet the specific patient and family needs."
- 418.56(d): the IDG "must review, revise and document the individualized plan as frequently as the patient's condition requires, but no less frequently than every 15 calendar days. A revised plan of care must include information from the patient's updated comprehensive assessment and must note the patient's progress toward outcomes and goals."
- 418.54(d): the assessment update includes "a reassessment of the patient's response to care."
- S2 PFC 5.1: "...provide services according to the scope and frequency specified in the plan of care."
- SOM L547 (S5, p.100): "Visit ranges with small intervals are acceptable (i.e., 1-3 visits/week; 2-4 visits/week) but ranges that include "0" as a frequency are not allowed." "The IDG may exceed the number of visits in the range ... There should be documentation in the record to support the need for the extra visit(s)." "If the patient requires frequent use of PRN visits, the plan of care should be updated to include the need for additional visits." Also: "The IDG should be proactive in developing each patient's plan of care by planning ahead for anticipated patient changes and needs."
- NHPCO tip sheet (S15): "Ensure that the IDG documents why the visit frequency on the patient's plan of care was not followed or to support the need for a change in frequency or extra visits."

**No fixed minimum**
- S3 Q&A 6: "Except for the hospice aide supervisory visit there is not a prescriptive visit frequency." It adds RN frequency "has come under some scrutiny by surveyors and other regulators, particularly if the RN visit frequency is 14 days or more between visits." Q&A 4: no Medicare requirement for a physician order for visit frequencies.
- 418.76(h)(1)(i): aide supervision, an RN on-site visit "No less frequently than every 14 days." Only fixed visit interval found.

**Missed visits**
- SOM (p.60): "If the clinical record identifies missed visits is there substantial evidence to describe why visits were missed and what efforts by the clinician have been made to resolve missed visits?"
- SOM (p.58): "Does the patient/caregiver know the visit schedule of the clinician and are visits made as scheduled. If home visits are missed does the patient/caregiver know why and are they able to easily contact the hospice if a need arises?"
- OIG (S10, p.9): "one hospice did not provide nurse visits for two consecutive weeks despite a beneficiary's care plan ordering weekly nurse visits."

**On-call and who to call**
- 418.100(c)(2): "Nursing services, physician services, and drugs and biologicals ... must be made routinely available on a 24-hour basis 7 days a week."
- S2 PFC 1.1: timely response to calls "twenty-four (24) hours a day, seven (7) days a week." PFC 1.5 practice examples: "Patients and families receive written information at the time of admission regarding how and when to access care after regular business hours. All team members regularly reinforce this information throughout the course of care."
- SOM (p.35) caregiver probe: "When you call with an urgent need, how long does it take for someone from the hospice team to respond?"
- AHRQ Tool 7 (S9): after-hours message should give a coverage number; "Say the phone number twice, slowly, so patients can write the number down." Primary-care advice, transferable.

**Last days**
- SOM (p.23): "Review the record to confirm that the agency was responsive and available to provide care and services in the last three days of life. Examples ... 1) no visits made in the last week of life; 2) missed visits in the last week of life; 3) pain and symptom management not addressed; or 4) hospice not addressing patient's or caregivers' concerns."
- HVLDL (S7, CBE #3645), a quality measure not a CoP: "in-person visits from a registered nurse or medical social worker on at least two out of the final three days of the patient's life."

**Agency policy (S16, one agency):** "one routine visit weekly, at a minimum"; every 14 days only "rare occasions" after supervisor discussion; "All patients are given PRN x4 for Exacerbation of Disease Process"; "All Patients should receive a follow-up visit or phone call within 24-48 hours of admission"; new or changed pain regimen "should have follow-up documentation within 24 hours."

### C3. Reassessment after an intervention: what exists (S1, S2, S5, S6, S7, S11-S14)

**No source gives a universal hospice interval.**
- S1 2.2.4 "timely"; S1 7.3.1 frequency set by agency policy.
- S2 PFC 6.2: "Reassessment is performed during any contact by hospice interdisciplinary team members with the patient and/or family/caregiver." Practice examples: "Specific protocols/procedures are in place for reassessing patients who rate their pain greater than the identified level the patient desires"; nurse "documents assessments of the patient's pain, related interventions, and outcomes for each visit." CES 2.8: "Regular assessment of the current pain medication regimen and supply is made in order to quickly optimize pain control and avoid interruption or delay in ordering or obtaining any required analgesics."
- SOM (pp.53-54, SNF/NF section): plans include "Time frames and approaches for monitoring the status of the patient's pain, including the effectiveness of the interventions" and "Whether the pain has been reassessed and the plan of care revised as necessary if the current interventions are not effective..." SOM (p.35) staff probe: "How does the hospice monitor a patient when they begin a new medication, increase/decrease a dosage, or discontinue a medication?"
- HPNA/ASPMN (S13): "Pain assessment at the end of life must be thorough, ongoing, and evidence-based." WHO (S12, p.23): "Assessment and re-assessment at regular intervals are key..." Neither gives a number.

**Intervals that are sourced**
1. **CMS HOPE Symptom Follow-up Visit (S6, 1.3.3 p.10; J2052 pp.74-75).** "The SFV is an in-person visit expected within two calendar days as a follow-up for any pain or non-pain symptom impact rated as moderate or severe" at Admission or a HOPE Update Visit (HUV1 days 6-15, HUV2 days 16-30). Separate visit; RN or LPN/LVN; up to three per stay. Not-done reasons coded: declined, unavailable, contact attempts unsuccessful, none. This is a quality-reporting rule, not a CoP.
2. **NCCN v3.2019 (S11).** "Assessment of efficacy and adverse effects should be performed every 60 minutes for orally administered opioids and every 15 minutes for intravenous opioids to determine a subsequent dose." Scope: initiating short-acting opioids in opioid-naive patients with pain >=4; a titration protocol. **v2.2025 dropped those intervals:** "Pain should be reassessed regularly and the dose titrated further as needed"; "Methadone should not be titrated more frequently than every 5 to 7 days." WHO: methadone "titrate the regular dose upwards once a week."
3. **Wounds.** HPNA: "perform a wound assessment on admission, weekly, and if the patient's condition deteriorates"; "If healing potential is questionable, consider a two- to four-week 'intent to treat' trial"; if non-healable, "symptom management should always take priority over painful procedures." AAWC 2010: "Measure ulcer and document overall progress weekly, or sooner if there is a significant change"; "If no significant reduction in wound area after 2-4 weeks ... re-evaluate diagnosis and/or care plan." Trap: AAWC "Hospice Care: Reassess weekly for 4 weeks, then monthly" (I.A.5.d) is pressure-ulcer RISK assessment, not wound recheck.
4. **HCI "Gaps in Skilled Nursing Visits" (S7 manual pp.22-23):** share of stays of 30+ days with "at least one gap between nursing visits exceeding 7 days." Quality indicator, not a rule.

### C4. Teaching, teach-back, orders, supplies, DME (S1, S2, S4, S5, S8, S9, S20)

- 418.56(b): "The hospice must ensure that each patient and the primary care giver(s) receive education and training provided by the hospice as appropriate to their responsibilities for the care and services identified in the plan of care."
- 418.56(c)(4)-(6): plan includes "Drugs and treatment necessary...", "Medical supplies and appliances necessary...", and documentation of "the patient's or representative's level of understanding, involvement, and agreement with the plan of care ... in the clinical record." S2 PFC 4.4 repeats the last.
- 418.106(d)(1): at plan review the IDG "must determine the ability of the patient and/or family to safely self-administer drugs and biologicals." 418.106(e)(2)(i): at first controlled-drug order, discuss the written policy "in a language and manner that they understand" and "Document in the patient's clinical record that the written policies and procedures ... was provided and discussed."
- 418.106(f)(2): "The patient, family, and/or caregiver must be able to demonstrate the appropriate use of durable medical equipment to the satisfaction of the hospice staff." Only CoP text requiring demonstration. 418.64(d) is counseling (bereavement, dietary, spiritual), NOT caregiver teaching; do not cite it for teach-back.
- SOM (p.34) probes: "Determining if written instructions were provided to the patient or caregiver"; "If equipment, supplies, and assistive devices were indicated in the plan of care, determining if the patient received the items timely." SOM (p.58): "The clinical record should reflect the education and counseling provided by skilled professionals to the patient, caregiver, and family."
- S2 PFC 4.2 item 5: plan includes "Medications, medical equipment, and supplies necessary to meet the needs of the patient"; PFC 13.2: caregiver capability "regularly evaluated." S3 p.4 lists "Education to be provided" and "Medications, supplies, DME" among interventions.
- **AHRQ Tool 5 (S9):** teach-back is "asking patients to state in their own words what they need to know or do about their health." "'Do you understand?' and 'Does that make sense?' are NOT teach-back questions." "'Chunk and Check.' Do not wait until the end of the visit to initiate teach-back." "If teach-back uncovers a misunderstanding, explain things using a different approach, and ask patients to teach-back again." Show-me method for doses and devices. Example: "If you will tell me back the plan we've made, I'll type it up and send it home with you." **Tool 6:** follow-up is "making contact with patients or their caregivers at a later, specified date"; "Ask patients how they would like to be contacted."
- CAHPS single item (S8 p.17): "Did the hospice team teach you how to care for your family member?" (framed as pain medicine, trouble breathing, restlessness, other care needs).
- EVIDENCE (S20): one-agency, non-randomized pre/post QI project of teach-back in hospice home visits: caregiver "confidence" 58% to 81%; hospitalizations 0 vs 2 (0% vs 1.97%). Weak evidence.
- Teach-back is not named in the CoP, NHPCO standards or NCP.

### C5. End-of-note "plan" in practice (S2, S15-S19)

There is no federal or professional standard for the layout of the end-of-note plan. MAC tip sheets (S19) are payment and eligibility oriented: CGS J15 asks only "Did the IDG review the POC as the patient's condition requires but no less frequently than every 15 days?" and "Does the Plan of Care identify treatment goals and coordination of services..."; NGS lists "Plan of Care (Physician and IDT)" and "Nursing Notes" as ADR items. Content lists that do exist:
- **S2 WE 14.1 (item 8):** nurse documents "nursing assessments, identified problems, measurable goals of care, limitations to provision of care, care interventions, and response to care."
- **S16 (agency):** care-plan interventions include "Assess/teach safe administrations of scheduled and PRN medications." Admission checklist: "make sure they have our phone numbers and they know when to call." Discharge: "education related to medications, what to do in the event that patient worsens, who to" call. Level-of-care change: notify physician, DME, pharmacy; update visit frequency orders.
- **S17 (ACHC):** items "on every note" include education and "Review of medications and response for symptom management"; sample note ends "Pt verbalized understanding of above education along with his wife who is his primary caregiver."
- **S18 (ADPH, home health):** "Essential Elements in Documentation": "MD / multi-discipline contact; ... Description of patients response to treatment; Progress towards goals; Plan for next visit; ... Teaching content / who was taught / response to teaching."
- **S15 (NHPCO):** "Document all care plan updates! Voicemails to IDG members of plan of care changes are usually not recorded in the clinical record."

### C6. Continuity, scheduling, family experience (S1, S4, S5, S8, S21-S23)

- **Named RN:** 418.56(a)(1): the hospice "must designate a registered nurse that is a member of the interdisciplinary group to provide coordination of care and to ensure continuous assessment of each patient's and family's needs and implementation of the interdisciplinary plan of care." SOM (p.34): the RN "serves as the liaison between the patient and the IDG"; the role may be titled "case manager." NCP 1.4 and 1.7 do not say "same nurse."
- **AAHPM (S23), proposal for outpatient APCM-style codes:** "Continuity of care with a designated member of the care team with whom the patient is able to schedule successive routine appointments." A comment letter, not a hospice guideline.
- **Qualitative evidence only:** S22: "Continuity, accessibility and consistency in contact between patients, carers and key medical and social care professionals were clearly expressed as vital by both carers and patients." S21 (23 bereaved carers): "they were always prompt, they always rang before they came. And if they were running late, they rang."
- **CAHPS Hospice (S8 p.17; revised survey from Q2 2025 decedents).** Communication with Family: "How often did the hospice team let you know when they would arrive to care for your family member?"; "...explain things in a way that was easy to understand?"; "...keep you informed about your family member's condition?" Getting Timely Help: "...how often did you get help as soon as you needed it?"; "How often did you get the help you needed from the hospice team during evenings, weekends, or holidays?" None asks about "the plan" directly; they are proxies for plan clarity.
- **SOM (p.35) probes mirror CAHPS:** "How does the hospice team keep you informed about when they will arrive to care for you?"; "When there is an unexpected delay or re-scheduling of a visit, how does the hospice notify you?"
- Preferred visit or contact times: no standard found; only AHRQ Tool 6 and the S3 call-after-each-visit example.

### C7. Disagreements between sources
1. RN cadence: CoP none (aide supervision 14 days); NHPCO "scrutiny" at 14+ days; CMS HCI flags gaps over 7 days in 30+ day stays; Mountain Valley weekly. Four different instruments (rule, practice note, measure, agency policy).
2. NCCN 2019 gives 60/15-minute reassessment; NCCN 2025 says "regularly." Cite the version.
3. NCP 7.3.1 leaves reassessment frequency to agency policy; CMS HOPE fixes a 2-calendar-day SFV for moderate or severe symptom impact.

---

### C8a. Items that look strongly supported (multiple independent sources; detail in sections above)
1. Plan of care sets scope and frequency of visits; visits must match; deviations documented with reason (CFR, SOM, NHPCO S2/S3/S15, OIG).
2. Plan reviewed at least every 15 days and as condition requires; reassessment at every contact (CFR, S2, S3, CGS, NCP).
3. Education tied to the plan, with documented understanding or agreement (CFR, S2, NCP, SOM, CAHPS).
4. 24/7 access, with written after-hours instructions at admission, reinforced (CFR, S2, NCP, SOM, CAHPS, AHRQ).
5. Symptom reassessment after an intervention is expected, with no universal interval (NCP, S2, SOM, HPNA/ASPMN, WHO).
6. Medications, supplies, DME are plan elements and the family's ability to use them is checked (CFR, NCP, S2).
7. Named RN coordinator (CFR, S2, SOM, MLN).
8. Last days: frequent contact and visits; family expectations about availability set in advance (NCP, SOM, HVLDL).
9. Tell the family when the team will arrive; document missed visits with reason, efforts and what the family was told (CAHPS, SOM, OIG, S15, S21).
10. Wound recheck weekly with a 2-4 week re-evaluation point (HPNA and AAWC; AAWC is 2010).

### C8b. Single-sourced or opinion only
- HOPE SFV within 2 calendar days (one CMS manual; quality-reporting scope).
- NCCN 60/15-minute intervals (2019 only; titration context; reworded 2025).
- HCI nursing gap over 7 days (one CMS measure spec).
- NHPCO "14 days or more draws scrutiny" (one Primer FAQ).
- Mountain Valley weekly minimum, PRN x4, 24-48 hour admission and 24-hour pain follow-up (one agency).
- AAHPM designated team member and patient-friendly care-plan copy (one outpatient proposal).
- Teach-back in hospice (one non-randomized QI project).
- ACHC "every note" list; ADPH "plan for next visit" (slides; ADPH is home health).
- Family-reported continuity and "rang before they came" (small qualitative samples).

### C8c. Things people assume that I could NOT source
- **Universal minimum visit frequency by acuity.** None. CoP: only aide supervision every 14 days; SOM allows ranges (no "0"); NHPCO: "not a prescriptive visit frequency."
- **"Reassess pain within 1 hour."** Only NCCN 2019 (oral short-acting opioid titration, opioid-naive, pain >=4), dropped in 2025. NCP, NHPCO, SOM, WHO, HPNA give no number. Nearest hospice interval: HOPE 2-calendar-day SFV.
- **A rule for a call within 24 hours of a medication change.** Agency policy only.
- **A requirement that each note record the next visit date.** None found; the plan of care carries frequency, and SOM probes ask whether the family knows the schedule and is told of changes.
- **Teach-back mandated for hospice.** Not in CoP, NHPCO or NCP. 418.56(c)(6) requires documented understanding; 418.106(f)(2) requires DME demonstration.
- **A required "when to call / escalation" block in each note.** NCP 7.3.5 and S2 PFC 1.5 cover it at program level only.
- **CAHPS items measuring "plan clarity."** None; only proxies.
- **Outcome evidence that a named or consistent nurse improves results.** None found.
- **Standards on patient-preferred visit times.** None.
- **WOCN interval, Palmetto tips, HPNA competencies, AAHPM continuity statement.** Not retrieved or not found.

## 5. What the product does with this

Everything below is advisory. Nothing reads the finalize or sign gate, nothing blocks a note, the section stays required, and the
server's assembled note, the gate and the corpus version are unchanged (no migration, no new route, no `VOCAB_VERSION` change).

| Piece | Basis | Behaviour |
|---|---|---|
| **What this section covers** (`next-visit/plan-entry-guide.ts`) | Parts B and C | Nine short items, each labelled Medicare rule, CMS guidance, Guideline or Common practice with its citation. The next-visit item is labelled Common practice and says no rule requires it in each note. |
| **Next visit and schedule** (`next-visit-schedule.tsx`, `next-visit-model.ts`) | Findings 1 and 2; M7 spec; M17 spec D5 | Reads the patient's upcoming visits (`GET /api/v1/visits?patient=&from=&to=`, 30 days, `visit.read`, scoped by the server) and the plan of care (`GET /api/v1/patients/{id}/care-plan`). Shows the plan's ordered visit frequency for the note's discipline in the plan's own words, and flags "No RN visit is scheduled in the next 30 days that you can see" or "N visits scheduled in the next D days; the plan of care orders ...". A refused or failed read says so and never reads as an empty schedule. |
| **Schedule next visit** | M17 permission matrix; existing `/calendar?patient=&newVisit=1` link | A link, opened in a new tab so the note and anything unsaved stay put, to the Scheduling calendar with the New Visit form open for this patient, started on the discipline's routine visit purpose and, when the plan orders a readable frequency, the day it implies. The scheduler's own form still checks eligibility, credentials, caseload and time off; the note books nothing. Someone with `visit.read` but not `visit.create` gets "Open this patient's schedule" instead. |
| **Follow-ups from this visit** | M7 plan-of-care step (WF09) | The count of this visit's open plan-of-care proposals (drafts and pending) with a button to the Plan of care step, and the pain helper's plan-of-care review prompt when the note records pain. |
| **Write the entry (optional)** (`plan-entry-text.ts`) | Finding 3; the "candidate plan elements" in C5 | Next visit by and date, focus, follow-ups, orders and supplies pending, teaching and instructions given, "call the hospice if". **Add to the note** puts the filled fields into the section's free text as fixed sentences, each field's words exactly as typed, below what the clinician wrote; adding the same lines twice adds nothing. The free text is stored and stated verbatim by the server, so the note, preview and gate need no change. |

**Rules and approximations in the schedule check (for the clinical reviewer).**

1. Counted as upcoming: committed visits (status `published` or `en_route`, the repo's own "next visit" meaning in
   `apps/backend/src/modules/17-scheduling/seams/store.ts`) starting at or after the moment the section was first opened, leaving out the
   note's own visit. Visits of other disciplines are listed but not counted.
2. The ordered frequency is the most frequent active intervention of the note's discipline whose machine form is
   `count:visit:day|week|month`. M17's proposal worker likewise treats each cadenced visit intervention as a visit order. Nursing is one
   group (RN and LPN), as is physician (MD, DO, NP); this grouping is a product judgement, not a source.
3. A weekly order is met by that many scheduled visits in the next 7 days (the last day included), a daily order by 7, a monthly one by its
   count in the next 30 (M17 uses the same nominal 30-day month; NHPCO notes "1 x per month" has no standard meaning and suggests days or
   weeks). A rolling window is an approximation of "per week": it is a prompt to look at the schedule, not a compliance finding.
4. An order the check cannot read as a visit cadence is shown in the plan's words and never counted: as-needed, per-episode, a range
   ("1-3 visits/week", which the SOM allows at L547) or free text. The care-plan route does not enforce the machine form (it only requires a
   non-empty string), so the reader must tolerate anything.
5. The suggested day is the visit date plus `round(span / count)` days (at least one), the spacing M17's proposal worker uses. No day is
   suggested without a readable order.
6. Times are shown in the browser's time zone; the organisation's time zone is not shown (an existing M17 limitation).

**Overlap to know about.** With the tenant's draft wording on, the RN routine, recert and admission `plan` sections can also offer the
statement "Next visit is planned for ${next_visit_date}" (`nv.plan.next_visit`). The panel's "Next visit:" sentence and that statement can
both be in a note; no de-duplication was built.

## 6. Not built, and why

| Not built | Reason |
|---|---|
| A minimum visit frequency by acuity, or a visit duration field | No source (Findings 1 and 3). |
| A next-visit date required in each note | No source requires it (Finding 3); the section's required status is unchanged. |
| A last-days-of-life visit expectation | No rule sets one; the SIA is a payment add-on and HVLDL a quality measure; the repo's SIA computation (`packages/billing/src/sia`) is retrospective, so there is no prospective tracker to read. |
| A pain-reassessment interval | No hospice source gives one (Finding 5). The pain helper owns the pain prompts. |
| A wound-recheck prompt computed from wound records | The weekly interval is sourced (HPNA, AAWC) and is in the guide; computing "due" needs the wound module's records and is the wounds panel's concern. |
| The aide's 14-day supervisory visit due date | M15 exposes it per discipline plan (`/api/v1/discipline-plans/{planId}/aide-supervision-roster`); the note does not hold that plan id. The 14-day rule is in the guide. |
| The HOPE symptom follow-up due date | M10's SFV worklist (`GET /api/v1/hope/sfv`) is org-wide and has its own permission; the guide states the two-day expectation and a scheduled SFV appears in the upcoming list. |
| A server-stated "next scheduled visit" sentence in the assembled note | It needs an assembly input from M17 and a corpus change (a `VOCAB_VERSION` bump, which blocks in-progress drafts); owned elsewhere. |
| Booking a visit from the note | It needs `visit.create` and M17's gates (credential, discipline, caseload, time off, idempotency); the scheduler's form owns them. |
| Capturing a missed-visit reason in the note | The CFR is silent and the SOM only probes; M17 records cancellation reasons on the visit. |

## 7. Sign-off

Signed off by Lora, RN on 2026-11-25 (section 3 of the clinical sign-off sheet, with sections 1-6, not item by item). The points put to the reviewer: the nine guide items and which label each carries; the schedule rules above (rolling window,
RN-plus-LPN nursing group, most-frequent-order rule, 30-day month); the sentence forms ("Next visit: RN, Dec 5, 2026.", "Call the
hospice if: ...") as legal-record wording; and whether "Teaching and instructions given" should invite teach-back wording (it is AHRQ
guidance for primary care, not a hospice requirement). No compliance control changed (read-only use of existing endpoints under their own
permissions), so no `compliance/controls.yaml` row is proposed.

