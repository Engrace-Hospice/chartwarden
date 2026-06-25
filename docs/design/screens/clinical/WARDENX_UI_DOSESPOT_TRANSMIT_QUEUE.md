# WARDENX_UI_DOSESPOT_TRANSMIT_QUEUE

Version: 1.0
Status: Screen Specification
Module: DoseSpot Transmit Queue (M12)

---

## Purpose

The operations surface for **outbound NewRx transmission to DoseSpot**. A signed
`medication_order` enqueues a `dosespot.transmit_newrx` job; the queue moves through
`signed → queued_for_transmission → transmitted`, then a DoseSpot webhook flips it to
`ack_received` (pharmacy acknowledged) or `nack_received` (pharmacy rejected). This screen
monitors that pipeline: in-flight transmissions, NACK responses needing clinician attention,
transmission-failure retries, and the **degraded-mode** state where a DoseSpot adapter outage
flips the per-tenant `dosespot_degraded` flag and signed drafts queue until recovery.

---

## Primary Users

- Clinical Supervisor / Pharmacy coordinator
- Prescribers (NACK / transmission-failed resolution on their own orders)
- Ops / on-call (degraded-mode monitoring and drain status)

---

## Layout Pattern

Use Status Board.

```text
Status Header (DoseSpot adapter health · queue depth · degraded flag)
Service Card grid (Queued · Transmitting · Awaiting Ack · NACK · Failed)
Transmission Timeline  +  Webhook / Integration Status
Operational Controls (degraded-mode banner · retry · drain)
```

---

## A. Status Header

- DoseSpot adapter health (circuit-breaker state: closed / half-open / open)
- Queue depth (orders in `queued_for_transmission`)
- **Degraded-mode flag** — `dosespot_degraded` per tenant; when true, a persistent banner
  reads "e-prescribe temporarily unavailable; drafts will queue"

---

## B. Service Cards (by transmission state)

Each card counts orders and is a saved filter into the timeline:

- **Queued** — `queued_for_transmission`; job in flight or waiting; adapter not yet called
- **Transmitting** — adapter call in progress
- **Awaiting Ack** — `transmitted`; DoseSpot accepted, pharmacy ack pending (24h webhook window)
- **NACK** — `nack_received`; pharmacy rejected; high-severity, prescriber attention required
- **Failed** — `transmission_failed`; retry budget exhausted (terminal); survey evidence preserved

---

## C. Transmission Timeline

Per order: order id (IBM Plex Mono) · drug · patient (masked) · pharmacy (NCPDP) · current
state · attempt count · `dosespot_prescription_id` on success · last event timestamp. Rows
expand to the per-attempt audit (idempotency key `(prescriber_membership_id, patient_id,
rx_business_key)`, status code, `DegradedError` shape — never request/response bodies).

---

## D. Webhook / Integration Status

- Last DoseSpot webhook received · signature-verification status (HMAC-SHA256, 5-min tolerance)
- Dedup state (`dosespot_event_id`); replayed/duplicate webhooks shown as deduped
- ScriptStatusUpdate stream feeding ack / nack transitions

---

## Operational Controls

- **Degraded-mode banner** — surfaces the per-tenant flag; on recovery the
  `dosespot.transmit_queued` worker drains the queue and the banner clears
- **Retry** a `transmission_failed` order (creates a new `medication_order` with
  `replaces_medication_order_id` set — never an in-place retransmit)
- **Drain now** — manual trigger of the queued-transmission worker (ops, audited)

---

## Statuses

`signed` → `queued_for_transmission` → `transmitted` → `ack_received` (→ `active`) /
`nack_received` / `transmission_failed`. Degraded mode holds orders in
`queued_for_transmission` with `dosespot_send_state='queued'` until the adapter recovers.

---

## Guardrails

- **NACK** does not auto-resolve — the order stays in `nack_received` until the prescriber
  discontinues or revises; an M36 high-severity alert goes to prescriber + supervisor.
- **Retry blocked** for controlled substances when the tenant is no longer EPCS-certified.
- Drain / retry are ops actions requiring permission and are audited.

---

## Provenance & Sensitivity

- **AI-prohibited.** No AI may transmit, retry, or resolve a transmission outcome (medication
  AI hard-block, AI Governance §2.1.1).
- Order ids, `dosespot_prescription_id`, NCPDP pharmacy ids render in IBM Plex Mono. Adapter
  logs expose only correlation ids and status codes — PHI is never logged in the clear.

---

## Empty State

No transmissions in flight: "Transmission queue is clear." Cards read zero; the timeline shows
recently completed transmissions for the period.

---

## Pencil Notes

Create versions for:

- Board active — healthy adapter, mixed Queued / Awaiting-Ack counts
- **NACK** state — pharmacy-rejected card highlighted + high-severity alert + resolution actions
- **Transmission-failed** + retry (creates replacement order) flow
- **Degraded mode** — outage banner, adapter circuit open, drafts queuing
- Recovery drain — worker draining the queue, banner clearing
- Webhook integration panel — signature-verified vs deduped/replayed event
- Empty state — queue clear
- Loading skeleton; no-permission (read-only board, drain/retry hidden)
