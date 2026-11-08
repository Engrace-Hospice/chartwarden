# Remaining blockers

1. **P1 — contract migration sequencing:** deploy split worker code, quiesce old workers, then apply migration 1379 under the reviewed deployment procedure. Do not roll back to a worker that does not reserve dispatch state.
2. **P1 — uncertain legacy MAC outcomes:** the legacy portal path cannot prove whether a timed-out upload was received. Durable state blocks a resend; authorized operator reconciliation is required.
3. **P2 — broader PostgreSQL/runtime proof:** the private PostgreSQL 18 worker suite verifies a single winner under concurrent calls, no transaction across transport, and no resend after an uncertain result. Separate-process crash/restart, real tenant-role RLS probes, stale token injection, and populated contract-migration recovery remain for cumulative validation.
4. **P2 — direct legacy exports:** deprecated in-transaction processor exports remain for compatibility and must not be bound by another runtime composition.

The frontend/API verification blocker is resolved for this phase: targeted DOM tests, OpenAPI/client checks, and backend/web TypeScript checks passed (see `TEST_RESULTS.md`).

Claim.MD workers, notice upload, acknowledgment application and automatic financial posting remain disabled according to existing configuration. This phase performed no activation.
