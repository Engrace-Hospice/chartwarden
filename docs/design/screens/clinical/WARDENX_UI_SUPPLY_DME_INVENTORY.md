# WARDENX_UI_SUPPLY_DME_INVENTORY

Version: 1.0
Status: Screen Specification
Module: Supplies, DME & Comfort Kits — Inventory (M21)

---

## Purpose

This screen is the **physical-stock and replenishment** surface at the supply hub: on-hand stock
by category, low-stock reorder, the DME equipment tracker (serial number, maintenance due,
battery), and the supply-transaction ledger. It is the operational inventory side of M21, distinct
from the patient-facing Supplies / DME / Comfort-Kit dispatch screen.

Where the patient-facing screen tracks one patient's order through its fulfillment lifecycle, this
screen answers "what do we have on the shelf, what is below par, which DME units are deployed and
when is the next maintenance due, and what moved in or out of the hub?" Par-stock monitoring at the
Location-level supply hub is the backbone (per `par_stock` per org / location / SKU), with the
nightly `par-monitor` emitting below-threshold alerts.

---

## Primary Users

- Supply-Team Lead / Inventory Manager
- Controlled-Substance Dispatcher (eligible role only)
- DME Coordinator
- Location Administrator
- Compliance Officer (controlled-substance ledger review)

---

## Layout Pattern

Use Work Queue.

```text
Top Navigation
Page Header (Stock · DME Tracker · Ledger tabs)
KPI Strip
Filter Bar (location · category · HCPCS · par status · vendor)
Inventory Table  |  Right Detail Panel (SKU stock / DME unit / transaction)
```

---

## KPI Cards

- SKUs below par (reorder)
- Stockouts (zero on-hand)
- DME units deployed
- Maintenance due (next 30 days)
- Controlled-substance discrepancies (open)
- Pending reorders (in transit)

---

## On-Hand Stock View

The default tab. Stock by category, keyed by HCPCS where billable.

Columns:

- SKU / item name
- HCPCS code
- Category (DME, consumable supply, comfort-kit medication)
- Location / supply hub
- On-hand quantity
- Reorder point (par)
- Current severity (derived: OK / low / stockout)
- Assigned vendor
- Last movement

Below-par rows are flagged; the reorder action drafts a replenishment dispatch routed by the
deterministic vendor-routing rule (per-tenant default → per-Location override → per-SKU pin).

---

## DME Equipment Tracker

A second tab tracking durable equipment as physical assets (hospital bed, oxygen concentrator,
wheelchair, BiPAP):

- Serial number
- Model / HCPCS
- Status (in-stock, deployed, in-maintenance, retired)
- Deployed-to (admission / location, logical FK)
- Deployment date
- Maintenance due date
- Battery status / last service
- Rental cadence (`monthly` / `one_time_purchase`)

Units with maintenance overdue or battery low surface as warn-severity rows.

---

## Supply-Transaction Ledger

A chronological ledger of every stock movement: receipts, dispatches, returns, disposals,
adjustments. For controlled-substance kit medications the ledger carries the DEA 21 CFR §1304
perpetual-log data layer:

- Lot number
- Expiration date
- Quantity dispensed / returned / disposed-at-home
- Disposal method + witness (membership)
- Actor + timestamp

A discrepancy ≥ 5% of expected quantity for a controlled-substance medication renders a
survey-investigable discrepancy row.

---

## Sensitivity & Guardrails

- Identifiers (HCPCS codes, DME serial numbers, NDC, lot numbers) render in IBM Plex Mono.
- Free-text fields (reorder notes, special-handling notes, disposal notes) are PHI-denylist
  scrubbed in audit value capture.
- Controlled-substance rows carry `compliance` retention and are gated by the
  `controlled_substance_dispatcher_eligible` ABAC predicate.

Blocked actions show an explicit reason:

- Releasing a controlled-substance dispatch without the eligible role → "Requires controlled-
  substance dispatcher eligibility."
- Recording a witnessed disposal where witness equals reconciler → "Witness must differ from
  reconciler."
- Dispatching against an inactive source order → "Source order is not active."
- AI is **prohibited** from creating, modifying, witnessing, or attesting any controlled-substance
  dispatch or return row (boot-time `validateSupplyAIBlock`); no AI affordance renders here.

---

## Empty States

- No items below par: "All stock is at or above par for this location."
- No DME deployed: "No durable equipment currently deployed."
- Ledger empty: "No transactions in the selected range."

---

## Actions

- Reorder / replenish (vendor-routed)
- Receive stock · adjust on-hand
- Deploy / return / retire DME unit
- Schedule / record DME maintenance
- Record controlled-substance return + reconciliation
- Investigate discrepancy
- Request BOL / packing-slip / return-receipt PDF (M22 renders)
- Export ledger

---

## Pencil Notes

Create versions for:

- On-hand stock table (par status, below-par flag)
- SKU stock detail + reorder action
- DME equipment tracker (serial / maintenance / battery)
- DME unit detail (deployment + service history)
- Supply-transaction ledger
- Controlled-substance ledger line (lot / expiration / disposal)
- Discrepancy investigation state
