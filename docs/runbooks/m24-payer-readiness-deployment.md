# M24 payer-readiness migration deployment

The original M24 payer-readiness and M25 ERA-review batch adds nine migrations: `1535`, `1538` and `1539` are `-- compat: expand`; `1536`, `1537`, `1541`, `1542`, `1543` and `1544` are `-- compat: contract`. L6C2 later adds migrations `1547` and `1548`, L6D adds `1549`, L8A.1 adds `1550`, L8A.2R adds `1551`, L8A.2C adds `1552`, and L8A.2C1 adds `1553` and `1554`; all eight are contract, so fourteen contract migrations of this work are held in total (seventeen migrations with the three expand ones). Migrations `1540` and `1545` (M8) and `1546` (the object-key column rename) belong to other work and are not part of this batch. A merge to `main` therefore stops `deploy.sh` at exit 75 before any DDL, and the whole pending batch waits for an operator. This runbook is that operator procedure. Every statement below is read off the migration SQL or the deploy scripts; where a fact depends on production state it says so and tells you how to read it.

No deployment is authorized by this document.

## The migrations

| Ordinal | Class | What the SQL does | Why that class |
| --- | --- | --- | --- |
| `1535_m24_payer_program_readiness` | expand | Four nullable columns on `medicaid_claim`; new tables `medicaid_program_assignment` and `medicaid_enrollment_evidence` (RLS enabled and FORCEd, column-limited UPDATE grant for `chartwarden_app`, four-eyes CHECK, provider-entity, insert-status, identity and status-transition guard triggers, audit triggers). | Additive: new nullable columns and new tables nothing reads. |
| `1536_m24_hospice_line_span_rate_qualification` | contract | `medicaid_claim_line.service_date_to` plus a CHECK; on `medicaid_state_rate_schedule` three new columns (`canonical_payer_id`, `rate_source_kind` default `legacy_unqualified`, `verification_status` default `unverified`), three CHECKs, the unique constraint `medicaid_state_rate_schedule_uq` dropped and re-added with `canonical_payer_id` in the key, one partial index; the claim-line date guard function replaced. | `ADD CONSTRAINT` on two existing tables and `DROP`/`ADD` of a unique constraint. See "Why the previous release must be drained". |
| `1537_m24_rate_schedule_null_identity` | contract | A guard that aborts if two `medicaid_state_rate_schedule` rows share an identity; then `medicaid_state_rate_schedule_uq` dropped and re-added as `UNIQUE NULLS NOT DISTINCT`. | `DROP`/`ADD` of a unique constraint; rejects new duplicate rows the old key admitted. |
| `1538_m24_payer_authorization_evidence` | expand | New append-only table `medicaid_payer_authorization_event` (RLS FORCEd, INSERT-only grant, provider-entity guard, append-only trigger, audit trigger). | A new table. |
| `1539_m24_payer_rate_policy_evidence` | expand | New append-only table `medicaid_payer_rate_policy`, same shape as 1538. | A new table. |
| `1541_m40_medicaid_payer_classification_and_m24_submission_provenance` | contract | New global table `mdm_medicaid_payer_program_classification`; nine new columns on `medicaid_submission` (`source_provenance_status` NOT NULL DEFAULT `unverified`), four CHECKs, two partial indexes (one UNIQUE), and a BEFORE INSERT OR UPDATE guard trigger on `medicaid_submission`. | `ADD CONSTRAINT` on an existing table, `CREATE UNIQUE INDEX`, a new trigger on a table the previous release writes. |
| `1542_m24_era_source_account_evidence` | contract | Three nullable columns on `medicaid_enrollment_evidence` (`vendor_account_ref`, `source_environment`, `evidence_fresh_until`), four CHECKs validated immediately (the table is created by 1535 in the same batch, so it is empty and the scan costs nothing; applied alone after an earlier 1535 it would scan the table under an ACCESS EXCLUSIVE lock), the redefined identity guard that now also freezes those three columns, one partial index. | `ADD CONSTRAINT` on an existing table. Historical rows stay NULL and unqualified; no account or environment is inferred. |
| `1543_m25_medicaid_era_nonposting_reviews` | contract | New tables `medicaid_era_review` and `medicaid_era_review_history` (RLS enabled and FORCEd, SELECT grant for `chartwarden_app`, append-only history, identity guard trigger, audit triggers); a conditional `chartwarden_platform` grant when that role exists. Never a ledger or posting record. | New tables with their guards and grants. |
| `1544_m25_medicaid_era_assessment_writer_lockdown` | contract | `medicaid_era_review.assessment_trust_status` (default `legacy_unverified`) and a non-posting CHECK; every privilege on both review tables is revoked from `PUBLIC`, `chartwarden_app` and the platform roles (`chartwarden_platform`, `chartwarden_platform_login`); SELECT is re-granted to `chartwarden_app` only, so a platform role that exists when 1544 runs ends with no access. | `REVOKE` and `ADD CONSTRAINT`. After it no application or platform role can write a review row until a separately isolated evaluator writer exists. |
| `1547_m25_isolated_medicaid_era_evaluator` | contract | Creates the NOLOGIN, NOBYPASSRLS evaluator carrier; allows `isolated_evaluator` assessment provenance and grants review/history writes only to that carrier under tenant RLS. | Changes trust checks and restores writes only to an isolated evaluator identity. |
| `1548_m25_medicaid_era_integrity_and_source_reader` | contract | Creates restricted source-reader roles, removes all held and reverse role memberships and broad privileges, installs the audited one-shot Claim.MD staged-artifact projection, and adds duplicate-safe nonposting evaluation idempotency storage. | Revokes broad/default privileges and grants source access only through the narrow reader function. |
| `1549_m25_medicaid_era_point_in_time_assessments` | contract | Adds nullable evidence-snapshot fingerprint and observed-at columns, validates their paired format, requires snapshots on trusted evaluator inserts/promotions, prevents snapshot deletion, and requires a version increment when snapshot or trust status changes. Historical rows are not backfilled. | Adds database constraints and a trigger to make point-in-time assessment provenance explicit; no row is upgraded or treated as current authorization. |
| `1550_m24_rate_policy_methodology_and_variants` | contract | On `medicaid_payer_rate_policy`: ten new methodology columns (pricing method, quantity conversion, minimum duration and minutes, methodology version, rounding mode and boundary, charge-ceiling method and boundary, quality-reporting applicability), all defaulting to `unqualified` so an existing row cannot price a claim; ten validated CHECKs; the bucket CHECK and the identity unique constraint dropped and re-added (the identity key now includes the quality-reporting variant); a `NOT VALID` CHECK that a `verified` row carries a complete methodology; the supersession guard function replaced (a correction must keep the same identity, quality variant and effective date). | `DROP`/`ADD` of a CHECK and of a unique constraint on an existing table, and new CHECKs. The table is created by 1539 in this batch, so it is empty and each validated CHECK scans nothing; applied alone after an earlier 1539 they would scan the table under an ACCESS EXCLUSIVE lock. No row is rewritten or promoted. |
| `1551_m24_immutable_hospice_pricing_snapshots` | contract | Adds the M24-owned append-only, provider/patient/admission/payer-scoped billing-evidence profile and immutable payer-rate pricing snapshot tables; adds the payer-rate identity to claim lines, exact-one rate-source constraints, RLS/FORCE RLS, audit triggers, source-integrity checks and snapshot/line immutability. Historical claims are not backfilled. | Alters an existing partitioned claim-line table and adds guards, constraints and grants; applying it requires the same operator hold as the other contract migrations. |
| `1552_m24_billing_evidence_lineage_integrity` | contract | Replaces the billing-evidence identity key to include patient and payer-program identity; strengthens the insert guard so corrections preserve complete identity, increment the evidence version and cannot branch. No historical evidence is rewritten or promoted. | Replaces a uniqueness constraint and tightens append-only correction semantics; it requires the operator hold and a reviewed application-writer plan. |
| `1553_m40_facility_kind_locked_reader` | contract | Adds the bounded M40 SECURITY DEFINER `m40_facility_kind_for_ids_locked(jsonb)` projection, owned by `mdm_canonical_writer`, to resolve facility merge chains and hold facility rows with `FOR SHARE`; only `chartwarden_app` receives EXECUTE. | Adds a privileged M40 read function and grant; role ownership/search path and the exact returned projection must be reviewed before the operator applies it. |
| `1554_m24_generalized_daily_rhc_pricing_snapshots` | contract | Preserves v1 home-RHC/Q5001 snapshots; permits v2 only for the explicit assisted-living RHC/Q5002 local-draft profile, validates the effective M5 residence and active M40 ALF identity on snapshot insert, and permits adjacent verified Q5002 billing evidence. No existing snapshot is rewritten. | Changes existing CHECK constraints and installs a new source-integrity trigger; historical rows remain unchanged and the migration remains under the operator hold. |

