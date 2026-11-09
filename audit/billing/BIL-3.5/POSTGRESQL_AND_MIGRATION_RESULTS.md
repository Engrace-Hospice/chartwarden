# PostgreSQL and migrations

The private runner `scripts/test-m25-835-ingestion-private.sh` requires the locally available `chartwarden-postgres:dev` image. It starts a disposable loopback-only container, uses a random test password, creates a fresh database, applies the complete migration set, and the live M25 suite resets only that private database's public schema. Service operations use the real restricted `chartwarden_app` role. No shared or production database was used.

The current run validates the staged financial source, actual M41 historical submission rows, immutable M23 attempt evidence, matching and posting state, M25 remittance/outbox writes, RLS-scoped service reads/writes, rollback, concurrency and idempotency. Migration numbering and compatibility gates pass. Existing migration 1378 aliases are not changed.

The live suite does not claim deployment rehearsals against populated production history. It applies migrations to a fresh disposable database.
