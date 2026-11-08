# Release blockers

## Block controlled-test resolver activation

1. **P1 — PostgreSQL behavior unverified.** Apply migrations 1350–1353 only to a private disposable cluster. Verify role grants, FORCE RLS, platform audit events, cross-tenant isolation, lease token fencing, history append-only behavior, duplicate requeue protection, and source reads as real roles.
2. **P1 — inbox encryption/runtime configuration absent from current deploy evidence.** Configure the secret-manager `CLAIMMD_RESPONSE_INBOX_KEYRING` with current and historical keys, confirm M34 tenant DEK service can open synthetic tenant evidence, and verify the prebootstrapped `claim_responses` stream matches account reference/environment.
3. **P1 — BIL-1.1 capture runtime remains inactive.** The resolver consumes captured inbox records but does not create them or advance cursor. Before end-to-end controlled processing, register/configure the BIL-1.1 capture service and validate its full-page durable capture separately, or provide an isolated synthetic captured page.
4. **P1 — account-wide platform privilege deployment not runtime inspected.** Verify `DATABASE_PLATFORM_URL` login inherits only required integration reads/writes and audit insert; candidate source column grants must work without using a superuser.
The previous architecture blocker was removed after `bun run arch:tables` passed. BIL-0 and BIL-1.1 reports are present under their requested `docs/billing/` location, so the old `audit/billing/` path absence is not a release blocker. These source and documentation findings do not certify a live database role or authorize activation.

## Block production rollout

6. **P1 — Claim.MD semantics not test-account certified.** Confirm vendor `claimid`, `claimmd_id`, `remote_claimid`, `fileid`, `inboundid`, `batchid`, and PCN field semantics and namespace guarantees with synthetic test-account fixtures; this PR makes no live call.
7. **P1 — historical legacy rows lack immutable evidence.** They remain unmatched/review-only. No speculative backfill was added.
8. **P1 — M23 NOE/NOTR/transfer notice gap.** Current Claim.MD notice callers do not supply per-attempt evidence metadata and correctly fail closed. A narrow metadata propagation fix plus tests is required before enabling affected workflows; do not bypass the gate.
9. **P2 — operations metrics/alerting incomplete.** Safe log counts and oldest age are present, but no dedicated metrics, DLQ, or alert thresholds exist for resolver backlog, key failures, candidate overflow, or lease contention.
10. **P2 — operator requeue has no approved CLI/front door.** The privileged audited store method exists but no operator invocation tool is delivered; add a guarded internal runbook/CLI before support reprocessing is operationally available.

No BIL-1.3 status application, ERA processing, payment posting, production activation, live Claim.MD call, or migration execution is included.
