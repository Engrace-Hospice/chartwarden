#!/usr/bin/env bash
# deploy/production/backup/cw-backup.sh — coordinated Postgres + object-store backup and restore (#857).
#
# Runs inside the image built from ./Dockerfile (pgvector/pgvector:pg18 + pgBackRest + mc). Subcommands:
#   entrypoint <cmd...>        render /etc/pgbackrest/pgbackrest.conf from BACKUP_* env, then the stock entrypoint
#   snapshot [full|diff|incr|none]
#                              one coordinated snapshot: optional pgBackRest base backup (local + off-site repo), then
#                              capture the DB LSN, force + confirm WAL archiving up to it, list every MinIO object
#                              (sha256 per object), mirror the buckets off-site, confirm every listed object landed,
#                              and write snapshots/<id>/{manifest.ndjson.gz,marker.json} off-site (marker last)
#   schedule                   the long-running loop the `backup` sidecar runs (snapshot every interval, daily base backup)
#   healthcheck                exit 1 when the last successful snapshot is older than BACKUP_MAX_AGE_S
#   provision-source-reader    create the read-only MinIO account the sidecar lists/reads with (needs MINIO_ROOT_*)
#   marker [id|latest]         print a snapshot's marker (default: the newest complete one)
#   restore-db <id|latest>     pgBackRest restore of a snapshot into the EMPTY $PGDATA (PITR to the marker's LSN)
#   restore-objects <id>       copy the snapshot's objects into the RESTORE_MINIO_* store and verify every sha256
#
# Coordination rule: the app writes an object BEFORE it commits the row that references it, and the object listing
# starts AFTER the LSN is captured, so every row committed at or before the marker's LSN has its object in the
# snapshot's manifest. Restoring the DB to exactly that LSN plus exactly that manifest gives a consistent pair.
# Objects created after the LSN are harmless orphans. Failures exit non-zero and POST an ops notice to
# OPS_ALERT_WEBHOOK_URL (the payload shape of apps/backend/src/bootstrap/platform-ops-notices.ts). Secrets are never
# echoed: no `set -x`, mc credentials travel in MC_HOST_* env, pgBackRest redacts its secure options.
set -Eeuo pipefail
umask 077

STANZA="${BACKUP_PG_STANZA:-chartwarden}"
CONF=/etc/pgbackrest/pgbackrest.conf
STATE_DIR="${BACKUP_STATE_DIR:-/var/lib/cw-backup}"
DB_NAME="${CHARTWARDEN_DB_NAME:-chartwarden}"
PGDATA_PATH="${PGDATA:-/var/lib/postgresql/18/docker}"
FINGERPRINT_SQL=/usr/local/share/cw-backup/schema-fingerprint.sql
LEDGER_TABLE=_chartwarden_migration
OFFSITE_REPO=2
SNAPSHOT_ID=""
STEP=init

log() { printf '%s cw-backup %s\n' "$(date -u +%FT%TZ)" "$*" >&2; }
die() {
  log "ERROR: $*"
  exit 1
}
need() {
  local v
  for v in "$@"; do [ -n "${!v:-}" ] || die "$v is not set"; done
}
uri() { jq -rn --arg v "$1" '$v|@uri'; }
mc_host() { # alias url user secret -> MC_HOST_<alias> (credentials stay in the environment, never on disk or argv)
  local user secret
  user="$(uri "$3")"
  secret="$(uri "$4")"
  printf -v "MC_HOST_$1" '%s://%s:%s@%s' "${2%%://*}" "$user" "$secret" "${2#*://}"
  export "MC_HOST_$1"
}
local_repo_enabled() { [ "${BACKUP_PG_LOCAL_REPO:-/var/lib/pgbackrest}" != none ]; }
pg_repos() { if local_repo_enabled; then echo "1 $OFFSITE_REPO"; else echo "$OFFSITE_REPO"; fi; }
pgbr() { pgbackrest --stanza="$STANZA" "$@"; }
psql_db() { psql -X -v ON_ERROR_STOP=1 -At -h /var/run/postgresql -U postgres -d "$DB_NAME" "$@"; }

