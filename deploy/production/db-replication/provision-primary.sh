#!/usr/bin/env bash
# deploy/production/db-replication/provision-primary.sh — primary-side half of streaming replication (CW-CP-01).
# Idempotent; run once per primary by compose.replication.yml's `replication-provision` (or by hand). As the postgres
# user over the shared socket (the same trust the backup sidecar has); it needs the data volume writable, because
# pg_hba.conf lives in PGDATA.
#
#   REPLICATION_STANDBY_CIDR   REQUIRED: the standby host's address as ONE host: a /32 (IPv4) or a /128 (IPv6).
#                              The cert rule below is pinned to it, so a stolen client key is useless from anywhere else.
#
# What it does, in order:
#   1. the replication role, converged on every run: LOGIN REPLICATION, no password (it can only authenticate with a
#      client certificate), no other attribute, at most 2 connections
#   2. the physical replication slot the standby reads from (reserves WAL immediately; compose.replication.yml bounds
#      what a stalled standby can make the primary retain with max_slot_wal_keep_size)
#   3. a managed block at the TOP of pg_hba.conf, so it wins over whatever the cluster already carries and no other rule
#      is touched or assumed:
#         hostssl replication <role> <cidr> cert   TLS + a client certificate whose CN is the role, from the standby only
#         host    replication <role> all reject    no plain-text replication, no other source, ever
#         host    all         <role> all reject    the role is never a normal login (this also stops a logical
#                                                  `replication=database` connection)
#      then pg_reload_conf(). The new file is checked for parse errors (pg_hba_file_rules); on any failure the previous file
#      is put back and reloaded. NOTE: that proves the file parses and holds the rule, not that the postmaster has finished
#      reloading; the drill proves the behaviour (backup:replication-drill).
# The cluster's own rules stay below the block, so password logins on a published 5432 are NOT narrowed by it: keep the port
# off the public internet (README, "Database standby": a private address, or Docker-aware filtering).
set -Eeuo pipefail
umask 077

DB_NAME="${CHARTWARDEN_DB_NAME:-chartwarden}"
ROLE="${REPLICATION_ROLE:-cw_replicator}"
SLOT="${REPLICATION_SLOT:-cw_standby}"
CIDR="${REPLICATION_STANDBY_CIDR:?set REPLICATION_STANDBY_CIDR to the standby host address as a /32 (a /128 for IPv6)}"
CONNECTION_LIMIT=2
BEGIN_MARK="# BEGIN cw-replication (managed by db-replication/provision-primary.sh; do not edit)"
END_MARK="# END cw-replication"

log() { printf '%s provision-primary %s\n' "$(date -u +%FT%TZ)" "$*" >&2; }
die() { log "ERROR: $*"; exit 1; }
[[ $ROLE =~ ^[a-z_][a-z0-9_]*$ ]] || die "REPLICATION_ROLE must be a plain role name"
[[ $SLOT =~ ^[a-z0-9_]+$ ]] || die "REPLICATION_SLOT must be lowercase letters, digits and underscores"
v4='^([0-9]{1,3}\.){3}[0-9]{1,3}/32$'
v6='^[0-9a-fA-F:]+/128$'
if ! [[ $CIDR =~ $v4 || $CIDR =~ $v6 ]]; then
  die "REPLICATION_STANDBY_CIDR must be ONE host: an IPv4 address with /32 or an IPv6 address with /128, not '$CIDR'"
fi
# The published address is a boundary the /32 above does not cover: the port carries every role's password login too.
# compose.replication.yml hands it to this one-shot; refuse a wildcard BEFORE any change (unset = a by-hand run, skipped).
case "${REPLICATION_PUBLISH_ADDR:-}" in
0.0.0.0 | :: | "[::]" | 0:0:0:0:0:0:0:0 | "[0:0:0:0:0:0:0:0]" | 0)
  die "REPLICATION_PUBLISH_ADDR is the wildcard '$REPLICATION_PUBLISH_ADDR': 5432 would be reachable on every interface, with every role's password login. Bind it to a PRIVATE address, recreate postgres, then run this again"
  ;;
