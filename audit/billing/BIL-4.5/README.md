# BIL-4.5 — Medicare ERA Integration & Billing Validation

## Result

Integrated staged Medicare hospice ERAs with the M25 review workflow using M23-owned, tenant-scoped historical submission evidence. The reviewer can inspect the matched M23 claim and exact attempt, review financial facts, and receive an explicit server-side `MEDICARE_POSTING_NOT_CERTIFIED` blocker. No Medicare financial effect is permitted through the Claim.MD posting path.

## Evidence

- A fresh private PostgreSQL run passed the M25 ingestion, legacy intake and downstream consumer suites. The new test reads actual M23 attempt and immutable line evidence, matches a staged synthetic Medicare ERA, and confirms approval is refused without financial records or success events.
- OpenAPI and generated client are synchronized. Focused M25 web and backend tests passed.
- Production and automatic Claim.MD posting remain disabled. See [remaining dependencies](REMAINING_DEPENDENCIES_AND_NEXT_PHASE.md).

## Documents

- [M23 claim identity and source evidence](MEDICARE_HOSPICE_SOURCE_AND_CLAIM_IDENTITY.md)
- [M23 to M25 integration](M23_TO_M25_ERA_INTEGRATION.md)
- [Review and posting blockers](MEDICARE_FINANCIAL_REVIEW_AND_POSTING_BLOCKERS.md)
- [API and UI](API_AND_FRONTEND.md)
- [Private PostgreSQL evidence](POSTGRESQL_MEDICARE_INTEGRATION_TESTS.md)
- [Cumulative regressions](CUMULATIVE_BILLING_REGRESSIONS.md)
- [Security and nonposting](SECURITY_AND_NONPOSTING.md)
- [Dependencies and next phase](REMAINING_DEPENDENCIES_AND_NEXT_PHASE.md)
