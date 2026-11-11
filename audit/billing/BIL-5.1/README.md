# BIL-5.1 — Tenant-scoped Billing Operations workspace

Implemented a new `/billing/operations` entry point in the existing Billing navigation. It combines bounded, read-only pages from the M23, M24, M25 and M41 owner APIs for one provider context, displays source status and source amount without inventing a shared financial state, and links to existing claim/ERA action screens.

The authenticated actor context now includes server-resolved `providerEntityIds` for selector options. Every data request still goes through its source-owned route, which independently enforces tenant, provider and permission scope. M25's ERA list now supports a server-side `locationId` filter. The M25 detail page accepts `?stage=<id>` and opens the stage only after it appears in the caller's authorized list.

This is a bounded operational entry point, not a complete cross-payer exception system: each source keeps its own cursor, summary counts describe loaded pages only, location filtering applies to M25 stages, and central unattributed quarantine is intentionally not exposed. See [remaining blockers](REMAINING_BLOCKERS.md).

No migration, ledger write, posting route, Claim.MD request, worker activation, or deployment was added.

## Evidence

- Source and API/UI details: [API and pagination](BACKEND_API_AND_PAGINATION.md), [frontend](FRONTEND_NAVIGATION_AND_ACCESSIBILITY.md).
- Private PostgreSQL M25 runner and focused checks: [tests](POSTGRESQL_AND_RLS_TESTS.md), [HTTP/frontend tests](HTTP_AND_FRONTEND_TESTS.md).
- Roadmap handoff: [BIL-5.2](BIL_5_2_HANDOFF.md).