1542 to 1544 are `contract` only because the compat heuristic reads `ADD CONSTRAINT` and `REVOKE` as contracting. Every table they change is created by this batch (`medicaid_enrollment_evidence` by 1535; `medicaid_era_review` and `medicaid_era_review_history` by 1543). Migrations 1547–1549 deliberately remain contract because they change trusted-writer/source-reader authority or assessment integrity. Migration 1551 is contract because it changes the existing claim-line persistence contract and adds append-only evidence integrity controls. The previous-release drain below is for 1536, 1537 and 1541; the new evaluator must remain disabled unless an operator separately completes the reviewed credential and deployment procedure. This holds only when 1535 and 1543 are in the same batch: if the ledger shows 1535 already applied by an earlier release, read what that release does with `medicaid_enrollment_evidence` before applying 1542.

No migration seeds or rewrites a row. Existing claim rows keep NULL program columns (legacy unresolved), existing rate rows become `legacy_unqualified` / `unverified`, existing submission attempts become `unverified`, existing pricing snapshots remain v1, and the payer-readiness, ERA-review and pricing-evidence tables start empty.

PostgreSQL 15 or later is required by `NULLS NOT DISTINCT` (1537, and the identity key of `medicaid_payer_rate_policy` in 1539). Production's Postgres image is PostgreSQL 18 (`deploy/production/postgres/Dockerfile`); confirm the running server with `SHOW server_version_num;` before the window.

