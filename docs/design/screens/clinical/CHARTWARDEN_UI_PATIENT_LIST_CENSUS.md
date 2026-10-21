# CHARTWARDEN_UI_PATIENT_LIST_CENSUS

Version: 1.0
Status: Screen Specification
Module: Patient / Census (M05)

---

## Purpose

The Patient List / Census is the clinical landing surface: find a patient, see the active
census, and open a chart. It is **caseload-scoped** — each clinician sees the patients on
their caseload (per the M05 CaseloadProvider seam + active-shift union), with broader views
gated by role.

---

## Primary Users

- RN / Case Manager
- LPN/LVN, CHHA
- MSW, Chaplain
- NP, MD, Medical Director
- Office Manager, Scheduler
- Intake/Admissions, Biller

---

## Layout Pattern

Use Work Queue.

```text
Page Header
KPI Strip
Filter Bar
Patient Table  |  Right: Patient Quick Summary
```

---

## KPI Cards

- Active Census
- On Hold
- Pending Admission
- Discharged (30d)
- Deceased (30d)

---

## Filters

- Name (fuzzy / Jaro-Winkler)
- MRN
- MBI
- DOB
- Status
- Location
- Level of care (RHC / CHC / IRC / GIP)
- Primary clinician / caseload
- Payer / coverage kind
- Privacy flag present

---

## Table Columns

- Patient (legal or preferred name)
- MRN
- DOB / Age
- Status
- Location
- Level of care
- Primary RN
- Next visit
- Flags (privacy / safety / alerts)

---

## Right Panel — Patient Quick Summary

- Banner identity (name, DOB, age, MRN, MBI last4)
- Status + level of care
- Primary address (state)
- Primary payer + coverage kind
- Primary caregiver + legal-representative marker
- Privacy flags (badges)
- Open Chart action

---

## Statuses

Patient lifecycle: `Prospective`, `Active`, `On Hold`, `Discharged`, `Deceased`, `Merged`.

> A `Merged` patient resolves through a redirect to the surviving MRN; show a "merged into
> [MRN]" link rather than a row that opens an orphan chart.

---

## Privacy & Access

- SSN never shown in lists; MBI shown as last-4 only.
- Privacy flags (SUD / HIV / mental health / genetic / minor-restricted / abuse-victim)
  render as badges **only** when the user holds the matching disclosure consent (M39);
  otherwise hidden, not greyed.
- List rows are restricted to the caller's caseload unless the role carries an
  all-patients scope.

---

## Empty State

- Caseload empty: "No patients are currently assigned to you." → Actions: Search All
  Patients (if permitted), View Pending Admissions.
- Zero after filter: "No patients match these filters." → Clear Filters.

---

## Mobile Behavior

- Default to the caller's caseload as a single-column card list.
- Search + status filter pinned at top.
- Tap row → open chart; long-press → quick actions (message, start visit).

---

## Actions

- Open chart
- Search
- Save view
- Message care team
- Start visit

---

## Pencil Notes

Create versions for:

- Caseload default view
- All-patients search (broad scope)
- Quick-summary panel open
- Empty caseload
- Mobile caseload list
