#!/usr/bin/env python3
"""
DocLens complex referral packet — synthetic fixture generator (F-238).

Renders a ~32-page faxed hospice referral for ONE fictional complex patient (Arthur DOCLENS, 85M:
end-stage heart failure with COPD, CKD 4, Alzheimer's dementia, T2DM, AFib, alcohol dependence in
remission) as a fax-like image PDF, plus an ANSWER KEY (JSON) that later DocLens stages are scored
against: document boundaries (the fax splitter), every diagnosis mention with its page (mention
extraction), the coding problems deliberately planted (rule checks), negated findings, 42 CFR Part 2
content, and the prognosis evidence the packet does and does not contain.

EVERYTHING HERE IS FICTIONAL. No real patient, clinician, facility, MBI or phone number. Facility and
clinician names are invented; phone numbers use the 555-01xx fictional range.

THE PLANTED PROBLEMS (each is scored by the key's `expectedFlags`):
  • I42.0 written on 10/01/2026 — retired as a billable code on that very day (FY2027); valid on the
    09/22 cardiology consult that also uses it. Maps to I42.00/I42.01/I42.09.
  • "Hypertension (I10)" in a patient with heart failure AND CKD — ICD-10-CM presumes the link
    (Guidelines I.C.9.a.3): the combination code I13.0 applies, and the cardiology consult uses it.
  • "Type 2 diabetes mellitus (E11.9)" while CKD 4 is documented — "with" presumes the link
    (I.A.15): E11.22 is the specific code.
  • Debility (R53.81) as PRIMARY and adult failure to thrive (R62.7) on the SNF transfer form — CMS
    does not accept either as the hospice principal diagnosis.
  • F02.80 / F02.B0 (dementia "in other diseases classified elsewhere") — manifestation codes, never
    first; must follow G30.-.
  • Alzheimer's coded G30.9 (unspecified) in the discharge summary vs G30.1 (late onset) by neurology;
    "unspecified dementia" F03.90 on the SNF form vs Alzheimer's elsewhere — a conflict, not a choice.
  • Acute-on-chronic HF (I50.23) is the hospital stay's principal; at hospice admission the chronic
    picture (I50.22 + I50.84 end stage) applies.
  • Pneumonia (J18.9) — RESOLVED during the stay; must not be proposed as active.
  • "No evidence of pulmonary embolism", "no evidence of malignancy", "denies chest pain" — negations.
  • Alcohol dependence in remission (F10.21), "attended AA" — 42 CFR Part 2.
  • The echo report page is faxed twice (a duplicate page, not a second echo).
  • Dementia FAST 6d (not 7) — the packet does NOT support dementia as the terminal diagnosis.

Usage:  services/docling-worker/.venv/bin/python scripts/doclens/make-complex-packet.py <out-dir>
        → <out-dir>/complex-referral-packet.pdf and <out-dir>/complex-referral-packet.key.json
Deterministic: same input → byte-identical PDF (fixed RNG seed, no timestamps in the PDF metadata).
"""
from __future__ import annotations

import json
import random
import sys
import textwrap
from dataclasses import dataclass, field
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

W, H = 1700, 2200  # 8.5 x 11 in @ 200 dpi
MARGIN_X, TOP, BOTTOM = 120, 190, 150
LINE = 40
WRAP = 92
FAX_DATE = "10/02/2026"
FAX_FROM = "RIVERSIDE GEN CM  (503)555-0199"

PATIENT = "DOCLENS, ARTHUR"
MRN = "RGH-448812"
DOB = "03/02/1941"


def font(name: str, size: int) -> ImageFont.FreeTypeFont:
    for path in (f"/System/Library/Fonts/Supplemental/{name}.ttf", f"/usr/share/fonts/truetype/msttcorefonts/{name}.ttf"):
        try:
            return ImageFont.truetype(path, size)
        except OSError:
            continue
    return ImageFont.load_default()


MONO = font("Courier New", 26)
MONO_B = font("Courier New Bold", 28)
SANS = font("Arial", 27)
SANS_B = font("Arial Bold", 34)
HDR = font("Courier New", 22)


@dataclass
class Doc:
    id: str
    type: str  # DocLens document type (packages/intake-extraction registry)
    title: str
    source: str
    date: str
    header: list[str]
    body: list[str]
    face: str = "mono"  # "mono" (typed note) | "sans" (form)
    skew: float = 0.0
    duplicate_of: str | None = None
    pages: list[list[str]] = field(default_factory=list)


def wrap(lines: list[str]) -> list[str]:
    out: list[str] = []
    for ln in lines:
        if not ln.strip():
            out.append("")
            continue
        indent = len(ln) - len(ln.lstrip())
        out.extend(textwrap.wrap(ln, WRAP, subsequent_indent=" " * (indent + 2), break_long_words=False) or [""])
    return out


CONT = lambda d, n, total: f"{PATIENT}  MRN {MRN}  -  {d.title}  -  Page {n} of {total}"  # noqa: E731


def paginate(d: Doc) -> None:
    per_page = (H - TOP - BOTTOM) // LINE
    body = wrap(d.body)
    first_cap = per_page - len(d.header) - 1
    chunks = [body[:first_cap]]
    rest = body[first_cap:]
    while rest:
        chunks.append(rest[: per_page - 2])
        rest = rest[per_page - 2 :]
    total = len(chunks)
    d.pages = []
    for i, chunk in enumerate(chunks):
        lines = (d.header + [""] + chunk) if i == 0 else ([CONT(d, i + 1, total), ""] + chunk)
        if i == 0 and total > 1:
            lines = lines + ["", f"(continued - page 1 of {total})"]
        d.pages.append(lines)


# ─────────────────────────────── the documents ───────────────────────────────

RGH = "RIVERSIDE GENERAL HOSPITAL  -  1400 Harbor Blvd, Salem OR 97301"
PT = f"Patient: {PATIENT}   MRN: {MRN}   DOB: {DOB}   Sex: M"

