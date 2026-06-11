# ADR-0023 — Consumer↔producer seam-pair reconciliation + M2 surface (X10, X12)

- **Status:** Accepted
- **Date:** 2026-06-11
- **Phase:** 6 (cross-spec reconciliation)
- **Resolves:** X10, X12; M13↔M12, M14→M16, M15→M14, M19 phantom seams, M25→M22, M2 surface inflation
- **Depends on:** [ADR-0005](ADR-0005-manifest-single-source-of-truth.md)
- **Changes:** the paired specs; `WARDENX_MODULE_02_IDENTITY`

## Context

Modules bind to seams/events their producers never publish ("contract phantoms", X10), and M2's
authoritative surface is asserted by consumers to contain rows it does not (X12). A consumer that
compiles against a non-existent seam is a latent boot failure (`validateSeams()` only catches a
missing *registration*, not a producer that never declared the contract).

## Decision

### D1 — Every consumer↔producer seam pair is reconciled before either spec is honored as "Locked"

For each cross-module seam or outbox event, the **producer must declare it published** and the
**consumer must declare it consumed**, with matching payload types in `packages/types`. The seam
registry (`REQUIRED_SEAMS`) + the outbox-event catalog are the source of truth. The cross-module
pass reconciles these phantom pairs:

| Consumer expects | Producer must publish | Finding |
|---|---|---|
| M13 reconciliation consumers + lineage column | M12 | M13-F08 |
| M14 `bereavement_risk_flag` decision | M16 consumer must exist | M16-F03 |
| M15 IDG-decision target | M14's locked decision envelope | M15-F07 |
| M19 `voice_dial` / M16 reverse-lookup seams | M36 / M16 (don't exist) | M19 phantoms |
| M25 writing `packages/forms` | M22 must list M25 as a consumer | M25 |
| M9/M10 ← M8 completeness | resolved by **ADR-0007** (boot-registered completeness seams) | — |

A seam a consumer needs that no producer publishes is either (a) published by the producer in the
same change, or (b) the consumer drops the binding. **No spec is "Locked" with a dangling seam.**

### D2 — M2 surface inflation resolved (X12)

Surfaces consumers assert on M2 that are **absent from M2's authoritative `ownedTables`** —
`device_attestation`, `step_up_session`, emergency-contact rows, a "KMS path" — are adjudicated:
each is **either** added to M2 (a real manifest `ownedTables` edit, like `tenant_step_up_policy_override`
was in Phase 1) **or** declared vapor and removed from the consuming spec. M2's published session
interface (incl. the step-up fields, ADR resolved in Phase 1) is the contract; consumers bind to
that interface, not to assumed columns. Foundation-helper reachability (the "modules whose
`dependsOn` omits 1–4 still call `audit()`/`withOrgContext`/`requirePermission`") is already resolved
by **ADR-0005 D4** (`FOUNDATION_HELPER_PACKAGES`).

## Consequences

- The cross-module pass produces a reconciled seam/event matrix; each phantom pair is fixed at the
  producer or dropped at the consumer before re-lock.
- M2's owned surface is settled (added-or-removed per item); consumers bind to the published
  interface. No "Locked" status is honored while a consumed seam has no producer.
