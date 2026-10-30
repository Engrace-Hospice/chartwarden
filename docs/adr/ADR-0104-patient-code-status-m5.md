# ADR-0104 — A patient's clinician-set code status is an append-only Module 5 history; Module 22 keeps the source document

- **Status:** **Accepted** (2026-10-29)
- **Date:** 2026-10-29
- **Amends:** architecture §10.6.6 (the "Code status, advance directive content" row, previously Module 22 for both).
- **Related:** F-238 `patient_allergy` (the M5 chart-list precedent), M22 document type `code_status_directive`.

## Context

The chart header must show a DNR / code-status indicator. No table, route or permission holds code status today.
Architecture §10.6.6 assigned "Code status, advance directive content" to Module 22 (a document plus a structured
`CodeStatusDirective`); M39 and M22 module specs instead say M5/M7 hold the reference on the patient. No M5 spec mentions it.
Architecture wins over module specs, so the ownership has to be settled here.

## Decision

- **D1. Ownership.** The clinician-set code status lives in M5 (`patient_code_status`). M22 keeps the source directive
  document (type `code_status_directive` / `advance_directive`). The §10.6.6 row is split accordingly: code status → M5,
  advance directive content → M22.
- **D2. Values.** `full_code`, `dnr`, `dnr_dni`, `comfort_measures_only`. DNI alone is not a value (CPR yes, intubation no is
  not a coherent hospice order; forms record DNR with DNI). "Not recorded" is **not stored**: it is the absence of an active
  row, so a write can never replace a real DNR with a non-answer, and the UI must never render "not recorded" as Full Code.
- **D3. Append-only history.** One row per decision with who, when and a required reason. The current status is the newest row
  that is not entered-in-error. The app role holds SELECT and INSERT plus UPDATE on the entered-in-error columns only, so the
  database itself refuses an edit of a recorded value.
- **D4. Source document.** `source_document_id` is a plain uuid (M22 owns `document`; no cross-module FK). The route validates it
  through the M22 `DocumentReader` seam: it must exist, be readable, and belong to the same patient.
- **D5. Permission.** A new `patient.edit_code_status` key (ABAC `caseload_or_scope`), granted by migration to the physician,
  NP, nurse case-manager, DON and administrator role keys wherever a tenant has created them.
- **D6. Out of scope.** DocLens writeback of an extracted code status from a referral, and an outbox event
  (`m5.patient.code_status_changed`): nothing consumes one yet; add both when a consumer exists.

## Consequences

- M5 gains one table and three routes; the chart banner reads the current value with the other banner facts.
- The banner must refresh after a set, or it shows a stale DNR / Full Code (a safety defect, tested).