# ---- alerting ---------------------------------------------------------------------------------------------------
alert() { # kind summary details-json
  local body
  body="$(jq -nc --arg kind "$1" --arg summary "$2" --argjson details "$3" --arg cid "${SNAPSHOT_ID:-none}" \
    '{kind:$kind, summary:$summary, details:$details, correlationId:$cid, occurredAt:(now|todate)}')"
  log "ALERT [$1] $2"
  [ -n "${OPS_ALERT_WEBHOOK_URL:-}" ] || return 0
  curl -fs -m 10 -H 'content-type: application/json' --data "$body" "$OPS_ALERT_WEBHOOK_URL" >/dev/null ||
    log "alert webhook delivery failed"
}

on_snapshot_failure() {
  local rc="$1"
  # A subshell (a pipeline stage) only exits; pipefail hands the failure to the main shell, which alerts once.
  if [ "$BASHPID" != "$$" ]; then exit "$rc"; fi
  trap - ERR
  alert backup.snapshot_failed "coordinated backup snapshot failed at step '$STEP'" \
    "$(jq -nc --arg step "$STEP" --arg rc "$rc" --arg host "$(hostname)" '{step:$step, exitCode:($rc|tonumber), host:$host}')"
  exit "$rc"
}

# ---- configuration ----------------------------------------------------------------------------------------------
offsite_host_port() { # prints "host port"; refuses plain http (backups leave the host)
  local e="$BACKUP_OFFSITE_S3_ENDPOINT"
  case "$e" in
  https://*) e="${e#https://}" ;;
  *) die "BACKUP_OFFSITE_S3_ENDPOINT must start with https:// (backups leave the host; TLS is mandatory)" ;;
  esac
  e="${e%%/*}"
  if [[ $e == *:* ]]; then echo "${e%:*} ${e##*:}"; else echo "$e 443"; fi
}

render_conf() {
  need BACKUP_OFFSITE_S3_ENDPOINT BACKUP_OFFSITE_S3_BUCKET BACKUP_OFFSITE_S3_REGION BACKUP_OFFSITE_S3_ACCESS_KEY \
    BACKUP_OFFSITE_S3_SECRET_KEY BACKUP_PG_OFFSITE_CIPHER_PASS
  [ "${#BACKUP_PG_OFFSITE_CIPHER_PASS}" -ge 32 ] || die "BACKUP_PG_OFFSITE_CIPHER_PASS must be at least 32 characters"
  local host port
  read -r host port <<<"$(offsite_host_port)"
  {
    echo "[global]"
    echo "log-level-console=info"
    echo "log-level-file=off"
    echo "compress-type=zst"
    echo "process-max=${BACKUP_PG_PROCESS_MAX:-2}"
    echo "start-fast=y"
    echo "archive-async=y"
    echo "spool-path=/var/spool/pgbackrest"
    # The socket directory is the one volume the postgres container (archive-push) and the backup sidecar share,
    # so their pgBackRest locks see each other.
    echo "lock-path=/var/run/postgresql/pgbackrest-lock"
    if local_repo_enabled; then
      need BACKUP_PG_LOCAL_CIPHER_PASS
      [ "${#BACKUP_PG_LOCAL_CIPHER_PASS}" -ge 32 ] || die "BACKUP_PG_LOCAL_CIPHER_PASS must be at least 32 characters"
      echo "repo1-path=${BACKUP_PG_LOCAL_REPO:-/var/lib/pgbackrest}"
      echo "repo1-retention-full=${BACKUP_PG_RETENTION_FULL_LOCAL:-2}"
      echo "repo1-cipher-type=aes-256-cbc"
      echo "repo1-cipher-pass=$BACKUP_PG_LOCAL_CIPHER_PASS"
      echo "repo1-bundle=y"
    fi
    echo "repo$OFFSITE_REPO-type=s3"
    echo "repo$OFFSITE_REPO-s3-endpoint=$host"
    echo "repo$OFFSITE_REPO-storage-port=$port"
    echo "repo$OFFSITE_REPO-s3-bucket=$BACKUP_OFFSITE_S3_BUCKET"
    echo "repo$OFFSITE_REPO-s3-region=$BACKUP_OFFSITE_S3_REGION"
    echo "repo$OFFSITE_REPO-s3-key=$BACKUP_OFFSITE_S3_ACCESS_KEY"
    echo "repo$OFFSITE_REPO-s3-key-secret=$BACKUP_OFFSITE_S3_SECRET_KEY"
    echo "repo$OFFSITE_REPO-s3-uri-style=${BACKUP_OFFSITE_S3_URI_STYLE:-path}"
    echo "repo$OFFSITE_REPO-path=/pgbackrest"
    echo "repo$OFFSITE_REPO-cipher-type=aes-256-cbc"
    echo "repo$OFFSITE_REPO-cipher-pass=$BACKUP_PG_OFFSITE_CIPHER_PASS"
    echo "repo$OFFSITE_REPO-retention-full=${BACKUP_PG_RETENTION_FULL_OFFSITE:-13}"
    echo "repo$OFFSITE_REPO-bundle=y"
    if [ -n "${BACKUP_OFFSITE_CA_FILE:-}" ]; then echo "repo$OFFSITE_REPO-storage-ca-file=$BACKUP_OFFSITE_CA_FILE"; fi
    echo
    echo "[$STANZA]"
    echo "pg1-path=$PGDATA_PATH"
    echo "pg1-socket-path=/var/run/postgresql"
  } >"$CONF.tmp"
  mv "$CONF.tmp" "$CONF"
}

