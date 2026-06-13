# WARDENX_UI_ORDERS

Version: 1.0
Status: Screen Specification
Module: Orders (M11)

---

## Purpose

The Orders screen manages non-medication clinical orders (labs, DME, level-of-care changes,
recertifications, comfort kits, supplies, ancillary services), the 48-hour verbal-order
workflow per 42 CFR 418.104(b), physician signature and cosignature, and standing orders.

---

## Primary Users

- RN / Case Manager, LPN/LVN (drafts)
- MD, NP, PA, Hospice Physician, Medical Director (sign)
- Clinical Supervisor
- IDG Coordinator (IDG-requested orders)

---

## Layout Pattern

Use Patient Workspace + Work Queue.

```text
Patient view:
  Patient Banner
  Orders Summary
  Orders List  |  Right: Order Detail / Signatures / Verbal Deadline / Fulfillment

Signature inbox (global):
  KPI Strip
  Orders Awaiting Signature  |  Right Detail
```

---

## Order Kinds

- Lab
- DME
- Level-of-care change (RHC / CHC / IRC / GIP)
- Recertification
- Comfort kit
- Supply
- Ancillary service (PT / OT / ST / RT / nutrition)
- IDG-requested

---

## Signature Inbox Columns

- Patient
- Order · kind
- Priority (routine / stat / asap)
- Status
- Verbal deadline (countdown)
- Cosign status
- Owner

---

## Order Detail

- Per-kind order data
- Ordering physician · drafter
- Signatures (signature / cosignature / verbal attestation)
- Verbal-order deadline
- Linked care-plan intervention · source encounter
- Fulfillment status (DME/supply/comfort-kit via M21; lab transmission via M29)

---

## Statuses

`Draft`, `Pending Signature`, `Verbal Pending`, `Active`, `Completed`, `Discontinued`,
`Expired Unsigned`.

---

## Verbal-Order Workflow

1. RN records the verbal order with attestation (100–2000 chars) → `Verbal Pending`
   (clinically active).
2. Ordering physician signs before the deadline (≤ 48h, tenant-tightened) → `Active`.
3. Past deadline unsigned → `Expired Unsigned` + high-severity alert to medical director,
   clinical supervisor, compliance.

Show a live countdown on `Verbal Pending` orders; pre-expiry nudges at 12h and 2h.

---

## Cosignature

LPN-drafted kinds (per tenant policy) require RN/Clinical-Supervisor cosignature before the
order may go `Active`; surface `cosign pending` → `attached`.

---

## Special Flows

- **Level-of-care change** — from/to level, effective date, justification; RHC→GIP
  escalation requires medical-director cosign.
- **Recertification** — non-verbal; MD/DO or hospice physician only; drives benefit-period
  sequencing.
- **Lab** — on sign, transmits ORM to the reference lab; track transmission + results;
  clinician-only "Mark reviewed" closes the order.
- **Standing orders** — signed template spawns instances on cadence (spawned instances do
  not re-require signature).
- **Discharge cascade** — active/verbal-pending orders auto-discontinue on admission
  discharge.

---

## Empty State

No orders: "No active orders for this patient." → New Order, Record Verbal Order.

---

## Actions

- Create order · Record verbal order
- Request signature · Sign (step-up)
- Cosign
- Discontinue (reason) · Renew
- Mark reviewed (labs)
- Create standing order

---

## Pencil Notes

Create versions for:

- Verbal pending (countdown)
- Physician signature inbox
- Cosign-required state
- Level-of-care change order
- Expired unsigned (compliance)
