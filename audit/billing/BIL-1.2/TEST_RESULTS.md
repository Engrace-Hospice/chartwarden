# Test results

## Executed

```sh
bunx vitest run apps/backend/src/modules/23-billing-medicare/claimmd-identity/resolve.test.ts apps/backend/src/modules/23-billing-medicare/claimmd-identity/service.test.ts apps/backend/src/modules/23-billing-medicare/claimmd-identity/event-identifiers.test.ts
```

Result: **3 files passed, 10 tests passed**. A combined BIL-1.2 + BIL-1.1 focused run also passed: **5 files, 16 tests**. Tests use synthetic identifiers and cover account/environment partitioning, exact reference/receipt paths, provider/payer mismatch, absent historical identity, insufficient fallback fields, duplicate candidates, immutable prior result behavior, disabled worker behavior, bounded batch size, and extraction from nested messages.

No Claim.MD calls, live tests, database migration execution, full monorepo suite, or production services were run.

## Required follow-up before activation

- Run `bun run build`, `bun run typecheck`, and `bun run arch:fitness` after final changes.
- Add a private PostgreSQL suite applying migration 1351 and testing RLS as `chartwarden_app` and `claimmd_capture`, trigger/backfill behavior, atomic lease races, resolution version CAS, immutable resolved association, and tenant/provider ownership constraints.
- Add concrete candidate adapter integration tests with synthetic M23/M24/M41 rows, two tenants, multiple provider entities and historical NPI/TIN snapshots.
- Include tests for duplicate PCNs across tenants, resubmission attempts, test/prod repeated external IDs, expired leases, crashes around save, and corrupted/decryption-failed source events.

The worker/repository currently has no concrete candidate adapter or boot binding, so unit results do not certify end-to-end identity resolution.

## Static checks executed

- `bun run build` — passed across all 14 TypeScript batches.
- `bun run arch:tenancy` — passed.
- `bun run arch:tables` — passed, no cross-module schema access/platform bypass issues.
- `bun run arch:manifest-mirror` — passed for 41 modules and their owned-table lists.
- `bun run arch:migration-numbering` — passed; migration 1351 is uniquely numbered.
- `bun run arch:migration-compat` — passed; migration 1351 declares a valid additive `expand` change.
- `git diff --check` — passed.

The live database and actual candidate adapter limitations above remain; compile and static checks do not certify those.
