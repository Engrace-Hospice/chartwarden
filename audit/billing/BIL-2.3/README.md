# BIL-2.3 — Commercial Claim Correction Lifecycle

## Result

This phase adds a narrowly supported correction workflow for a **verified clearinghouse rejection before any payer response**. It creates a separate original-frequency claim draft from current authoritative M41 source data, preserves the rejected claim and its submission history, and links the new draft to the original. Existing original claim creation, validation and sending remain the M41 workflow.

Payer-accepted replacement/void transactions are deliberately blocked because the repository has no verified plan-specific replacement rules or payer control-reference contract. No payer control number is synthesized, no accepted claim is overwritten, and no payer-stage status is treated as a clearinghouse rejection.

## Included

- Durable correction lineage and idempotency constraints, with a database trigger protecting tenant/patient/plan/route scope and allowing overlap only within the same correction chain.
- An authenticated, provider-scoped API operation that requires the existing write authorization and idempotency middleware.
- A claim detail action and linked-claim navigation for eligible rejected claims.
- Focused service/database and DOM coverage.

## Not certified

No live Claim.MD request, production migration, deployment, payer-specific accepted-claim replacement, void transaction, or automatic financial posting is part of this phase. The live PostgreSQL suite outcome is recorded in `TEST_RESULTS.md`.
