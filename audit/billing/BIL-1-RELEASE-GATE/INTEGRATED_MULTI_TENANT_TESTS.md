# Integrated multi-tenant test status

## Existing evidence

- M23 RLS: 13/13 with the real app role on private PostgreSQL.
- M25 RLS: 16/16 with the real app role on private PostgreSQL.
- M25 835 ingestion: 35/35 in the previous BIL-1.5B run, including cross-source financial duplicate cases.
- Relevant cumulative non-live suites: 161 files, 1,992 passed, 12 skipped.
- Populated migration seed contained two synthetic organizations, four providers and four locations; preexisting M23/M41/M25 records survived migrations 1350–1361.

## Release Gate integrated journey

**NOT RUN.** The end-to-end two-tenant fixture from response capture through resolver, M23/M41 acknowledgment dispatch, plus a mixed-provider ERA journey through capture, ownership verification, M25 stage and operator review was not executed against one integrated database.

Therefore same-PCN cross-tenant collision, shared TIN with distinct NPIs, old/new claim revision arrival, unsupported status handling, mixed payee holds, duplicate-source outcomes and no-posting behavior are covered only by separate module tests or source review, not a single integrated certification. There is no test evidence for the requested “Sunrise Hospice” / “Sunshine Hospice” scenario beyond synthetic migration rows; those names were represented with synthetic test variants only.

Before controlled activation, Phase 2 must run a database-backed multi-tenant matrix using two organizations × two provider entities × multiple locations, synthetic identifiers, both environments and account-scoped events. Assert the owner, provider, claim, attempt, and environment for each resolution; all ambiguous or unsupported events stay held; repeated dispatch is idempotent; ERA review never posts money.
