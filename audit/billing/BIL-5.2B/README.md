# BIL-5.2B — Controlled Billing Operations Triage

Adds an M25-owned, read/triage-only investigation overlay for authorized M23 and M41 submission attempts whose outcome is `in_doubt`. The overlay supports assignment, append-only notes, status transitions, resolution outcomes, and history. It never retries or mutates the source submission and has no financial operation.

## Current scope

- Source identity is `M23|M41:submission:<attempt UUID>`; every read and mutation revalidates the source through its owner reader.
- M23 authorization uses the existing `billing.claim.read` grant and provider scope. M41 uses `commercial_billing.read`, provider scope, and the source reader's patient caseload check.
- M24 and M25 source cases are not accepted by this first implementation because no verified source-owner contracts were wired for them.
- Permissions are separate (`billing.operations.read|triage|assign|resolve`) and are not granted to roles by this migration.

## Evidence

See [source contracts](SOURCE_CONTRACTS_AND_SCOPE.md), [state and audit](STATE_AND_AUDIT.md), [security](SECURITY_AND_NONMUTATION.md), and [tests](TEST_RESULTS.md). The live M41 suite is run only with `scripts/test-m25-835-ingestion-private.sh` against its fresh private container.
