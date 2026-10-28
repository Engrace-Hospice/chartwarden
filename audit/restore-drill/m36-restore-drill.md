# M36 restore drill - PASS

> **Demo scale, not production figures.** Private containers on one developer machine, a few dozen rows and a handful of small objects. These numbers prove the procedure and the verifier; they do not size production.

Run 349b8d at 2026-10-22T06:36:05.756Z. Fault injected: none.

## Backup method used by this drill

> **Superseded statement (2026-10-27, #857).** When this drill ran, production had no object-store backup, no DB/object coordination and no PITR. The repository now ships all three (`deploy/production/backup/`, `compose.backup.yml`), proven end to end by [`2026-10-27-coordinated-backup-drill.md`](./2026-10-27-coordinated-backup-drill.md). What is still operational, not code: provisioning the off-site bucket and keys, enabling the overlay on the VPS, and the first witnessed production restore (tracked in the #857 follow-up ops issue). This M36 drill keeps its own pg_dump + volume-tar mechanism on purpose: it proves M36 consistency, not the production backup.

- **postgres**: pg_dump -U postgres -d chartwarden | gzip, as deploy/production/reseed-demo.sh runs it (logical, single snapshot; this drill's mechanism only: since #857 production runs pgBackRest with WAL archiving / PITR, see the coordinated drill)
- **objectStore**: tar of the stopped MinIO /data (this drill's own stand-in; since #857 production's object backup is deploy/production/backup/cw-backup.sh: versioned, SSE-C encrypted, object-locked off-site mirror)
- **coordination**: writes quiesced between the two (since #857 production coordinates them with a snapshot marker: DB LSN + object manifest; see audit/restore-drill/2026-10-27-coordinated-backup-drill.md)

## Measured RTO (demo scale)
Restore wall time (new Postgres up, roles bootstrapped, dump loaded, object store restored): **11.6 s**. Verification: 0.5 s.

| phase | wall |
|---|---|
| source-up | 1.2 s |
| scratch-containers-up (stand-in for a new host) | 1.2 s |
| roles bootstrap (migrate+provision on a throwaway db) | 4.0 s |
| pg_dump load (psql, ON_ERROR_STOP) | 6.4 s |

## Measured RPO (demo scale)
Backup taken 2026-10-22T06:36:11.889Z; source lost 2026-10-22T06:36:13.677Z. Data window lost: **1.8 s** (3 message, 1 message_attachment, 3 message_receipt; 1 object(s)).

## Checks
| result | check | detail |
|---|---|---|
| PASS | row counts per M36 table equal the backup-time counts | 54 tables, 52 rows, all equal |
| PASS | RLS flags, policies, grants and triggers per M36 table equal the source | 54 entries identical |
| PASS | audit_event count and M4 hash chain per org equal the backup-time source | 2 entries identical |
| PASS | every non-destroyed attachment row has its object present and byte-identical (size, sha256, etag) | 5 objects verified |
| PASS | destroyed attachment rows have no object | none present |
| PASS | no orphan objects (every stored object is referenced by a row) | none |
| PASS | message <-> attachment <-> audit reconcile (restored DB agrees with itself) | every message, revision and attachment has its audit event; no orphan audit; attachments belong to a message in the same org |
| PASS | restored DB: chartwarden_app logs in, is NOT superuser/BYPASSRLS | chartwarden_app super=false bypassrls=false |
| PASS | RLS holds after restore: no tenant context reads nothing; own tenant reads rows; cross-tenant reads nothing | no-context=0, A->A=10, A->B message=0 attachment=0 channel=0 audit=0 |
| PASS | message and message_revision body hashes verify (runHashVerifyForOrg, full coverage) | 19 rows hashed (expected >= 19), 0 mismatched |
| PASS | restore wall time within the documented RTO target (demo scale) | 11.6 s measured vs 3600 s target |