mc_setup() { # aliases: offsite (always), source / target when configured
  need BACKUP_OBJECT_SSE_C_KEY
  [ "$(printf '%s' "$BACKUP_OBJECT_SSE_C_KEY" | base64 -d 2>/dev/null | wc -c)" -eq 32 ] ||
    die "BACKUP_OBJECT_SSE_C_KEY must be base64 of exactly 32 random bytes (openssl rand -base64 32)"
  export MC_CONFIG_DIR="$STATE_DIR/mc"
  mkdir -p "$MC_CONFIG_DIR/certs/CAs"
  if [ -n "${BACKUP_OFFSITE_CA_FILE:-}" ]; then cp "$BACKUP_OFFSITE_CA_FILE" "$MC_CONFIG_DIR/certs/CAs/offsite.crt"; fi
  local host port
  read -r host port <<<"$(offsite_host_port)"
  mc_host offsite "https://$host:$port" "$BACKUP_OFFSITE_S3_ACCESS_KEY" "$BACKUP_OFFSITE_S3_SECRET_KEY"
  if [ -n "${BACKUP_SOURCE_MINIO_ACCESS_KEY:-}" ]; then
    mc_host source "${BACKUP_SOURCE_MINIO_URL:-http://minio:9000}" "$BACKUP_SOURCE_MINIO_ACCESS_KEY" \
      "${BACKUP_SOURCE_MINIO_SECRET_KEY:?}"
  fi
  if [ -n "${RESTORE_MINIO_ACCESS_KEY:-}" ]; then
    mc_host target "${RESTORE_MINIO_URL:?}" "$RESTORE_MINIO_ACCESS_KEY" "${RESTORE_MINIO_SECRET_KEY:?}"
  fi
  OFFSITE="offsite/$BACKUP_OFFSITE_S3_BUCKET"
  # SSE-C: every off-site object (copies, manifests, markers) is encrypted with a key the off-site provider never holds.
  # mc's --enc-c wants base64 without padding.
  ENC="$OFFSITE/=${BACKUP_OBJECT_SSE_C_KEY%%=*}"
}
mcq() { mc --quiet --no-color "$@"; }

# ---- snapshot ---------------------------------------------------------------------------------------------------
offsite_latest_backup_label() {
  pgbr --repo="$OFFSITE_REPO" info --output=json | jq -r '.[0].backup // [] | last | .label // empty'
}

