# ADR-0044 — EVV launch aggregator: Sandata multi-state adapter, not OR-PTC DCI

- **Status:** **Accepted** — ratifies the as-built adapter set (2026-08-14).
- **Date:** 2026-08-14
- **Supersedes (clause):** ADR-0008 Decision 4 ("Launch state is Oregon … the launch aggregator
  adapter uses Oregon Medicaid (OR-PTC / the Oregon aggregator)"). ADR-0008's Decisions 1–3 and 5
  — Medicare EVV never `regulatory_required`, Medicaid EVV state-scoped, no HQRP EVV measure,
  aggregators are INT-002 PHI integrations — stand unchanged (and Decision 1 is now enforced in
  `packages/billing/src/rules/evv-coherence.ts` as of the same audit).
- **Related:** [ADR-0008](ADR-0008-evv-applicability.md), `CHARTWARDEN_INTEGRATIONS` §2 row 26.

## Context

ADR-0008 corrected the Texas-modeled examples by picking Oregon (the Phase-1 tenant's state) as the
launch aggregator target. What shipped instead is **Sandata plus the open-model pattern**:
`packages/evv-aggregators` implements a per-state pluggable adapter registry with a Sandata adapter
whose Phase-1 launch set is TX/FL/PA/OH/NC; no OR-PTC DCI adapter exists. The integrations catalog
already records this honestly ("what `packages/evv-aggregators` actually implements; OR-PTC DCI is
NOT built") — but no ADR ratified the swap, leaving ADR-0008 D4 formally violated.

## Decision

1. **The launch aggregator adapter is Sandata**, behind the per-state pluggable adapter registry;
   additional state adapters (HHAeXchange, Tellus, CareBridge — and OR-PTC DCI if/when the Oregon
   tenant's Medicaid program requires submission) are Phase-2 adapter work behind the same pattern.
2. An Oregon go-live that requires state-aggregator submission must add the Oregon adapter first —
   the applicability decision stays per `(state × payer program × service type)` per ADR-0008 D1.

## Consequences

- ADR-0008 D4's Oregon-example sweep is void; the worked examples follow the shipped adapter.
- **Still open (backlog, from ADR-0020 D2):** the EVV aggregator adapter performs no BAA-status
  precondition before resolving production credentials — the start-refusal that M19/M22 implement
  is absent here and must be added when any aggregator goes live.
