# Object-key column rename deployment

Migration `1546_object_key_column_rename.sql` renames the five columns that still carry the retired "minio" vendor name (production object storage is SeaweedFS, dev/CI RustFS; the columns always held a plain S3 object key):

| Table | Old column | New column |
| --- | --- | --- |
| `document_version` (M22, NOT NULL, unique index rebuilt as `document_version_object_key_uk`) | `minio_object_key` | `object_key` |
| `remittance_advice` (M25, NOT NULL) | `minio_object_key` | `object_key` |
| `fhir_bulk_export_artifact` (M28, NOT NULL) | `minio_object_key` | `object_key` |
| `dsar_export_job` (M34) | `bundle_minio_object_key` | `bundle_object_key` |
| `tenant_export_job` (M34) | `bundle_minio_object_key` | `bundle_object_key` |

It also renames the three NOT NULL constraints, and replaces `audit_phi_write_document_version()` so the audit scrub list names `object_key` (it scrubbed `minio_object_key` by name; a rename alone would have left the object key going into `audit_event` in clear). Migration 1546 is contract-classified: the previous `api` and `worker` read and write the old names, so **do not start the previous image against the migrated schema**; every statement that names an old column fails with `42703`.

No deployment is authorized by this document.

## What a merge to `main` does with 1546

`deploy.yml` deploys every push to `main`, and `deploy.sh` runs its migrate step with `--hold-contract`. With 1546 pending, that step refuses the whole batch and exits 75 **before any DDL**: the job fails with `DEPLOY HELD BEFORE ANY SCHEMA CHANGE`, the previous release keeps running and the database is unchanged. Every later deploy stays held, a security fix included, until an operator applies 1546 by hand with the sections below; then re-run the held deploy (nothing is pending, so `deploy.sh` recreates `api`, `worker` and `web` on the new image). A database whose ledger is empty (a first deploy) is exempt.

The by-hand run applies **every** pending migration, not only 1546, one file at a time, each in its own transaction (see "Apply, verify, start"). The held deploy's output names the whole pending set; drain for any other `contract` migration in it as its own runbook requires. PR #1088's M24 migrations are such a set: read "Applying together with other held migrations" below before the window.

## Before the maintenance window