## What a merge to `main` does

`deploy.yml` deploys every push to `main`, and `deploy.sh` runs its migrate step with `--hold-contract`. With any of 1536, 1537, 1541, 1542, 1543, 1544, 1547, 1548, 1549, 1550, 1551, 1552, 1553 or 1554 pending, that step refuses the whole pending batch and exits 75 **before any DDL**: the job fails with `DEPLOY HELD BEFORE ANY SCHEMA CHANGE`, the previous release keeps running and the database is unchanged. Every later deploy, a security fix included, stays held until an operator applies the batch by hand with the sections below. An empty ledger (a first deploy) is exempt.

The by-hand run applies **every** pending migration, not only these fourteen. If another held migration is still pending in the production ledger (1508 for M25, 1512 and 1513 for M23, 1546 for the object-key column rename, or anything newer), its runbook applies too: `docs/runbooks/m25-835-deployment.md`, `docs/runbooks/m23-sia-revisions-deployment.md`, `docs/runbooks/object-key-column-rename-deployment.md`. Files apply in name order, so this batch's 1535 to 1544 run first, then 1546, 1547 to 1549, then 1550 to 1554. Read `_chartwarden_migration` first (below); do not infer production history from a branch.

## Why the previous release must be drained

Nothing here is a PostgreSQL error for the previous release's SQL, and this runbook does not claim one. Two derived reasons remain:

1. **Locks.** `ADD CONSTRAINT` takes an ACCESS EXCLUSIVE lock and scans the table (`medicaid_claim_line` and every partition of it, `medicaid_state_rate_schedule`, `medicaid_submission`); `CREATE INDEX` and `CREATE UNIQUE INDEX` on `medicaid_submission` block its writers for the build. `migrate.ts` sets a `lock_timeout` only for its own ledger bookkeeping, not for the migration files, so a DDL statement waits indefinitely behind any open transaction on the table, and every new statement on that table then queues behind it. A live `api` or `worker` doing claim assembly, submission or acknowledgment work is exactly such a writer.
2. **The previous release prices hospice lines from every schedule row.** Its claim assembly selects `medicaid_state_rate_schedule` rows by state, NULL county and effective date only (`write-service-drizzle.ts`, the `rateRows` query on `main`); it has no notion of the new qualification columns. 1536 exists so that the old, geography-free national seed rows are *not* taken as Oregon reimbursement, and labels them `legacy_unqualified`. A previous-release `api` that keeps running after 1536 would still price from them. Stop it before the schema moves, and do not bring it back afterwards.

Do not restart an old application image against the migrated schema.

## Before the maintenance window

