# PostgreSQL, RLS and migration validation

Runtime evidence and exact commands are in [TEST_RESULTS.md](TEST_RESULTS.md). PostgreSQL was run in private disposable containers using repository image `chartwarden-postgres:dev` (PostgreSQL 18.6), bound only to loopback. The shared local PostgreSQL 16 cluster and shared services were not used.

Migration 1395 is additive and compatible as `expand`. Migration 1394/1395 were applied by the M25 live suite. A fresh production migration-runner execution applied all 673 migrations. The legacy alias rehearsal verified checksum-identical 1378 ledger adoption to 1382 without reapplying it, and a deliberately mismatching checksum failed under `--strict-orphans` before any migration ran.