build_manifest() { # $1 = output ndjson; reuses sha256/content-type from the previous manifest when bucket/key/etag/size match
  local out="$1" prev="$STATE_DIR/manifest.ndjson" listing="$STATE_DIR/listing.ndjson" b
  [ -f "$prev" ] || : >"$prev"
  : >"$listing"
  # Every producer writes a file first: a failure inside `< <(...)` would be invisible to errexit and the ERR trap.
  mcq ls --json source/ </dev/null >"$STATE_DIR/buckets.json"
  jq -r 'select(.type == "folder") | .key | rtrimstr("/")' "$STATE_DIR/buckets.json" >"$STATE_DIR/buckets.txt"
  while read -r b; do
    [ -n "$b" ] || continue
    mcq ls --recursive --json "source/$b" </dev/null >"$STATE_DIR/bucket-listing.json"
    jq -c --arg b "$b" 'select(.type == "file") | {b:$b, k:.key, s:.size, e:.etag}' "$STATE_DIR/bucket-listing.json" >>"$listing"
  done <"$STATE_DIR/buckets.txt"
  jq -nc --slurpfile prev "$prev" \
    '($prev | map({key:"\(.b)/\(.k)/\(.e)/\(.s)", value:{h, t}}) | from_entries) as $idx
     | inputs | . + ($idx["\(.b)/\(.k)/\(.e)/\(.s)"] // {h:null, t:null})' "$listing" >"$STATE_DIR/joined.ndjson"
  : >"$out"
  while IFS= read -r line; do
    if [ "$(jq -r '.h // empty' <<<"$line")" = "" ]; then
      local bk h t
      bk="$(jq -r '"\(.b)/\(.k)"' <<<"$line")"
      # The content type is restored explicitly (restore-objects); the sha256 is of the bytes, not a stored header.
      t="$(mcq stat --json "source/$bk" </dev/null | jq -r '.metadata["Content-Type"] // "application/octet-stream"')"
      h="$(mcq cat "source/$bk" </dev/null | sha256sum | cut -d' ' -f1)"
      line="$(jq -c --arg h "$h" --arg t "$t" '.h = $h | .t = $t' <<<"$line")"
    fi
    printf '%s\n' "$line" >>"$out"
  done <"$STATE_DIR/joined.ndjson"
}

mirror_and_confirm() { # $1 = manifest; every listed object must be off-site with the same size
  local manifest="$1" b missing
  jq -r .b "$manifest" | sort -u >"$STATE_DIR/buckets.txt"
  while read -r b; do
    mcq mirror --overwrite --md5 --enc-c "$ENC" "source/$b" "$OFFSITE/objects/$b" </dev/null >/dev/null
  done <"$STATE_DIR/buckets.txt"
  mcq ls --recursive --json "$OFFSITE/objects/" >"$STATE_DIR/offsite-listing.json"
  missing="$(jq -nc --slurpfile have "$STATE_DIR/offsite-listing.json" \
    '($have | map(select(.type == "file") | {key:.key, value:.size}) | from_entries) as $idx
     | [inputs | select($idx["\(.b)/\(.k)"] != .s) | "\(.b)/\(.k)"] | length' "$manifest")"
  [ "$missing" = 0 ] || die "$missing listed object(s) missing or wrong size off-site after the mirror"
}

cmd_snapshot() {
  local db_type="${1:-none}"
  case "$db_type" in full | diff | incr | none) ;; *) die "snapshot type must be full|diff|incr|none" ;; esac
  SNAPSHOT_ID="$(date -u +%Y%m%dT%H%M%SZ)"
  trap 'on_snapshot_failure $?' ERR
  render_conf
  mc_setup
  need BACKUP_SOURCE_MINIO_ACCESS_KEY
  mkdir -p "$STATE_DIR"
  log "snapshot $SNAPSHOT_ID start (base backup: $db_type)"

  STEP=stanza-create
  pgbr stanza-create
  if [ "$db_type" = none ] && [ -z "$(offsite_latest_backup_label)" ]; then
    log "no base backup off-site yet: taking a full one"
    db_type=full
  fi
  if [ "$db_type" != none ]; then
    local repo
    for repo in $(pg_repos); do
      STEP="pg-backup-repo$repo"
      pgbr --repo="$repo" --type="$db_type" backup
    done
  fi

  STEP=capture-lsn
  local captured lsn db_time fingerprint ledger_count ledger_last
  captured="$( {
    echo "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;"
    echo "SELECT pg_current_wal_lsn() || '|' || to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"');"
    cat "$FINGERPRINT_SQL"
    echo "SELECT count(*) || '|' || coalesce(max(filename), '') FROM $LEDGER_TABLE;"
    echo "COMMIT;"
  } | psql_db -f - | grep -v -e '^BEGIN$' -e '^COMMIT$')"
  IFS='|' read -r lsn db_time <<<"$(sed -n 1p <<<"$captured")"
  fingerprint="$(sed -n 2p <<<"$captured")"
  IFS='|' read -r ledger_count ledger_last <<<"$(sed -n 3p <<<"$captured")"

  STEP=wal-archive-check # switches WAL and waits until the segment holding $lsn is archived to every repo
  pgbr check

  STEP=pg-label
  local label
  label="$(offsite_latest_backup_label)"
  [ -n "$label" ] || die "no base backup in the off-site repository"

  STEP=object-manifest
  local work="$STATE_DIR/snap-$SNAPSHOT_ID" objects_started
  mkdir -p "$work"
  objects_started="$(date -u +%FT%TZ)"
  build_manifest "$work/manifest.ndjson"

  STEP=object-mirror
  mirror_and_confirm "$work/manifest.ndjson"

  STEP=upload-marker
  gzip -9n <"$work/manifest.ndjson" >"$work/manifest.ndjson.gz"
  local manifest_sha
  manifest_sha="$(sha256sum "$work/manifest.ndjson.gz" | cut -d' ' -f1)"
  mcq cp --md5 --enc-c "$ENC" "$work/manifest.ndjson.gz" "$OFFSITE/snapshots/$SNAPSHOT_ID/manifest.ndjson.gz" >/dev/null
  jq -n --arg id "$SNAPSHOT_ID" --arg stanza "$STANZA" --arg db "$DB_NAME" --arg baseLabel "$label" --arg lsn "$lsn" \
    --arg dbTime "$db_time" --arg fp "$fingerprint" --arg lc "$ledger_count" --arg ll "$ledger_last" \
    --arg os "$objects_started" --arg sha "$manifest_sha" --slurpfile m "$work/manifest.ndjson" \
    '{version:1, snapshotId:$id, createdAt:(now|todate),
      db:{stanza:$stanza, database:$db, repo:2, backupLabel:$baseLabel, lsn:$lsn, capturedAt:$dbTime,
          schemaFingerprint:$fp, migrations:{count:($lc|tonumber), last:$ll}},
      objects:{listingStartedAt:$os, count:($m|length), bytes:($m|map(.s)|add // 0),
               buckets:($m|map(.b)|unique), manifest:"snapshots/\($id)/manifest.ndjson.gz", manifestSha256:$sha}}' \
    >"$work/marker.json"
  mcq cp --md5 --enc-c "$ENC" "$work/marker.json" "$OFFSITE/snapshots/$SNAPSHOT_ID/marker.json" >/dev/null

  STEP=finish
  local object_count
  object_count="$(jq .objects.count "$work/marker.json")"
  mv "$work/manifest.ndjson" "$STATE_DIR/manifest.ndjson"
  rm -rf "$work"
  echo "$SNAPSHOT_ID" >"$STATE_DIR/last-success"
  if [ -n "${BACKUP_HEARTBEAT_URL:-}" ]; then curl -fs -m 10 "$BACKUP_HEARTBEAT_URL" >/dev/null || log "heartbeat ping failed"; fi
  trap - ERR
  log "snapshot $SNAPSHOT_ID done: lsn $lsn, base backup $label, $object_count object(s)"
}

