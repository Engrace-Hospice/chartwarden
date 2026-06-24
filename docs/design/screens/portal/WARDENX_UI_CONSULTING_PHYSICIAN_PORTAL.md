# WARDENX_UI_CONSULTING_PHYSICIAN_PORTAL

Version: 1.0  
Status: Screen Specification  
Module: PORTAL (M31)

---

## Purpose

A read-mostly portal for a consulting physician brought in for a specific patient: review the
patient summary, read and add consult notes, and exchange limited messages. Scope is narrower
than the attending portal — no order or certification signing.

---

## Primary Users

- Consulting / specialist physician
- Second-opinion physician

---

## Layout Pattern

Use Portal Dashboard.

```text
Portal Header (physician name · NPI · agency · sign-out)
Assigned Patient List (consult scope)
Patient Summary (selected · read-only)
Consult Notes (read + add)
Messages (limited)
Urgent / After-hours Contact (persistent)
```

---

## Assigned Patients

- Patients for which I hold an active consult assignment: name · status · level of care.
- Consult reason / referring question shown per patient.
- Selecting a patient scopes the summary, notes, and messages below.

---

## Patient Summary (read-only)

- Recent signed notes, active orders, active medications, level of care, care team.
- Code status, allergies, relevant problems for the consult question.
- SUD / Part 2 content sealed unless M39 consent permits unsealing.

---

## Consult Notes

- Read prior consult notes; add a new consult note tied to the consult assignment.
- Notes are signed by the consultant (step-up) and become part of the chart read-only after sign.
- No order entry, no certification — the consultant advises; the attending acts.

---

## Messaging

- Limited, patient-scoped thread with the care team; urgent flag available.
- Attachments and recipients constrained by access level.

---

## Statuses

Patient: `Active`, `On Hold`, `Discharged`, `Deceased`.  
Consult: `Requested`, `Active`, `Completed`.  
Consult note: `Draft`, `Signed`.

When the consult is `Completed` or the patient is Discharged/Deceased, the surface is read-only.

---

## Edit Rules & Sensitive Data

- **Scoped, least-privilege:** consultant sees ONLY patients with an active consult assignment;
  scope enforced server-side.
- Read-mostly: the only write is a consult note tied to the assignment — no orders, no certs.
- PHI minimized; SSN/MBI masked `xxx-xx-####`, no reveal here.
- SUD / 42 CFR Part 2 content sealed unless M39 consent allows; unsealing is consent-checked.
- Every view, note, and message is audited with consultant identity; note signing is step-up.

---

## Actions

- Open patient summary (read-only)
- Read consult notes
- Add / sign consult note (step-up)
- Message care team (urgent flag)
- Contact agency / urgent care line

---

## Empty State

No active consults: "You have no consult assignments at this time." No notes yet: "No consult
notes have been recorded for this patient."

---

## Pencil Notes

Create versions for:

- Dashboard with active consults
- Read-only patient summary
- Consult-note read vs add/sign
- Sealed SUD block in summary
- Completed-consult read-only state
- Empty / no-consults state
