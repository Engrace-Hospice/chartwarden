# Remaining blockers

1. **Service-line identity — blocking line matching.** Current 837 send paths and immutable evidence do not bind an internal line UUID to a payer-returnable reference and attempt-specific snapshot. Remedy: add a reviewed line-control representation and immutable line evidence at M23/M41 send reservation, with route compatibility tests; then correlate only returned references.
2. **Private PostgreSQL/RLS certification — runtime evidence pending.** Migration 1394 decision constraints, FORCE RLS, concurrency, stale version and financial-table immutability were not run as a real application role. Remedy: use the approved disposable production-version Postgres image and real NOBYPASSRLS app role.
3. **Migration alias compatibility — not runtime-certified.** The runner's checksum-gated alias is unit-tested, but no populated ledger upgrade was run. Remedy: exercise old 1378 ledger adoption in a private PostgreSQL rehearsal before release migration.
4. **Full candidate reader DB integration — pending.** Unit tests cover candidate eligibility and route authorization; M23/M41 joined read projections require private DB-backed integration tests.

Financial posting remains out of scope and unauthorized.