1. Confirm the immutable backend image digest of the release contains migration 1546 and the code that uses the new names (take it from the held deploy's banner). An operator with database and application access is present.
2. Take the normal pre-migration backup (pgBackRest, operations runbook) and record the backup id and restore point. A backup taken before this migration carries the old column names; see "Restoring an older backup" below.
3. Read the pending set from the held deploy's output and the `_chartwarden_migration` ledger: no checksum drift, no orphaned entries, 1546 is the only `contract` entry (or each other one has its drain planned and its own pre-window checks done).
4. Run this catalog query on the admin connection (`DATABASE_ADMIN_URL`, loopback tunnel or `sslmode=verify-full`; it only reads). It is the check migration 1546 ends with, character for character (a test keeps the two copies identical): it lists whatever would still name the old columns after the renames, and the objects 1546 itself renames or replaces are excused. It must return **no row**. A row aborts the migration after the drain, so settle each one first:

   ```sql
   SELECT what FROM (
   -- predicate:begin
   WITH renamed AS (
     SELECT unnest(ARRAY['document_version', 'remittance_advice', 'fhir_bulk_export_artifact', 'dsar_export_job', 'tenant_export_job']::regclass[])::oid AS relid
   )
   SELECT 'function ' || p.oid::regprocedure::text AS what
     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
      AND p.proname <> 'audit_phi_write_document_version'
      AND p.prosrc ILIKE '%minio\_object\_key%'
   UNION ALL
   SELECT 'trigger ' || t.tgrelid::regclass::text || '.' || t.tgname
     FROM pg_trigger t
    WHERE NOT t.tgisinternal AND pg_get_triggerdef(t.oid) ILIKE '%minio\_object\_key%'
   UNION ALL
   SELECT 'policy ' || pol.tablename || '.' || pol.policyname
     FROM pg_policies pol
    WHERE coalesce(pol.qual, '') || ' ' || coalesce(pol.with_check, '') ILIKE '%minio\_object\_key%'
   UNION ALL
   SELECT 'view ' || v.schemaname || '.' || v.viewname
     FROM pg_views v
    WHERE v.schemaname NOT IN ('pg_catalog', 'information_schema') AND v.definition ILIKE '%minio\_object\_key%'
   UNION ALL
   SELECT 'matview ' || m.schemaname || '.' || m.matviewname
     FROM pg_matviews m
    WHERE m.definition ILIKE '%minio\_object\_key%'
   UNION ALL
   SELECT 'column ' || a.attrelid::regclass::text || '.' || a.attname
     FROM pg_attribute a JOIN renamed r ON r.relid = a.attrelid
    WHERE a.attnum > 0 AND NOT a.attisdropped AND a.attname ILIKE '%minio%'
      AND (a.attrelid::oid, a.attname::text) NOT IN (
        ('document_version'::regclass::oid, 'minio_object_key'),
        ('remittance_advice'::regclass::oid, 'minio_object_key'),
        ('fhir_bulk_export_artifact'::regclass::oid, 'minio_object_key'),
        ('dsar_export_job'::regclass::oid, 'bundle_minio_object_key'),
        ('tenant_export_job'::regclass::oid, 'bundle_minio_object_key'))
   UNION ALL
   SELECT 'index ' || ic.relname
     FROM pg_index i JOIN pg_class ic ON ic.oid = i.indexrelid JOIN renamed r ON r.relid = i.indrelid
    WHERE ic.relname ILIKE '%minio%' AND ic.relname <> 'document_version_minio_key_uk'
   UNION ALL
   SELECT 'constraint ' || c.conrelid::regclass::text || '.' || c.conname
     FROM pg_constraint c JOIN renamed r ON r.relid = c.conrelid
    WHERE c.conname ILIKE '%minio%' AND NOT (c.contype = 'n' AND c.conname LIKE '%\_minio\_object\_key\_not\_null')
   -- predicate:end
   ) found ORDER BY what;
   ```

   | Row | What it is | What to do |
   | --- | --- | --- |
   | `function <name>` | a function whose text names `minio_object_key` (a rename never rewrites function text; an audit scrub list on the old name silently stops scrubbing) | change it to `object_key` or drop it |
   | `trigger`, `policy` | a definition that names the old column. On one of the five tables, an `UPDATE OF` column list or a policy expression is rewritten by the rename and will not stop the migration; a mention inside text (a trigger argument, a trigger name, a policy on some other table's own `minio_object_key` column) is not rewritten | confirm and ignore the first kind; fix the second like a function |
   | `view`, `matview` | a view or materialized view whose definition names the old column. One that only **uses** the column inside an expression or under another alias (`length(minio_object_key) AS key_length`, `minio_object_key AS object_key`) is rewritten and will not stop the migration. One that **exposes** it under its old output name (`SELECT id, minio_object_key FROM ...`) is not: after the rename its definition reads `object_key AS minio_object_key`, which still names the old column, so the migration aborts after the drain | drop it and recreate it over the new name (or alias the column to `object_key`) **before** the window; confirm and ignore the other kind |
   | `column <table>.<name>` | an extra column of one of the five tables with `minio` in its name | rename or drop it |
   | `index <name>`, `constraint <table>.<name>` | an index or constraint of one of the five tables named with `minio` | `ALTER INDEX ... RENAME TO` / `ALTER TABLE ... RENAME CONSTRAINT`, or drop it |

   A scratch copy of a table (`document_version_bak`) or an ad hoc index on a renamed column is not reported: the rename leaves them working.
5. Confirm nothing outside the application reads the old names: ad-hoc SQL, BI or reporting connections, saved queries and any operator script on `document_version.minio_object_key`, `remittance_advice.minio_object_key`, `fhir_bulk_export_artifact.minio_object_key` or `{dsar,tenant}_export_job.bundle_minio_object_key`. Those break the same way as the old image.

## Stop and drain old writers

1. Identify the running `api` and `worker` containers by the immutable `CHARTWARDEN_IMAGE` digest/release label and compare with the release digest above. Include any separate consumer process or operator-run job on the older image.
2. Pause what writes these tables: document uploads and renders (M22 intake, extraction, DSAR and tenant-export renders), 835 pulls and uploads (M25), FHIR bulk exports (M28), DSAR and tenant exports and the bundle-expiry sweep (M34). Stop/drain the previous `api` and `worker` with the normal production controller and let in-flight transactions finish.
3. Verify the controller reports no old-digest `api` or `worker`, and `pg_stat_activity` shows no connection still holding a transaction on those tables. A process name alone does not prove its version; use the image digest and controller state.
4. Do not continue if an old writer remains or the ledger is unclear.

## Apply, verify, start

1. With old writers stopped, run the checked production migrate job from the deploy directory with the NEW release's backend image. Take the digest only from the held deploy's banner (it is the digest `deploy.sh` verified with cosign); a digest from anywhere else must pass `cosign verify` first, because this job runs DDL as the database owner. Record the change ticket id with the verification record (the ledger row has no operator). Production migrates through the Docker job, never host `db:migrate`; never run a down or manual rename.

   ```sh
   CHARTWARDEN_IMAGE='<new backend image: ghcr.io/…/chartwarden@sha256:…>' \
     docker compose --env-file .env.production -f compose.yml \
     run --rm --no-deps migrate bun run scripts/db/migrate.ts --strict --schema-only
   ```

   The runner applies the pending files in file-name order and **each file is its own transaction**: it commits together with its ledger row, and a failure rolls back that file only. Every file before the failing one stays applied; every file after it is not run. 1546 itself is a single transaction. If it is the only pending file, a failure leaves the database exactly as it was (previous names and function intact); if other files precede it, see "Applying together with PR #1088's migrations".

   1546 sets `lock_timeout = '10s'` and ends with the check from the pre-window query. Two ways it can stop:

   - **Lock timeout** (`canceling statement due to lock timeout`, SQLSTATE `55P03`): a session is holding or queued on a lock on one of the five tables, usually idle in a transaction. The file rolled back whole, so it is safe to retry once the blocker is gone. Find it with `SELECT pid, usename, state, xact_start, left(query, 80) FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND state <> 'idle';`, ask its owner to finish (or terminate that one pid by number), then re-run the command.
   - **`object-key rename incomplete: still naming ...`**: the check found a leftover and rolled the file back; the error lists each one. A new migration cannot fix this (the runner throws at 1546 on every attempt, so it never reaches a later file). Remove or rename each listed object by hand on the admin connection, as the pre-window table says, and re-run the same command. If 1546 itself is wrong, amend it before it is merged (it has been applied nowhere); once it has been applied anywhere, never edit it (`--strict` refuses a checksum drift).
2. Confirm 1546 is in `_chartwarden_migration` with its checksum, then check the catalog on the admin connection (`DATABASE_ADMIN_URL`, loopback tunnel or `sslmode=verify-full`):

   ```sql
   -- five rows
   SELECT table_name, column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND column_name IN ('object_key', 'bundle_object_key')
      AND table_name IN ('document_version', 'remittance_advice', 'fhir_bulk_export_artifact', 'dsar_export_job', 'tenant_export_job');
   -- no row: none of the five tables still has a column named with minio
   SELECT attrelid::regclass, attname FROM pg_attribute
    WHERE attrelid IN ('document_version'::regclass, 'remittance_advice'::regclass, 'fhir_bulk_export_artifact'::regclass,
                       'dsar_export_job'::regclass, 'tenant_export_job'::regclass)
      AND attnum > 0 AND NOT attisdropped AND attname ILIKE '%minio%';
   -- document_version_object_key_uk (and any ad hoc index of yours on the column)
   SELECT indexname FROM pg_indexes WHERE tablename = 'document_version' AND indexdef LIKE '%object_key%';
   -- the audit scrub list names the new column
   SELECT pg_get_functiondef('audit_phi_write_document_version'::regproc) LIKE '%''byte_payload_cipher'', ''object_key''%'  AS scrubs_new_name,
          pg_get_functiondef('audit_phi_write_document_version'::regproc) ILIKE '%minio%'                                  AS still_old_name;  -- t, f
   ```

   The column check looks at the five tables only, so a scratch copy of a table (`document_version_bak`) or an ad hoc index elsewhere does not show up in it. A row from it means a column named with `minio` exists on one of the five tables: 1546's own closing check would have aborted on it, so it was added after the migration, or the file did not run as written. Find out which before starting the application. `still_old_name` must be `f`: `t` means the audit scrub function still names the old column.
3. Start the compatible `api` and `worker` by immutable digest: re-run the held deploy, then confirm every replica runs that digest.
4. Verify the audit scrub on live data once a document version is written (an upload, or any render): the newest `document_version.*` audit rows carry `"object_key": "<changed>"` (never the key), and none carries `minio_object_key` as a new key:

   ```sql
   SELECT event_type, after ->> 'object_key' AS scrubbed, (after ? 'minio_object_key') AS old_key_present
     FROM audit_event WHERE resource_kind = 'document_version' ORDER BY created_at DESC LIMIT 5;   -- <changed>, f
   ```

   Audit rows written before the migration keep the old image key `minio_object_key: "<changed>"` (the value was scrubbed; audit_event is append-only and is not rewritten).
5. Smoke the paths that read the renamed columns: open a document, an 835 intake/post, a FHIR bulk export download, a DSAR export fulfilment and a tenant export download. Watch for `42703` ("column ... does not exist") in the API and worker logs: any hit is an old-name reader this release missed.

## Applying together with other held migrations (PR #1088's M24 set)

PR #1088 (M24 payer readiness) carries several migrations, `contract` ones among them, and it is still moving: do not rely on any list of its ordinals here. Read the held deploy's pending list and each pending file's `-- compat:` header. The runner applies **every** pending file in file-name order, each in its own BEGIN/COMMIT, and has no switch to apply only one; every `contract` file is applied by hand in that single run. A failure at file N therefore leaves all earlier files committed and all later ones, 1546 included, unrun. PR #1088's runbook (`docs/runbooks/m24-payer-readiness-deployment.md` on that branch until it merges) is the authority for its own files.

- **A failure part-way commits everything before it.** One of #1088's migrations (1537 at the time of writing) aborts on purpose (`RAISE EXCEPTION`) when two `medicaid_state_rate_schedule` rows share an identity. If a file like that fails, everything before it is committed, it and everything after it (1546 included) is not, and the old `api` and `worker` are already stopped. The application then stays down: the previous image must not be started when an applied file is not `expand` (per that runbook, an earlier file there changes how the previous release prices hospice lines), and the new image cannot run before 1546 has applied (it reads the new column names).
- **Resume.** Fix the cause (for a duplicate-row abort, the rows, as that runbook describes) and re-run the same migrate command. The committed files are in `_chartwarden_migration` and are skipped; the run continues at the first file that is not. Read the ledger before and after (`SELECT filename, applied_at FROM _chartwarden_migration ORDER BY filename DESC LIMIT 10;`).
- **Prefer one set per window.** If #1088 merges first, apply its set under its own runbook and run the held deploy; then merge this change and apply 1546 alone. If this change merges first, 1546 is alone in the release image: apply it, then #1088's set. If both ride in one release, also do that runbook's pre-window checks, above all its step 4 (the duplicate query its migration 1537 runs: it must return no row), and plan for the longer outage.

## Names deliberately not renamed

These are public or persisted contracts, mapped to the new names inside the code and left alone here: the `m25.edi.835_received` outbox payload field `minioObjectKey`, the `POST /api/v1/internal/remittance/advices` request field `minioObjectKey`, the 277CA sidecar request body field `minioObjectKey`, and the `bundleMinioObjectKey` JSON key inside `tenant_export_job_event.shard_receipt` (an `oversized_hold` event waiting for approval still carries it, and the approve route reads it).

## Restoring an older backup

A snapshot taken before 1546 has the old column names. The restore verifier (`scripts/lib/backup/verify-restore.ts`, its object reconciliation) reads the object references of either schema: it uses `object_key` / `bundle_object_key` and falls back to the old names on a table that still has them, so verifying a pre-1546 snapshot works as before. Do **not** run the migrate step on the restored database first: the verifier compares the restored ledger and schema fingerprint with the snapshot's own marker, and a migrated restore fails both. A restore of an older snapshot legitimately shows pending migration files, and the ledger check says so.

Take a fresh snapshot right after the verification step above, so the next drill runs on a post-1546 snapshot and needs no fallback. Never rename columns by hand to make a restore pass.

## Recovery boundary

Before 1546 commits: if 1546 is the only pending file, abandoning the attempt is safe (one transaction, the database is unchanged, the previous image can keep running). If other files precede it in the run they have each committed on their own: read `_chartwarden_migration` for exactly what is applied. The previous image is safe only if every applied file is `expand` (read each one's `-- compat:` header); after an applied `contract` file follow `deploy/production/README.md`'s operator-halt procedure instead.

Once 1546 commits, an application-only rollback to the previous image is unsafe (`42703` on every renamed column, on the upload, intake, export and remittance paths). If the new release fails after the migration:

- Keep old writers stopped and prefer a forward repair release.
- If forward repair is not viable, either restore the verified pre-migration backup together with the image that matches that schema, or apply a **second contract migration** that renames the columns back, through this same hold-and-hand-apply procedure. That migration must also restore `audit_phi_write_document_version()` with `minio_object_key` in its scrub list: renaming the columns back by hand without it would leave `object_key` scrubbed but the old-named column (the one the previous release writes) going into `audit_event` in clear.
- Do not run an ad hoc `ALTER TABLE ... RENAME COLUMN` in production.

If `deploy.sh` exits 75 after applying 1546 for any reason, follow `deploy/production/README.md`'s operator-halt procedure; do not restart the previous image automatically.
