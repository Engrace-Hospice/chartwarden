#!/usr/bin/env bash
# deploy/production/backup/restore.sh — restore a coordinated snapshot into an ISOLATED target (#857).
#
#   restore.sh <snapshot-id|latest>     restore into new containers on a new network, ports on 127.0.0.1 only
#   restore.sh destroy <restore-id>     remove those containers, the network and the volume
#
# Never touches the running stack: everything it creates is named cw-restore-<RESTORE_ID>-* and labelled
# chartwarden-restore=<RESTORE_ID>. The restored Postgres runs with archive_mode=off, so it can never push WAL into the
# production repository. Then run the verifier (printed at the end) against the restore.env it writes.
#
# Environment:
#   BACKUP_ENV_FILE      (required) env file with the BACKUP_* variables. Use the restore credentials of the off-site
#                        bucket (read-only), not the backup sidecar's, when the target supports it.
#   BACKUP_IMAGE         image built from this directory (default chartwarden-backup:local)
#   RESTORE_ID           default: a random hex id
#   RESTORE_PG_PORT      host port for the restored Postgres (default 55433), bound to 127.0.0.1
#   RESTORE_MINIO_PORT   host port for the restored MinIO (default 59000), bound to 127.0.0.1
#   RESTORE_MINIO_IMAGE  default minio/minio:latest (the image deploy/production/compose.yml runs)
#   RESTORE_OUT_DIR      where restore.env and marker.json go (default ./restore-<RESTORE_ID>), mode 0700
set -Eeuo pipefail
umask 077

LABEL=chartwarden-restore
IMAGE="${BACKUP_IMAGE:-chartwarden-backup:local}"
log() { printf '%s restore %s\n' "$(date -u +%FT%TZ)" "$*" >&2; }
die() {
  log "ERROR: $*"
  exit 1
}
rand_hex() { head -c "$1" /dev/urandom | od -An -tx1 | tr -d ' \n'; }
now_ms() { # GNU date has %N; BSD/macOS date does not
  local t
  t="$(date +%s%3N)"
  if [[ $t =~ ^[0-9]+$ ]]; then echo "$t"; else python3 -c 'import time; print(int(time.time() * 1000))'; fi
}
pg_promoted() { [ "$(docker exec "$1" psql -X -At -U postgres -d postgres -c 'SELECT pg_is_in_recovery()' 2>/dev/null)" = f ]; }

destroy() {
  local id="$1"
  local ids
  ids="$(docker ps -aq --filter "label=$LABEL=$id")"
  # shellcheck disable=SC2086 # word splitting intended: one container id per line
  if [ -n "$ids" ]; then docker rm -f -v $ids >/dev/null; fi
  docker network rm "cw-restore-$id" >/dev/null 2>&1 || true
  docker volume rm "cw-restore-$id-pgdata" >/dev/null 2>&1 || true
  log "removed restore $id"
}

wait_for() { # what, command...
  local what="$1" _
  shift
  for _ in $(seq 1 600); do
    if "$@" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  die "$what not ready after 600 s"
}