# ---- schedule / health ------------------------------------------------------------------------------------------
cmd_schedule() {
  local interval="${BACKUP_SNAPSHOT_INTERVAL_S:-900}" hour="${BACKUP_DB_BACKUP_HOUR_UTC:-2}"
  local full_day="${BACKUP_FULL_BACKUP_WEEKDAY:-7}" timeout_s="${BACKUP_SNAPSHOT_TIMEOUT_S:-21600}"
  mkdir -p "$STATE_DIR"
  while :; do
    local today type=none rc=0
    today="$(date -u +%F)"
    if [ "$(date -u +%-H)" -ge "$hour" ] && [ "$(cat "$STATE_DIR/last-base-backup-day" 2>/dev/null)" != "$today" ]; then
      if [ "$(date -u +%u)" = "$full_day" ]; then type="full"; else type="diff"; fi
    fi
    timeout "$timeout_s" "$0" snapshot "$type" || rc=$?
    if [ "$rc" = 0 ] && [ "$type" != none ]; then echo "$today" >"$STATE_DIR/last-base-backup-day"; fi
    if [ "$rc" = 124 ]; then
      alert backup.snapshot_timeout "coordinated backup snapshot exceeded ${timeout_s}s and was killed" '{}'
    fi
    if ! cmd_healthcheck; then
      alert backup.stale "no successful coordinated backup snapshot within BACKUP_MAX_AGE_S" \
        "$(jq -nc --arg last "$(cat "$STATE_DIR/last-success" 2>/dev/null || echo none)" '{lastSuccess:$last}')"
    fi
    sleep "$interval"
  done
}

