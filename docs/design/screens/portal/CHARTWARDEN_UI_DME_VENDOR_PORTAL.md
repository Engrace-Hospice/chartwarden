# CHARTWARDEN_UI_DME_VENDOR_PORTAL

Version: 1.0  
Status: Screen Specification  
Module: PORTAL (M31)

---

## Purpose

A minimal-PHI portal for a durable medical equipment (DME) vendor to see **pending DME orders**
assigned to them, update **delivery and pickup status**, and track equipment through delivery
confirmation and pickup scheduling. The vendor sees logistics, not clinical detail.

---

## Primary Users

- DME vendor dispatcher / driver
- DME vendor account coordinator

---

## Layout Pattern

Use Portal Dashboard.

```text
Portal Header (vendor · account · sign-out)
Pending DME Orders (action needed)
Selected Order Detail (equipment · address)
Equipment Tracking (delivery / pickup)
Messages (logistics)
Urgent / After-hours Contact (persistent)
```

---

## Pending DME Orders

- Orders assigned to this vendor: order id, equipment item(s), requested-by date, status badge.
- Minimal identification: patient initials + delivery address only — no diagnosis, no chart.
- Selecting an order opens its detail and tracking actions.

---

## Order Detail

- Equipment item(s), quantity, delivery instructions, contact-on-site name + phone.
- Delivery window; special handling notes (e.g. oxygen safety).
- No clinical content — equipment and logistics only.

---

## Equipment Tracking

- **Delivery:** mark out-for-delivery, confirm delivery (date/time, optional proof/signature).
- **Pickup:** schedule a pickup, mark picked up; close out the equipment.
- Status changes flow back to the agency supplies/DME module.

---

## Messaging

- Logistics-only thread with the agency (access issues, reschedules, damaged equipment).
- Urgent flag for oxygen / time-critical items.

---

## Statuses

DME order: `Pending`, `Out for Delivery`, `Delivered`, `Pickup Scheduled`, `Picked Up`,
`Canceled`.

Once `Picked Up` or `Canceled`, the order is read-only.

---

## Edit Rules & Sensitive Data

- **Scoped, least-privilege:** the vendor sees ONLY DME orders assigned to their account — no
  patient chart, no clinical data, no other vendors' orders; scope enforced server-side.
- **Minimal PHI:** patient initials + delivery address only; no SSN/MBI/diagnosis ever rendered.
- Writes are limited to delivery/pickup status and logistics messages — no clinical writes.
- Every status update, confirmation, and message is audited with vendor identity.

---

## Actions

- Mark out-for-delivery
- Confirm delivery (date/time · proof)
- Schedule pickup
- Mark picked up
- Message agency logistics (urgent flag)
- Contact agency / after-hours line

---

## Empty State

No assigned orders: "No DME orders are assigned to you right now." Nothing pending: "All assigned
orders are up to date."

---

## Pencil Notes

Create versions for:

- Pending orders list (minimal PHI)
- Order detail with delivery instructions
- Delivery confirmation (proof/signature)
- Pickup scheduling
- Completed / picked-up read-only state
- Empty / no-orders state
