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
- Generate discharge summary

---

## Pencil Notes

Create versions for:

- Reason picker
- Revocation (signer + reason)
- For-cause (cosign required → pending)
- Transfer-out vs transfer-in
- Cascade review / confirm
