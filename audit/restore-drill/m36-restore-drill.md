# M36 restore drill - PASS

> **Demo scale, not production figures.** Private containers on one developer machine, a few dozen rows and a handful of small objects. These numbers prove the procedure and the verifier; they do not size production.

Run 349b8d at 2026-10-22T06:36:05.756Z. Fault injected: none.

## Backup method (what production really does)
- **postgres**: pg_dump -U postgres -d chartwarden | gzip, as deploy/production/reseed-demo.sh runs it (logical, single snapshot, no WAL archive, no PITR)
- **objectStore**: tar of the stopped MinIO /data (closest real mechanism; production has NO object-store backup)
- **coordination**: writes quiesced between the two (production has no coordination between them)

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
