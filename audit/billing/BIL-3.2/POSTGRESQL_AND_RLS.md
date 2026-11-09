# PostgreSQL and RLS

Migration `1394_m25_claimmd_era_match_decisions.sql` is present, additive, and follows local `main` migration numbering through 1393. It adds a FORCE-RLS table and an append-only trigger. The existing live M25 RLS suite was extended with seeded decision visibility, cross-organization denial, and cross-organization insert rejection.

**Runtime result: NOT EXECUTED.** `CHARTWARDEN_TEST_DATABASE_URL` resolves to `wardenx_test` on the same local PostgreSQL 16 cluster/data directory as the development database, uses a superuser connection, and has no `chartwarden_app` role. The live suite drops/recreates `public` and cluster roles, so it would not be safe to run there. No migrations were applied. The repository's private disposable production-image PostgreSQL procedure must run this suite before RLS can be certified.
