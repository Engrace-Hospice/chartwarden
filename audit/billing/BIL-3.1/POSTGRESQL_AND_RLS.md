# PostgreSQL and RLS

No schema change or migration was needed: the implementation reuses existing central append-only history tables and the M25 tenant stage. The stage query retains its existing FORCE-RLS-aware organization/provider context. Central history remains behind the existing platform execution role. No private disposable PostgreSQL instance was exercised during this phase, so live RLS, role-grant and transaction behavior remain uncertified and must be included in cumulative validation. No shared or production database was used.
