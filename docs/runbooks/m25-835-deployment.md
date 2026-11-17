# M25 835 group-identity migration deployment

Migration `1508_m25_835_group_identity_dates.sql` changes the unique conflict target used by 835 intake and Claim.MD staging. An old API or worker writer still issuing the former three-column `ON CONFLICT` target will fail with PostgreSQL `42P10` after the migration. Migration 1508 is contract-classified, so the normal deploy rollback must halt for an operator decision. Do not restart an old application image against the migrated schema.

This procedure is for a reviewed release containing both migration 1508 and the matching M25 writer. No deployment is authorized by this document.

## Before the maintenance window

1. Confirm the exact immutable ChartWarden image digest contains the new writer and the migration. Confirm an operator with database and application access is present.
2. Take the normal production pre-migration backup using the operations runbook's pgBackRest procedure. Verify the backup completed and recovery credentials, WAL archive, and restore procedure are available. Record the backup identifier and restore point.
3. Run the read-only migration audit from an authorized operator host:

   ```sh
   M25_PREFLIGHT_DATABASE_URL="$DATABASE_ADMIN_URL" bun run m25:835:preflight
   ```

   Require a readable `_chartwarden_migration` ledger, no checksum drift, no orphaned ledger entries, no pending historical migrations, no ordinal collisions, and no M25 scoped-identity data violations. Before migration 1508, its target should report `PENDING`; inspect the current unique index definition and confirm it is the old target. After migration, rerun and require the provenance columns and new `NULLS NOT DISTINCT` indexes. The command is read-only and never applies or repairs migrations.

4. Verify the database ledger directly against the release's migration directory. Do not infer production history from this branch, a local database, or the Drizzle journal alone. The exact migration filename and checksum must be visible in `_chartwarden_migration` after deployment.

## Stop and drain old writers

1. Identify running `api` and `worker` containers by the immutable `CHARTWARDEN_IMAGE` digest/release label, and compare them with the release digest confirmed above. Include any separate M25 consumer process or operator-run intake job using that same older image.
2. Pause new 835 uploads/pulls and stop accepting Claim.MD delivery work for the maintenance window. Stop/drain the previous `api` and `worker` services using the normal production deployment controller; allow in-flight receive, review-commit, outbox, and posting transactions to finish.
3. Verify the deployment controller reports no old-digest `api` or `worker` process and no queued/in-flight M25 operation is still owned by that release. Check `pg_stat_activity` for remaining connections from those processes and wait until their active transactions finish. A process name or PostgreSQL `application_name` alone does not prove its code version; use the immutable image digest and controller state as the version evidence.
4. Do not continue if an old writer remains, if the ledger is unclear, or if preflight reports a drift/data issue. Resolve the operational blocker first.

## Migrate, start, and verify

1. With old writers stopped, run the normal checked production migration command (`bun run db:migrate:deploy`) using the approved database owner connection. Do not invoke a manual/down migration.
2. Confirm migration 1508 is recorded with its checksum. Rerun the read-only preflight; confirm all new columns, scope constraints, and unique index definitions, and verify the old conflict target is no longer present.
3. Start the compatible API and worker image by its immutable digest. Confirm all replicas use that digest before resuming intake.
4. Verify service health and M25 worker/outbox bindings. Exercise the approved 835 receive path with a controlled, authorized operational sample only when the business owner has approved one. Confirm the advice is scoped to the expected tenant/provider, identity evidence contains no raw NPI/TIN, dates retain their separate values, and the advice reaches the expected review/posting state. Do not use a synthetic fixture as proof of MAC compatibility.
5. Monitor non-retryable identity refusals, parse degradation, `42P10`, held duplicates, cross-source duplicate holds, failed postings, and outbox lag. Compare counts to the normal operational baseline and retain the migration checksum, image digest, preflight output, and verification record.

## Recovery boundary

Before migration 1508 commits, stopping the attempted deploy and restoring the prior application is safe if the database is unchanged. Once 1508 commits, an application-only rollback to the previous image is unsafe because its `ON CONFLICT` target no longer has a matching unique index.

If the compatible release fails after migration:

- Keep old writers stopped. Prefer a forward repair release compatible with migration 1508.
- If forward repair is not viable, use the approved database restore/recovery plan to restore the verified pre-migration backup and the application image that matches that schema. Coordinate intake pause, WAL recovery point, queued outbox work, and any external 835 delivery acknowledgments before reopening service.
- Do not drop the new index, recreate the old index, or run an unverified down migration as an ad hoc rollback. Reconcile any intake/outbox work after recovery to prevent lost or duplicate posting.

If `deploy.sh` exits 75 after applying migration 1508, follow `deploy/production/README.md`'s operator-halt procedure; do not restart the previous image automatically.