DOCS: list[Doc] = [
    Doc("cover", "transfer_record", "Fax cover sheet", "Riverside General - Case Management", "10/02/2026",
        ["RIVERSIDE GENERAL HOSPITAL - CASE MANAGEMENT", "FACSIMILE TRANSMITTAL"],
        [
            f"Date: {FAX_DATE}", "To: Engrace Hospice - Intake   Fax: (503) 555-0100",
            "From: Dana Whitfield, RN, Case Manager   Phone: (503) 555-0198",
            "Pages (including cover): see page count on header", "",
            f"RE: HOSPICE REFERRAL - {PATIENT}, DOB {DOB}", "",
            "Enclosed: referral form, face sheet, discharge summary, H&P, cardiology consult,",
            "echocardiogram, labs, imaging, palliative care consult, SNF transfer form, wound and",
            "nutrition notes, nursing assessment, outside pulmonology and memory clinic records,",
            "medication list and POLST.", "",
            "Patient discharges today; family requests hospice admission at home tomorrow.", "",
            "CONFIDENTIALITY NOTICE: This facsimile contains protected health information. Records",
            "in this transmission may include information protected by 42 CFR Part 2. If you received",
            "this in error, notify the sender and destroy all copies.",
        ], face="sans"),
    Doc("referral", "transfer_record", "Hospice Referral", "Riverside General - Case Management", "10/01/2026",
        ["RIVERSIDE GENERAL HOSPITAL", "HOSPICE REFERRAL FORM", PT],
        [
            "Referral date: 10/01/2026     Requested start of care: 10/03/2026",
            "Referring physician: Priya Raman, MD (Hospitalist)   NPI on file",
            "Attending / PCP after discharge: Lena Okafor, MD",
            "Address: 1220 Alder St, Salem, OR 97301   Phone: (503) 555-0161",
            "Primary caregiver / HCPOA: Ruth Doclens (daughter)  (503) 555-0162",
            "Insurance: Medicare Part A/B (traditional)", "",
            "Hospice diagnosis: End-stage heart failure",
            "Other conditions: COPD on home oxygen; chronic kidney disease stage 4; Alzheimer's",
            "dementia; type 2 diabetes; atrial fibrillation; pressure injury sacrum.", "",
            "Code status: DNR / DNI (POLST attached)",
            "Prognosis per attending: less than 6 months if disease follows its expected course.",
            "Equipment needs: hospital bed, oxygen concentrator 2 L/min, wheelchair.",
        ], face="sans"),
    Doc("facesheet", "transfer_record", "Face Sheet", "Riverside General - Registration", "09/17/2026",
        ["RIVERSIDE GENERAL HOSPITAL", "INPATIENT FACE SHEET", PT],
        [
            "Admission: 09/17/2026 21:40   Unit: 4 West Telemetry   Account: 70045512",
            "Attending: Priya Raman, MD    Admitting dx (ED): Shortness of breath",
            "Address: 1220 Alder St, Salem, OR 97301", "Home phone: (503) 555-0161",
            "Emergency contact: Ruth Doclens (daughter)  (503) 555-0162",
            "Primary payer: Medicare Part A   Secondary: none",
            "Religion: Methodist    Language: English    Marital status: Widowed",
        ], face="sans"),
    Doc("ds", "discharge_summary", "Discharge Summary", "Riverside General - Hospital Medicine", "10/01/2026",
        [RGH, "DISCHARGE SUMMARY", PT,
         "Admitted: 09/17/2026   Discharged: 10/01/2026   Attending: Priya Raman, MD"],
        [
            "DISCHARGE DIAGNOSES",
            "Principal diagnosis:",
            "  1. Acute on chronic systolic congestive heart failure (I50.23)",
            "Secondary diagnoses:",
            "  2. Dilated cardiomyopathy, EF 15% (I42.0)",
            "  3. Hypertension (I10)",
            "  4. Chronic kidney disease, stage 4 (N18.4)",
            "  5. Chronic obstructive pulmonary disease (J44.9)",
            "  6. Type 2 diabetes mellitus (E11.9)",
            "  7. Permanent atrial fibrillation (I48.21)",
            "  8. Alzheimer's dementia (G30.9, F02.80)",
            "  9. Anemia of chronic kidney disease (D63.1)",
            "  10. Community-acquired pneumonia, right lower lobe - resolved (J18.9)",
            "  11. Alcohol use disorder, in sustained remission (F10.21)",
            "  12. Moderate protein-calorie malnutrition (E44.0)",
            "  13. Pressure injury of sacrum, stage 2 (L89.152)",
            "",
            "HOSPITAL COURSE",
            "Mr. Doclens is an 85-year-old man with non-ischemic dilated cardiomyopathy and chronic",
            "systolic heart failure, admitted 09/17 with acute on chronic decompensated heart failure,",
            "his fourth heart failure hospitalization in six months. He was diuresed with IV",
            "furosemide with limited response; diuresis was complicated by acute kidney injury on",
            "CKD stage 4 (creatinine 2.4 baseline, peak 3.1). Guideline-directed medical therapy could",
            "not be up-titrated because of symptomatic hypotension (SBP 82-90) and renal function;",
            "sacubitril/valsartan and spironolactone were stopped.",
            "",
            "On hospital day 2 he developed fever and a right lower lobe infiltrate. CT angiogram",
            "showed no evidence of pulmonary embolism and right lower lobe consolidation. He completed",
            "a course of ceftriaxone and azithromycin; the pneumonia resolved clinically and",
            "radiographically by 09/26.",
            "",
            "Cardiology (Dr. Hamid Sousa) saw him 09/22: stage D heart failure, NYHA class IV",
            "symptoms at rest, not a candidate for advanced therapies (LVAD or transplant). His ICD",
            "was deactivated on 09/28 per the patient's and family's wishes.",
            "",
            "Palliative care was consulted 09/25. In a family meeting the patient, who has moderate",
            "Alzheimer's dementia with fluctuating capacity, and his daughter (health care power of",
            "attorney) chose comfort-focused care and hospice at home. Code status changed to DNR/DNI.",
            "",
            "PROGNOSTIC INDICATORS AT DISCHARGE",
            "  NYHA class IV symptoms at rest despite maximally tolerated therapy.",
            "  LVEF 15% (echo 09/19/2026).",
            "  Four heart failure admissions in the last 6 months.",
            "  Palliative Performance Scale 30%.",
            "  Weight 61.0 kg, down from 70.0 kg in March 2026 (12.9% in 6 months).",
            "  Serum albumin 2.6 g/dL.",
            "",
            "PERTINENT RESULTS",
            "  BNP 4,820 pg/mL on admission, 3,950 pg/mL on 09/30.",
            "  Creatinine 3.1 mg/dL, eGFR 18 mL/min/1.73m2, sodium 129 mmol/L.",
            "  Hemoglobin 9.8 g/dL.",
            "  CT chest: no suspicious nodule or mass; no evidence of malignancy.",
            "",
            "CONDITION AT DISCHARGE",
            "Dyspnea with minimal exertion, oriented to person only, bed to chair with two-person",
            "assist, eating less than 50% of meals. Sacral pressure injury stage 2, dressing per",
            "wound care. No chest pain.",
            "",
            "DISCHARGE MEDICATIONS",
            "  1. Furosemide 80 mg PO twice daily",
            "  2. Metoprolol succinate 25 mg PO daily",
            "  3. Apixaban 2.5 mg PO twice daily",
            "  4. Morphine sulfate oral solution 20 mg/mL, 2.5 mg SL every 2 hours PRN dyspnea",
            "  5. Lorazepam 0.5 mg SL every 6 hours PRN anxiety",
            "  6. Donepezil 5 mg PO at bedtime",
            "  7. Tiotropium 18 mcg inhaled daily",
            "  8. Albuterol 2.5 mg nebulized every 4 hours PRN wheeze",
            "  9. Senna 8.6 mg PO at bedtime",
            "STOPPED: sacubitril/valsartan, spironolactone, insulin glargine (hypoglycemia).",
            "",
            "ALLERGIES: Lisinopril (angioedema); sulfa antibiotics (rash).",
            "",
            "DISPOSITION: Home with hospice. Oxygen 2 L/min continuous.",
            "CODE STATUS: DNR/DNI.",
            "",
            "Electronically signed: Priya Raman, MD  10/01/2026 15:12",
        ]),
    Doc("hp", "hp", "History and Physical", "Riverside General - Hospital Medicine", "09/17/2026",
        [RGH, "HISTORY AND PHYSICAL", PT, "Date of service: 09/17/2026   Author: Priya Raman, MD"],
        [
            "CHIEF COMPLAINT: Shortness of breath and leg swelling for one week.",
            "",
            "HISTORY OF PRESENT ILLNESS",
            "85-year-old man with heart failure with reduced ejection fraction from non-ischemic",
            "dilated cardiomyopathy, presenting with worsening orthopnea, 6 kg weight gain and",
            "bilateral leg edema despite home furosemide. He sleeps upright in a recliner. He denies",
            "chest pain. Daughter reports increasing confusion over the last three days and poor",
            "oral intake for a month.",
            "",
            "PAST MEDICAL HISTORY",
            "  - HFrEF / dilated cardiomyopathy, EF 15-20% (echo 03/2026), ICD in place",
            "  - Hypertension",
            "  - Chronic kidney disease stage 4, baseline creatinine 2.4",
            "  - COPD, on 2 L home oxygen since 2024",
            "  - Type 2 diabetes mellitus, last A1c 6.9%",
            "  - Atrial fibrillation, permanent, on apixaban",
            "  - Alzheimer's dementia, followed by memory clinic",
            "  - Alcohol dependence, in remission since 2015",
            "  - History of prostate biopsy 2019, benign; no history of cancer",
            "  - Cholecystectomy 1998",
            "",
            "SOCIAL HISTORY",
            "Widowed, lives with daughter. Former smoker, 60 pack-years, quit 2010. History of",
            "alcohol dependence; sober since 2015, attended AA for several years. No illicit drugs.",
            "",
            "FAMILY HISTORY: Father died of myocardial infarction at 70.",
            "",
            "REVIEW OF SYSTEMS",
            "Positive for dyspnea, orthopnea, edema, fatigue, anorexia. Denies chest pain, syncope,",
            "fever, hematuria. Negative for melena.",
            "",
            "PHYSICAL EXAM",
            "BP 94/58, HR 88 irregular, RR 26, SpO2 89% on 2 L, T 37.2 C, weight 64.2 kg.",
            "Frail, tachypneic, oriented to person only. JVP to the angle of the jaw. Bibasilar",
            "crackles, prolonged expiration. Irregular rhythm, S3. Abdomen soft. 3+ pitting edema",
            "to the knees. Skin: 2 cm open area over sacrum.",
            "",
            "ASSESSMENT AND PLAN",
            "1. Acute on chronic systolic heart failure exacerbation - IV furosemide, strict I/O,",
            "   cardiology consult.",
            "2. Acute kidney injury on CKD stage 4 - monitor creatinine with diuresis.",
            "3. Possible right lower lobe pneumonia - blood cultures, start ceftriaxone/azithromycin.",
            "4. Rule out pulmonary embolism - CT angiogram chest.",
            "5. Acute encephalopathy superimposed on Alzheimer's dementia - delirium precautions.",
            "6. COPD - continue tiotropium, nebulizers PRN.",
            "7. Atrial fibrillation - rate control, continue apixaban (renally dosed).",
            "8. Type 2 diabetes - hold insulin glargine given poor intake; sliding scale.",
            "9. Sacral wound - wound care consult.",
            "10. Goals of care - palliative care consult; patient full code on admission.",
        ]),
    Doc("cardio", "consult", "Cardiology Consultation", "Riverside Heart Associates", "09/22/2026",
        ["RIVERSIDE HEART ASSOCIATES - INPATIENT CONSULTATION", "CARDIOLOGY CONSULT NOTE", PT,
         "Date: 09/22/2026   Consultant: Hamid Sousa, MD   Requested by: Priya Raman, MD"],
        [
            "REASON FOR CONSULT: Advanced heart failure, candidacy for further therapy.",
            "",
            "HISTORY: Non-ischemic dilated cardiomyopathy diagnosed 2017. Progressive symptoms over",
            "two years; four heart failure admissions since April 2026. Single-chamber ICD placed",
            "2018 for primary prevention, one appropriate shock in 2023. Intolerant of up-titration",
            "of GDMT because of hypotension and worsening renal function.",
            "",
            "DATA: Echo 09/19/2026 LVEF 15%, severe global hypokinesis, moderate functional mitral",
            "regurgitation, RVSP 58 mmHg. ECG: atrial fibrillation, rate 84, QRS 148 ms (LBBB).",
            "",
            "ASSESSMENT",
            "1. End-stage heart failure with reduced ejection fraction, chronic systolic",
            "   (I50.84, I50.22). ACC/AHA stage D, NYHA class IV symptoms at rest.",
            "2. Non-ischemic dilated cardiomyopathy (I42.0).",
            "3. Hypertensive heart and chronic kidney disease with heart failure, CKD stage 4",
            "   (I13.0, N18.4).",
            "4. Permanent atrial fibrillation, rate controlled (I48.21).",
            "",
            "RECOMMENDATIONS",
            "- Not a candidate for LVAD or heart transplantation given age, CKD 4, frailty and",
            "  dementia. CRT upgrade would not change his trajectory.",
            "- Recommend transition to comfort-focused care; supportive of hospice referral.",
            "- Discussed ICD deactivation with patient and daughter; they wish to proceed.",
            "- Continue low-dose metoprolol succinate and diuretics for symptoms.",
            "",
            "Hamid Sousa, MD - Cardiology   09/22/2026 11:05",
        ]),
    Doc("echo", "imaging", "Echocardiogram Report", "Riverside General - Cardiac Imaging", "09/19/2026",
        [RGH, "TRANSTHORACIC ECHOCARDIOGRAM", PT, "Study date: 09/19/2026   Reading: Hamid Sousa, MD"],
        [
            "Indication: Heart failure exacerbation.",
            "",
            "FINDINGS",
            "Left ventricle: severely dilated (LVIDd 7.1 cm), severe global hypokinesis.",
            "Left ventricular ejection fraction: 15% (biplane).",
            "Right ventricle: moderately reduced systolic function, TAPSE 1.3 cm.",
            "Mitral valve: moderate functional regurgitation.",
            "Estimated RV systolic pressure: 58 mmHg.",
            "Pericardium: no effusion.",
            "",
            "IMPRESSION",
            "1. Severe dilated cardiomyopathy with LVEF 15%.",
            "2. Moderate functional mitral regurgitation; moderate pulmonary hypertension.",
            "3. No change compared with 03/2026 except lower LVEF (previously 20%).",
        ]),
    Doc("labs", "lab", "Laboratory Results", "Riverside General - Laboratory", "09/30/2026",
        [RGH, "LABORATORY RESULTS - CUMULATIVE", PT],
        [
            "Test                     09/17/2026     09/24/2026     09/30/2026    Ref range",
            "BNP (pg/mL)              4,820          4,410          3,950         <100",
            "Sodium (mmol/L)          132            130            129           135-145",
            "Potassium (mmol/L)       4.9            5.2            4.8           3.5-5.1",
            "Creatinine (mg/dL)       2.4            3.1            2.9           0.7-1.3",
            "eGFR (mL/min/1.73m2)     25             18             19            >60",
            "BUN (mg/dL)              58             74             69            8-23",
            "Albumin (g/dL)           2.9            2.7            2.6           3.5-5.0",
            "Hemoglobin (g/dL)        10.4           9.9            9.8           13.5-17.5",
            "WBC (K/uL)               13.8           9.1            7.2           4.0-11.0",
            "Hemoglobin A1c (%)       6.9                                         <5.7",
            "Troponin I (ng/mL)       0.06 / 0.07 / 0.06 (flat)                   <0.04",
            "Procalcitonin (ng/mL)    1.9                           0.2           <0.5",
            "",
            "Blood cultures 09/18/2026: no growth at 5 days.",
            "",
            "Results verified by: Riverside General Laboratory, CLIA on file.",
        ]),
    Doc("ct", "imaging", "CT Angiogram Chest", "Riverside General - Radiology", "09/18/2026",
        [RGH, "CT ANGIOGRAM CHEST WITH CONTRAST", PT, "Exam date: 09/18/2026   Radiologist: Grace Lindqvist, MD"],
        [
            "Clinical history: dyspnea, fever, evaluate for pulmonary embolism.",
            "",
            "FINDINGS: Pulmonary arteries opacify well. Cardiomegaly. Moderate bilateral pleural",
            "effusions. Right lower lobe consolidation with air bronchograms. Centrilobular and",
            "paraseptal emphysema, upper lobe predominant. No suspicious pulmonary nodule.",
            "",
            "IMPRESSION",
            "1. No evidence of pulmonary embolism.",
            "2. Right lower lobe consolidation, consistent with pneumonia in the clinical setting.",
            "3. Cardiomegaly with moderate bilateral pleural effusions.",
            "4. Emphysema.",
            "5. No suspicious pulmonary nodule or mass; no evidence of malignancy.",
        ]),
    Doc("echo_dup", "imaging", "Echocardiogram Report", "Riverside General - Cardiac Imaging", "09/19/2026",
        [], [], duplicate_of="echo"),
    Doc("palliative", "consult", "Palliative Care Consultation", "Riverside General - Palliative Care", "09/25/2026",
        [RGH, "PALLIATIVE CARE CONSULTATION", PT, "Date: 09/25/2026   Consultant: Miriam Tse, MD"],
        [
            "REASON: Goals of care in advanced heart failure.",
            "",
            "SUMMARY: Family meeting with the patient and his daughter Ruth (HCPOA). The patient",
            "said he is \"tired of the hospital\" and wants to be at home. He has fluctuating",
            "capacity; his daughter confirms this is consistent with his long-held values.",
            "",
            "SYMPTOMS: dyspnea at rest (ESAS 7/10), fatigue 8/10, anorexia 7/10, anxiety 5/10.",
            "Pain 2/10, sacral discomfort with repositioning.",
            "",
            "ASSESSMENT",
            "End-stage heart failure is the primary terminal diagnosis. COPD with chronic hypoxemic",
            "respiratory failure and CKD stage 4 contribute to his decline and are related",
            "conditions. Alzheimer's dementia (moderate) and malnutrition contribute to frailty.",
            "Estimated prognosis: weeks to a few months.",
            "",
            "RECOMMENDATIONS",
            "1. DNR/DNI - POLST completed with daughter today.",
            "2. Hospice referral at discharge; home with hospital bed and oxygen.",
            "3. Morphine 2.5 mg SL every 2 hours PRN dyspnea; lorazepam 0.5 mg PRN anxiety.",
            "4. ICD deactivation - patient and daughter agree; cardiology to arrange.",
            "5. Stop non-beneficial medications: insulin glargine, atorvastatin.",
            "",
            "Miriam Tse, MD - Palliative Medicine   09/25/2026 16:40",
        ]),
    Doc("snf", "transfer_record", "SNF Transfer Form", "Willow Creek Care Center", "08/29/2026",
        ["WILLOW CREEK CARE CENTER", "INTER-FACILITY TRANSFER / CONTINUITY OF CARE FORM",
         f"Resident: {PATIENT}   DOB: {DOB}   Facility ID: WC-20931"],
        [
            "Transfer date: 08/29/2026   From: Willow Creek Care Center (short-term rehab)",
            "To: Home with home health   Physician: Lena Okafor, MD",
            "",
            "Primary diagnosis: Debility (R53.81)",
            "Secondary diagnoses:",
            "   Adult failure to thrive (R62.7)",
            "   Congestive heart failure (I50.9)",
            "   Dementia (F03.90)",
            "   Chronic kidney disease (N18.9)",
            "",
            "Functional status: Ambulates 15 feet with walker and one assist. Requires assistance",
            "with bathing, dressing and toileting. Incontinent of urine at night.",
            "Diet: 2 g sodium, 1.5 L fluid restriction.  Weight on discharge: 66.8 kg.",
            "Skin: intact.  Falls this stay: 1 (no injury).",
            "Cognition: BIMS 6/15, severe impairment.",
            "Advance directive: Full code at time of transfer.",
            "",
            "Completed by: Alicia Moreno, RN   08/29/2026",
        ], face="sans", skew=0.6),
    Doc("wound", "consult", "Wound Care Note", "Riverside General - Wound Care", "09/27/2026",
        [RGH, "WOUND / OSTOMY NURSING NOTE", PT, "Date: 09/27/2026   Author: Paul Ferreira, RN, CWOCN"],
        [
            "Location: sacrum, midline.",
            "Classification: pressure injury, stage 2 (partial-thickness skin loss, pink wound bed,",
            "no slough). Present on admission (noted on 09/17 exam).",
            "Measurements: 2.0 cm x 1.5 cm x 0.1 cm.  Periwound: intact, blanchable erythema.",
            "Drainage: scant serous.  Odor: none.",
            "",
            "Plan: foam dressing, change every 3 days and PRN; low-air-loss mattress; reposition",
            "every 2 hours; heels offloaded.",
            "",
            "Diagnosis: Pressure ulcer of sacral region, stage 2 (L89.152).",
        ]),
    Doc("diet", "consult", "Nutrition Assessment", "Riverside General - Clinical Nutrition", "09/24/2026",
        [RGH, "CLINICAL NUTRITION ASSESSMENT", PT, "Date: 09/24/2026   Author: Hannah Yoon, RDN"],
        [
            "Weight history: 70.0 kg (03/2026, cardiology clinic); 66.8 kg (08/29/2026); 61.0 kg",
            "dry weight estimate 09/24/2026. Loss of 12.9% in 6 months.",
            "Intake: less than 50% of estimated needs for more than 2 weeks per daughter and",
            "calorie counts.",
            "Physical exam: moderate temporal and clavicular muscle wasting; mild fat loss.",
            "",
            "Nutrition diagnosis: Moderate protein-calorie malnutrition (E44.0) in the context of",
            "chronic illness, meeting ASPEN/AND criteria (weight loss, intake, muscle wasting).",
            "",
            "Recommendations: liberalize diet for comfort; oral nutrition supplement as tolerated;",
            "no tube feeding per goals of care.",
        ]),
    Doc("nursing", "transfer_record", "Nursing Functional Assessment", "Riverside General - 4 West Nursing", "09/30/2026",
        [RGH, "NURSING FUNCTIONAL ASSESSMENT", PT, "Date: 09/30/2026   Author: Kim Abara, RN"],
        [
            "Palliative Performance Scale (PPS): 30%  - mainly in bed, unable to do any work,",
            "total care, reduced intake, drowsy or confused.",
            "FAST (Functional Assessment Staging): 6d - requires assistance with dressing and",
            "bathing, urinary incontinence; speech limited to short phrases; ambulatory with",
            "two-person assist only.",
            "Katz ADL: dependent in 5 of 6 (feeds self with setup).",
            "Oxygen: 2 L/min continuous; SpO2 90-92%.",
            "Dyspnea: with minimal exertion and talking.",
            "Edema: 2+ bilateral lower extremities.",
            "Continence: urinary incontinence, bowel continent.",
            "Fall risk: high (Morse 65).",
        ]),
    Doc("pulm", "consult", "Pulmonology Clinic Note", "Cascade Lung Clinic", "08/14/2025",
        ["CASCADE LUNG CLINIC - OUTPATIENT NOTE", PT, "Visit: 08/14/2025   Provider: Owen Achebe, MD"],
        [
            "Follow-up of COPD and chronic hypoxemia.",
            "",
            "PFTs 07/2025: FEV1 0.78 L (28% predicted), FEV1/FVC 0.41, DLCO 34% predicted.",
            "Two exacerbations in the past year, one requiring hospitalization.",
            "Resting SpO2 86% on room air, 92% on 2 L.",
            "",
            "ASSESSMENT",
            "1. Chronic obstructive pulmonary disease, severe, GOLD 4, group E (J44.9).",
            "2. Chronic respiratory failure with hypoxia (J96.11).",
            "3. Dependence on supplemental oxygen (Z99.81).",
            "4. Former tobacco use, 60 pack-years (Z87.891).",
            "",
            "PLAN: Continue tiotropium; add budesonide/formoterol; continuous oxygen 2 L/min;",
            "pulmonary rehab declined. Return 6 months.",
            "",
            "Owen Achebe, MD   08/14/2025",
        ]),
    Doc("memory", "consult", "Memory Clinic Letter", "Salem Neurology & Memory Center", "03/10/2025",
        ["SALEM NEUROLOGY & MEMORY CENTER", "1 Court Plaza, Salem OR 97301",
         "March 10, 2025"],
        [
            "Lena Okafor, MD",
            "Re: Arthur Doclens, DOB 03/02/1941",
            "",
            "Dear Dr. Okafor,",
            "",
            "I saw Mr. Doclens in follow-up with his daughter. Cognitive decline has progressed over",
            "the past year: MoCA 12/30 (from 17/30). He needs help with finances, medications and",
            "instrumental activities, and some help selecting clothing. FAST stage 5.",
            "",
            "Diagnosis: Alzheimer's disease with late onset (G30.1), with dementia, moderate,",
            "without behavioral disturbance (F02.B0).",
            "",
            "I have continued donepezil 5 mg nightly; we did not increase the dose because of",
            "bradycardia concerns. Follow-up in 6 months.",
            "",
            "Sincerely,",
            "Nadia Varga, MD - Cognitive Neurology",
        ], skew=-0.4),
    Doc("medrec", "med_recon", "Discharge Medication Reconciliation", "Riverside General - Pharmacy", "10/01/2026",
        [RGH, "DISCHARGE MEDICATION RECONCILIATION", PT, "Reconciled by: Omar Haddad, PharmD   10/01/2026"],
        [
            "CONTINUE",
            "  Furosemide 80 mg PO twice daily (dose increased from 40 mg)",
            "  Metoprolol succinate 25 mg PO daily",
            "  Apixaban 2.5 mg PO twice daily",
            "  Donepezil 5 mg PO at bedtime",
            "  Tiotropium 18 mcg inhaled daily",
            "NEW",
            "  Morphine sulfate oral solution 20 mg/mL - 2.5 mg SL every 2 hours PRN dyspnea",
            "  Lorazepam 0.5 mg SL every 6 hours PRN anxiety",
            "  Albuterol 2.5 mg nebulized every 4 hours PRN wheeze",
            "  Senna 8.6 mg PO at bedtime",
            "STOP",
            "  Sacubitril/valsartan 24/26 mg - hypotension",
            "  Spironolactone 25 mg - hyperkalemia, CKD",
            "  Insulin glargine 10 units nightly - hypoglycemia, poor intake",
            "  Atorvastatin 40 mg - not beneficial per goals of care",
            "",
            "ALLERGIES: Lisinopril - angioedema.  Sulfa antibiotics - rash.",
        ]),
    Doc("polst", "advance_directive", "POLST", "Oregon POLST", "09/25/2026",
        ["OREGON PHYSICIAN ORDERS FOR LIFE-SUSTAINING TREATMENT (POLST)", f"Patient: {PATIENT}   DOB: {DOB}"],
        [
            "A. CARDIOPULMONARY RESUSCITATION: [X] Do Not Attempt Resuscitation (DNR)",
            "B. MEDICAL INTERVENTIONS: [X] Comfort Measures Only",
            "C. ARTIFICIAL NUTRITION: [X] No artificial nutrition by tube",
            "",
            "Discussed with: Health care representative - Ruth Doclens (daughter)",
            "Signed: Miriam Tse, MD   09/25/2026",
        ], face="sans"),
]

