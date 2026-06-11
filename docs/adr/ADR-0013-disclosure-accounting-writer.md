# ADR-0013 — §164.528 accounting-of-disclosures: the disclosure-record writer at every egress

- **Status:** Accepted
- **Date:** 2026-06-11
- **Phase:** 3 (governed subsystems)
- **Resolves:** H1; M39-F03; M04 (sink ownership), M32-F08, M28/M22/M29/M05 egress accounting
- **Changes:** `WARDENX_MODULE_39_CONSENT`, `WARDENX_MODULE_04_AUDIT`, and the disclosing modules (M22/M28/M29/M05/M32)

## Context

HIPAA §164.528 requires a queryable per-patient accounting of **actual disclosures** (date,
recipient, description, purpose). The audit found this broken and mis-owned:

- **M39 conflates consent *evaluation* with *disclosure*.** Its `consent_eval_audit` logs
  `evaluate()` decision calls — which fire on **internal access**, not only disclosures — and it
  declares that log to be the §164.528 feeder. That is wrong on both ends: it over-captures
  (internal access ≠ disclosure) and under-captures (not every disclosure traverses an M39
  `evaluate()`).
- **Major disclosure paths write no accounting record at all:** M28 `$everything`/bulk `$export`,
  M22 signed-URL mint, M05 §164.524 patient-access export, M29 outbound HL7, M32 cloud AI calls.
- **M4 owns the §164.528 sink** (ARCH-240) but no module writes the disclosure record into it at
  the egress boundary.

## Decision

### D1 — M4 owns the accounting-of-disclosures sink; M39 does not redefine it

§164.528 ownership stays with **Module 4**. M39's `consent_eval_audit` is a **consent-decision
audit**, renamed to make that explicit, and **must not** be presented as the §164.528 feeder. M39
publishes the `ConsentEvaluator` seam (evaluation, fires on access) — a **separate** concern from
disclosure accounting.

### D2 — The disclosing module writes the disclosure record at the point of actual disclosure

Every module that **discloses PHI across a boundary** writes a §164.528 accounting record to M4's
sink (via M4's `recordDisclosure(...)` helper / outbox), **at the moment of disclosure**,
independent of consent evaluation:

| Egress | Disclosing module | When |
|---|---|---|
| FHIR read / `$everything` / bulk `$export` | M28 | per external request (recipient = the FHIR client) |
| Signed-URL document mint / §164.524 export | M22 / M05 | per URL mint / per export |
| Outbound HL7 (ORM/ADT/results) | M29 | per outbound message (recipient = the trading partner) |
| Cloud AI invocation | M32 | per `ai.phi_disclosed` event (recipient = the AI vendor) — ADR-0012 D3 |
| Portal / collaborator / funeral-home read | M31 / M02 session class | per external-actor access |

Each record carries `{patientId, recipient, purpose, description, disclosedAt, sourceModule}`. TPO
(treatment/payment/operations) internal access is **not** a §164.528 disclosure and is captured by
ordinary read-audit, not this sink.

### D3 — The §164.528 query enumerates the disclosure sink, not consent evaluations

M4's accounting query (6-year lookback, TPO-excluded) reads the disclosure records from D2. The AI
disclosure accounting (M32) is satisfied by enumerating `ai.phi_disclosed` (ADR-0012 D3), keyed off
`ai_model_backend.kind='cloud'`.

## Consequences

- M39 relabels `consent_eval_audit` and removes the §164.528 claim (M39-F03); the `ConsentEvaluator`
  seam stays the access-time gate.
- M4 specifies the `recordDisclosure` helper + the disclosure-record table/partition; the disclosing
  modules call it at egress (cross-module pass reconciles each producer↔M4 pair).
- Bulk egress (M28 `$export`, M22) must not flood the sink per-resource — record **once per
  recipient/request** at the disclosure boundary (M39-F15 perf note).
