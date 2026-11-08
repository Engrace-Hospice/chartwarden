# BIL-1.4.1B — Safe M25 Staging Delivery & Idempotency

## Verdict

**CONDITIONAL GO** for BIL-1.5 implementation. The source path is implemented as protected, tenant-scoped M25 staging with a recoverable delivery receipt. It has no posting-capable dependency. Focused tests and targeted compile/static checks pass. Private PostgreSQL/RLS/concurrency certification and operational review remain outstanding, so no activation is authorized by this report.

## Implemented

- Delivery revalidates the captured source, account/environment, source digest, current verified BIL-1.4.1A resolution, algorithm version, and resolution history before staging (`apps/backend/src/modules/25-remittance/ingest/claimmd-era-store.ts`, `claimmd-era-delivery.ts`).
- M25 persists a tenant-owned, encrypted, held stage row; it becomes review-eligible only after the central delivery receipt commits (`claimmd-era-stage.ts`). It does not invoke `receiveAdvice`, `postAdvice`, or the outbox.
- Migration 1358 adds source/provenance fields and a central delivery ledger/history. Existing stage rows remain valid because new stage fields are nullable; idempotency uniqueness applies to populated keys.
- Delivery activation is a separate exact-string opt-in, disabled when absent or invalid. It is restricted to worker roles and has no Claim.MD HTTP client (`claimmd-era-config.ts`, `apps/backend/src/index.ts`).
- Reused legacy M25 intake is serialized against staging using a shared transaction advisory lock. Weak duplicate evidence is held for review.

## Files

Implementation includes M25 delivery/staging/store/runtime files, M1 provider reader use, X12 parser transaction-set identity support, migration 1358, schema/manifest/RLS updates, and focused tests. The preceding BIL-1.4.1A files and migration 1357 remain present in this worktree as part of the same uncommitted phase chain; they are not BIL-1.4.1B-only changes.

## Limits

The cross-source comparison reads existing M25 advice rows and conservatively handles weak matches. It does not prevent an independent posting from every legacy source using every possible financial identity. M25 review UI consumption of encrypted staging details and an audited internal requeue workflow are not established here. No live database, Claim.MD account, or deployment was exercised.

See [TEST_RESULTS.md](./TEST_RESULTS.md), [RELEASE_BLOCKERS.md](./RELEASE_BLOCKERS.md), and [NEXT_PHASE_READINESS.md](./NEXT_PHASE_READINESS.md).
