# Isolated PostgreSQL proof — `test:m34:support-session:live`

- Run at: 2026-11-24T17:14Z, after the commit below was made, on a clean working tree (tree
  `21014fba4175c77fa20551097ef399cee06c01a4`)
- Commit under test: `9a8740733` (on top of `92a36c073`, where the failures below were first found). The same suite also
  passed 29 of 29 on `707874893`, `eefb6ea3d`, `0b2827a01` and `822089796`. `eefb6ea3d` adds the patient-scope refusal and the
  cross-organization and expired-at-entry cases; `0b2827a01` makes the support read strictly read-only, re-checks the filed
  patient with the read, and names the audit actor `superadmin_via_support_session`; `822089796` records a refused read as
  `support_session.wardenlens_read_denied`; `9a8740733` makes the patient-scoped read fail closed (the filed patient must be
  proven) and gives a content refusal its own denial reason code.
- Result: PASS — 1 file, 29 of 29 tests passed, 0 unhandled errors
- Also run on the same private container: `test:f237:doclens-review:live`, PASS, 19 of 19, including three cases that drive the
  real review-workspace service with a support-session scope (the filed-patient proof, the page-coverage refusal and the
  re-file conflict). It ran on the tree whose only later change is the denial reason code in `wardenlens-support-access.ts`,
  which that suite does not import.
- Database: private container `cw-pr1112-m34-live` from `chartwarden-postgres:dev` (built from `deploy/production/postgres`, PostgreSQL 18.6)
  on `127.0.0.1:55432`, started with `-c max_locks_per_transaction=1024`, removed after the run. The shared Docker cluster on 5432
  was not touched.
- Runner: `/private/tmp/run-pr1112-isolated-postgres.sh`, the commands in the plan with two changes: the readiness wait uses
  `pg_isready -h 127.0.0.1` (the init-phase server answers on the unix socket before it restarts) and gives up after 60 s.
- Data: synthetic fixtures created by the suite. No credentials, cookies, passkey material or PHI are recorded here.

## What the suite covers for the WardenLens superadmin path

- `authorizes and audits WardenLens reads only inside the actor-bound consent scope`: actor and session binding, organization and
  patient scope, the `ops.read` ledger event and the critical `support_session.wardenlens_read` audit.
- `holds consent stable while a WardenLens disclosure is prepared, then lets revocation close it`: the revocation/read locking race.
- The rest of the suite covers expired, closed and revoked sessions, the revoke cascade, the expiry sweep, and a start or elevation
  racing a revoke, as the real `chartwarden_app` and platform roles.

## What the first run found at `92a36c073`

At `92a36c073` the suite failed 8 of 29 tests. The same 6 non-WardenLens tests failed on the commit before the WardenLens work, so
they were not introduced by PR #1112.

1. WardenLens support access locked `organization` and `tenant_account` rows with `FOR SHARE`, which needs an UPDATE privilege
   the platform role does not hold: "permission denied for table organization". The lock now covers only the session and grant rows.
2. Migration 1487's `grant_revoked` close trigger ran `INSERT ... ON CONFLICT` as `chartwarden_admin`, which has no SELECT policy on
   `support_session_event`, so every `grant_revoked` close failed the RLS check. Migration `1547` removes the clause.
3. 1487 also moved the two support-session audit triggers to `search_path = pg_catalog, public` with unqualified names, so a TEMP
   `audit_event` table created by the app role would capture their rows. Migration `1547` restores the `pg_temp`-last,
   schema-qualified form from 1486.
4. One test closed a session as `grant_revoked` before revoking the grant, which 1487 forbids. It revokes first now.

Migration `1547` is `-- compat: expand`. 1487 is already on `origin/main`, so a deploy of this branch applies 1547.