1. Confirm the exact immutable image digest contains migrations 1535 to 1539 and 1541 to 1544 and the matching M24/M25/M40 code. Confirm an operator with database and application access is present.
2. Take the normal pre-migration backup (pgBackRest, per the operations runbook), verify it completed, and record the backup identifier and restore point.
3. Read the ledger directly from an authorized operator host, as the database owner or a `BYPASSRLS` role (the same connection rule as the M25 preflight):

   ```sql
   SELECT filename, applied_at FROM _chartwarden_migration ORDER BY filename DESC LIMIT 20;
   ```

   Require no checksum drift and no orphaned or unexpected pending file other than the ones you intend to apply. List what is pending by diffing the release's `packages/db/migrations/` against the ledger.
4. **1537 preflight (read-only).** 1537 aborts the whole file when two rate-schedule rows share an identity, treating NULLs as equal. Run the same query it runs and require zero rows:

   ```sql
   SELECT state_code, level_of_care, canonical_payer_id, county_code, effective_from, count(*)
     FROM medicaid_state_rate_schedule
    GROUP BY state_code, level_of_care, canonical_payer_id, county_code, effective_from
   HAVING count(*) > 1;
   ```

   Before 1536 the table has no `canonical_payer_id` column, so on a database that has not applied 1536 run the same query without that column and its `GROUP BY` entry. A row returned there is a duplicate that 1537 will refuse; resolve it manually before the window (this runbook does not choose which row survives).
5. Check for open transactions on the three tables that take a strong lock, and wait for them or ask their owners to finish:

   ```sql
   SELECT pid, usename, state, xact_start, left(query, 80)
     FROM pg_stat_activity
    WHERE datname = current_database() AND state <> 'idle' AND pid <> pg_backend_pid()
      AND query ~* 'medicaid_(claim_line|state_rate_schedule|submission)';
   ```

## Stop and drain the previous release

1. Turn the maintenance page on first (`deploy/production/maintenance.sh on`), since `api` will be stopped.
2. Identify the running `api` and `worker` containers by the immutable image digest and compare with the release digest. Include any operator-run job using an older image.
3. Stop or drain the previous `api` and `worker` with the normal deployment controller and let in-flight claim assembly, validation, submission and acknowledgment transactions finish.
4. Verify no old-digest process remains and no old connection is active in `pg_stat_activity` (the image digest and controller state are the version evidence, not a process name). Do not continue if one remains.

## Migrate, start, verify

1. With the previous writers stopped, apply the pending batch through the Docker migrate job with the NEW image, from the deploy directory (never `bun run db:migrate` on a host, which resets the application role). The held deploy's log prints this exact command with the digest filled in; take the digest only from that banner. Record the change ticket id with the retained verification record: the ledger row has no operator, so the ticket is the attribution.

   ```sh
   CHARTWARDEN_IMAGE='<new backend image, repo@sha256:digest>' docker compose --env-file .env.production -f compose.yml \
     run --rm --no-deps migrate bun run scripts/db/migrate.ts --strict --schema-only
   ```

   `--hold-contract` is left off on purpose. Each file is applied in ordinal order in its own transaction together with its ledger row. If a file fails, that file rolls back and the run stops: files before it stay committed, files after it are not applied. A 1537 refusal (`1537 found duplicate nullable medicaid_state_rate_schedule identities`) therefore leaves 1535 and 1536 committed and 1537, 1538, 1539 and 1541 to 1544 pending; fix the rows, then run the same command again. Do not restart the previous image meanwhile.
2. Turn the maintenance page OFF and confirm it (`sh /opt/chartwarden/maintenance.sh off`, then `sh /opt/chartwarden/maintenance.sh status` must report it off). The deploy's smoke tier 3 fetches the public SPA; with maintenance still on it sees the 503 page and fails `tier3/web`, and the failed smoke makes `restore_previous_release` recreate the OLD `api` and `worker` on the migrated schema, which is the state this runbook exists to avoid (`deploy/production/README.md`: "Turn maintenance off before re-running `deploy.sh`"). The previous writers are still stopped, so nothing writes while the page is off.
3. Re-run the held deploy: its migrate step has nothing left to apply and its `up -d --force-recreate api worker web docling-worker` starts the new release. **A failed re-run can restart the OLD writers on the migrated schema** (it believes the schema is unchanged, so `restore_previous_release` recreates the previous image). If the re-run fails after its migrate step, stop them at once with `docker compose --env-file .env.production -f compose.yml stop api worker`, turn maintenance back on (`sh /opt/chartwarden/maintenance.sh on`), fix the cause, turn it off and re-run; do not recreate from `.env.production` as it stands.
4. Confirm the ledger holds all seventeen rows with checksums, and that every replica runs the release digest:

   ```sql
   SELECT filename, checksum FROM _chartwarden_migration
    WHERE filename ~ '^(1535|1536|1537|1538|1539|1541|1542|1543|1544|1547|1548|1549|1550|1551|1552|1553|1554)_' ORDER BY filename;  -- 17 rows
   ```

