# M25 835 group-identity migration deployment

Migration `1508_m25_835_group_identity_dates.sql` changes the unique conflict target used by 835 intake and Claim.MD staging. An old API or worker writer still issuing the former three-column `ON CONFLICT` target will fail with PostgreSQL `42P10` after the migration. Migration 1508 is contract-classified, so the normal deploy rollback must halt for an operator decision. Do not restart an old application image against the migrated schema.

This procedure is for a reviewed release containing both migration 1508 and the matching M25 writer. No deployment is authorized by this document.

## What a merge to `main` does with 1508

`deploy.yml` deploys every push to `main`, and `deploy.sh` runs its migrate step with `--hold-contract`. With 1508 pending, that step refuses the whole batch and exits 75 **before any DDL**: the job fails with `DEPLOY HELD BEFORE ANY SCHEMA CHANGE`, the previous release keeps running, and the database is unchanged. Every deploy stays held, loudly, until an operator applies 1508 by hand with the sections below (the manual command does not pass `--hold-contract`; the compose `migrate` service now defaults to it, so even a plain `docker compose up` cannot apply 1508). While 1508 is pending, every push to `main` is held, a security fix included; applying 1508 is what unblocks them. Once 1508 is in `_chartwarden_migration`, re-run the held deploy: nothing is pending, so `deploy.sh` proceeds normally. There is deliberately no "acknowledge and proceed" switch, because `deploy.sh` does not stop the old writers before it migrates.

A database whose ledger is empty (a first deploy) is exempt, since no old writers exist. A first deploy that fails part-way leaves a non-empty ledger, so its retry is held on 1508 the same way; that fails closed, and the same hand-apply clears it.

## Before the maintenance window

1. Confirm the exact immutable ChartWarden image digest contains the new writer and the migration. Confirm an operator with database and application access is present.
2. Take the normal production pre-migration backup using the operations runbook's pgBackRest procedure. Verify the backup completed and recovery credentials, WAL archive, and restore procedure are available. Record the backup identifier and restore point.
3. Run the read-only migration audit from an authorized operator host:

   ```sh
   M25_PREFLIGHT_DATABASE_URL="$DATABASE_ADMIN_URL" bun run m25:835:preflight
   ```

   The preflight is deliberately strict about its connection. It refuses a role that is neither a superuser nor `BYPASSRLS` (row-level security would hide rows and print a false clean zero), and it refuses any non-loopback host unless the URL carries `sslmode=verify-full`. Use the database owner connection the migrate job uses, reached through a loopback tunnel to the database or a TLS-verified connection; do not weaken either check to get an answer.

   Require a readable `_chartwarden_migration` ledger, no checksum drift, no orphaned ledger entries, no pending historical migrations, no ordinal collisions, and no M25 scoped-identity data violations. Before migration 1508, its target should report `PENDING`; inspect the current unique index definition and confirm it is the old target. After migration, rerun and require the provenance columns and new `NULLS NOT DISTINCT` indexes. The command is read-only and never applies or repairs migrations.

4. Verify the database ledger directly against the release's migration directory. Do not infer production history from this branch, a local database, or the Drizzle journal alone. The exact migration filename and checksum must be visible in `_chartwarden_migration` after deployment.

## Stop and drain old writers

1. Identify running `api` and `worker` containers by the immutable `CHARTWARDEN_IMAGE` digest/release label, and compare them with the release digest confirmed above. Include any separate M25 consumer process or operator-run intake job using that same older image.
2. Pause new 835 uploads/pulls and stop accepting Claim.MD delivery work for the maintenance window. Stop/drain the previous `api` and `worker` services using the normal production deployment controller; allow in-flight receive, review-commit, outbox, and posting transactions to finish.
3. Verify the deployment controller reports no old-digest `api` or `worker` process and no queued/in-flight M25 operation is still owned by that release. Check `pg_stat_activity` for remaining connections from those processes and wait until their active transactions finish. A process name or PostgreSQL `application_name` alone does not prove its code version; use the immutable image digest and controller state as the version evidence.
4. Do not continue if an old writer remains, if the ledger is unclear, or if preflight reports a drift/data issue. Resolve the operational blocker first.

## Migrate, start, and verify

1. With old writers stopped, run the checked production migrate job from the deploy directory, with the NEW release's backend image (the held deploy prints this exact command with the digest filled in; it has put the env file back on the previous release's image, which does not contain 1508, so the override is required). Production migrates through the Docker job, never host `db:migrate`. Do not invoke a manual/down migration.

   ```sh
   CHARTWARDEN_IMAGE='<new backend image: ghcr.io/…/chartwarden@sha256:…>' \
     docker compose --env-file .env.production -f compose.yml \
     run --rm --no-deps migrate bun run scripts/db/migrate.ts --strict --schema-only
   ```
2. Confirm migration 1508 is recorded with its checksum. Rerun the read-only preflight; confirm all new columns, scope constraints, and unique index definitions, and verify the old conflict target is no longer present.
3. Start the compatible API and worker image by its immutable digest: re-run the held deploy (with 1508 now in the ledger nothing is pending, so `deploy.sh` recreates `api`, `worker` and `web` on the new image). Confirm all replicas use that digest before resuming intake.
4. Verify service health and M25 worker/outbox bindings. Exercise the approved 835 receive path with a controlled, authorized operational sample only when the business owner has approved one. Confirm the advice is scoped to the expected tenant/provider, identity evidence contains no raw NPI/TIN, dates retain their separate values, and the advice reaches the expected review/posting state. Do not use a synthetic fixture as proof of MAC compatibility.
5. Monitor non-retryable identity refusals, parse degradation, `42P10`, held duplicates, cross-source duplicate holds, failed postings, and outbox lag. The 835 pull cron fails (BullMQ retries it) while a file is held (`LEGACY_IDENTITY_AMBIGUOUS`, `CLAIMMD_ERA_STAGE_MATCH`) and, every tick, while any file is quarantined: a `N quarantined remittance(s) awaiting operator release (UNSUPPORTED_ROUTING=n, RECEIVE_REFUSED=n)` line means money is waiting on an operator, because a quarantined file is no longer offered by the vendor. The reason code tells a routing refusal (a non-HP functional group in the interchange) from a content one. Release a file with the admin SQL in the header of migration 1256 (it also rewinds the cursor); an unreleased file keeps the cron failing by design. Compare counts to the normal operational baseline and retain the migration checksum, image digest, preflight output, and verification record.

## Recovery boundary

Before migration 1508 commits, stopping the attempted deploy and restoring the prior application is safe if the database is unchanged. Once 1508 commits, an application-only rollback to the previous image is unsafe because its `ON CONFLICT` target no longer has a matching unique index.

If the compatible release fails after migration:

- Keep old writers stopped. Prefer a forward repair release compatible with migration 1508.
- If forward repair is not viable, use the approved database restore/recovery plan to restore the verified pre-migration backup and the application image that matches that schema. Coordinate intake pause, WAL recovery point, queued outbox work, and any external 835 delivery acknowledgments before reopening service.
- Do not drop the new index, recreate the old index, or run an unverified down migration as an ad hoc rollback. Reconcile any intake/outbox work after recovery to prevent lost or duplicate posting.

If `deploy.sh` exits 75 after applying migration 1508, follow `deploy/production/README.md`'s operator-halt procedure; do not restart the previous image automatically.
