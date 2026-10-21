# CHARTWARDEN_UI_PATIENT_CHART

Version: 1.0
Status: Screen Specification
Module: Patient (M05)

---

## Purpose

The Patient Chart is the central hub for a single patient: a persistent identity banner, a
module navigation rail, and a clinical summary. Every other clinical screen (encounters,
care plan, orders, medications, assessments, documents) is reached from here and shares this
banner.

---

## Primary Users

- RN / Case Manager, LPN/LVN, CHHA
- MSW, Chaplain, NP, MD, Medical Director
- Pharmacist, Bereavement Coordinator
- Office Manager, Biller, Compliance/Privacy Officer

---

## Layout Pattern

Use Patient Workspace.

```text
Patient Banner            ← sticky, required
Left: Module Nav Rail  |  Center: Active Module / Summary  |  Right: Alerts / Tasks
```

---

## Patient Banner (sticky)

- Name (legal or preferred) + pronouns
- DOB / age / sex assigned at birth
- MRN (org-unique, immutable) · MBI (last 4)
- Status badge · level of care
- Code status · allergies
- Primary address (state) · primary phone
- Primary payer + coverage kind
- Primary caregiver + legal-representative marker
- Privacy flags (consent-gated badges)
- If deceased: deceased date · if merged: "merged into [MRN]"

---

## Module Nav Rail

- Summary
- Demographics & Identifiers
- Coverage / Payers
- Care Team & Assignments
- Care Plan
- Encounters / Visits
- Assessments
- Orders
- Medications / eMAR
- Documents
- Election & Certification
- IDG History
- Bereavement (when deceased)

---

## Summary Tab

- Active problems (from Care Plan)
- Current benefit period + recert/F2F deadlines
- Upcoming visits · recent signed visits
- Active orders · active medications
- Recent assessment scores + trend
- Open tasks / alerts

---

## Statuses

Patient lifecycle: `Prospective`, `Active`, `On Hold`, `Discharged`, `Deceased`, `Merged`.

When `Discharged` or `Deceased`, the chart is **read-only** except Bereavement (M16) and
amendment (M05) surfaces.

---

## Edit Rules & Sensitive Data

- MRN is immutable after creation.
- SSN / state ID are envelope-encrypted, shown as `xxx-xx-####`; full read requires
  `phi.read_ssn`, write requires step-up + `phi.write_ssn`.
- Addresses are append-only; setting a new primary atomically closes the prior one.
- Caregivers: exactly one primary; legal representative requires authority + proof document.
- Status transitions are state-machine guarded; recording death requires a pronouncer +
  step-up auth.
- Amendment requests (HIPAA §164.526) show a **60-day SLA timer** — warning at 7 days,
  critical at expiry.

---

## Actions

- Edit demographics / identifiers (gated)
- Manage caregivers & emergency contacts
- Manage care-team assignments
- Record death (step-up)
- Request / track amendment
- Message care team
- Open any module (nav rail)

---

## Empty State

New/sparse chart (just-admitted): Summary shows "Care plan not yet started", "No signed
visits yet", with deep-links to start each.

---

## Pencil Notes

Create versions for:

- Active chart (full summary)
- Just-admitted chart (sparse summary)
- Discharged chart (read-only)
- Deceased chart (bereavement surfaced)
- Merged-patient redirect state
- SSN masked vs revealed (step-up)