5. Read-only structure checks (run as the owner or a `BYPASSRLS` role; under any other role FORCEd RLS hides every row and a count prints a false zero):

   ```sql
   -- RLS enabled and FORCEd on all nine new tables (the last two are created by 1551): 9 rows, both flags true.
   SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
    WHERE relname IN ('medicaid_program_assignment', 'medicaid_enrollment_evidence', 'medicaid_payer_authorization_event',
                      'medicaid_payer_rate_policy', 'mdm_medicaid_payer_program_classification',
                      'medicaid_era_review', 'medicaid_era_review_history',
                      'medicaid_hospice_billing_evidence', 'medicaid_claim_line_pricing_snapshot') ORDER BY relname;

   -- 1544 write lockdown: the application role reads the ERA review tables and cannot write them (true, false, false, false).
   SELECT has_table_privilege('chartwarden_app', 'medicaid_era_review', 'SELECT') AS review_select,
          has_table_privilege('chartwarden_app', 'medicaid_era_review', 'INSERT') AS review_insert,
          has_table_privilege('chartwarden_app', 'medicaid_era_review', 'UPDATE') AS review_update,
          has_table_privilege('chartwarden_app', 'medicaid_era_review_history', 'INSERT') AS history_insert;

   -- Guards installed and enabled (tgenabled = 'O'): 23 rows (the six before the last are installed by 1551, the last by 1554).
   SELECT tgrelid::regclass AS tbl, tgname, tgenabled FROM pg_trigger
    WHERE tgname IN ('trg_medicaid_program_assignment_provider_entity', 'trg_medicaid_program_assignment_insert_status',
                     'trg_medicaid_program_assignment_location', 'trg_medicaid_program_assignment_update_guard',
                     'trg_medicaid_enrollment_evidence_provider_entity', 'trg_medicaid_enrollment_evidence_insert_status',
                     'trg_medicaid_enrollment_evidence_update_guard',
                     'trg_medicaid_payer_authorization_evidence_status', 'trg_medicaid_payer_authorization_event_location',
                     'trg_medicaid_payer_authorization_event_append_only',
                     'trg_medicaid_payer_rate_policy_status', 'trg_medicaid_payer_rate_policy_supersession',
                     'trg_medicaid_payer_rate_policy_append_only',
                     'trg_medicaid_submission_provenance',
                     'medicaid_era_review_identity_immutable', 'medicaid_era_review_history_immutable',
                     'trg_lock_medicaid_rate_policy_pricing_identity',
                     'trg_medicaid_hospice_billing_evidence_insert', 'trg_medicaid_hospice_billing_evidence_append_only',
                     'trg_medicaid_claim_line_pricing_snapshot_insert', 'trg_medicaid_claim_line_pricing_snapshot_append_only',
                     'trg_medicaid_priced_claim_line_immutable',
                     'trg_medicaid_claim_line_pricing_snapshot_supported_profile') ORDER BY tgname;

   -- Audit triggers installed and enabled (tgenabled = 'O'): 9 rows. Without them the new tables change unrecorded.
   SELECT tgrelid::regclass AS tbl, tgname, tgenabled FROM pg_trigger
    WHERE tgname IN ('trg_audit_medicaid_program_assignment', 'trg_audit_medicaid_enrollment_evidence',
                     'trg_audit_medicaid_payer_authorization_event', 'trg_audit_medicaid_payer_rate_policy',
                     'trg_audit_mdm_medicaid_payer_program_classification',
                     'trg_audit_medicaid_era_review', 'trg_audit_medicaid_era_review_history',
                     'trg_audit_medicaid_hospice_billing_evidence', 'trg_audit_medicaid_claim_line_pricing_snapshot') ORDER BY tgname;

   -- 1544: the platform roles hold nothing on the two ERA review tables. 0 rows (a host without provisioned platform
   -- roles prints none either).
   SELECT r.rolname, t.relname, p.priv FROM pg_roles r
     CROSS JOIN (VALUES ('medicaid_era_review'), ('medicaid_era_review_history')) AS t(relname)
     CROSS JOIN (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE')) AS p(priv)
    WHERE r.rolname IN ('chartwarden_platform', 'chartwarden_platform_login')
      AND has_table_privilege(r.rolname, t.relname, p.priv);

   -- Unique keys: both NULLS NOT DISTINCT; the rate-policy key ends with supersedes_id.
   SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
    WHERE conname IN ('medicaid_state_rate_schedule_uq', 'medicaid_payer_rate_policy_identity_uq');

   -- Column-limited UPDATE grant: status true, patient_id false.
   SELECT has_column_privilege('chartwarden_app', 'medicaid_program_assignment', 'status', 'UPDATE') AS status_updatable,
          has_column_privilege('chartwarden_app', 'medicaid_program_assignment', 'patient_id', 'UPDATE') AS patient_id_updatable;
   ```

