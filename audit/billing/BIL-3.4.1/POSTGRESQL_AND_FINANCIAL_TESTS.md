# PostgreSQL and financial tests

Using `BIL1_TEST_PG_IMAGE=chartwarden-postgres:dev bash audit/billing/BIL-1-RELEASE-GATE/PHASE-1.1/run-private-postgres.sh`, the repository runner created and removed a fresh private PostgreSQL 18.6 container. It applied the full migration set including 1396, then passed response inbox 3/3, M23 FORCE RLS 14/14, and M25 FORCE RLS 21/21. The M23 suite includes line evidence owner/cross-tenant visibility, mismatched provider insert rejection, immutability/update denial, and audit metadata.

No posting plan, approval, posting transaction, cross-source duplicate, rollback, or actual financial-effect test exists or ran. These remain NOT EXECUTED, not waived.
