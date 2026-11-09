# BIL-3.0 — M25 Financial Flow Baseline & Nonposting ERA Review

## Result

M25 already had an encrypted BIL-1 Claim.MD stage table, tenant/provider-scoped GET services and authorized routes. It had no web screen consuming those routes. This phase adds a read-only review screen, a typed OpenAPI/client contract, and an aggregate list DTO that keeps claim/service-line details behind the explicit detail read.

The existing manual/SFTP intake has a separate posting path. It was inspected and left unchanged. The new Claim.MD stage path does not call it, emit its event, or write its financial tables.

## Baseline

- Local branch: `develop`; working tree was clean before these BIL-3.0 edits.
- Local HEAD at inspection: `8acc12df303c661b7ce0012b729430f583bbc7f3`.
- `origin/develop` at inspection: `b37972c6238aeaf88cb6f5344899ff3f15921cf8`; local `develop` was ahead by 26 commits after the user's local rebase onto `origin/main`.
- BIL-2 sources are present in local `develop` ancestry. This task did not push, merge, rebase, reset, or delete branches.

## Implementation

- `GET /api/v1/remittance/claimmd-era` now has a generated typed query and aggregate response contract.
- `GET /api/v1/remittance/claimmd-era/:id` remains the authorized detail boundary.
- A new Billing Revenue Cycle screen lists stages, filters by state/payer/date, pages through the server cursor, and shows claims, service lines, adjustments, ownership outcomes, safe hold reasons, and verified internal claim links.
- The screen states that review does not post, match, or reconcile money. It has no mutation API call.
- Claim identity results retain patient control number and billing module only when returned by the existing verified ownership resolver. They are labeled as identity correlation, not financial matching.

## Validation

See [TEST_RESULTS.md](./TEST_RESULTS.md). No PostgreSQL migration, live Claim.MD request, posting activation, or deployment was performed.

## Limits

The work does not add line-level financial allocation, reviewer event history, cash/EFT reconciliation, or staged-ERA posting. Claim matching remains uncertified; the screen is a nonposting review surface.
