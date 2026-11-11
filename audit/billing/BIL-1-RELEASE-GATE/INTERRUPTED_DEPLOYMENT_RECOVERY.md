# Interrupted deployment and migration recovery

## Runner transaction and restart exercise

On the private PostgreSQL 18 database, a temporary migration directory contained:

1. `9901`: create a checkpoint table and commit one row.
2. `9902`: create another table, then intentionally execute a division-by-zero failure.

The actual `applyMigrations()` runner rejected `9902`; PostgreSQL rolled back its DDL and the runner did not record it in `_chartwarden_migration`. The committed `9901` table and row remained. After replacing `9902` with valid SQL, rerunning applied only `9902`; the following rerun was a no-op. Final row counts were one checkpoint and one repaired row.

This demonstrates per-migration transaction rollback and restart idempotence. The test used synthetic tables in the isolated database and cleaned them afterward.

## Deployment semantics

`deploy/production/deploy.sh` only restarts the previous image automatically if every applied migration in that deployment is verified `compat: expand`. For a failed deployment after a `contract` migration, it holds with operator-decision exit 75; it does not restart the old image on a possibly incompatible schema. This behavior is covered by `scripts/__tests__/deploy-schema-rollback.test.ts` in the focused 92-test run.

1353 and 1358 remain contract migrations. Sequence deployment only after backups and maintenance/quiescence planning, apply migrations before starting the compatible new image, and retain a forward-fix path. Do not manually roll back or edit the migration ledger. A pre-migration interruption is a no-op; a committed migration before app startup is handled by the runner ledger on restart.

## Not certified

No real SIGKILL/power-loss was injected into `deploy.sh`; no container swap, production backup restore, or contract-migration failure rehearsal was performed. The runner-level transactional failure is not equivalent to a complete deployment interruption certification.
