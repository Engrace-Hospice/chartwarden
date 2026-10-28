# 06 — Database integrity

Full migration replay passed 13/13 in a private PostgreSQL 18/pgvector database. Baseline RLS passed
109/109 using the non-BYPASSRLS application-role setup. Architecture checks passed table ownership,
DDL legality, tenancy/FORCE RLS, migration numbering, and index coverage rules. These are strong
controls, not proof of every transactional invariant.

## Findings

- `CW-QA-0001`: the payer service closes a prior interval on the replacement start date while the
  reader treats both endpoints as inclusive. Database uniqueness covers only current rows and does
  not forbid historical/effective overlap.
- `CW-QA-0016`: the generated live-test matrix does not name M17's `oncall_rotation_entry` table.
- `CW-QA-0017`: migrations commit per file and production rollback can start old code after schema
  advancement without enforceable expand compatibility.
- `CW-QA-0015`: one HOPE live suite has noncanonical cluster-role cleanup.

Query-plan and load analysis were not performed: no safe representative large dataset existed. The
foreign-key index live control is present in the repository but the complete live matrix was not run
in this audit. N+1, pool exhaustion, lock contention, and long-transaction risks remain unverified
unless covered by the static/targeted paths reviewed here.

Financial values use explicit database/domain representations in the reviewed billing paths; no
floating-point corruption was confirmed. Signed-note mutation controls were inspected but not fully
exercised under concurrent writers.
