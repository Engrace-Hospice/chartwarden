# PostgreSQL and migrations

## Isolated environment

Used a disposable local container from `chartwarden-postgres:dev`, built from `deploy/production/postgres` and reporting PostgreSQL 18.6. It was bound only to `127.0.0.1:55443`, had no persistent volume, and was separate from the shared `os-postgres-1` PostgreSQL 16 service on port 55432. Tests received an explicit `CHARTWARDEN_TEST_DATABASE_URL`; normal `.env` configuration was not used. The disposable container was stopped and removed after the test run.

## Results

- M23 claim submit worker live PostgreSQL suite: 17/17 passed; migrations applied from a clean disposable database. Transport is mocked. Coverage includes reviewed-source retry propagation, known pre-send refusal versus uncertain outcome, retry idempotence after success, and Prepare/Send/Finalize redelivery.
- M23 FORCE RLS: 13/13 passed as `chartwarden_app` NOBYPASSRLS role after correcting the fixture to use the dispatch state machine.
- M24 FORCE RLS: 22/22 passed as `chartwarden_app` NOBYPASSRLS role.
- M41 commercial claim assembly/correction: 37/37 passed, including concurrent correction serialization and the new missing-metadata constraint test.
- M41 commercial route suite: 11/11 passed.
- M41 commercial submission live suite: 88 tests passed, 4 skipped because real Valkey/Redis was not available.

## Migration ordering and scope

New BIL-2 migrations 1378, 1379 and 1380 remain in dependency order. Migration 1381, `packages/db/migrations/1381_m41_correction_metadata_not_null.sql`, is additive and marked `compat: contract`; it follows 1380 and blocks malformed linked correction records. Migration numbering and compatibility checks passed. No production or shared-development migration was run. A production-shaped interrupted deployment rehearsal and populated upgrade from the exact production baseline were not performed; migration deployment/rollback remains a release activity.
