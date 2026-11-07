# Next-phase readiness

## Three separate decisions

The BIL-1.2.2B ownership correction is implemented and `arch:tables` now passes. M1 and M41 source facts are read through owner-exported internal readers in the same audited repeatable-read transaction. This is implementation verification, not live role/RLS certification.

### A. BIL-1.3 implementation readiness — CONDITIONAL GO

BIL-1.3 development may begin as inactive code using the resolved-event identity contract in `BIL_1_3_HANDOFF.md`. Keep status application behind a separate false-by-default dispatch control, preserve source provenance, and do not treat identity as acceptance. No acknowledgment state mutation should run in this phase's tests except explicitly mocked dispatch logic.

### B. Controlled-test resolver activation readiness — NO-GO

Do not enable the worker in a shared or actual Claim.MD account yet. First run migrations and focused RLS/lease tests in a private disposable Postgres cluster, configure the inbox keyring and tenant key lifecycle, prove stream bootstrap, and feed synthetic captured inbox events through the concrete M23/M41 adapters. BIL-1.1 capture is not runtime-registered in this checkout, so a synthetic harness or its separately gated runtime wiring is necessary.

### C. Production activation readiness — NO-GO

Production lacks database role/RLS certification, account-specific vendor namespace evidence, confirmed keyring deployment, full BIL-1.1 capture runtime, and M23 notice evidence compatibility. Legacy rows without immutable evidence must remain in review. No status application or financial processing is allowed from this verdict.

### D. Existing draft PR review readiness — CONDITIONAL GO

The source architecture blocker is resolved. Keep the PR in draft while final code review and CI run; do not merge or enable the worker on source checks alone. Private database tests are activation blockers and should be tracked explicitly in review, not described as already passed.

## Result

The concrete candidate provider and runtime composition make the existing matcher executable in code. The cross-owner read correction passes the static ownership gate and uses one consistent snapshot. Runtime certification depends on private PostgreSQL and approved synthetic Claim.MD test fixtures that were not available. Next-phase development may continue inactive; controlled and production enablement remain blocked.
