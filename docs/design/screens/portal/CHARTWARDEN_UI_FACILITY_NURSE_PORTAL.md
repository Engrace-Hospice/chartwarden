# CHARTWARDEN_UI_FACILITY_NURSE_PORTAL

Version: 1.0  
Status: Screen Specification  
Module: PORTAL (M31)

---

## Purpose

A scoped portal for a SNF or facility nurse to see the hospice patients **at their facility** —
level-of-care orders and status — and to add **limited observation documentation** permitted by
their access level. Not a clinical seat: no orders, no medication administration.

---

## Primary Users

- SNF / nursing-facility RN or LPN
- Assisted-living / group-home nurse

---

## Layout Pattern

Use Portal Dashboard.

```text
Portal Header (nurse · facility · sign-out)
Patients at This Facility (status + LOC)
Selected Patient Summary (limited)
Add Observation (per access level)
Messages (care team)
Urgent / After-hours Contact (persistent)
```

---

## Patients at This Facility

- Hospice patients physically at my facility: name · status badge · level of care.
- Active LOC orders (e.g. Routine, Respite, GIP) and effective dates.
- Selecting a patient scopes the summary and observation cards.

---

## Patient Summary (limited)

- Care team contacts, next scheduled hospice visit, code status, allergies.
- Active LOC order detail; recent hospice visit dates (read-only).
- SUD / Part 2 content sealed unless M39 consent permits unsealing.

---

## Add Observation

- A constrained observation note (vital signs, intake, behavior, comfort) that the facility nurse
  is permitted to contribute; surfaced to the hospice care team for follow-up.
- Fields and visibility are gated by `access_level`; no order entry, no eMAR administration.
- Observation is attributed to the facility nurse and dated; agency reviews it.

---

## Messaging

- Patient-scoped thread with the hospice care team; urgent flag available for changes in condition.

---

## Statuses

Patient: `Active`, `On Hold`, `Discharged`, `Deceased`.  
LOC order: `Active`, `Pending`, `Expired`.  
Observation: `Submitted`, `Acknowledged`.

Discharged/Deceased patients are read-only.

---

## Edit Rules & Sensitive Data

- **Scoped, least-privilege:** the nurse sees ONLY hospice patients at their own facility; scope
  and `access_level` are enforced server-side, never by client filtering.
- Writes are limited to permitted observation notes — no orders, no medications, no LOC changes.
- PHI minimized; SSN/MBI masked `xxx-xx-####`, no reveal here.
- SUD / 42 CFR Part 2 content sealed unless M39 consent allows; unsealing is consent-checked.
- Every view, observation, and message is audited with facility-nurse identity.

---

## Actions

- Open patient summary
- Add observation (per access level)
- Message hospice care team (urgent flag)
- Contact agency / urgent care line

---

## Empty State

No patients at this facility: "There are no hospice patients at your facility right now." No
observations yet for a patient: "No observations recorded."

---

## Pencil Notes

Create versions for:

- Facility roster with LOC badges
- Limited patient summary
- Add-observation form (gated by access level)
- Sealed SUD block in summary
- Discharged-patient read-only state
- Empty / no-patients state