6. Read-only data checks; every result below is what the SQL leaves behind, and any other result needs an explanation before the release is opened to users:

   ```sql
   SELECT rate_source_kind, verification_status, count(*) FROM medicaid_state_rate_schedule GROUP BY 1, 2;
     -- only legacy_unqualified / unverified: no rate is verified by these migrations
   SELECT source_provenance_status, count(*) FROM medicaid_submission GROUP BY 1;   -- only 'unverified'
   SELECT count(*) FROM medicaid_claim WHERE medicaid_program_kind IS NOT NULL;      -- 0 before the new release writes any claim
   SELECT (SELECT count(*) FROM medicaid_program_assignment) AS assignments,
          (SELECT count(*) FROM medicaid_enrollment_evidence) AS evidence,
          (SELECT count(*) FROM medicaid_payer_authorization_event) AS authorization_events,
          (SELECT count(*) FROM medicaid_payer_rate_policy) AS rate_policies,
          (SELECT count(*) FROM mdm_medicaid_payer_program_classification) AS classifications,
          (SELECT count(*) FROM medicaid_era_review) AS era_reviews,
          (SELECT count(*) FROM medicaid_era_review_history) AS era_review_history;  -- all 0 until the new release or an operator writes; the two review tables stay 0 for every application and platform role after 1544
   ```

   Do NOT test a guard by inserting into a real tenant's table: the 1538 and 1539 tables are append-only for every role (UPDATE and DELETE are refused by trigger), so a test row would be permanent. The guards are proven by the live suites (`test:rls:live:m24`, `test:rls:live:m40`, `test:m24:remittance-feedback:live`), not on production.
7. Verify service health and the M24 routes on the new release. A migration succeeding does not prove the application works against it.

## Recording program assignments (operators)

A claim records ONE program assignment, and submission evidence is qualified against that single id, so a claim whose service window is covered only by two or more contiguous verified assignment records of the same payer resolves `ambiguous` (`PROGRAM_ASSIGNMENT_SPANS_MULTIPLE_RECORDS`) and cannot qualify: record ONE assignment that covers the whole service window, or split the claim at the assignment boundary. The application role records an assignment (and enrollment evidence) only as `candidate` or `pending`: the database refuses a one-statement INSERT of a verified or closed row. Verification is meant to go through the verify route, by a member other than the recorder; that route (the M40 classification match, the source allow-list, step-up) is enforced by the verify service, not by the database.

Known limit: the database cannot tell the verify route from other application SQL, so the application role can still INSERT a `pending` row and then UPDATE it to `verified` in a second statement, naming any verifier except the recorder. What the database does guarantee is the four-eyes arithmetic (the verifier column differs from the recorder column), that identity and verification evidence freeze once a row leaves `candidate`/`pending`, and the status transition table: not WHO the verifier is. The live suite `test:rls:live:m24` pins this limit ("known limit: ..."); do not state a stronger guarantee than this one.

## Recovery boundary

Before the first file commits, stopping the attempted deploy and restoring the prior application is safe: the database is unchanged. Each file commits on its own, so a run that stops part-way leaves the files before it applied; read the ledger to see which.

