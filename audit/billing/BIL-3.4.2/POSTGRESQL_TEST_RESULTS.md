# PostgreSQL test results

The repository private runner was executed against a fresh disposable PostgreSQL 18.6 image (`chartwarden-postgres:dev`):

- Migration set applied, including migration 1396.
- Response inbox integration: 3/3 passed.
- M23 FORCE RLS: 14/14 passed, including submitted-line evidence tenant/provider scope, immutability denial and audit metadata.
- M25 FORCE RLS: 21/21 passed.

These tests do not exercise an approved posting service. Successful ledger posting, duplicate posting, concurrent execution, atomic rollback, stale approval and cross-source duplicate cases are **NOT EXECUTED** because there is no such service in source.
