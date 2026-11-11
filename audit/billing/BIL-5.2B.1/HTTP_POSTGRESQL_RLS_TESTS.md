# HTTP/PostgreSQL and RLS tests

The focused live suite runs through registered Fastify routes against a fresh private PostgreSQL instance and the repository's restricted `chartwarden_app` role. It exercises both M23 and M41 lifecycle paths, source-owner authorization, cross-tenant guessed IDs, provider scope, M41 caseload revocation, source-state changes, and persisted audit/history.

The suite does not use a superuser connection to assert application visibility. Setup uses the administrative fixture connection; HTTP requests and direct RLS reads use the restricted application pool. The test inserts a foreign synthetic case, event, and note, then queries each under Tenant A's `withOrgContext`; all three return zero rows. The guessed foreign case URL returns 404.

See [exact commands and results](TEST_RESULTS.md). No production or shared database was used.
