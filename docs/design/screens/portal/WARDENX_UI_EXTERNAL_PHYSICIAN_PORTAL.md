# WARDENX_UI_EXTERNAL_PHYSICIAN_PORTAL

Version: 1.0  
Status: Screen Specification  
Module: PORTAL (M29, M31)

---

## Purpose

A scoped, least-privilege portal for an attending or external physician to act on **their own
assigned patients**: review summaries, sign pending orders, sign initial certifications and
recertifications, and exchange patient-specific messages with the agency — without a full EHR seat.

---

## Primary Users

- Attending physician of record
- External / community physician with assigned patients

---

## Layout Pattern

Use Portal Dashboard.

```text
Portal Header (physician name · NPI · agency · sign-out)
Assigned Patient List (status badges)
Pending Order Signing
Pending Certification Signing
Patient Summary (selected)
Messages (patient-specific)
Urgent / After-hours Contact (persistent)
```

---

## Assigned Patients

- Patient name (legal/preferred) · status badge · level of care
- Last visit date · any items needing me (orders, certs to sign)
- Selecting a patient scopes the summary, signing, and message cards below.

---

## Order Signing

- Queue of orders awaiting my signature: type, medication detail, prescriber-of-record, date.
- Each order opens a Signature Ceremony (step-up); EPCS orders require the EPCS credential flow.
- Reason-for-decline path; declined orders return to the agency, not silently dropped.

---

## Certification Signing

- Pending **initial certification** and **recertification** items with benefit period dates.
- Prognosis narrative ("terminal illness, ≤6 months") shown for review before signing.
- F2F-attestation linkage where required; signing is a step-up ceremony, never inline.

---

## Patient Summary

- Recent signed notes (read-only), active orders, active medications.
- Level of care, care team contacts, code status, allergies.
- SUD / Part 2 content renders as a sealed block unless consent permits unsealing.

---

## Messaging

- Patient-scoped thread with the agency care team; **urgent flag** raises priority + routing.
- Plain-language composer; attachments limited per access level.

---

## Statuses

Patient: `Active`, `On Hold`, `Discharged`, `Deceased`.  
Order: `Pending`, `Signed`, `Declined`.  
Certification: `Pending`, `Signed`, `Expired`.

Discharged/Deceased patients are read-only except outstanding signatures.

---

## Edit Rules & Sensitive Data

- **Scoped, least-privilege:** the physician sees ONLY patients assigned to them; scope is
  enforced server-side, never by client filtering.
- PHI is minimized to what signing/review requires; SSN/MBI masked `xxx-xx-####`, no reveal here.
- SUD / 42 CFR Part 2 content is sealed unless M39 consent allows; unsealing is consent-checked.
- Every view, sign, decline, and message is audited with physician identity.
- Order and certification signing require step-up auth; EPCS adds the EPCS credential ceremony.

---

## Actions

- Sign / decline an order (step-up · EPCS where applicable)
- Sign initial cert / recert (step-up)
- Open patient summary
- Message care team (urgent flag)
- Contact agency / urgent care line

---

## Empty State

No assigned patients: "You have no patients assigned at this time." Nothing pending: "No orders
or certifications are waiting for your signature."

---

## Pencil Notes

Create versions for:

- Dashboard with pending orders + certs
- Order signing ceremony (standard vs EPCS)
- Certification signing with prognosis narrative
- Patient summary with sealed SUD block
- Empty / nothing-pending state
- Discharged-patient read-only state
