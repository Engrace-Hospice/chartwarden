# CHARTWARDEN_UI_ALLERGY_MANAGEMENT

Version: 1.0
Status: Screen Specification
Module: Allergy & Intolerance Management (composed — M05 patient, M12 prescribing, M38 terminology)

---

## Purpose

The Allergy & Intolerance screen maintains the patient's coded allergy list — allergen,
reaction, severity, and status — which drives the banner badge and the drug-allergy /
interaction alerts at prescribing. It promotes allergies from a banner field to a managed,
reconcilable list.

---

## Primary Users

- RN / LPN
- Prescriber (MD / NP / PA)
- Pharmacist

---

## Layout Pattern

Use Patient Workspace + Work Queue.

```text
Patient Banner (allergy badge)
Allergy List  |  Right: Allergy Detail / Add-Edit
```

---

## Allergy Detail

- Allergen (coded via M38 — RxNorm / substance) and allergen type (drug / food / environmental / biologic)
- Reaction(s) and manifestation
- Severity: `Mild`, `Moderate`, `Severe`, `Anaphylaxis`
- Criticality (low / high), onset
- Source: patient-reported / observed / external import
- Verification: `Confirmed` / `Unconfirmed`

A **No Known Drug Allergies (NKDA)** state is explicit, not an empty list.

---

## Statuses

`Active`, `Inactive`, `Resolved`, `Refuted`, `Entered in Error`. Verification: `Confirmed` /
`Unconfirmed`.

---

## Reconciliation & Alerts

- Reconciled on admission / transfer alongside medication reconciliation.
- Feeds drug-allergy and interaction checking at prescribing (M12) — informational, does not
  hard-block ordering.
- `Entered in Error` and `Refuted` retain an audit trail (never hard-deleted).

---

## Empty State

"No allergies recorded." → Add Allergy, Mark NKDA. (NKDA renders as an explicit confirmed
state, with who/when.)

---

## Actions

- Add allergy · edit
- Set severity / criticality / verification
- Mark resolved / refuted / entered-in-error
- Reconcile (admission / transfer)
- Set NKDA

---

## Pencil Notes

Create versions for:

- Allergy list (active + inactive)
- Add / edit allergy (coded allergen)
- NKDA confirmed state
- Reconciliation (admission)
- Entered-in-error (audit retained)
