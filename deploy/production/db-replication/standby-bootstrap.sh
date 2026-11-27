#!/usr/bin/env bash
# deploy/production/db-replication/standby-bootstrap.sh — build the standby's data directory (CW-CP-01).
# The `standby-bootstrap` one-shot in compose.standby.yml runs it as the postgres user in the backup image, once, before
# the `standby` server starts. It restores the LATEST base backup of the stanza with `pgbackrest --type=standby` (from
# the off-site repository by default, so the primary is not loaded by the copy), which writes standby.signal, a
# restore_command (pgBackRest archive-get: the standby is configured to catch up from the WAL archive; the drill does not
# force that path) and, from here:
#
#   primary_conninfo    TLS to the primary, verified (sslmode=verify-full) against the replication CA, authenticated with
#                       the client certificate (no password exists); every path is a Docker secret, nothing is secret on disk
#   primary_slot_name   the slot provision-primary.sh created, so the primary keeps the WAL the standby has not read yet
#   archive_mode=off    a standby must never push WAL into the production repository (after a promotion it would write a
#                       new timeline into the old stanza); DR/BCP 6.1 re-enables archiving on purpose, with a new stanza
#
# A non-empty data directory is left alone (an already bootstrapped standby just restarts), so re-running is safe.
# pgbackrest.conf: rendered from BACKUP_* env by `cw-backup.sh render-conf` (the off-site repository; use the READ-ONLY
# restore key, never the backup sidecar's) unless /etc/pgbackrest/pgbackrest.conf already exists (the drill supplies one).
set -Eeuo pipefail
umask 077

PGDATA_PATH="${PGDATA:-/var/lib/postgresql/18/docker}"
STANZA="${BACKUP_PG_STANZA:-chartwarden}"
SLOT="${REPLICATION_SLOT:-cw_standby}"
ROLE="${REPLICATION_ROLE:-cw_replicator}"
REPO="${STANDBY_RESTORE_REPO:-2}"
SECRETS="${STANDBY_SECRETS_DIR:-/run/secrets}"

log() { printf '%s standby-bootstrap %s\n' "$(date -u +%FT%TZ)" "$*" >&2; }
die() { log "ERROR: $*"; exit 1; }

if [ -s "$PGDATA_PATH/PG_VERSION" ]; then
  log "$PGDATA_PATH already holds a cluster: nothing to restore"
  exit 0
fi
if [ -n "$(ls -A "$PGDATA_PATH" 2>/dev/null)" ]; then die "refusing to restore: $PGDATA_PATH is not empty and holds no cluster"; fi

host="${STANDBY_PRIMARY_HOST:?set STANDBY_PRIMARY_HOST to the name the primary server certificate carries}"
port="${STANDBY_PRIMARY_PORT:-5432}"
[[ $host =~ ^[A-Za-z0-9.:-]+$ ]] || die "STANDBY_PRIMARY_HOST must be a DNS name or an IP address"
[[ $port =~ ^[0-9]+$ ]] || die "STANDBY_PRIMARY_PORT must be a number"
[[ $ROLE =~ ^[a-z_][a-z0-9_]*$ && $SLOT =~ ^[a-z0-9_]+$ ]] || die "REPLICATION_ROLE / REPLICATION_SLOT are not plain names"
for f in replication_ca replication_client_cert replication_client_key; do
  [ -r "$SECRETS/$f" ] || die "$SECRETS/$f is not readable (the replication secrets are mounted by compose.standby.yml)"
done

if [ ! -s /etc/pgbackrest/pgbackrest.conf ]; then cw-backup.sh render-conf; fi

conninfo="host=$host port=$port user=$ROLE application_name=$SLOT sslmode=verify-full"
conninfo="$conninfo sslrootcert=$SECRETS/replication_ca sslcert=$SECRETS/replication_client_cert sslkey=$SECRETS/replication_client_key"

log "restoring the latest base backup of stanza $STANZA (repo $REPO) as a standby of $host:$port, slot $SLOT"
pgbackrest --stanza="$STANZA" --repo="$REPO" --type=standby --archive-mode=off \
  --recovery-option="primary_conninfo=$conninfo" --recovery-option="primary_slot_name=$SLOT" restore
log "standby data directory ready"
