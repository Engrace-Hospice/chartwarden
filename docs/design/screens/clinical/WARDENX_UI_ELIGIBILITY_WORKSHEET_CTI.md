# WARDENX_UI_ELIGIBILITY_WORKSHEET_CTI

Version: 1.0
Status: Screen Specification
Module: CTI & Terminal-Decline / Eligibility Worksheet (M06 + M09 + M38)

---

## Purpose

This worksheet builds the Certification of Terminal Illness for a benefit period: validating
the terminal diagnosis, assembling the clinical decline evidence that supports a ≤ 6-month
prognosis (LCD-style criteria), composing the prognosis narrative, and capturing the required
physician signatures and F2F.

---

## Primary Users

- Hospice Medical Director / Hospice Physician
- Attending Physician (period 1 co-sign)
- NP, RN (preparation)
- Compliance Officer

---

## Layout Pattern

Use Patient Workspace + Documentation Workspace.

```text
Patient Banner
CTI Header (benefit period · period dates · status · deadlines)
Left: Diagnosis · Decline Evidence · Narrative · F2F · Signatures  |  Center: Worksheet  |  Right: Deadlines / Decline Trend / Prior Periods
```

---

## Diagnosis & Eligibility

- `terminal_diagnosis_icd10` — validated against the M38 CMS-allowable list (rejects with
  `TERMINAL_DX_NOT_ALLOWABLE`).
- `related_conditions_icd10[]`, comorbidities.
- LCD-style criteria checklist for the diagnosis (decline indicators) — decision support to
  evidence eligibility; the binding rules live in M38/M23.

---

## Decline Evidence

Assembled from the chart to substantiate prognosis: functional decline (PPS / FAST / KPS
trend from M09), weight loss / ADL decline, recent hospitalizations, ESAS-r symptom burden.
Shown as a trend so the physician sees the trajectory, not a snapshot.

---

## Narrative

`narrative` (prognosis statement, ≥ 200 chars) with optional governed AI assist that drafts
from the decline evidence (clinician edits and owns it); attestation language.

---

## F2F

Required from period 3; window = 30 days prior to period start. Status `Scheduled`,
`Completed`, `Attested`; performer hospice MD/NP (not attending); out-of-window requires a
medical-director override with reason.

---

## Signatures

Hospice MD signs first (`hospice_md_signed_at`); attending co-signs for period 1
(`attending_md_signed_at`). Signing before `period_start` avoids `signed_late`; late signing
sets `signed_late` + requires `late_reason`. Step-up auth required. The attending co-sign does not
block admission activation; it must be on file before the period-1 claim is billed (M6 §11 D3).

---

## Statuses

- CTI: `Drafted`, `Awaiting Hospice MD`, `Awaiting Attending`, `Signed`, `Voided`,
  `Superseded`.
- Benefit period kind: `ninety_day`, `sixty_day`; election: `pending` / `signed` / `active` /
  `completed`.

---

## Empty State

"No certification is due for this patient right now." → View Benefit Periods.

---

## Actions

- Select / validate terminal diagnosis
- Assemble decline evidence
- Draft narrative (AI assist)
- Link F2F · request window override
- Sign (MD / attending, step-up) · mark late
- Void · generate CTI document

---

## Pencil Notes

Create versions for:

- Diagnosis + LCD criteria checklist
- Decline-evidence trend
- Narrative builder (AI assist)
- F2F window (in / out of window)
- Signature flow (awaiting attending / late)
