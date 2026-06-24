# WARDENX_UI_CERTIFICATION_RECERT_LIFECYCLE

Version: 1.0
Status: Screen Specification
Module: ADMISSION ELECTION CERTIFICATION (M06)

---

## Purpose

The Recertification Lifecycle covers everything *after* initial election: tracking benefit
periods as they roll, running the recert wizard (clinical reassessment → terminal-prognosis
narrative), managing level-of-care segments and benefit periods, the face-to-face (F2F)
encounter timing window, and the physician certification / CTI. It is where the agency keeps a
patient continuously certified and billable across an unbounded hospice stay.

---

## Primary Users

- RN / Case Manager
- Medical Director / Hospice Physician
- Nurse Practitioner (F2F)
- Office Manager / Compliance Officer
- Biller

---

## Layout Pattern

Use Stepper Workflow.

```text
Context Header (patient · current BP · recert due window · certification status)
Left Nav Rail: Recert Steps  |  Center: active step  |  Right: Deadlines / F2F / Signatures
Sticky Footer Actions (Back / Save / Request Signature / Certify)
```

---

## Recert Dashboard

- Benefit-period ledger: BP1/BP2 (90 days each), BP3+ (60 days each), with start/end dates
- Recert due window per period (the days before the next period begins)
- F2F due window (the 30 days before the third benefit period and every subsequent recert)
- HOPE timepoint due (admission / recert-aligned) status
- Color-coded due chips — green on-track, amber within window, red overdue — each with glyph

## Recert Wizard

- Step 1 — Clinical reassessment: pull latest assessments, decline indicators, weight/PPS trend
- Step 2 — Terminal-prognosis narrative: physician-authored "still terminally ill" statement
- Step 3 — Diagnosis review: principal terminal + related conditions, eligibility rationale
- AI-suggested narrative drafts render `success`-tinted with provenance line + citation; nothing
  commits without physician Accept / Edit

## LOC Segment Manager

- Level-of-care segments: RHC, CHC, IRC, GIP — each with start/stop, location, revenue code
- Justification required for CHC/GIP (acuity narrative); change is append-only, prior segment
  atomically closed
- Revenue code per segment (0651 RHC · 0652 CHC · 0655 IRC · 0656 GIP) shown for billing review
- Overlap/gap validation between segments

## Benefit Period Manager

- Sequential BP cards; period number drives length (90/90/60…) and F2F applicability
- Election anchor, gaps (revocation/discharge re-election restarts), transfer-in continuity
- Editing a period boundary re-derives downstream recert/F2F windows

## F2F Encounter Workspace

- Required-from BP3 indicator; visit date must fall inside the 30-day pre-period window
- Performing provider (physician or NP), attestation, linked encounter (M08)
- Timing-window validator: a visit outside the window is flagged and does not satisfy the gate

## Physician Certification / CTI

- Certifying physician + attending concurrence
- Certification of Terminal Illness narrative + attestation language, certification period
- Signature ceremony with step-up; signature date stamped and audited

---

## Statuses

Per period: `Not Started`, `In Progress`, `Pending Signature`, `Certified`, `Overdue`,
`Billing Blocked`, `Expired`. Each LOC segment: `Open`, `Closed`, `Disputed`.

---

## Edit Rules & Sensitive Data

- Recert wizard is state-machine guarded; a period cannot certify until reassessment + narrative
  + F2F (when required) + HOPE complete.
- The **recert invariant alert** is a Guardrail blocker (§7.2 Gate Stepper): missing F2F,
  missing prognosis narrative, or missing HOPE timepoint each render a Guard Chip with a
  deep-link, and certification's primary action stays disabled until all clear.
- SUD-related diagnoses in the narrative are consent-gated (M39); redacted content reads as a
  sealed Part 2 block, never blank.
- Certification signature requires step-up auth and is append-only/audited.

---

## Actions

- Open recert wizard
- Author / accept prognosis narrative
- Add or change LOC segment (justification)
- Schedule / link F2F encounter
- Request physician signature
- Certify (ceremony, step-up)
- View benefit-period audit trail

---

## Empty State

Patient mid-BP1 with no recert yet due: dashboard shows "Next recert window opens [date]", all
steps not-started, with the F2F card explaining it is not required until BP3.

---

## Pencil Notes

Create versions for:

- Recert dashboard (multi-BP ledger, on-track)
- Recert wizard — narrative step (AI-suggested draft)
- LOC segment manager (GIP change with justification)
- F2F workspace — in-window vs out-of-window (flagged)
- Physician certification ceremony (step-up)
- Recert invariant alert — billing blocked (Gate Stepper, F2F/prognosis/HOPE)
