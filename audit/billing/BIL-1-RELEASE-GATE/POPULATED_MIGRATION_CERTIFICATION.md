# Populated migration certification

## Result

**PASS for the exercised synthetic PostgreSQL 18 upgrade path.** A private disposable `pgvector/pgvector:pg18` container was bound only to loopback port 55433. The active shared `os-postgres-1` on port 55432 and `.env` database were not used. The test server was a fresh container, one database, and no real records.

The production migration runner core `applyMigrations()` was used with `strict: true`: 642 historical migrations below 1350 built the pre-BIL-1 schema; synthetic records were inserted; then the full repository migration directory was applied. The runner reported all 12 migrations 1350–1361 as applied. Counts before and after were identical: 2 organizations, 1 M23 claim and submission, 1 M41 commercial claim and submission, and 1 M25 remittance advice. Four synthetic providers and four synthetic locations remained as seeded. No speculative tenant was assigned to historical rows.

Migration runner live suite also passed: `CHARTWARDEN_TEST_DATABASE_URL=<private-loopback-url> bun run test:db:migrate:live` — 13 tests passed, including full fresh replay, repeat no-op, strict checksum drift and ledger compatibility cases.

## Security metadata verified after upgrade

- Central response event, ERA inbox, ERA delivery, recovery audit and notice evidence tables had both RLS enabled and FORCE RLS enabled.
- `chartwarden_app` and `claimmd_capture` had `LOGIN=false` and `BYPASSRLS=false` in the migration-only role state; deployment bootstrap is a separate operation.
- `chartwarden_app` had no `SELECT` privilege on central response events or ERA inbox; it did have tenant staging access. `claimmd_capture` had read access to the M25 staging relation for delivery.
- The M23 and M25 real-role RLS suites passed serially: 13/13 and 16/16.

## Scope and limits

This is a synthetic runner-core in-place upgrade from the current repository baseline, not an anonymized production backup. It verifies data preservation for representative records, not every optional billing relation or production volume. The actual `deploy.sh` container lifecycle and a production-shaped populated backup/restore remain untested. The test script used for the seed was session-local under `/tmp`, not committed as a reusable live suite.

Migrations 1353 and 1358 retain their `compat: contract` headers. The repository deployment gate therefore will not automatically restore the old application after these migrations; a failed deployment requires operator-directed forward recovery. No migration was run against production or the configured local application database.
