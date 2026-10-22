# Runbook: M36 restore drill ("restore consistency")

Phase 1 gate: *a restore drill proves DB + object-store consistency within the recorded RPO/RTO.* This runbook is
what the drill does, how to run it, what production backs up today (not much), and how to read the numbers.

Run it: `bun run m36:restore-drill` (needs Docker and the images `pgvector/pgvector:pg18` and a MinIO image;
`WX_DRILL_MINIO_IMAGE` overrides the default `cgr.dev/chainguard/minio:latest`). Reports are written to
`audit/restore-drill/m36-restore-drill.{json,md}`. Detection proof: `bun run m36:restore-drill:detect`.
It starts and removes only containers it labels itself (`wx-m36-restore-drill=<runId>`); it never touches the shared
cluster or the local Docker compose stack, and it is not wired into CI (a live, Docker-in-Docker drill is run by a person, per release). Containers use free loopback ports chosen at run time, so nothing needs a fixed port.

## 1. What production actually backs up (findings)

Read from `deploy/production/`, `ops/pgbackrest/`, `.github/workflows/` and the DR/BCP + ADR-0050 text. The DR/BCP
document's own banner says the same: every backup topology in it is a target, not a build.

| Asset | What exists today | What does not |
|---|---|---|
| Postgres | `pg_dump -U postgres -d chartwarden \| gzip` into `backups/pre-reseed-<ts>.sql.gz` on the VPS, **only** when an operator runs `reseed-demo.sh reseed` (`deploy/production/reseed-demo.sh`) | No scheduled backup, no WAL archiving, no PITR, no off-host copy, no retention, no restore script. pgBackRest is `ops/pgbackrest/pgbackrest.conf.template` ("NOT wired to any real host/credentials"). `deploy.sh` backs up only `.env.production` |
| Object store (MinIO) | Data lives in the `minio-data` Docker volume on the same host | **No backup of any kind**: no `mc mirror`, no site replication, no snapshot. DR/BCP section 4.2 (replication to a backup VM, Object Lock) is unbuilt |
| Cross-store coordination | none | Nothing relates a DB backup to an object-store backup. A DB restore with no matching object restore leaves attachment rows pointing at missing objects |
| Secrets | `.env.production` copy beside each deploy | `MESSAGING_ENCRYPTION_KEY` (and `M34_TENANT_KEK`) are not in any backup; a DB restored without the same key cannot decrypt a single message body, and `messaging.hash_verify` reports every row as a mismatch |
| Roles | Created by migrations and `provision-runtime-roles.ts` | `pg_dump` of one database carries **no roles**. See section 3: a naive restore fails |

Consequence: the only RPO that can be stated for production today is "everything since the last manual pre-reseed dump
(possibly never)", and the only RTO is "a person improvising". The DR/BCP targets below are not met by anything that runs.
The drill therefore exercises the closest real mechanisms: the production `pg_dump | gzip` command for the DB, and a copy
of the MinIO data volume for the object store (flagged as an assumption, not as production behaviour).

Recorded targets (DR/BCP section 3, all marked TARGET): Tier 1 (real-time alerts, API) 1 h RTO / 5 min RPO; Tier 2
(documents, care plan) 4 h / 15 min. Which tier M36 messaging belongs to is not stated anywhere; a person has to decide it.

## 2. What the drill does

1. Starts a source Postgres 18 (pgvector) and MinIO; creates database `chartwarden`; runs `scripts/db/migrate.ts` and
   `scripts/db/provision-runtime-roles.ts` (the production path).
2. Seeds two tenants **through the real M36 routes** as `chartwarden_app` (Authorization Contract, `channel_visibility` ABAC,
   idempotency store, catalog-validating outbox): messages, two edits (revisions), attachments uploaded by real presigned
   PUT to MinIO and scanned, and one quarantined attachment destroyed by the real reaper under the destruction credential.
   Only organizations, users and memberships are inserted directly.
3. Records a backup-time manifest (row count per M36-owned table; RLS flags, policies, grants, triggers per table; per-org
   `audit_event` count and M4 hash chain; per-object size, sha256 of the bytes, etag), then takes the backups and notes the timestamp.
4. Writes more data **after** the backup, notes the failure instant, kills the source. Rows and objects that exist only
   there are the RPO loss.
