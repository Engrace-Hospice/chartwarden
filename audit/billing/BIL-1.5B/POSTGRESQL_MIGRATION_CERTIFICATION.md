# PostgreSQL and migration certification

A new private container `wardenx-bil15b-pg` ran `pgvector/pgvector:pg18` on loopback port 55433 with `max_locks_per_transaction=1024`. The shared `os-postgres-1` and the local `.env` database URL were not used. Live suites replayed the repository's full sorted SQL migration baseline into fresh databases; the M23 response suite also reset `public` before replay. This proves fresh-schema replay for those suites, not an in-place upgrade of a populated pre-BIL-1 database.

Migrations 1350–1361 were present and executed by the live suites. `arch:migration-compat`, `arch:migration-numbering`, `arch:ddl`, `arch:tenancy` and `arch:manifest-mirror` passed. The numbering gate reported historical gaps as informational. Migration 1353 and 1358 retain `compat: contract`; no header was rewritten. Contract migrations require forward deployment planning and cannot be assumed safe for automatic database rollback. The repository deploy script halts on failed contract migration for operator intervention.

**Pending:** a populated pre-BIL-1 snapshot upgrade, interruption/restart of the migration runner, old/new binary compatibility across 1353 and 1358, production-role startup after in-place upgrade, and backup/restore rehearsal. These are merge and production gate items.