After a file commits, an application-only rollback to the previous image is not the default: for 1536 it would put back the writer that prices from `legacy_unqualified` rows (see above). The SQL shows the previous release's own statements are not rejected by the new schema (new columns are nullable or defaulted; a new row of the previous release is `unverified`), but that is read from the SQL, not from a rollback test, and it does not make the previous release correct for this data.

- Keep the previous `api` and `worker` stopped. Prefer a forward repair release compatible with these migrations.
- If forward repair is not viable, use the approved database restore plan (the verified pre-migration backup and the image matching that schema) and reconcile any M24 work done in between.
- Do not drop the new constraints or guard triggers, re-create the old unique keys, or run an unverified down migration as an ad hoc rollback. The 1538 and 1539 tables are append-only for every role, so a row written to them cannot be removed by an application or admin `DELETE`.

If `deploy.sh` exits 75 after a migration ran ("AUTOMATIC ROLLBACK REFUSED"), follow `deploy/production/README.md`, "When a deploy halts for an operator decision"; do not restart the previous image automatically. An exit 75 before any schema change ("HELD BEFORE ANY SCHEMA CHANGE") is the hold above: nothing was applied.

## L6C2 isolated M25 evaluator activation (disabled by default)

Migrations 1547–1549 are `contract` migrations and remain inside the existing operator hold. Migration 1547 creates the NOLOGIN `chartwarden_m25_evaluator` carrier, permits `isolated_evaluator` trust provenance, adds event-level provenance and operation fingerprints, and grants only org-scoped review/history writes. Migration 1548 creates a function-only Claim.MD staged-artifact reader and a separate source-reader identity. Migration 1549 records the point-in-time evaluator evidence fingerprint and observation time, but does not make historical rows trusted or current authorization. Apply them only during the documented drain above. The base Compose file keeps `M25_EVALUATOR_ENABLED=false` and requires no evaluator secrets.

Activation is a separate reviewed operation after migration:

1. Generate an Ed25519 command key pair. Custody the private PKCS#8 DER base64url file for API only and the public SPKI DER base64url file for the evaluator only.
2. Generate distinct evaluator and source-reader database passwords. Place them in root-controlled files and pass them only through `M25_EVALUATOR_LOGIN_PASSWORD_FILE` and `M25_ERA_SOURCE_LOGIN_PASSWORD_FILE`; the provision service reads these as `_FILE` secrets. Rotation uses new secret files, and the corresponding `CHARTWARDEN_M25_EVALUATOR_REVOKE=true` or `CHARTWARDEN_M25_ERA_SOURCE_REVOKE=true` operation clears memberships, disables login and removes the password.
3. Write separate evaluator-writer, application-reader and ERA-source-reader database URLs to root-controlled secret files. The evaluator also needs its Claim.MD artifact keyring file. Never add these values or key material to `.env.production`. The writer URL must connect as `chartwarden_m25_evaluator_login` and the source URL as `chartwarden_m25_era_source_login`; the application-reader URL is the API's `chartwarden_app` login (no reader-only role exists). At boot the evaluator asserts that the writer and source pools use exactly those logins and that no pool is a superuser or BYPASSRLS login, and it refuses to start otherwise. Provisioning a login with a new password also terminates that login's open sessions, so a leaked credential does not outlive its rotation.
4. Validate the effective Compose configuration with `compose.yml` plus `compose.m25-evaluator.yml`. Confirm API alone mounts the private command key; evaluator alone mounts the public key, three narrowly scoped database URLs and Claim.MD keyring; the one-shot provisioner alone mounts the login passwords; generic workers/listeners mount none of these; and evaluator publishes no host port.
5. Start the `m25-evaluator` profile, wait for `/ready` from inside its container, then recreate API with the overlay. A missing evaluator or invalid command returns a degraded error; there is no platform-database fallback.

Disable by recreating API from the base Compose file, then stop the evaluator and revoke both isolated logins when the operation is no longer required. Rollback never restores the pre-1544 shared-platform writer. Keep migrations 1547 and 1548 and their legacy provenance data in place; forward-fix the evaluator or leave writes disabled. This runtime performs no vendor polling, Medicaid submission, payment posting, claim transition or financial outbox publication. These local qualification results do not establish production account enrollment or EOCCO readiness.
