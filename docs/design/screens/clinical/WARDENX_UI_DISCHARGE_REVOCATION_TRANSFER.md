# WARDENX_UI_DISCHARGE_REVOCATION_TRANSFER

Version: 1.0
Status: Screen Specification
Module: Discharge / Revocation / Transfer Workflow (M06)

---

## Purpose

A guided workflow for ending or moving a hospice episode (other than death): live discharge,
revocation, transfer-out, or discharge for cause — capturing reason-specific data and running
the correct cascades (election/period close, LOC end, NOTR, final claim).

---

## Primary Users

- Clinical Manager
- Hospice MD / NP
- Medical Director (for-cause cosign)
- Intake (transfer-in)
- Compliance Officer

---

## Layout Pattern

Use Patient Workspace + Stepper Workflow.

```text
Patient Banner
Discharge Workflow Header
Left: Steps  |  Center: Reason-specific Form  |  Right: Cascades / Compliance
Sticky Footer Actions
```

---

## Reason Types (`discharge_type`)

`revocation`, `transfer`, `no_longer_terminal`, `moved_out_of_service_area`, `for_cause`.
(Death is handled by the Death / Pronouncement workflow.)

---

## Steps

1. **Select reason.**
2. **Reason-specific data:**
   - *Revocation* — `revocation_reason` (`seek_curative_treatment` / `dissatisfaction` /
     `transferred_out` / `other`), signer (`patient` / `representative`), signed date.
   - *For cause* — `for_cause_reason` (≥ 20 chars) + narrative; **medical-director cosign
     required**.
   - *No longer terminal* — patient-education attestation.
   - *Transfer-out* — destination; *Moved out of area* — narrative.
3. **Effective date** (`effectiveAt` ≤ today, ≥ admission).
4. **Review cascades.**
5. **Confirm** (step-up).

---

## Cascades

Closes the active election period (with cause), ends the LOC, sets admission → `discharged`;
emits `m6.revocation.created` / `m6.transfer.created` / `m6.discharge.created`+`m6.discharge.death` (the registered M6 names) → M23 (NOTR + final
claim) and M22 (discharge summary).

- **For cause:** admission stays `active` until the medical director cosigns; a rejected
  cosign voids the discharge and returns the admission to `active`.
- **Transfer-in** (separate entry): creates a new admission (`transferred_in`,
  `inherited_period_sequence`); a prior signed election statement is not re-collected.
- One transfer per period is enforced.

---

## Statuses

- Admission: `… → discharged` (or `active` pending for-cause cosign).
- Election period: `… → completed` (cause = revocation / transfer / discharge).

---

## Empty State

Not applicable — launched for a specific patient.

---

## Actions

- Select reason · enter reason data
- Sign / attest (revocation signer)
- For-cause cosign (medical director, step-up)
- Execute discharge
- Initiate transfer-in (new admission)
- Readmit a live-discharged patient (new admission — see Readmission below)
- Generate discharge summary

---

## Pencil Notes

Create versions for:

- Reason picker
- Revocation (signer + reason)
- For-cause (cosign required → pending)
- Transfer-out vs transfer-in
- Cascade review / confirm

---

## Readmission (`/admissions/:id/readmit`)

A patient discharged **alive** (live discharge, revocation, transfer out — never a death) comes back. Entry points:
the **Readmit** list (below), the admission detail of a discharged stay ("Readmit patient"), the discharge hub's
**Recently discharged** list (live endings of the last 90 days whose patient has no later admission), and the patient
chart's Election & Certification tab. Gated on `admission.create` — intake supervisors and (migration 0379) the
nursing, physician, NP and PA roles; the server scopes WHICH patients (intake org-wide, a clinician their own provider
entity / location — the `admission_clinical_site_scope` predicate). Same workspace frame as the end-of-episode workflows (chart banner,
step navigator, flat sections, right rail: the previous admission + what happens on create).

Steps:

1. **Previous episode** — admitted / ended (kind + date), reason, days since discharge, last benefit period, the prior
   election's close-out (NOTR 8xB / final claim filed or not), RHC prior days. A transfer ending points to transfer-in.
2. **Benefit period** — the period this admission elects into, prefilled with our history's suggestion (last period
   +1 after a live discharge / revocation, the same after a transfer). A **"Confirmed against HETS / ELGA / ELGH"**
   checkbox + date checked. Unconfirmed, or different from the suggestion → a **warning, not a block**: Medicare counts
   periods across every hospice (Claims Processing Manual ch. 11 §20.1.6).
3. **Requirements** for that period — new election statement; certification signers (period 1: hospice physician +
   attending; 2+: medical director / IDG physician only); face-to-face from period 3 (window, the 2-day
   exceptional-circumstance path, death within 2 days deemed complete); NOE due (5 days, admission = day 1) and
   **held** until the prior NOTR / final claim is filed; initial / comprehensive assessments; HOPE Admission (A0220);
   RHC day-count carry-over when within 60 days.
4. **Intake** — admission date, intake method, hospice medical director, attending; period 3+: exceptional
   circumstances + reason.
5. **Review** → Create readmission → lands on the new admission (intake / activation as usual).

The plain **New admission** screen carries the same benefit-period field (suggestion from history, 1 when none; same
warning) and links to the readmission workflow when the patient has a live-ended earlier stay.

HETS: the benefit-period field has one integration slot (`useHetsHospicePeriods`) for the HETS 270/271 hospice-period
read; until it is wired the confirmation is the manual checkbox + date.

## Readmit list (`/admissions/readmit`)

Sidebar: **Admissions → Readmit**, right after Discharge / transfer; shown to `admission.create` holders. The patients
who can be readmitted — the discharge worklist's `recently_discharged` bucket (live discharges, revocations, transfers
out of the last 90 days, never deaths, patient with no later admission), scoped server-side as above. Same idiom as the
hub: page head, one flat panel with a name / MRN search and the hub's recently-discharged table (patient, MRN, how it
ended, date, days since, **Readmit…** → `/admissions/:id/readmit`), empty state ("No one to readmit"), and a right rail
("Before you readmit": new election, HETS check, F2F from period 3, not-listed guidance). Rows carry the patient's name
and MRN from the server (a former patient's chart is usually off the caller's caseload), so the name is not a chart
link here.