# The order the pages arrive in the fax (not the order a chart would file them).
FAX_ORDER = ["cover", "referral", "facesheet", "ds", "hp", "cardio", "echo", "labs", "ct", "echo_dup",
             "palliative", "snf", "wound", "diet", "nursing", "pulm", "memory", "medrec", "polst"]


# ─────────────────────────────── the answer key ───────────────────────────────
# A mention is (doc, exact text on the rendered page, codeAsWritten | None, context).
# context: "listed" (a diagnosis list), "narrative", "pmh", "assessment", "history", "negated".

M = lambda doc, text, code=None, ctx="listed": {"doc": doc, "text": text, "codeAsWritten": code, "context": ctx}  # noqa: E731

CONDITIONS = [
    {"id": "hf", "label": "Heart failure - chronic systolic, end stage", "status": "active",
     "expectedRole": "terminal_candidate",
     "preferredCodes": ["I50.22", "I50.84"],
     "note": "Clinically the terminal condition (palliative and cardiology concur). The hospital "
             "principal I50.23 (acute on chronic) describes the stay, not the hospice admission.",
     "mentions": [
         M("referral", "Hospice diagnosis: End-stage heart failure"),
         M("ds", "Acute on chronic systolic congestive heart failure (I50.23)", "I50.23"),
         M("hp", "HFrEF / dilated cardiomyopathy, EF 15-20%", None, "pmh"),
         M("cardio", "End-stage heart failure with reduced ejection fraction, chronic systolic", "I50.84, I50.22", "assessment"),
         M("palliative", "End-stage heart failure is the primary terminal diagnosis", None, "assessment"),
         M("snf", "Congestive heart failure (I50.9)", "I50.9"),
     ]},
    {"id": "htn", "label": "Hypertensive heart and chronic kidney disease with heart failure", "status": "active",
     "expectedRole": "related", "preferredCodes": ["I13.0"],
     "note": "With HF and CKD documented, ICD-10-CM presumes the hypertension link (I.C.9.a.3): I13.0, "
             "sequenced before I50.- and N18.-.",
     "mentions": [
         M("ds", "Hypertension (I10)", "I10"),
         M("hp", "  - Hypertension", None, "pmh"),
         M("cardio", "Hypertensive heart and chronic kidney disease with heart failure, CKD stage 4", "I13.0, N18.4", "assessment"),
     ]},
    {"id": "cardiomyopathy", "label": "Non-ischemic dilated cardiomyopathy", "status": "active",
     "expectedRole": "related", "preferredCodes": ["I42.09"],
     "note": "I42.0 became a header on 2026-10-01; FY2027 requires I42.00/I42.01/I42.09 (non-ischemic, not "
             "familial-genetic → I42.09 'other' or I42.00 'unspecified' per documentation).",
     "mentions": [
         M("ds", "Dilated cardiomyopathy, EF 15% (I42.0)", "I42.0"),
         M("cardio", "Non-ischemic dilated cardiomyopathy (I42.0).", "I42.0", "assessment"),
     ]},
    {"id": "ckd", "label": "Chronic kidney disease, stage 4", "status": "active", "expectedRole": "related",
     "preferredCodes": ["N18.4"],
     "mentions": [
         M("ds", "Chronic kidney disease, stage 4 (N18.4)", "N18.4"),
         M("hp", "Chronic kidney disease stage 4, baseline creatinine 2.4", None, "pmh"),
         M("snf", "Chronic kidney disease (N18.9)", "N18.9"),
     ]},
    {"id": "copd", "label": "COPD, severe, with chronic hypoxemic respiratory failure", "status": "active",
     "expectedRole": "related", "preferredCodes": ["J44.9", "J96.11", "Z99.81"],
     "mentions": [
         M("ds", "Chronic obstructive pulmonary disease (J44.9)", "J44.9"),
         M("hp", "COPD, on 2 L home oxygen since 2024", None, "pmh"),
         M("pulm", "Chronic obstructive pulmonary disease, severe, GOLD 4, group E (J44.9).", "J44.9", "assessment"),
         M("pulm", "Chronic respiratory failure with hypoxia (J96.11).", "J96.11", "assessment"),
     ]},
    {"id": "dm", "label": "Type 2 diabetes mellitus with diabetic CKD", "status": "active", "expectedRole": "related",
     "preferredCodes": ["E11.22"],
     "mentions": [
         M("ds", "Type 2 diabetes mellitus (E11.9)", "E11.9"),
         M("hp", "Type 2 diabetes mellitus, last A1c 6.9%", None, "pmh"),
     ]},
    {"id": "afib", "label": "Permanent atrial fibrillation", "status": "active", "expectedRole": "related",
     "preferredCodes": ["I48.21"],
     "mentions": [
         M("ds", "Permanent atrial fibrillation (I48.21)", "I48.21"),
         M("cardio", "Permanent atrial fibrillation, rate controlled (I48.21).", "I48.21", "assessment"),
     ]},
    {"id": "dementia", "label": "Alzheimer's disease, late onset, with moderate dementia", "status": "active",
     "expectedRole": "related", "preferredCodes": ["G30.1", "F02.B0"],
     "note": "Not supported as the terminal diagnosis: FAST 6d (not 7) in the packet.",
     "mentions": [
         M("ds", "Alzheimer's dementia (G30.9, F02.80)", "G30.9, F02.80"),
         M("hp", "Alzheimer's dementia, followed by memory clinic", None, "pmh"),
         M("memory", "Alzheimer's disease with late onset (G30.1), with dementia, moderate,", "G30.1, F02.B0", "assessment"),
         M("snf", "Dementia (F03.90)", "F03.90"),
     ]},
    {"id": "anemia", "label": "Anemia in chronic kidney disease", "status": "active", "expectedRole": "related",
     "preferredCodes": ["D63.1"],
     "mentions": [M("ds", "Anemia of chronic kidney disease (D63.1)", "D63.1")]},
    {"id": "malnutrition", "label": "Moderate protein-calorie malnutrition", "status": "active",
     "expectedRole": "related", "preferredCodes": ["E44.0"],
     "mentions": [
         M("ds", "Moderate protein-calorie malnutrition (E44.0)", "E44.0"),
         M("diet", "Nutrition diagnosis: Moderate protein-calorie malnutrition (E44.0)", "E44.0", "assessment"),
     ]},
    {"id": "pressure_injury", "label": "Pressure ulcer of sacral region, stage 2", "status": "active",
     "expectedRole": "unrelated_candidate", "preferredCodes": ["L89.152"],
     "mentions": [
         M("ds", "Pressure injury of sacrum, stage 2 (L89.152)", "L89.152"),
         M("wound", "Diagnosis: Pressure ulcer of sacral region, stage 2 (L89.152).", "L89.152", "assessment"),
     ]},
    {"id": "pneumonia", "label": "Community-acquired pneumonia, right lower lobe", "status": "resolved",
     "expectedRole": "not_active", "preferredCodes": [],
     "note": "Resolved 09/26 - must not be proposed as an active diagnosis.",
     "mentions": [
         M("ds", "Community-acquired pneumonia, right lower lobe - resolved (J18.9)", "J18.9"),
         M("ct", "Right lower lobe consolidation, consistent with pneumonia", None, "assessment"),
     ]},
    {"id": "aud", "label": "Alcohol dependence, in remission", "status": "active", "expectedRole": "unrelated_candidate",
     "preferredCodes": ["F10.21"], "part2": True,
     "mentions": [
         M("ds", "Alcohol use disorder, in sustained remission (F10.21)", "F10.21"),
         M("hp", "Alcohol dependence, in remission since 2015", None, "pmh"),
         M("hp", "alcohol dependence; sober since 2015, attended AA for several years", None, "history"),
     ]},
    {"id": "debility", "label": "Debility / adult failure to thrive (SNF form)", "status": "active",
     "expectedRole": "not_principal", "preferredCodes": [],
     "note": "Symptom codes; CMS does not accept R53.81 or R62.7 as the hospice principal diagnosis, and the "
             "definitive diagnoses that explain the decline are documented.",
     "mentions": [
         M("snf", "Primary diagnosis: Debility (R53.81)", "R53.81"),
         M("snf", "Adult failure to thrive (R62.7)", "R62.7"),
     ]},
]