esac
psql_db() { psql -X -v ON_ERROR_STOP=1 -At -h /var/run/postgresql -U postgres -d "$DB_NAME" "$@"; }

[ "$(psql_db -c 'SELECT pg_is_in_recovery()')" = f ] || die "this server is a standby: provision the primary"
[ "$(psql_db -c "SHOW ssl")" = on ] || die "ssl is off: start postgres with compose.replication.yml's flags first (replication needs TLS)"

psql_db -v role="$ROLE" -v slot="$SLOT" -v limit="$CONNECTION_LIMIT" <<'SQL'
SELECT format('CREATE ROLE %I', :'role') WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'role') \gexec
SELECT format('ALTER ROLE %I WITH LOGIN REPLICATION NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS PASSWORD NULL CONNECTION LIMIT %s', :'role', :'limit') \gexec
SELECT pg_create_physical_replication_slot(:'slot', true)
 WHERE NOT EXISTS (SELECT 1 FROM pg_replication_slots WHERE slot_name = :'slot');
SQL
log "role $ROLE and slot $SLOT ready"

hba="$(psql_db -c 'SHOW hba_file')"
[ -w "$hba" ] || die "$hba is not writable: run this with the postgres data volume mounted read-write"
block="$BEGIN_MARK
hostssl replication $ROLE $CIDR cert
host    replication $ROLE all reject
host    all         $ROLE all reject
$END_MARK"

next="$hba.cw-replication.new"
skipping=0
{
  printf '%s\n' "$block"
  while IFS= read -r line || [ -n "$line" ]; do # the existing file without a previous managed block
    if [ "$line" = "$BEGIN_MARK" ]; then skipping=1; continue; fi
    if [ "$skipping" = 1 ]; then
      [ "$line" = "$END_MARK" ] && skipping=0
      continue
    fi
    printf '%s\n' "$line"
  done <"$hba"
} >"$next"
# A BEGIN without its END would have dropped the rest of the file, the cluster's own rules included: refuse that.
# (skipping was set in the group above, which runs in this shell, not a subshell.)
if [ "$skipping" != 0 ]; then
  rm -f "$next"
  die "$hba has a '$BEGIN_MARK' line without its END line; fix it by hand (the previous file is untouched)"
fi

check_loaded() { # the new rules parse, and the cert rule for this role is listed
  local errors seen
  errors="$(psql_db <<<"SELECT count(*) FROM pg_hba_file_rules WHERE error IS NOT NULL")" || return 1
  [ "$errors" = 0 ] || return 1
  seen="$(psql_db -v role="$ROLE" <<<"SELECT count(*) FROM pg_hba_file_rules WHERE :'role' = ANY(user_name) AND database = '{replication}' AND auth_method = 'cert'")" || return 1 # psql interpolates :'role' from stdin, never from -c
  [ "$seen" = 1 ]
}

if cmp -s "$next" "$hba"; then
  rm -f "$next"
  log "pg_hba.conf already carries the managed block"
else
  [ -e "$hba.pre-cw-replication" ] || cp -p "$hba" "$hba.pre-cw-replication"
  cp -p "$hba" "$hba.cw-replication.bak"
  mv "$next" "$hba"
  psql_db -c 'SELECT pg_reload_conf()' >/dev/null
  if ! check_loaded; then
    mv "$hba.cw-replication.bak" "$hba"
    psql_db -c 'SELECT pg_reload_conf()' >/dev/null || true
    die "the new pg_hba.conf did not parse or does not list the cert rule; the previous file is back in place and reloaded"
  fi
  rm -f "$hba.cw-replication.bak"
  log "pg_hba.conf updated and reloaded"
fi
check_loaded || die "pg_hba.conf does not list the replication cert rule (see $hba and pg_hba_file_rules)"
# Leave a trace in the SERVER log too (HIPAA 164.312(b)): a role that can read the whole database was created or confirmed,
# and the access rules were touched. The container's own stderr is gone when this one-shot is removed.
psql_db -v msg="cw-replication: replication role $ROLE, slot $SLOT and the pg_hba block for $CIDR provisioned" <<'SQL'
SELECT format('DO $x$ BEGIN RAISE LOG %L; END $x$', :'msg') \gexec
SQL
log "replication provisioned"
