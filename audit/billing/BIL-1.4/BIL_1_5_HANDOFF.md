# BIL-1.5 handoff

BIL-1.5 can only be a hardening phase after BIL-1.4's incomplete source boundaries are implemented. First complete the blocking BIL-1.4 corrective work:

1. Implement audited `claimmd_capture` repository operations: operator bootstrap, account lease with generation fencing, stable-page batch upsert plus cursor commit in one transaction, inbox detail state/retries.
2. Wire disabled workers at the root with explicit test/production account configuration, shared rate counter, protected payload cipher/keyring, and mutually exclusive legacy Claim.MD polling. Reject auto-post at startup.
3. Parse original 835 with M25's existing X12 parser; compare payee identity and structured details; route through M1 owner-exported readers under audited platform context. Hold unknown, mixed, or conflicting artifacts whole.
4. Add M25-owned staging/delivery service with per-tenant context, durable idempotency and cross-source duplicate checks. Never invoke `receiveAdvice`/`postAdvice` on this route.
5. Add live tests on a private PostgreSQL cluster with the real NOBYPASSRLS role, and synthetic-account certification. Verify crash after capture/commit and repeat delivery.

BIL-1.5 validation should cover 2 tenants × multiple locations/providers, API and SFTP duplication, concurrent cursor leases, page mutation during scan, malformed and multi-ST 835, mixed payees, RLS, PHI-safe logs, payment/AR invariance, and kill-switch behavior. No production rollout until every P0/P1 blocker is closed and operational rollback is rehearsed.