5. Restores into a **scratch** Postgres and **scratch** MinIO and times it.
6. Verifies (the drill exits 1 if any check fails):
   - row counts per M36 table equal the backup-time counts;
   - RLS flags / policies / grants / triggers per M36 table equal the source;
   - `audit_event` count and hash chain per org equal the source;
   - every non-destroyed `message_attachment` row has its object present, with matching size, sha256 (of the bytes, not the
     stored checksum header) and etag; destroyed rows have no object; no stored object lacks a row;
   - as `chartwarden_app` on the restored DB: not superuser/BYPASSRLS; no tenant context reads nothing; org A reads its rows;
     org A reads nothing of org B (messages, attachments, channels, audit);
   - message <-> attachment <-> audit reconcile, independent of the backup manifest (WP 5.10): every `message`, `message_revision`
     and `message_attachment` row has its `<table>.insert` audit event (the generic audit trigger writes one per row); no such
     audit event points at a row that does not exist; every attachment with a `message_id` has a message in the same org (an
     upload not yet attached has `message_id` NULL by design and is not flagged);
     **Known limit:** the orphan-audit rule assumes M36 never hard-deletes `message`, `message_revision` or `message_attachment`
     rows. WP 5.6 retention destruction (branch `feat/m36-wp56-retention-finish`) does, and records the ids in
     `m36.retention_destruction.batch_completed`; a drill against a database that has had a destruction run will therefore report
     those audit rows as orphans by design. Not exempted yet (it would couple the drill to code not on this branch); once 5.6
     merges, exempt audit rows whose id appears in a `batch_completed` record, and add a fault test for it.
   - `runHashVerifyForOrg` (the production job body) over every message and `message_revision` row (run last: it writes audit rows);
   - restore wall time against the Tier 1 RTO target (1 h; `WX_DRILL_RTO_TARGET_S` overrides, must be a positive number or the drill refuses to start). This compares a measurement with a
     TARGET; it is not evidence that any service level is committed.

## 3. Restore procedure the drill proved

1. New Postgres 18 + pgvector. **Create the roles first**: `pg_dump` has none, and the dump's `OWNER TO` / `GRANT` /
   `CREATE POLICY ... TO chartwarden_app` lines name them. The drill bootstraps them by running migrate + provision against a
   throwaway database and dropping it. Verified failure without this step: `bun run m36:restore-drill -- --no-role-bootstrap`
   stops with `ERROR: role "chartwarden_admin" does not exist`. Without `ON_ERROR_STOP` the same restore completes with
   thousands of errors and a database whose policies and grants are partly missing.
2. `gunzip -c backup.sql.gz | psql -U postgres -d chartwarden -v ON_ERROR_STOP=1`.
3. Restore the object store (the drill copies the volume tar into a fresh MinIO container before it starts).
4. Provide the same `MESSAGING_ENCRYPTION_KEY` and runtime-role passwords as the failed host.
5. Run the verification above (or the drill's report) before cutting traffic over.

## 4. Reading the numbers

The report labels itself **demo scale**. Measured on this developer machine (Apple laptop, Docker Desktop, 2026-10-22, WP 5.10):
three runs restored in 11.6 s, 11.8 s and 12.5 s (new Postgres up 1.3 s, roles bootstrap 4.1 to 4.4 s, `pg_dump` load 6.4 to 6.8 s;
verification 0.5 to 0.6 s) with a data window lost of 1.7 to 1.8 s (3 messages, 1 attachment, 3 receipts and 1 object written
after the backup). An earlier session on the same class of hardware recorded 9.2 s, 9.6 s and 37.9 s (the slow one under container
load). Those numbers are not production figures: the backup is 1.0 MB gzip, mostly the schema of ~480 migrations (dump load and roles
bootstrap dominate, not data), so they show the procedure works and where the time goes, not what a production-sized restore would
take. RPO here is `failure instant - backup instant`: the drill's window is seconds because it is told to fail seconds after the
backup; with `pg_dump` the real window is the gap between dumps, which today is "since the last manual pre-reseed dump". So the
RTO check can pass against the 1 h Tier 1 target at demo scale, while the RPO target (5 min or 15 min) is **not** met by anything
that runs in production.

## 5. Detection proof

`bun run m36:restore-drill:detect` injects one fault into the restored side and requires the drill to exit 1 *and* the
matching check to be the one that failed:

| Fault | Failing check |
|---|---|
| `--fault=missing-object` (one object deleted) | attachment objects present and byte-identical |
| `--fault=object-bytes` (same-size random bytes) | attachment objects present and byte-identical |
| `--fault=hash-flip` (one `message.body_sha256` overwritten) | message and message_revision body hashes verify |
| `--fault=orphan-audit` (a `message.insert` audit event for a message id with no row) | message <-> attachment <-> audit reconcile (the audit count/chain check fails too) |
| `--fault=missing-audit` (one `message.insert` audit event removed) | message <-> attachment <-> audit reconcile (the audit count/chain check fails too) |
| `--fault=message-deleted` (a message that owns an attachment removed) | message <-> attachment <-> audit reconcile (the row-count check fails too) |

Faults are injected with `session_replication_role = replica`, i.e. the way corruption or a lossy restore bypasses the
append-only and immutability triggers. Last run: all six reported `DETECTED`.

## 6. Open decisions (need a person)

- Approve the RPO/RTO that apply to M36 (Tier 1: 5 min / 1 h, or Tier 2: 15 min / 4 h). Today's reality does not meet either.
- Build the missing backup: scheduled `pg_dump` at minimum, WAL archiving + PITR to meet any minutes-scale RPO, an
  off-host object-store backup, and a way to take the two consistently (DB first, then objects, so every row's object exists).
- Decide where `MESSAGING_ENCRYPTION_KEY` / `M34_TENANT_KEK` are escrowed.
