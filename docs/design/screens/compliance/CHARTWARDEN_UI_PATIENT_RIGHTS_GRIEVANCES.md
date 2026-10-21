# CHARTWARDEN_UI_PATIENT_RIGHTS_GRIEVANCES

Version: 1.0
Status: Screen Specification
Module: COMPLIANCE (M30)

---

## Purpose

The compliance office's surface for hospice patient-rights obligations under the Medicare
Conditions of Participation (§418.52): the **rights-acknowledgment** tracker confirming each
patient received and acknowledged the required notices at admission, **grievance** management
with its 5-day acknowledgment / 30-day resolution clocks, and **abuse / neglect** mandatory
reporting to the state survey agency with investigation tracking (§418.52(c)).

---

## Primary Users

- Compliance Officer
- Administrator / Patient-Rights Coordinator
- Quality (QAPI) Officer
- Clinical Manager

---

## Layout Pattern

Use Work Queue.

```text
Page Header
KPI Strip (open grievances · missing acknowledgments · abuse reports · ≤5d / ≤30d due)
Filter Bar (kind · status · patient · deadline · category)
Rights / Grievance / Report Table  |  Right Detail Panel
```

---

## Tabs & Kinds

- **Rights acknowledgments** — per admission, the 8+ required notices (patient rights, notice
  of privacy practices, advance-directive policy, complaint process, Medicare hospice election
  rights, non-discrimination, financial liability/ABN, photography/consent) tracked to signed.
- **Grievances** — formal complaints from patient/family about care, conduct, or rights.
- **Abuse / neglect / exploitation** — mandated reports to the state agency + investigation.

---

## Table Columns

- Item ID
- Patient (masked banner)
- Kind · category
- Received / due · **deadline countdown chip**
- Assigned to
- Status

---

## Detail Panel

- Rights: checklist of required notices, who acknowledged (patient vs representative), signed
  artifacts, gaps highlighted
- Grievance: complainant, narrative, category, acknowledgment letter, investigation steps,
  resolution + written response
- Abuse/neglect: allegation, alleged perpetrator, state-agency report (date + confirmation #),
  protective actions, investigation findings, substantiation outcome
- Audit trail; links to QAPI where systemic

---

## Statuses

Acknowledgment: `Pending` → `Acknowledged` / `Refused (documented)`.
Grievance: `Received` → `Acknowledged` → `Under investigation` → `Resolved` → `Closed`.
Abuse report: `Reported` → `Under investigation` → `Substantiated` / `Unsubstantiated` →
`Closed`.

---

## Edit Rules & Sensitive Data

- Requires `compliance.grievance.manage`; abuse reporting requires `compliance.abuse.report`.
- Patient PHI masked on banner; reveal step-up + audited.
- **Grievance clocks:** 5-day written acknowledgment, 30-day investigation/resolution with a
  written response — both countdown chips (neutral → warning → error at expiry).
- Abuse/neglect carries a **state-specific reporting deadline** (often immediate / 24h);
  surfaced as an urgent countdown and a Guard Chip if not yet reported.
- Mandatory-reporter obligations cannot be dismissed — a flagged allegation blocks "close"
  until a state-agency report is recorded or a documented determination of non-reportable.

---

## Actions

- Record / collect rights acknowledgment (signature ceremony)
- Open grievance · send acknowledgment · record investigation · issue written resolution
- File abuse/neglect report to state agency (capture confirmation #)
- Record protective/corrective actions
- Escalate to QAPI

---

## Empty State

Nothing open: "No open grievances or reports" with "Start a rights checklist" and "Log a
grievance" affordances; KPI strip zeros.

---

## Pencil Notes

Create versions for:

- Rights-acknowledgment checklist (8+ notices) with gaps flagged and a **signature ceremony**
- Grievance detail with the **5-day** and **30-day** deadline countdown chips
- Abuse/neglect report with an urgent state-deadline countdown and pre-report **Guard Chip**
- Substantiated vs unsubstantiated investigation outcomes
- Masked patient banner vs step-up reveal
- Escalate-to-QAPI affordance on a systemic grievance
