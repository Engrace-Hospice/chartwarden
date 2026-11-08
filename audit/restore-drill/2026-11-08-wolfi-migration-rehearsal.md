# Debian to Wolfi Postgres migration rehearsal - PASS

> **Synthetic scale, private containers on one developer machine.** A few tens of thousands of invented rows prove the
> mechanism, not the duration: `cw-refresh-collation` rebuilds every index, so its time grows with the real database.
> Time it again on a copy of production data before the maintenance window, and size the window from that.

Run 11081146369947 at 2026-11-08T11:48:00Z. Tree commit ddb9581d62a6 (working tree has uncommitted changes under deploy/, scripts/, .github/). Reproduce:
`bash scripts/backup/wolfi-migration-rehearsal.sh` (set `WOLFI_BACKUP_IMAGE` to reuse a built Wolfi backup image).

## Images
| role | reference | image id | repo digest |
|---|---|---|---|
| Debian-era backup image | built from `origin/main:deploy/production/backup/` (2ea20d5c0bf3) | 5caa3f01501c | cw-rehearsal-11081146369947-debian@sha256:5caa3f01501cdc6f2f5bf7ae80cfae1635a3bd9ea0da6dc5b2fe63191dc5359b |
| Wolfi Postgres (base) | ghcr.io/engrace-hospice/chartwarden-postgres@sha256:b325d5fd8f295ef1aaed77508f808fcbd573787ff0469de6126fdff4ae261636 | b325d5fd8f29 | ghcr.io/engrace-hospice/chartwarden-postgres@sha256:b325d5fd8f295ef1aaed77508f808fcbd573787ff0469de6126fdff4ae261636 |
| Wolfi backup image | cw-rehearsal-prod-backup:amd64 | e2c4069b9bc0 | cw-rehearsal-prod-backup@sha256:e2c4069b9bc0eecce63398757ac6b5a8adb402b60baaa510e96bb7dfeac70988 |

Docker host linux/aarch64, containers run as `linux/amd64` (emulated when it differs from the host: wall times are then inflated).

## Tooling
- **Debian-era**: PostgreSQL 18.6 (Debian 18.6-1.pgdg12+2), glibc 2.36, pgBackRest 2.60.0
- **Wolfi**: PostgreSQL 18.6, glibc 2.44, pgBackRest 2.60.0

## Steps
| result | step | detail | wall |
|---|---|---|---|
| PASS | images ready | Debian-era backup image built from origin/main, Wolfi backup image cw-rehearsal-prod-backup:amd64 | - |
| PASS | Debian-era cluster seeded and backed up | 20500 rows, md5 09d4702cb1fb94c074aa2ce99c39abc4; indexes: unique btree, 2 btree, expression btree, pg_trgm GIN, pgvector HNSW; extensions amcheck 1.5,pg_trgm 1.6,vector 0.8.7; full backup 20261108-114718F; seed + backup | 24.1 s (full backup 1.8 s) |
| PASS | Debian server stopped cleanly | shut down checkpoint written; container removed, volume and repo kept | 0.8 s |
| PASS | Wolfi image started on the Debian-created volume | no initdb; same PGDATA volume and repository | 1.4 s |
| PASS | collation version mismatch is reported | The database was created using collation version 2.36, but the operating system provides version 2.44. | - |
| PASS | table contents identical on Wolfi | 20500 rows, md5 09d4702cb1fb94c074aa2ce99c39abc4 (rows 1-20500, ordered by id) | - |
| PASS | collation order probe, en_US.utf8 on Debian glibc vs Wolfi glibc (informational) | identical order: md5 2c5f5ba3fdcd2334faec43d043ede93e over 140961 strings | - |
| PASS | amcheck BEFORE cw-refresh-collation (informational: shows whether the stale indexes are actually inconsistent) | amcheck: 169 ok, 0 failed (btree 168, gin 1) | - |
| PASS | cw-refresh-collation (REINDEX + REFRESH COLLATION VERSION in every connectable database) | completed | 2.2 s |
| PASS | amcheck after reindex: every btree (heapallindexed) and GIN index | amcheck: 169 ok, 0 failed (btree 168, gin 1) | - |
| PASS | amcheck negative control: an index whose collation order is changed under it is flagged | ERROR:  item order invariant violated for index "t_c_ix" | - |
| PASS | datcollversion equals the OS version in every connectable database | recorded/actual: cw_rehearsal 2.44/2.44, postgres 2.44/2.44, template0 -/2.44 (no connections), template1 2.44/2.44 | - |
| PASS | no collation warning on connect after the refresh | 0 warnings | - |
| PASS | probe: a database created from template0 after the refresh (informational) | 0 collation warning(s) on its first connect | - |
| PASS | extensions after the swap, and an HNSW nearest-neighbour query | amcheck 1.5 (available 1.5),pg_trgm 1.6 (available 1.6),vector 0.8.7 (available 0.8.7); 10 neighbours returned | - |
| PASS | WAL pushed by the Wolfi pgBackRest into the Debian-created stanza | pg_stat_archiver at Wolfi start: 9 archived, 10 failed, last 000000010000000000000008; after pg_switch_wal(): 10 archived, 10 failed, last 000000010000000000000009 (failed_count did not move; any earlier failures are the Debian run archiving before stanza-create) | - |
| PASS | pgbackrest check (Wolfi) on the Debian-created stanza | archive and backup repository consistent | - |
| PASS | incremental backup by the Wolfi pgBackRest on top of the Debian full backup | 20261108-114718F_20261108-114747I (repo: 20261108-114718F full; 20261108-114718F_20261108-114747I incr) | 2.4 s |
| PASS | 100 more rows after the incremental backup, segment archived | final state 20900 rows, md5 9fb0a674f9a0cca1f03a3fac07fab179 at 0/D0E54F0 | - |
| PASS | restore of the Wolfi incremental backup 20261108-114718F_20261108-114747I into a fresh volume with the Wolfi image | 20900 rows, md5 9fb0a674f9a0cca1f03a3fac07fab179 equals the source; amcheck: 169 ok, 0 failed (btree 168, gin 1); 0 collation warnings; archive_mode off, promoted at 0/D0E54F0 | 3.9 s |
| PASS | restore of the Debian full backup 20261108-114718F (replays Debian- and Wolfi-pushed WAL) into a fresh volume with the Wolfi image | 20900 rows, md5 9fb0a674f9a0cca1f03a3fac07fab179 equals the source; amcheck: 169 ok, 0 failed (btree 168, gin 1); 0 collation warnings; archive_mode off, promoted at 0/D0E54F0 | 5.0 s |

## Not covered
- The cluster is a few MB; production's reindex time, WAL volume and restore time are larger. Re-time on a restored copy.
- The repository is a local posix repo with a repo cipher; S3 transport and the off-site key policies are proven by
  `bun run backup:coordinated-drill`, which builds the Wolfi backup image too.
- The server is started through the Postgres entrypoint with a hand-written `pgbackrest.conf` equal to what
  `cw-backup.sh render-conf` writes for repo1 (aes-256-cbc, bundle, async archive); `cw-backup.sh entrypoint` needs an https off-site repository.
- The ordering probe covers single characters to U+1FFFF and 'a<char>b' strings to U+2EE0 in en_US.utf8 only; text outside
  it, or another locale, is not compared. If it reports identical order, the reindex was not needed for correctness on
  that range: it still clears the warning and records the new version, so keep it, and still time it.
- Debian side is main's backup image (pgvector/pgvector:pg18-bookworm, glibc 2.36), the image compose.yml ran before this change.