EXPECTED_FLAGS = [
    {"kind": "code_not_valid_on_date", "code": "I42.0", "doc": "ds",
     "detail": "Written 10/01/2026; I42.0 is a header (not billable) from 2026-10-01. Successors I42.00/I42.01/I42.09."},
    {"kind": "code_retired_since_written", "code": "I42.0", "doc": "cardio",
     "detail": "Valid when written 09/22/2026; retired 2026-10-01 - recode for any claim on/after that date."},
    {"kind": "combination_code_expected", "code": "I10", "doc": "ds", "suggest": ["I13.0"],
     "detail": "Hypertension with documented heart failure and CKD - I13.0 (Guidelines I.C.9.a.3)."},
    {"kind": "more_specific_code_supported", "code": "E11.9", "doc": "ds", "suggest": ["E11.22"],
     "detail": "Diabetes 'without complications' while CKD 4 is documented - 'with' convention (I.A.15)."},
    {"kind": "unspecified_code", "code": "G30.9", "doc": "ds", "suggest": ["G30.1"],
     "detail": "Neurology documents late-onset Alzheimer's."},
    {"kind": "unspecified_code", "code": "F02.80", "doc": "ds", "suggest": ["F02.B0"],
     "detail": "Neurology documents moderate severity."},
    {"kind": "manifestation_code", "code": "F02.80", "doc": "ds",
     "detail": "'in diseases classified elsewhere' - never first; follows G30.-."},
    {"kind": "manifestation_code", "code": "F02.B0", "doc": "memory", "detail": "Never first; follows G30.1."},
    {"kind": "unacceptable_hospice_principal", "code": "R53.81", "doc": "snf",
     "detail": "Debility listed as primary - not acceptable as the hospice principal diagnosis."},
    {"kind": "unacceptable_hospice_principal", "code": "R62.7", "doc": "snf",
     "detail": "Adult failure to thrive - not acceptable as the hospice principal diagnosis."},
    {"kind": "unspecified_code", "code": "I50.9", "doc": "snf", "suggest": ["I50.22"], "detail": "Type documented elsewhere."},
    {"kind": "unspecified_code", "code": "N18.9", "doc": "snf", "suggest": ["N18.4"], "detail": "Stage documented elsewhere."},
    {"kind": "conflicting_codes", "codes": ["F03.90", "G30.1", "G30.9"], "detail": "Unspecified dementia (SNF) vs Alzheimer's (neurology, hospital)."},
    {"kind": "resolved_condition", "code": "J18.9", "doc": "ds", "detail": "Pneumonia resolved during the stay."},
    {"kind": "part2_sud", "code": "F10.21", "doc": "ds", "detail": "42 CFR Part 2 - consent gating applies."},
]

