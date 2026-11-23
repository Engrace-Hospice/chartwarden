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

The by-hand run applies **every** pending migration, not only 1546. The held deploy's output names the whole pending set; drain for any other `contract` migration in it as its own runbook requires.

## Before the maintenance window

1. Confirm the immutable backend image digest of the release contains migration 1546 and the code that uses the new names (take it from the held deploy's banner). An operator with database and application access is present.
2. Take the normal pre-migration backup (pgBackRest, operations runbook) and record the backup id and restore point. A backup taken before this migration carries the old column names; see "Restoring an older backup" below.
3. Read the pending set from the held deploy's output and the `_chartwarden_migration` ledger: no checksum drift, no orphaned entries, 1546 is the only `contract` entry (or each other one has its drain planned).
4. Confirm nothing outside the application reads the old names: ad-hoc SQL, BI or reporting connections, saved queries and any operator script on `document_version.minio_object_key`, `remittance_advice.minio_object_key`, `fhir_bulk_export_artifact.minio_object_key` or `{dsar,tenant}_export_job.bundle_minio_object_key`. Those break the same way as the old image.

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

   The migration is one transaction and ends with a check that fails it if any function, trigger, policy, view, index or constraint still names the old columns. If it fails, nothing changed (the previous names and function are intact): read the error, it lists the leftover objects, and fix forward in a new migration; do not edit 1546 after it has been applied anywhere.
2. Confirm 1546 is in `_chartwarden_migration` with its checksum, then check the catalog on the admin connection (`DATABASE_ADMIN_URL`, loopback tunnel or `sslmode=verify-full`):

   ```sql
   -- five rows, no old names left anywhere
   SELECT table_name, column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND column_name IN ('object_key', 'bundle_object_key')
      AND table_name IN ('document_version', 'remittance_advice', 'fhir_bulk_export_artifact', 'dsar_export_job', 'tenant_export_job');
   SELECT count(*) FROM pg_attribute WHERE attnum > 0 AND NOT attisdropped AND attname ILIKE '%minio%';          -- 0
   SELECT indexname FROM pg_indexes WHERE tablename = 'document_version' AND indexname LIKE '%object_key%';       -- document_version_object_key_uk
   -- the audit scrub list names the new column
   SELECT pg_get_functiondef('audit_phi_write_document_version'::regproc) LIKE '%''byte_payload_cipher'', ''object_key''%'  AS scrubs_new_name,
          pg_get_functiondef('audit_phi_write_document_version'::regproc) ILIKE '%minio%'                                  AS still_old_name;  -- t, f
   ```
3. Start the compatible `api` and `worker` by immutable digest: re-run the held deploy, then confirm every replica runs that digest.
4. Verify the audit scrub on live data once a document version is written (an upload, or any render): the newest `document_version.*` audit rows carry `"object_key": "<changed>"` (never the key), and none carries `minio_object_key` as a new key:

   ```sql
   SELECT event_type, after ->> 'object_key' AS scrubbed, (after ? 'minio_object_key') AS old_key_present
     FROM audit_event WHERE resource_kind = 'document_version' ORDER BY created_at DESC LIMIT 5;   -- <changed>, f
   ```

   Audit rows written before the migration keep the old image key `minio_object_key: "<changed>"` (the value was scrubbed; audit_event is append-only and is not rewritten).
5. Smoke the paths that read the renamed columns: open a document, an 835 intake/post, a FHIR bulk export download, a DSAR export fulfilment and a tenant export download. Watch for `42703` ("column ... does not exist") in the API and worker logs: any hit is an old-name reader this release missed.

## Names deliberately not renamed

These are public or persisted contracts, mapped to the new names inside the code and left alone here: the `m25.edi.835_received` outbox payload field `minioObjectKey`, the `POST /api/v1/internal/remittance/advices` request field `minioObjectKey`, the 277CA sidecar request body field `minioObjectKey`, and the `bundleMinioObjectKey` JSON key inside `tenant_export_job_event.shard_receipt` (an `oversized_hold` event waiting for approval still carries it, and the approve route reads it).

## Restoring an older backup

A snapshot taken before 1546 has the old column names. The restore verifier's object-reference check (`scripts/lib/backup/object-refs.ts`) now queries the new names, so on a restore of an older snapshot run the migrate step on the restored database first (the verifier already reports the pending files and says to run migrate next). Do not point current tooling at an unmigrated restore, and do not rename columns by hand to make it pass.

## Recovery boundary

Before 1546 commits, abandoning the attempt is safe: the migration is one transaction, so the database is unchanged and the previous image can keep running.

Once 1546 commits, an application-only rollback to the previous image is unsafe (`42703` on every renamed column, on the upload, intake, export and remittance paths). If the new release fails after the migration:

- Keep old writers stopped and prefer a forward repair release.
- If forward repair is not viable, either restore the verified pre-migration backup together with the image that matches that schema, or apply a **second contract migration** that renames the columns back, through this same hold-and-hand-apply procedure. That migration must also restore `audit_phi_write_document_version()` with `minio_object_key` in its scrub list: renaming the columns back by hand without it would leave `object_key` scrubbed but the old-named column (the one the previous release writes) going into `audit_event` in clear.
- Do not run an ad hoc `ALTER TABLE ... RENAME COLUMN` in production.

If `deploy.sh` exits 75 after applying 1546 for any reason, follow `deploy/production/README.md`'s operator-halt procedure; do not restart the previous image automatically.