cmd_healthcheck() {
  local max_age="${BACKUP_MAX_AGE_S:-$((3 * ${BACKUP_SNAPSHOT_INTERVAL_S:-900}))}" f="$STATE_DIR/last-success"
  [ -f "$f" ] && [ $(($(date +%s) - $(stat -c %Y "$f"))) -le "$max_age" ]
}

cmd_provision_source_reader() {
  need MINIO_ROOT_USER MINIO_ROOT_PASSWORD BACKUP_SOURCE_MINIO_ACCESS_KEY BACKUP_SOURCE_MINIO_SECRET_KEY
  local policy="${BACKUP_SOURCE_MINIO_POLICY:-chartwarden-backup-reader}"
  export MC_CONFIG_DIR="$STATE_DIR/mc"
  mc_host root "${BACKUP_SOURCE_MINIO_URL:-http://minio:9000}" "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD"
  local doc="$STATE_DIR/reader-policy.json"
  mkdir -p "$STATE_DIR"
  cat >"$doc" <<'POLICY'
{
  "Version": "2012-10-17",
  "Statement": [
    {"Effect": "Allow", "Action": ["s3:ListAllMyBuckets", "s3:GetBucketLocation", "s3:ListBucket"], "Resource": ["arn:aws:s3:::*"]},
    {"Effect": "Allow", "Action": ["s3:GetObject"], "Resource": ["arn:aws:s3:::*/*"]}
  ]
}
POLICY
  mcq admin policy create root "$policy" "$doc" >/dev/null
  mcq admin user add root "$BACKUP_SOURCE_MINIO_ACCESS_KEY" "$BACKUP_SOURCE_MINIO_SECRET_KEY" >/dev/null
  mcq admin policy attach root "$policy" --user "$BACKUP_SOURCE_MINIO_ACCESS_KEY" >/dev/null 2>&1 || true # already attached
  log "read-only backup account ready (policy $policy)"
}

# ---- restore ----------------------------------------------------------------------------------------------------
resolve_snapshot() { # $1 = id or "latest"; prints the id of a snapshot whose marker exists
  if [ "$1" != latest ]; then
    echo "$1"
    return
  fi
  mcq ls --recursive --json "$OFFSITE/snapshots/" |
    jq -r 'select(.type == "file" and (.key | endswith("/marker.json"))) | .key | split("/")[0]' | sort | tail -n 1
}

fetch_marker() { mcq cat --enc-c "$ENC" "$OFFSITE/snapshots/$1/marker.json"; }

cmd_marker() {
  mc_setup
  local id
  id="$(resolve_snapshot "${1:-latest}")"
  [ -n "$id" ] || die "no snapshot with a marker found off-site"
  fetch_marker "$id"
}

