# M23 SIA revisions migration deployment

Migration `1512_m23_sia_revision_unique.sql` changes `sia_calculation` from one row per claim to one row per `(claim, revision)`: it drops `UNIQUE (claim_id)` and adds `UNIQUE (claim_id, revision)`, the CHECKs and the INSERT guard trigger. It is classified `-- compat: contract`, as is `1513_m8_encounter_delivery_integrity.sql` (CHECKs and a write-once trigger on the encounter's visit-delivery columns). `1510` and `1511` are `expand`, but they ride in the same pending set.

No deployment is authorized by this document.

## What a merge to `main` does with 1512 and 1513

`deploy.yml` deploys every push to `main`, and `deploy.sh` runs its migrate step with `--hold-contract` (landed in #1060; check the file in the commit being released, do not assume). With 1512 and 1513 pending, that step refuses the whole batch and exits 75 **before any DDL**: the job fails with `DEPLOY HELD BEFORE ANY SCHEMA CHANGE`, the previous release keeps running (the old `api` and `worker` included) and the database is unchanged. Every deploy then stays held, a security fix included, until an operator applies the pending batch by hand with the sections below.

The by-hand run applies **every** pending migration. If 1508 (M25, `contract`) is still pending it goes with them, so run `bun run m25:835:preflight` first and drain the M25 writers too (`docs/runbooks/m25-835-deployment.md`). A database whose ledger is empty (a first deploy) is exempt from the hold.

A release whose `deploy.sh` has no `--hold-contract` (a commit before #1060) would apply 1510 to 1513 while the previous `api` and `worker` are still running, and an old death-claim assembly would fail with `42P10` until they are recreated. Never release these migrations from such a commit.

**Nothing else gates the merge.** `verify` is waived on `main` while `deploy.yml` carries its `ci-waived` release-gate line (until 2026-11-29 at the time of writing; recorded in `compliance/controls.yaml` CW-CM-01): `release` needs only `quality` (typecheck and lint), so no unit test or live suite runs before a deploy. A pull request into `main` does not trigger CI either (`ci.yml` runs `pull_request` for `fix/admission` only), so the live suites that prove this change run only when CI is dispatched on the branch: `gh workflow run ci.yml --ref <branch>`. Dispatch it and require it green, apart from named pre-existing reds, before merging.

## Why old writers must be gone first

- The previous M23 assembly inserts `sia_calculation` with `ON CONFLICT (claim_id)`. That target no longer has a unique index after 1512, so an old API or worker assembling a death claim fails with PostgreSQL `42P10`.
- The previous release reads a claim's SIA row as "the" row. Once a claim has a second revision it would read an arbitrary one.

Do not restart an old application image against the migrated schema.

## Before the maintenance window

1. Confirm the exact immutable ChartWarden image digest contains migrations 1510 to 1513 and the matching M8 and M23 code. Confirm an operator with database and application access is present.
2. Take the normal pre-migration backup (pgBackRest, per the operations runbook) and record the backup identifier and restore point.
3. Read `_chartwarden_migration` directly: no checksum drift, no pending historical migrations, no ordinal collisions. Do not infer production history from a branch or a local database. If 1508 is still pending, run `bun run m25:835:preflight` and follow the M25 runbook's drain as well.

## Stop and drain old writers

1. Identify the running `api` and `worker` containers by the immutable image digest and compare with the release digest above. Include any operator-run job using the older image.
2. Turn the maintenance page on first (`deploy/production/maintenance.sh on`), since `api` will be stopped. Then stop or drain the previous `api` and `worker` services with the normal deployment controller; let in-flight claim assembly and validation transactions finish.
3. Verify no old-digest process remains and no old connection is active in `pg_stat_activity` (the image digest and controller state are the version evidence, not a process name).

## Migrate, start, verify

1. With old writers stopped, apply the pending migrations through the Docker migrate job using the NEW image (never `bun run db:migrate` on a host, which resets the application role). The held deploy's log prints the exact command with the digest filled in; take the digest only from that banner. It is this, run from the deploy directory:

   ```sh
   CHARTWARDEN_IMAGE='<new backend image, repo@sha256:digest>' docker compose --env-file .env.production -f compose.yml \
     run --rm --no-deps migrate bun run scripts/db/migrate.ts --strict --schema-only
   ```

   The new image is needed because the deploy put `.env.production` back on the previous release's image, which lacks these migrations; `--hold-contract` is left off on purpose (the compose `migrate` service defaults to it, so a plain `docker compose up` cannot apply a held migration). Then re-run the held deploy: its migrate step has nothing left to apply, and its `up -d --force-recreate api worker web docling-worker` starts the new release.

   **A failed re-run can restart the OLD writers on the migrated schema.** The re-run applies nothing itself, so `deploy.sh` believes the schema is unchanged. If it fails after its migrate step (at `provision`, `up` or the smoke test), `restore_previous_release` puts `.env.production` back on the previous release and force-recreates `api`, `worker` and `web` from it, then prints "rollback is clean". That is the `42P10` and arbitrary-revision hazard above. (A failure before its migrate step leaves the running containers untouched, so drained writers stay stopped; a deploy that also runs the one-time object-store cutover recreates them regardless.) If that happens, stop the old writers at once with `docker compose --env-file .env.production -f compose.yml stop api worker`, fix the cause and re-run the deploy. Do not recreate from `.env.production` as it stands: it names the previous release. Only the deploy writes the new release's references back.
2. Confirm 1510, 1511, 1512 and 1513 are recorded with their checksums.
3. Confirm the new `api` and `worker` are running the release digest on every replica.
4. Confirm the guards are installed, read-only: `SELECT tgrelid::regclass, tgname, tgenabled FROM pg_trigger WHERE tgname IN ('trg_sia_calculation_insert_guard', 'trg_encounter_delivery_freeze')` returns both rows with `tgenabled = 'O'`. Do NOT test the refusal by inserting a revision into a real submitted claim: if the guard were missing that row would be permanent (UPDATE is refused, DELETE is allowed only for a draft claim's own rows) and would change the claim's published add-on.
5. Verify on a draft death claim: assemble it, then confirm `sia_calculation` holds revision 1 and that re-validation appends revision 2 only after a visit fact changes.

## After the deploy: legacy visits need a delivery mode

A visit signed before 1510 has no confirmed delivery mode, and an unconfirmed visit is never counted toward the add-on. On a death claim, a registered nurse or social work visit in the last 7 days of life whose mode is still unconfirmed makes `sia_calculation_correct` fail the claim until its author confirms the mode once through `POST /api/v1/encounters/:encounterId/visit-modality` and the claim is re-validated (re-assembled when the visit turns out to be telephonic or video, which removes its units). A confirmed in-person visit still needs documented start and stop times to count. A billing manager can override the rule with a reason. Tell the billing team before the release; confirm nothing on a clinician's behalf.

Nothing alerts billing when a legacy visit is confirmed after its claim was already billed. If the author confirms it as telephonic or video after a claim was billed (a claim billed before this release, which carries the earlier minutes-based calculation, or one billed after a billing manager's override), the claim was billed with a visit that should not have counted, which may be an overpayment to identify and return. For the weeks after the release, have billing review the `encounter.update` audit events (the real actor is recorded) that confirm an already-signed visit as telephonic or video, and check each against its claim's status. Filter on the confirmation, not on the mode changing: the 1510 backfill already set `visit_modality = 'telephonic'` on telephonic visit types and left them unconfirmed, so confirming one leaves `visit_modality` unchanged and only stamps the confirmation columns (and `updated_at`). The audit row holds the full before and after image of the encounter, and the table is multi-tenant, so:

```sql
SELECT organization_id, resource_id, actor_user_id, created_at, after->>'visit_modality' AS visit_modality
  FROM audit_event
 WHERE event_type = 'encounter.update'
   AND before->>'signed_at' IS NOT NULL
   AND before->>'visit_modality_confirmed_at' IS NULL
   AND after->>'visit_modality_confirmed_at' IS NOT NULL
   AND after->>'visit_modality' IN ('telephonic', 'video');
```

## Recovery boundary

Rollback is a one-way door once any claim holds revision 2 or later: `sia_calculation` is append-only (UPDATE is refused, DELETE only for a draft claim's own rows), so `UNIQUE (claim_id)` cannot be restored by any application or admin `DELETE`. The append-only trigger has no role exemption (unlike the claim delete guard, which honours the destruction role), so it would take a deliberate, compliance-approved and recorded disable of `trg_append_only_sia_calculation` by the table owner, which rewrites the add-on of billed claims.

- Before 1512 commits, stopping the attempted deploy and restoring the prior application is safe.
- After it commits, keep old writers stopped and prefer a forward repair release. If that is not viable, use the approved restore plan (the verified pre-migration backup and the image matching that schema) and reconcile any claim work done in between.
- Do not drop the new constraint or trigger, or run an unverified down migration, as an ad hoc rollback.

If `deploy.sh` exits 75 after a migration ran ("AUTOMATIC ROLLBACK REFUSED"), follow `deploy/production/README.md`, "When a deploy halts for an operator decision"; do not restart the previous image automatically. An exit 75 before any schema change ("HELD BEFORE ANY SCHEMA CHANGE") is the hold above: nothing was applied.