NEGATED = [
    M("ct", "No evidence of pulmonary embolism.", None, "negated"),
    M("ct", "No suspicious pulmonary nodule or mass; no evidence of malignancy.", None, "negated"),
    M("ds", "CT chest: no suspicious nodule or mass; no evidence of malignancy.", None, "negated"),
    M("hp", "He denies", None, "negated"),
    M("hp", "no history of cancer", None, "negated"),
    M("hp", "Rule out pulmonary embolism - CT angiogram chest.", None, "negated"),
]

PROGNOSIS = [
    {"condition": "hf", "item": "NYHA class IV", "doc": "ds", "text": "NYHA class IV symptoms at rest despite maximally tolerated therapy."},
    {"condition": "hf", "item": "LVEF", "value": "15%", "doc": "echo", "text": "Left ventricular ejection fraction: 15% (biplane)."},
    {"condition": "hf", "item": "not a candidate for advanced therapy", "doc": "cardio", "text": "Not a candidate for LVAD or heart transplantation"},
    {"condition": "hf", "item": "optimal therapy limited by hypotension/renal function", "doc": "ds", "text": "could"},
    {"condition": "hf", "item": "recurrent admissions", "value": "4 in 6 months", "doc": "ds", "text": "Four heart failure admissions in the last 6 months."},
    {"condition": "general", "item": "PPS", "value": "30%", "doc": "nursing", "text": "Palliative Performance Scale (PPS): 30%"},
    {"condition": "general", "item": "weight loss", "value": "12.9% in 6 months", "doc": "diet", "text": "dry weight estimate 09/24/2026. Loss of 12.9% in 6 months."},
    {"condition": "general", "item": "albumin", "value": "2.6 g/dL", "doc": "labs", "text": "Albumin (g/dL)"},
    {"condition": "copd", "item": "FEV1", "value": "28% predicted", "doc": "pulm", "text": "FEV1 0.78 L (28% predicted)"},
    {"condition": "copd", "item": "resting hypoxemia on room air", "value": "SpO2 86%", "doc": "pulm", "text": "Resting SpO2 86% on room air"},
    {"condition": "dementia", "item": "FAST", "value": "6d", "doc": "nursing", "text": "FAST (Functional Assessment Staging): 6d"},
]

