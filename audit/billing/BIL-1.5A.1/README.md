# BIL-1.5A.1 — Recovery, Financial Safety & Observability

## Executive result

**Source status: CONDITIONAL.** This sub-phase adds an immutable recovery audit table and fenced/idempotent state transition service, a fail-closed M25 hold when an 835 lacks a usable TRN/content identity, fixed-label Claim.MD worker metrics, targeted M25 review route tests, and PostgreSQL scenarios in the existing destructive live M25 harness.

The recovery store and authorization boundary are implemented, but no privileged operator route/CLI currently composes them. Recovery is therefore **not operator-operable yet**. The DB concurrency scenarios are present but not runtime-certified because `CHARTWARDEN_TEST_DATABASE_URL` is absent. No worker, Claim.MD request, posting activation, or migration was run.

## Changes

- Migration `1360_m25_claimmd_era_recovery_audit.sql` adds the platform-only recovery ledger; `claimmd_capture` receives select/insert only.
- M25 recovery locks the inbox row, checks expected state/version, preserves source bytes/cursor and verified ownership, caps capture/delivery recovery, and records immutable outcome history.
- Recovery retries with the same action UUID return the committed receipt after lock acquisition. Failed state checks attempt to persist a safe rejected receipt.
- M25 posting now holds an advice with missing TRN or missing immutable content digest before creating financial lines.
- Fixed-label Prometheus metrics are updated from response capture, identity, acknowledgment, and ERA worker tick summaries.
- Route tests exercise actual Fastify registration and the `remittance.read` permission prehandler.

## Remaining hard blockers

1. Add a platform-ops authorized, step-up protected invocation path for the recovery service; do not expose it to tenant routes.
2. Run the existing M25 live suite on a private disposable PostgreSQL instance, including the new concurrent cases; verify RLS, migration grants, lock behavior and final DB state.
3. Expand worker metrics/readiness to report cursor age, lease contention, oldest unresolved/undelivered records, and bounded stage totals. Current metrics are tick-derived aggregates, not a complete operational dashboard.
4. BIL-1.5A.2 must resolve immutable evidence compatibility for Medicare NOE/NOTR/Transfer notices.

## Safety statement

New Claim.MD feature flags remain default-off. M25 review is read-only. Claim.MD ERA staging remains non-posting. A held financial identity requires operator review; it is not automatically retried into posting.

See [TEST_RESULTS.md](./TEST_RESULTS.md), [REMAINING_BLOCKERS.md](./REMAINING_BLOCKERS.md), and [NEXT_PHASE_READINESS.md](./NEXT_PHASE_READINESS.md).
