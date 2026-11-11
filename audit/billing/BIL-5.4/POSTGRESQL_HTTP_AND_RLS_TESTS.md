# PostgreSQL, HTTP, and RLS tests

- `BIL_TEST_ONLY=rls scripts/test-m25-835-ingestion-private.sh`: PASS, 22/22 on a fresh approved PostgreSQL container.
- `ops-claimmd-observability.test.ts`: PASS, 2/2 Fastify authorization/response tests.
- Tenant central-table denial, cross-tenant stage denial, and scoped stage aggregates were exercised as `chartwarden_app` with NOBYPASSRLS.

The platform HTTP test uses real permission/ABAC/role guards with injected durable-reader results. A combined Fastify-to-platform-PostgreSQL central reader test was not added in this phase.