main() {
  local snapshot="${1:?usage: restore.sh <snapshot-id|latest> | restore.sh destroy <restore-id>}"
  [ -n "${BACKUP_ENV_FILE:-}" ] && [ -r "$BACKUP_ENV_FILE" ] || die "BACKUP_ENV_FILE must name a readable env file"
  local id="${RESTORE_ID:-$(rand_hex 4)}"
  local net="cw-restore-$id" vol="cw-restore-$id-pgdata" pg="cw-restore-$id-pg" minio="cw-restore-$id-minio"
  local pg_port="${RESTORE_PG_PORT:-55433}" minio_port="${RESTORE_MINIO_PORT:-59000}"
  local out="${RESTORE_OUT_DIR:-./restore-$id}"
  mkdir -p "$out"
  chmod 700 "$out"
  trap 'log "restore failed; inspect, then: restore.sh destroy '"$id"'"' ERR

  local t0 t_db t_pg
  t0="$(now_ms)"
  docker network create --label "$LABEL=$id" "$net" >/dev/null
  docker volume create --label "$LABEL=$id" "$vol" >/dev/null

  # 1. pgBackRest restore (base backup + WAL replay to the marker's LSN) into the empty volume.
  log "restoring database for snapshot '$snapshot' (restore id $id)"
  docker run --rm --label "$LABEL=$id" --user postgres --env-file "$BACKUP_ENV_FILE" -e BACKUP_PG_LOCAL_REPO=none \
    -v "$vol:/var/lib/postgresql" ${BACKUP_CA_MOUNT[@]+"${BACKUP_CA_MOUNT[@]}"} "$IMAGE" cw-backup.sh restore-db "$snapshot" >"$out/marker.json"
  t_db="$(now_ms)"
  local snapshot_id db_name
  snapshot_id="$(jq -r .snapshotId "$out/marker.json")"
  db_name="$(jq -r .db.database "$out/marker.json")"

  # 2. Start it: WAL replay runs here (restore_command fetches from the off-site repo), then promotion.
  docker run -d --name "$pg" --label "$LABEL=$id" --network "$net" -p "127.0.0.1:$pg_port:5432" \
    --env-file "$BACKUP_ENV_FILE" -e BACKUP_PG_LOCAL_REPO=none -v "$vol:/var/lib/postgresql" ${BACKUP_CA_MOUNT[@]+"${BACKUP_CA_MOUNT[@]}"} \
    "$IMAGE" postgres -c archive_mode=off -c "max_locks_per_transaction=${RESTORE_PG_MAX_LOCKS:-4096}" >/dev/null
  wait_for "restored postgres (WAL replay to the target LSN, then promotion)" pg_promoted "$pg"
  t_pg="$(now_ms)"

  # Fresh credentials that exist only in this isolated copy (the restored cluster carries production's hashes).
  local admin_pw app_pw
  admin_pw="$(rand_hex 24)"
  app_pw="$(rand_hex 24)"
  printf "ALTER ROLE postgres PASSWORD '%s';\nALTER ROLE chartwarden_app PASSWORD '%s';\n" "$admin_pw" "$app_pw" |
    docker exec -i "$pg" psql -X -q -v ON_ERROR_STOP=1 -U postgres -d postgres >/dev/null

  # 3. Fresh MinIO, then the snapshot's objects (sha256-checked against the manifest by restore-objects).
  local minio_user="cwrestore" minio_pw
  minio_pw="$(rand_hex 24)"
  MINIO_ROOT_USER="$minio_user" MINIO_ROOT_PASSWORD="$minio_pw" docker run -d --name "$minio" --label "$LABEL=$id" \
    --network "$net" -p "127.0.0.1:$minio_port:9000" -e MINIO_ROOT_USER -e MINIO_ROOT_PASSWORD \
    "${RESTORE_MINIO_IMAGE:-minio/minio:latest}" server /data >/dev/null
  wait_for "restored minio" curl -fs "http://127.0.0.1:$minio_port/minio/health/ready"
  RESTORE_MINIO_ACCESS_KEY="$minio_user" RESTORE_MINIO_SECRET_KEY="$minio_pw" docker run --rm --label "$LABEL=$id" \
    --network "$net" --user postgres --env-file "$BACKUP_ENV_FILE" -e "RESTORE_MINIO_URL=http://$minio:9000" \
    -e RESTORE_MINIO_ACCESS_KEY -e RESTORE_MINIO_SECRET_KEY ${BACKUP_CA_MOUNT[@]+"${BACKUP_CA_MOUNT[@]}"} "$IMAGE" \
    cw-backup.sh restore-objects "$snapshot_id" >"$out/manifest.ndjson.gz"
  local t_end
  t_end="$(now_ms)"

  {
    echo "RESTORE_ID=$id"
    echo "RESTORE_SNAPSHOT_ID=$snapshot_id"
    echo "RESTORE_ADMIN_URL=postgres://postgres:$admin_pw@127.0.0.1:$pg_port/$db_name"
    echo "RESTORE_APP_URL=postgres://chartwarden_app:$app_pw@127.0.0.1:$pg_port/$db_name"
    echo "RESTORE_MINIO_ENDPOINT=http://127.0.0.1:$minio_port"
    echo "RESTORE_MINIO_ACCESS_KEY=$minio_user"
    echo "RESTORE_MINIO_SECRET_KEY=$minio_pw"
    echo "RESTORE_MARKER_FILE=$(cd "$out" && pwd)/marker.json"
    echo "RESTORE_MANIFEST_FILE=$(cd "$out" && pwd)/manifest.ndjson.gz"
    echo "RESTORE_WALL_MS=$((t_end - t0))"
    echo "RESTORE_PHASE_DB_MS=$((t_db - t0))"
    echo "RESTORE_PHASE_REPLAY_MS=$((t_pg - t_db))"
    echo "RESTORE_PHASE_OBJECTS_MS=$((t_end - t_pg))"
  } >"$out/restore.env"
  trap - ERR
  log "snapshot $snapshot_id restored in $(((t_end - t0) / 1000)) s (restore id $id)"
  log "verify:   RESTORE_ENV_FILE=$out/restore.env bun run backup:verify-restore"
  log "clean up: restore.sh destroy $id"
}

# BACKUP_OFFSITE_CA_FILE (a private CA for the off-site endpoint) is a path inside the container; mount the host file
# at the same path when it exists on the host.
BACKUP_CA_MOUNT=()
if [ -n "${BACKUP_OFFSITE_CA_HOST_FILE:-}" ]; then
  BACKUP_CA_MOUNT=(-v "$BACKUP_OFFSITE_CA_HOST_FILE:${BACKUP_OFFSITE_CA_FILE:?set BACKUP_OFFSITE_CA_FILE too}:ro")
fi

if [ "${1:-}" = destroy ]; then destroy "${2:?restore id}"; else main "$@"; fi
