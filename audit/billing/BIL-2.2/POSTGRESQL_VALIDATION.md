# PostgreSQL validation

Migration 1379 adds four columns and checks on the existing M23-owned `claim_submission` table and replaces its terminalization trigger with a bounded dispatch-state transition contract. Classification is `compat: contract`; it intentionally is not reclassified as expand because old application workers cannot meet the new send-reservation invariant.

Validation used a disposable container built from `deploy/production/postgres` (PostgreSQL 18), a fresh tmpfs data directory, a dedicated loopback port and `max_locks_per_transaction=1024`. The live M23 worker suite applied the migration chain through 1379 and passed 5/5 tests. The container was removed afterward. The local `.env` database and shared `os-postgres-1` were not touched.

The live suite verifies concurrent worker invocations yield one external upload, a committed uncertain dispatch is not resent on replay, and the transport callback observes no open idle transaction from the worker. The migration is applied as part of the full migration chain. Still required in cumulative validation: separate OS processes, process crash after remote success and before finalize, stale fencing-token injection, tenant RLS role probes, migration restart/forward-recovery with populated attempts, and independently committed tests for every new trigger transition.