cmd_restore_db() {
  render_conf
  mc_setup
  local id marker label lsn
  id="$(resolve_snapshot "${1:?snapshot id or latest}")"
  [ -n "$id" ] || die "no snapshot with a marker found off-site"
  marker="$(fetch_marker "$id")"
  label="$(jq -r .db.backupLabel <<<"$marker")"
  lsn="$(jq -r .db.lsn <<<"$marker")"
  if [ -n "$(ls -A "$PGDATA_PATH" 2>/dev/null)" ]; then die "refusing to restore: $PGDATA_PATH is not empty"; fi
  log "restoring snapshot $id: base backup $label, replaying WAL to LSN $lsn (archive_mode forced off)"
  pgbr --repo="$OFFSITE_REPO" --set="$label" --type=lsn --target="$lsn" --target-action=promote \
    --archive-mode=off restore >&2 # stdout carries only the marker
  printf '%s\n' "$marker"
}

cmd_restore_objects() {
  mc_setup
  need RESTORE_MINIO_ACCESS_KEY
  local id="${1:?snapshot id}" work="$STATE_DIR/restore-$1" marker want got b k h t f bad=0
  mkdir -p "$work/stage"
  marker="$(fetch_marker "$id")"
  mcq cat --enc-c "$ENC" "$OFFSITE/$(jq -r .objects.manifest <<<"$marker")" >"$work/manifest.ndjson.gz"
  want="$(jq -r .objects.manifestSha256 <<<"$marker")"
  got="$(sha256sum "$work/manifest.ndjson.gz" | cut -d' ' -f1)"
  [ "$want" = "$got" ] || die "manifest checksum mismatch (marker $want, downloaded $got)"
  gunzip -c "$work/manifest.ndjson.gz" >"$work/manifest.ndjson"
  # Two hops: off-site -> local staging (decrypts SSE-C) -> fresh store. A direct copy would carry the off-site
  # object-lock retention headers onto the restored objects, and then the app's D12 shred could not delete them.
  # The off-site prefix also holds history (objects removed before the snapshot); only manifest entries are uploaded.
  jq -r .b "$work/manifest.ndjson" | sort -u >"$work/buckets.txt"
  while read -r b; do
    mcq mb --ignore-existing "target/$b" </dev/null >/dev/null
    mcq mirror --enc-c "$ENC" "$OFFSITE/objects/$b" "$work/stage/$b" </dev/null >/dev/null
  done <"$work/buckets.txt"
  jq -r '[.b, .k, .h, (.t // "application/octet-stream")] | @tsv' "$work/manifest.ndjson" >"$work/expect.tsv"
  while IFS=$'\t' read -r b k h t; do
    f="$work/stage/$b/$k"
    if [ ! -f "$f" ] || [ "$(sha256sum "$f" | cut -d' ' -f1)" != "$h" ]; then
      log "object in bucket $b missing off-site or sha256 differs from the manifest"
      bad=$((bad + 1))
      continue
    fi
    mcq cp --attr "Content-Type=$t" "$f" "target/$b/$k" </dev/null >/dev/null
  done <"$work/expect.tsv"
  [ "$bad" = 0 ] || die "$bad object(s) failed the restore sha256 check"
  cat "$work/manifest.ndjson.gz" # stdout: restore.sh keeps it for the verifier
  rm -rf "$work"
  log "restored $(jq .objects.count <<<"$marker") object(s) for snapshot $id; every sha256 matches the manifest"
}

# ---- dispatch ---------------------------------------------------------------------------------------------------
cmd="${1:-}"
shift || true
case "$cmd" in
entrypoint)
  render_conf
  if [ "$(id -u)" = 0 ]; then chown -R postgres:postgres /etc/pgbackrest /var/spool/pgbackrest; fi
  umask 022 # the stock entrypoint creates PGDATA's parents as root, then drops to postgres
  exec docker-entrypoint.sh "$@"
  ;;
render-conf) render_conf ;;
snapshot) cmd_snapshot "$@" ;;
schedule) cmd_schedule ;;
healthcheck) cmd_healthcheck ;;
provision-source-reader) cmd_provision_source_reader ;;
marker) cmd_marker "$@" ;;
restore-db) cmd_restore_db "$@" ;;
restore-objects) cmd_restore_objects "$@" ;;
*) die "usage: cw-backup.sh entrypoint|render-conf|snapshot|schedule|healthcheck|provision-source-reader|marker|restore-db|restore-objects" ;;
esac
