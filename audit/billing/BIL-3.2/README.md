# BIL-3.2 — Claim and service-line matching

## Result

This change adds a tenant-scoped, nonposting matching review over the existing Claim.MD ERA stage. It revalidates only claim identities already marked `verified` by upstream immutable submission evidence, lets a separately permissioned reviewer record or clear that identity review, persists decisions as append-only revisions, and exposes a decimal-safe read-only ERA payment balance check.

This is a deliberately limited first slice. It does **not** discover alternative claim candidates, resolve unmatched/ambiguous identities, select corrected-claim attempts, or match service lines. The source contracts inspected for this phase do not provide a trustworthy original claim-line reference or a safe complete candidate reader for those cases. Those remain blocked rather than guessed.

No posting, allocation, balance mutation, legacy `receiveAdvice`/`postAdvice` call, posting event, live vendor request, worker activation, or production migration was performed. Migration `1394_m25_claimmd_era_match_decisions.sql` is additive and was not executed locally.

## Evidence

- API: existing Claim.MD ERA detail plus a matching read and permission-gated decision route.
- Persistence: append-only tenant/provider scoped decision revisions with optimistic versions and an advisory lock.
- UI: identity evidence review, reason capture, decision history, and explicit no-line-reference limitation in the existing ERA screen.
- Tests and unexecuted database gate: see [TEST_RESULTS.md](./TEST_RESULTS.md) and [POSTGRESQL_AND_RLS.md](./POSTGRESQL_AND_RLS.md).

## Next

Complete safe historical candidate discovery and service-line identity contracts before a usable exception-resolution workflow or financial review can be claimed. See [BIL_3_3_HANDOFF.md](./BIL_3_3_HANDOFF.md).
