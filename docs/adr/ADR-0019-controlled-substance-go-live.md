# ADR-0019 — Controlled-substance go-live: lawful Phase-1 non-EPCS path, authenticated standing orders, SUPPORT Act disposal, witness scope

- **Status:** Accepted
- **Date:** 2026-06-11
- **Phase:** 4 (controlled-substance correctness — blocks core comfort-med care)
- **Resolves:** M12-F02, M13-F03/F04/F05, M11-F02, M21 (disposal)
- **Changes:** `WARDENX_MODULE_11_ORDERS`, `WARDENX_MODULE_12_DOSESPOT_PRESCRIBING`, `WARDENX_MODULE_13_EMAR`, `WARDENX_MODULE_21_SUPPLIES`

## Context

EPCS (electronic prescribing of controlled substances) is deferred to Phase 3, but the v0.x specs
left **no lawful Phase-1 path** to order, sign, activate, or administer any Schedule II–V
medication — i.e., **the core hospice comfort-kit opioids could not be used at go-live**. That is a
patient-care blocker.

## Decision

### D1 — A lawful Phase-1 non-EPCS controlled-substance path exists (M12-F02 / M13-F03)

Until EPCS is enabled, controlled-substance medication orders are supported via the **non-EPCS
prescription path**:

- The EHR **records** the medication order (drug, schedule, dose, route, frequency, prescriber) and
  drives the eMAR, exactly as for non-controlled meds.
- The **prescription itself is transmitted lawfully without EPCS**: a Schedule II Rx is issued as a
  **manually-signed paper/printed DEA-compliant prescription** (or the prescriber's own external
  EPCS system); Schedule III–V per oral/fax rules where the state permits. The EHR captures the
  prescription artifact reference and the prescriber's wet/qualified signature attestation.
- **Ordering, signing, activating, and administering** a Schedule II–V medication is therefore
  **fully functional in Phase 1** — the EPCS deferral governs only the *electronic transmission*
  channel, not the clinical order/administration workflow.

### D2 — Standing orders are authenticated (M11-F02)

The standing-order spawner must execute against an **authorized prescriber's signed standing-order
protocol** — it may **not** create or activate controlled (or any) orders **unauthenticated**. Each
spawned order carries the authorizing protocol reference and the prescriber identity; controlled
substances additionally require the prescriber's controlled-substance authority on file.

### D3 — SUPPORT Act at-home disposal documentation (M13-F05 / M21)

Per the SUPPORT Act, hospice staff may **dispose of a patient's controlled substances on-site** in
the home after discontinuation or death. M13/M21 capture the **disposal record**: drug, quantity
disposed, **method** (on-site rendering non-retrievable), date, and **disposing-staff +
witness/attestation**. The physical-retrieval model that conflicts with on-site destruction is
removed in favor of the on-site-disposal posture.

### D4 — Administration witness rule scoped for solo home hospice (M13-F04)

A **mandatory double-witness for every controlled administration is unworkable** in solo home
hospice and creates a perverse caregiver-attested bypass. The witness requirement is scoped to
**waste/disposal of a controlled substance** (where a second witness is feasible and meaningful) and
to **inpatient** administration; routine **in-home administration by a lone clinician** is recorded
with the clinician's attestation + the eMAR controlled-substance accounting (lot, count, waste), not
a fabricated second witness.

## Consequences

- M12/M13 specify the non-EPCS prescription path so Schedule II–V meds are orderable/administrable at
  go-live; EPCS (Phase 3) becomes an additive transmission channel, not a precondition for care.
- M11 authenticates the standing-order spawner; M13/M21 add the SUPPORT Act disposal record; the
  witness rule is scoped to waste/disposal + inpatient.
