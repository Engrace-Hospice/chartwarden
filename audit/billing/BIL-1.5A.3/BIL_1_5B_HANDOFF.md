# BIL-1.5B handoff

## Branch dependency chain

Continue the established BIL-1 branch ancestry; do not merge individual branches into `develop` before cumulative validation and the BIL-1 Release Gate. Expected order remains BIL-1.5A.2 → BIL-1.5A.3 → BIL-1.5B → BIL-1 Release Gate → ordered integration into `develop` → BIL-2. Current working branch is `feat/bil-1-5a-claimmd-runtime-hardening`; its working tree includes previous billing phase changes. No branch merge or PR creation occurred in this phase.

## Validation plan

1. Run all focused BIL-1.1 through BIL-1.5A.3 tests and the required full relevant TypeScript build/test-typecheck.
2. Create a private disposable PostgreSQL instance only; never use shared `os-postgres-1`. Apply migrations from the proper baseline and test as `chartwarden_app`/NOBYPASSRLS plus approved platform principal.
3. Prove tenant isolation for review and staging, platform-only central inbox access, recovery audit, stale/concurrent action rejection, and source/delivery history preservation.
4. Exercise financial duplicate and distinct-payment scenarios with final DB state and outbox atomicity.
5. Validate worker leases, rate limiter, independent flags, disabled defaults, missing dependency behavior and rolling-deployment quiescence without live calls.
6. Run synthetic multi-tenant Claim.MD flows only with an approved vendor test account and synthetic identifiers. Validate notices only after vendor confirms route and semantics.
7. Perform independent security/code review and document activation/rollback gates. Production activation requires separate explicit release authorization.

## No activation

This handoff authorizes cumulative validation only. It does not authorize live Claim.MD calls, controlled worker activation, financial posting, deployment or production migration.