MISSING_EVIDENCE = [
    {"condition": "dementia", "item": "FAST stage 7", "detail": "Only FAST 6d (09/30/2026) and FAST 5 (03/2025) are documented."},
    {"condition": "copd", "item": "pCO2 >= 50 mmHg / recent ABG", "detail": "No blood gas in the packet."},
]

EXPECTED_PRINCIPAL = {
    "clinicalTerminalCondition": "hf",
    "codingSequenceSuggestion": ["I13.0", "I50.22", "I50.84", "N18.4"],
    "rationale": "End-stage HFrEF is the terminal condition (cardiology + palliative). Because hypertension, "
                 "heart failure and CKD are all documented, ICD-10-CM sequences I13.0 first, then the HF type "
                 "(I50.22) and end stage (I50.84), then the CKD stage (N18.4). The physician makes the final "
                 "determination, including related/unrelated.",
}


# ─────────────────────────────── rendering ───────────────────────────────

def render_page(lines: list[str], d: Doc, fax_page: int, fax_total: int, rng: random.Random) -> Image.Image:
    img = Image.new("L", (W, H), 255)
    dr = ImageDraw.Draw(img)
    dr.text((40, 30), f"{FAX_DATE} 14:37   FROM: {FAX_FROM}   TO: 5035550100   P.{fax_page:02d}/{fax_total:02d}", fill=0, font=HDR)
    body = MONO if d.face == "mono" else SANS
    y = TOP
    for i, ln in enumerate(lines):
        f = MONO_B if (d.face == "mono" and i < 3 and ln.isupper()) else (SANS_B if d.face == "sans" and i < 2 else body)
        dr.text((MARGIN_X, y), ln, fill=0, font=f)
        y += LINE
    for _ in range(900):  # scan speckle
        x, yy = rng.randrange(W), rng.randrange(H)
        dr.point((x, yy), fill=rng.choice((0, 90)))
    if d.skew:
        img = img.rotate(d.skew, resample=Image.BICUBIC, fillcolor=255)
    return img.point(lambda v: 0 if v < 150 else 255, mode="1")


