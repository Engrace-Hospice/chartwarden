# PostgreSQL and RLS tests

No schema migration or cross-module database query was added. The M25 filter is an additive predicate over its existing RLS-owned stage table.

Executed `scripts/test-m25-835-ingestion-private.sh`. The script verified local image `chartwarden-postgres:dev`, created a uniquely named disposable container bound to loopback with a fresh database and `max_locks_per_transaction=1024`, and used the repository's restricted app-role live suites. The shared `os-postgres-1` container was present but was not targeted.

The runner passed M25 staging/posting-core 50/50, legacy 835 21/21, M23/M24 consumer 7/7, M26 consumer 4/4, and synthetic clearinghouse pull 15/15. Those are module-level database/regression results; they do not constitute one combined multi-tenant HTTP worklist RLS scenario. No test database schema was changed by BIL-5.1.

The new route-level location test uses Fastify injection and a mocked review service; it proves route contract forwarding and server-derived actor scope, not SQL/RLS in isolation. Cross-module provider switching remains protected by each source's existing owner route and needs a future integrated restricted-role HTTP test.
