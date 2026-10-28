# Coordinated backup -> restore -> verify drill - PASS

> **Synthetic scale, private containers on one developer machine.** These numbers prove the mechanism and the
> verifier end to end; they do not size production. Production RPO/RTO must come from a witnessed drill on the
> real host and off-site target (see the follow-up ops issue).

Run 13d376 at 2026-10-27T16:13:44.720Z. Scale: synthetic: 2 tenants seeded through the real M36 routes; 50293 rows in 658 tables (incl. reference data); 6 objects.

## Tooling
- **pgbackrest**: pgBackRest 2.60.0
- **postgres**: postgres (PostgreSQL) 18.6 (Debian 18.6-1.pgdg12+2)
- **objectStore**: cgr.dev/chainguard/minio:latest (source, restore target and off-site stand-in)
- **offsite**: second private MinIO over TLS (throwaway self-signed cert), object lock COMPLIANCE + versioning, three scoped keys from deploy/production/backup/offsite-policies (WAL-only in the postgres container, backup in the sidecar, read-only for the restore), secrets passed as files, SSE-C

## Snapshots taken
| snapshot | base backup | LSN | objects | bytes | wall |
|---|---|---|---|---|---|
| 20261027T161403Z | 20261027-161505F (full) | 0/D000000 | 6 | 1630228 | 66.0 s |
| 20261027T161510Z | 20261027-161505F (reused) | 0/E480118 | 6 | 1671168 | 1.2 s |

## Measured RTO (synthetic scale)
Isolated restore (pgBackRest restore + WAL replay + promotion + object copy with sha256 check): **7.0 s**. Verification: 2.9 s.

| phase | wall |
|---|---|
| pgBackRest restore from the off-site repo (base backup) | 2.8 s |
| Postgres start + WAL replay to the marker LSN + promotion | 2.3 s |
| objects: off-site -> fresh MinIO, sha256 checked against the manifest | 1.8 s |

## Measured RPO (synthetic scale)
Restored snapshot taken 2026-10-27T16:15:12.014Z; source destroyed 2026-10-27T16:15:15.604Z. Window lost: **3.6 s** (11 audit_event, 4 idempotency_key, 3 message, 1 message_attachment, 3 message_receipt, 4 outbox_event; 1 object(s)). With the production schedule the coordinated RPO is the snapshot interval (default 15 min); the database alone can be recovered to the last archived WAL segment (archive_timeout 60 s).

## Checks
| result | check | detail |
|---|---|---|
| PASS | restore.sh picked the newest complete snapshot (snapshot 2, no base backup of its own) | restored 20261027T161510Z, expected 20261027T161510Z |
| PASS | restored cluster replayed WAL to the snapshot LSN, promoted, and does not archive | in_recovery=false wal>=0/E480118:true archive_mode=off |
| PASS | migrations ledger equals the snapshot's (count and last applied file) | restored 610 / last 1287_m41_commercial_destruction_grants.sql; snapshot 610 / last 1287_m41_commercial_destruction_grants.sql |
| PASS | migrations ledger is consistent with this release (no unknown or drifted file) | 0 pending (apply with migrate), 0 unknown, 0 drifted |
| PASS | schema fingerprint (columns, constraints, indexes, RLS flags, policies, grants, triggers) equals the snapshot's | 4c4a34067acd162f0712b0a263535cd2 |
| PASS | restored DB: chartwarden_app logs in and is NOT superuser / BYPASSRLS | chartwarden_app super=false bypassrls=false |
| PASS | RLS smoke over every tenant table: no tenant context reads no tenant row; tenant A reads its own rows and none of any other tenant (and B likewise) | 570 tables; own rows visible to A: 135; other-tenant rows visible: 0 (A) / 0 (B); no-context rows: 0; probes refused by grants/policies: 6 |
| PASS | every column that looks like an object reference is classified (registered for reconciliation or excluded with a reason) | 15 column(s) classified |
| PASS | every live row that references an object has it after restore, retrievable through the app adapter, sha256 = snapshot = row | 6 object reference(s) reconciled (message_attachment=6) |
| PASS | snapshot objects not referenced by a live row (informational: pending uploads, quarantined or platform objects) | 0 of 6 |
| PASS | M4 audit hash chain: stored seals link up and every sealed month recomputes to its seal | 2 org(s), 2 sealed month(s) recomputed, full chain digested per org |
| PASS | every table's row count equals the source at the snapshot (whole schema) | 658 tables, 50293 rows, all equal |
| PASS | point-in-time recovery: rows written after the last base backup are present (WAL replay to the marker LSN) | message rows: base backup 15, snapshot LSN 18, restored 18 |
| PASS | every org's audit hash chain (all months) equals the source's at the snapshot | 2 org chains compared |
| PASS | M4 seals were written before the snapshot, so the verifier's seal recompute is exercised (not vacuous) | 2 month seal(s) written from the M4 chain digest across 2 orgs |
| PASS | least privilege: the WAL key (postgres container) cannot delete or write outside pgbackrest/archive/; the backup key cannot purge versions (COMPLIANCE lock); the restore key is read-only | walDeletesMarker=denied, walWritesOutsideArchive=denied, walDeletesArchiveInfo=denied, backupPurgesVersions=denied, restoreWrites=denied, restoreReads=allowed, backupDeletesSnapshot=denied |
| PASS | residual risk captured: the WAL key CAN overwrite a key under pgbackrest/archive/, and the COMPLIANCE lock keeps the prior version | overwrite allowed; 2 version(s) retained |
| PASS | every snapshot verified the off-site default retention is COMPLIANCE and recorded it in its marker | marker lock modes: COMPLIANCE, COMPLIANCE |
| PASS | wal-health (archive_command failures, pg_wal size) runs clean against the archiving source | archiver healthy, pg_wal under the alert threshold |
| PASS | provision-source-reader is idempotent (ran twice) and the sidecar ran hardened (PGDATA read-only, cap-drop ALL, read-only root) | both provisioning runs and every snapshot succeeded under those flags |
| PASS | an object deleted before the snapshot is not resurrected (the off-site history keeps it; the restore drops it) | absent after restore |
| PASS | a failing snapshot exits non-zero and POSTs backup.snapshot_failed to OPS_ALERT_WEBHOOK_URL | exit non-zero; alert backup.snapshot_failed at step object-manifest |
| PASS | negative control: the verifier FAILS when a referenced object is missing from the restored store | 1 message_attachment:missing-after-restore |
| PASS | no secret (cipher passes, SSE-C key, S3/MinIO/Postgres passwords) appears in any backup/restore output | 11 secrets scanned across 10 captured outputs; 0 found |
| PASS | restore wall time within the documented RTO target (demo scale) | 7.0 s measured vs 3600 s target |
