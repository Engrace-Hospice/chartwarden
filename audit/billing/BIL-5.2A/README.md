# BIL-5.2A — Billing operations worklists

This increment extends the existing `/billing/operations` workspace with source-owned M23/M41 submission uncertainty projections, explicit lower-bound/page count language, retryable per-source pagination, duplicate suppression across continuations, and a small-screen work-item layout. M25 remains the owner of ERA holds and matching exceptions. M24 electronic submission is unavailable and has no in-doubt transport contract to project.

All worklist actions remain read-only navigation. No submission retry, quarantine release, posting, approval, or financial mutation was added. The tenant-facing workspace continues to omit central unattributed Claim.MD quarantine.

This is **partial** against BIL-5.2A: the required restricted-role authenticated HTTP-to-PostgreSQL cross-owner test and complete independent in-doubt feeds for every owner have not been delivered. See [remaining blockers](REMAINING_BLOCKERS.md).

## Verification run for this increment

- `bun run build`: passed.
- `bun run lint`: passed.
- Focused Vitest: 4 files, 22 tests passed (Billing Operations DOM, M23 provider scope, M41 historical reader, M25 review routes).
- Focused test TypeScript programs for the affected DOM and backend test files: passed.
- `bun run openapi:check`, `bun run client:check`, `git diff --check`: passed.
- Architecture: ownership, tenancy, outbox, migration numbering/compatibility and most fitness gates passed. Full `bun run arch:fitness` remains red for missing `uv`, existing manifest orphans `packages/domain` and `packages/admin-ui-shell`, and stale generated E2E coverage reports. No migration was added.
- Restricted-role integrated HTTP/PostgreSQL isolation: not executed.