def main(out_dir: str) -> None:
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    by_id = {d.id: d for d in DOCS}
    for d in DOCS:
        if d.duplicate_of:
            src = by_id[d.duplicate_of]
            d.header, d.body, d.face, d.skew = src.header, src.body, src.face, 0.9
        paginate(d)

    sequence: list[tuple[Doc, int]] = [(by_id[i], n) for i in FAX_ORDER for n in range(len(by_id[i].pages))]
    total = len(sequence)
    rng = random.Random(238)
    images: list[Image.Image] = []
    page_text: dict[int, str] = {}
    documents = []
    cursor = 1
    for doc_id in FAX_ORDER:
        d = by_id[doc_id]
        first = cursor
        for lines in d.pages:
            images.append(render_page(lines, d, cursor, total, rng))
            page_text[cursor] = "\n".join(lines)
            cursor += 1
        documents.append({"id": d.id, "type": d.type, "title": d.title, "source": d.source, "date": d.date,
                          "pages": [first, cursor - 1], **({"duplicateOf": d.duplicate_of} if d.duplicate_of else {})})
    doc_pages = {x["id"]: range(x["pages"][0], x["pages"][1] + 1) for x in documents}

    def locate(doc: str, text: str) -> int:
        norm = lambda t: " ".join(t.split())  # noqa: E731 — a mention may wrap across lines, as in OCR output
        hits = [p for p in doc_pages[doc] if norm(text) in norm(page_text[p])]
        if len(hits) != 1:
            raise SystemExit(f"answer key: {text!r} found on {hits} of {doc} (pages {list(doc_pages[doc])}) - must be exactly one")
        return hits[0]

    for c in CONDITIONS:
        for m in c["mentions"]:
            m["page"] = locate(m["doc"], m["text"])
    for m in NEGATED:
        m["page"] = locate(m["doc"], m["text"])
    for p in PROGNOSIS:
        p["page"] = locate(p["doc"], p["text"])

    key = {
        "fixture": "doclens-complex-referral-packet",
        "version": 1,
        "fictional": True,
        "patient": {"name": PATIENT, "mrn": MRN, "dob": DOB, "sex": "M"},
        "faxDate": FAX_DATE,
        "pageCount": total,
        "documents": documents,
        "conditions": CONDITIONS,
        "expectedFlags": EXPECTED_FLAGS,
        "negated": NEGATED,
        "prognosisEvidence": PROGNOSIS,
        "missingEvidence": MISSING_EVIDENCE,
        "expectedPrincipal": EXPECTED_PRINCIPAL,
    }
    pdf = out / "complex-referral-packet.pdf"
    images[0].save(pdf, save_all=True, append_images=images[1:], resolution=200)
    (out / "complex-referral-packet.key.json").write_text(json.dumps(key, indent=2) + "\n")
    print(f"wrote {pdf} ({total} pages, {pdf.stat().st_size // 1024} KB) and the answer key "
          f"({len(documents)} documents, {sum(len(c['mentions']) for c in CONDITIONS)} mentions, {len(EXPECTED_FLAGS)} flags)")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit(__doc__)
    main(sys.argv[1])
