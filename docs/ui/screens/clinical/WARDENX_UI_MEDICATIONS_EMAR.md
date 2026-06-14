# WARDENX_UI_MEDICATIONS_EMAR

Version: 1.0
Status: Screen Specification
Module: Medications — Prescribing & eMAR (M12 + M13)

---

## Purpose

The Medications screen covers the full medication lifecycle for a patient: the active
medication list, DoseSpot prescribing / eRx (including EPCS for controlled substances),
medication reconciliation, and the electronic Medication Administration Record (eMAR) for
scheduled, PRN, comfort-kit, and caregiver-attested dosing.

---

## Primary Users

- Prescribers: MD, Medical Director, NP, PA
- RN, LPN/LVN (administer; witness controlled)
- CHHA, MSW, Chaplain (non-controlled, per scope)
- Family caregiver (portal-attested administration)
- Clinical Supervisor, Pharmacist

---

## Layout Pattern

Use Patient Workspace + MAR Grid.

```text
Patient Banner
Medications Header (tabs: List · Prescribe · eMAR · Reconcile)
Medication List  |  Right: Med Detail / Alerts / RxBenefit
eMAR: MAR Grid (time × medication)  |  Right: Administration / PRN Reassessment / Witness
```

---

## A. Medication List

- Drug · strength · dose form · route · structured sig
- Class (standard / controlled / compounded) · DEA schedule
- Prescriber · refills remaining
- SUD-treatment flag (consent-gated disclosure)
- Allergy / interaction indicators (informational)

---

## B. Prescribing / eRx (DoseSpot)

- Draft → sign → transmit (NewRx)
- Controlled substances: EPCS 2FA step-up at signing; blocked if tenant not EPCS-certified
  (Phase-1 printed-DEA-Rx fallback with attestation)
- Refill inbox (pharmacy-initiated; approve/deny; 72h SLA)
- Medication-history pull (Surescripts) — never auto-linked
- RxBenefit: formulary, copay, prior-auth, alternatives (informational, non-gating)

---

## C. Medication Reconciliation

Triggered on admission / transfer / discharge / recert. Per-line decision: `carry_forward`,
`discontinue`, `hold`, `new_order`, `document_only`. Finalization SLA 5 days.

---

## D. eMAR (MAR Grid)

- Time × medication matrix of scheduled doses
- Per dose: administer / refuse / hold; capture time, dose, route
- PRN: reason, then reassessment due (ESAS-r / PAINAD) with banner when due
- Controlled substances: double-witness (second clinician attestation); wastage witnessed
- Comfort-kit draws decrement drawdown; replenishment alert at threshold
- Caregiver-attested doses route to the RN cosign queue (acknowledge / dispute)

---

## Statuses

- **Prescription:** `Draft`, `Pending Signature`, `EPCS Identity Pending`, `Signed`,
  `Queued for Transmission`, `Transmitted`, `Ack Received`, `Nack Received`, `Active`,
  `Completed`, `Discontinued`, `Expired Unsigned`, `Transmission Failed`.
- **Administration:** `Committed`, `Pending Caregiver Review`, `Superseded`, `Voided`.
- **Scheduled dose:** `Pending`, `Administered`, `Missed`, `Cancelled`,
  `Intentionally Held`.

Administration late-entry tiers: `Normal`, `Late`, `Significant Late`,
`Administrative Override`.

---

## Mobile / Offline Behavior

- eMAR usable offline (on-device queue); `administered at` (clinician-entered) preserved,
  `recorded at` = server time on sync.
- If the order is discontinued between capture and sync, the dose is blocked and surfaced as
  a sync-issue to resolve.
- Controlled-substance witness and EPCS signing require connectivity.

---

## Empty State

- No meds: "No active medications for this patient." → Prescribe, Run Reconciliation.
- eMAR with no scheduled doses: "No doses scheduled in this window." → Record PRN.

---

## Actions

- Prescribe · Sign (step-up / EPCS) · Transmit
- Approve / deny refill
- Run reconciliation
- Administer dose · Record PRN + reassessment
- Document refusal / hold
- Witness controlled substance · Record comfort-kit draw
- Acknowledge / dispute caregiver-attested dose

---

## Pencil Notes

Create versions for:

- Medication list
- Prescribing — controlled substance (EPCS 2FA)
- MAR grid (day view)
- PRN reassessment due (banner)
- Reconciliation worksheet
- Comfort-kit drawdown
- Caregiver-attested review queue
