# WARDENX_UI_FACILITY_SUPPLY_OPERATIONS

Version: 1.0
Status: Screen Specification
Module: SUPPLIES & IPU (M21, M37)

---

## Purpose

This screen manages the agency's physical operating layer: contracted GIP/IRC facilities and
their inpatient units, the room-and-board contracts that govern them, bed inventory within each
facility, supply stock by location, and the supply transaction ledger. It is the master-data and
inventory hub behind inpatient hospice and medical-supply operations.

---

## Primary Users

- Operations Manager / IPU Coordinator
- Supply / Materials Manager
- Administrator
- Biller (room-and-board reconciliation)

---

## Layout Pattern

Use Admin Hierarchy Layout.

```text
Page Header (entity · facility count · active beds)
Entity Tree (Facility → Unit → Room/Bed; Supply Locations)
  |  Selected Entity Detail  |  Right: Configuration / Validation
```

---

## Facility Master

- Facilities of type GIP, IRC (and contracted SNF/hospital units), each with NPI/address/contact
- Contract status: active, pending, expired, terminated — with effective dates
- Active bed count and current census per facility
- Validation surfaces missing contract, expired terms, or facilities with beds but no contract

## Facility Contract Manager

- Room-and-board rates (per-diem), effective-dated, by level of care
- Notification terms (admit/discharge/transfer notice windows), billing pass-through rules
- Contract documents attached; amendments append-only with effective dates
- Prior-rate comparison for reconciliation

## Bed Inventory

- Room → bed tree per facility unit; each bed: type (GIP/IRC/respite), status
- Bed status: available, occupied, reserved, out-of-service, cleaning
- Occupant link (to patient/admission) when occupied; status changes are append-only/audited

## Supply Inventory

- Stock on hand by location (warehouse, facility, vehicle/clinician bag)
- Par levels and reorder points per item per location; below-par items flagged
- Item master: SKU, description, unit of measure, category (DME, wound, comfort kit)
- Reorder Guard Chip on any below-reorder-point item with a deep-link to create an order

## Supply Transaction Ledger

- One row per movement: received, dispensed, returned, destroyed, transferred
- Quantity (`tabular-nums`), location from/to, actor, timestamp, linked patient where dispensed
- Destruction rows require reason + witness; ledger is append-only

---

## Statuses

Facility: `Active`, `Pending`, `Expired`, `Terminated`. Bed: `Available`, `Occupied`,
`Reserved`, `Out of Service`, `Cleaning`. Supply item: `In Stock`, `Below Par`, `Reorder`,
`Out of Stock`.

---

## Edit Rules & Sensitive Data

- Contract rates are effective-dated and append-only; changing a posted rate creates a new
  effective row.
- Bed occupancy is state-machine guarded (admit/transfer/discharge); a bed cannot go
  out-of-service while occupied without a transfer.
- Below-reorder-point items raise a Guardrail chip but never block dispensing.
- Destruction ledger rows require reason + witness and are non-erasable except via M04 eraser.
- Dispensed-to-patient rows carry patient_id and inherit PHI access rules.

---

## Actions

- Add / edit facility
- Manage facility contract (effective-dated rates)
- Add / retire bed; change bed status
- Adjust par / reorder points
- Record supply transaction (receive / dispense / return / destroy)
- Generate reorder

---

## Empty State

No contracted facilities yet: tree shows "No facilities", detail pane explains GIP/IRC requires
a contracted facility, with a link to add the first one.

---

## Pencil Notes

Create versions for:

- Facility master (mixed contract statuses)
- Contract manager (effective-dated R&B rates)
- Bed inventory tree (occupied / out-of-service)
- Supply inventory (below-par reorder chips)
- Supply transaction ledger (destruction row, witness)
