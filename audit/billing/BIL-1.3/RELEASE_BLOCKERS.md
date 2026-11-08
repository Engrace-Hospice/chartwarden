# Release blockers

## Controlled test activation

1. **P1 — Private PostgreSQL proof pending.** Apply 1354–1355 only in a disposable cluster, run the real app/platform roles, prove RLS, `FOR SHARE` privilege, trigger seeding, leases, advisory lock, audit writes, M41 outbox atomicity and crash replay. Static gates and mocks are insufficient.
2. **P1 — BIL-1.1 capture runtime is still not registered in `apps/backend/src/index.ts`.** Register and validate it in its own guarded work before end-to-end capture/ack activation; synthetic preloaded events may be used for isolated BIL-1.3 tests.
3. **P1 — Inherited BIL-1.2.2B key and account setup.** Provide the secret-manager inbox keyring, historical tenant DEKs, bootstrapped account/environment stream and least-privilege platform role; validate all with synthetic data. See `audit/billing/BIL-1.2.2B/RELEASE_BLOCKERS.md`.
4. **P1 — Claim.MD receipt semantics are example-backed only.** Obtain synthetic test-account evidence that `CLMMD` / `ACK` / `A` means clearinghouse receipt in the configured account and payer route. Do not enable apply mode from the documentation example alone.

## Production activation

5. **P1 — Payer/rejection mapping is deliberately unimplemented.** Sender-specific accepted/rejected semantics, out-of-order rules and reason code mapping need verified vendor fixtures and owner-domain tests. Current code holds them as informational and does not present them as rejection/denial workflows.
6. **P1 — No operator path for `needs_review`.** A guarded internal review/requeue path and alert thresholds are needed before unattended use. The ledger preserves held attempts, but the queue stops automatic retries after the cap.
7. **P1 — Legacy/history ambiguity.** Prior M23 Claim.MD `ack_999`/`ack_277ca` rows may carry normalized API statuses; do not reclassify without source evidence. Historical rows without immutable evidence remain unmatched.
8. **P1 — M23 notice evidence gap.** BIL-1.2.2B identified missing at-send metadata for Claim.MD NOE/NOTR/transfer uploads. This branch does not change notice semantics or make those workflows launch-ready.
9. **P1 — Production rollout approval and observation.** Complete CI, private DB tests, synthetic Claim.MD certification, rate/backlog alerting and a staged shadow comparison before production flags can be set.

These are activation blockers, not proof of a current production incident. The branch does not set either dispatcher flag.
