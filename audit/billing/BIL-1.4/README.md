# BIL-1.4 — Account-scoped ERA capture and safe M25 routing

## Status

**Implementation status: Partial. Runtime activation: NO-GO.** This branch adds an account-wide Claim.MD ERA API reader, bounded multi-page coordinator, audited database store, fenced stream lease, encrypted ERA capture, fail-closed identity/duplicate helpers, a non-posting M25 staging boundary, disabled-by-default capture worker wiring, and offline tests. It does **not** yet provide parsed-835 identity extraction, historical claim correlation, or a bound M25 staging/delivery pipeline. Capture has not been certified against a private PostgreSQL database or synthetic Claim.MD account.

No Claim.MD API calls, migration execution, worker activation, payment posting, deployment, or live database tests were performed. The existing M25 `receiveAdvice` path is intentionally not called by these additions because it emits `m25.edi.835_received`, whose consumer posts financial rows (`apps/backend/src/modules/25-remittance/ingest/service-drizzle.ts`, `apps/backend/src/modules/25-remittance/outbox-consumers/live-binding.ts`).

## Changes

- `packages/x12-837-client/src/clearinghouse/claimmd-account-era.ts`: account-wide `/eralist/`, `/era835/`, `/eradata/` requests; explicit `NewOnly=0`; shared request counter; no NPI/TIN filters; decimal ERA IDs preserved as strings; page snapshot commit contract.
- `apps/backend/src/modules/25-remittance/ingest/claimmd-era-store.ts` and `claimmd-era-capture.ts`: audited central store, fenced stream lease, atomic discovery/inbox/cursor transaction, encrypted 835/detail capture, pending retry backlog, and explicit capture worker gate.
- `apps/backend/src/modules/25-remittance/ingest/claimmd-era-routing.ts` and `claimmd-era-stage.ts`: exact-NPI plus optional TIN verification; whole-artifact hold for mixed payees; owner-context, source-proof-gated M25 staging with exact duplicate detection and possible-duplicate review. No posting/outbox call. Stage delivery is deliberately not wired because parsed X12 and audited source/owner proof adapters are not complete.
- `apps/backend/src/modules/25-remittance/ingest/claimmd-era-config.ts`: exact-string false-by-default capture/delivery settings and rejects auto-post.
- `packages/db/src/schema/remittance/claimmd-era.ts`, migration `1356_m25_claimmd_account_era.sql`, module manifests, tenancy checker: central encrypted-inbox/cursor tables and tenant-scoped staging table. No bootstrap cursor is inserted.
- `apps/backend/src/bootstrap/claimmd-payload-cipher.ts`: shared AES-GCM payload cipher; M23 capture cipher now delegates with its existing response purpose/AAD.

See [TEST_RESULTS.md](./TEST_RESULTS.md), [RELEASE_BLOCKERS.md](./RELEASE_BLOCKERS.md), and [NEXT_PHASE_READINESS.md](./NEXT_PHASE_READINESS.md) for exact status.
