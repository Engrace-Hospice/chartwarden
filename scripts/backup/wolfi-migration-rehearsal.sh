#!/usr/bin/env bash
# scripts/backup/wolfi-migration-rehearsal.sh - rehearse the Debian -> Wolfi Postgres migration on a private cluster
# and print the record (markdown) on stdout:
#
#   bash scripts/backup/wolfi-migration-rehearsal.sh > audit/restore-drill/<date>-wolfi-migration-rehearsal.md
#
# What it proves, in the order production will meet it (deploy/production/README.md, "Migration runbook (Debian -> Wolfi, one time)"):
#   1. a cluster the Debian-era backup image created (main's backup/Dockerfile, glibc 2.36) is archiving into a
#      pgBackRest stanza on an encrypted posix repository, with a full backup taken;
#   2. the Wolfi backup image (this tree's backup/Dockerfile, glibc 2.44) starts on the SAME data volume and repository,
#      Postgres reports the collation version mismatch, cw-refresh-collation clears it, amcheck passes on every btree
#      (and GIN) index, and datcollversion equals the OS version in every database;
#   3. the Wolfi pgBackRest pushes WAL into the Debian-created stanza, passes `check`, takes an incremental backup on
#      top of the Debian full backup, and restores (like cw-backup.sh restore-db: --type=lsn, archive_mode off) into fresh
#      volumes, both from that incremental backup and from the Debian full backup replaying Debian- and Wolfi-pushed WAL.
# Run it on the production artifacts with DOCKER_DEFAULT_PLATFORM=linux/amd64 (the VPS architecture), WOLFI_POSTGRES_IMAGE set
# to compose.yml's pinned image and WOLFI_BACKUP_IMAGE built from backup/Dockerfile's defaults, so the record names the digest.
# Everything is a private, labelled container or volume (cw-rehearsal-<run>) with --network none and no published port,
# so it never touches the dev stack or a host port; all of it is removed on exit. Data is invented (names, codes).
# The posix repo stands in for S3 and the engine is started through the Postgres entrypoint, not cw-backup.sh (whose
# render_conf requires an https off-site repository); backup:coordinated-drill covers that path.
#
# Env: REHEARSAL_DEBIAN_REF (default origin/main) is the ref whose deploy/production/backup/ builds the Debian image;
#      WOLFI_BACKUP_IMAGE uses a prebuilt Wolfi backup image instead of building one from this tree (then
#      WOLFI_POSTGRES_IMAGE only names its base for the record); REHEARSAL_KEEP=1 skips the cleanup.
set -Eeuo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RUN_ID="${REHEARSAL_RUN_ID:-$(date -u +%m%d%H%M%S)$$}"
P="cw-rehearsal-$RUN_ID"
LABEL="cw-rehearsal=$RUN_ID"
DEBIAN_REF="${REHEARSAL_DEBIAN_REF:-origin/main}"
WOLFI_IMG="${WOLFI_BACKUP_IMAGE:-}"
WOLFI_BASE="${WOLFI_POSTGRES_IMAGE:-}"
STANZA=chartwarden
DB=cw_rehearsal
PGDATA_DIR=/var/lib/postgresql/18/docker
BUILT_IMAGES=()
ROWS=""
FAILED=0
LAST_LINE=0
DEBIAN_INFO="" WOLFI_INFO="" DEBIAN_IMG=""
SERVER_VOLUMES=(-v "$P-data:/var/lib/postgresql" -v "$P-repo:/var/lib/pgbackrest" -v "$P-conf:/etc/pgbackrest")

log() { printf '[rehearsal] %s\n' "$*" >&2; }
now() { perl -MTime::HiRes=time -e 'printf "%.2f", time'; }
since() { perl -e 'printf "%.1f s", $ARGV[1] - $ARGV[0]' "$1" "$(now)"; }
row() { ROWS+="| $1 | $2 | ${3//|//} | ${4:--} |"$'\n'; }
pass() { row PASS "$@"; log "PASS $1"; }
fail() {
  FAILED=1
  row FAIL "$@"
  log "FAIL $1: $2"
  exit 1
}
image_id() { docker image inspect --format '{{slice .Id 7 19}}' "$1"; }
image_row() { # role reference image
  [ -n "$3" ] || { printf '| %s | %s | n/a | n/a |' "$1" "$2"; return 0; }
  printf '| %s | %s | %s | %s |' "$1" "$2" "$(image_id "$3" 2>/dev/null || echo n/a)" \
    "$(docker image inspect --format '{{if .RepoDigests}}{{index .RepoDigests 0}}{{else}}local build, no digest{{end}}' "$3" 2>/dev/null || echo n/a)"
}
engine_info() { # container
  printf 'PostgreSQL %s, glibc %s, %s' "$(sql "$1" postgres -c 'SHOW server_version')" \
    "$(docker exec "$1" getconf GNU_LIBC_VERSION | cut -d' ' -f2)" "$(docker exec "$1" pgbackrest version)"
}

sql() { # container db psql-args...
  local c=$1 d=$2
  shift 2
  docker exec -u postgres "$c" psql -X -qAt -v ON_ERROR_STOP=1 -U postgres -d "$d" "$@"
}
pgb() { # container pgbackrest-args...
  local c=$1
  shift
  docker exec -u postgres "$c" pgbackrest --stanza="$STANZA" "$@"
}
repo_json() { pgb "$1" info --output=json; }

wait_ready() { # container [first-start]
  local c=$1
  if [ -n "${2:-}" ]; then
    for _ in $(seq 1 120); do
      [ "$(docker logs "$c" 2>&1 | grep -c 'init process complete')" -ge 1 ] && break
      sleep 1
    done
  fi
  for _ in $(seq 1 120); do
    docker exec "$c" pg_isready -q -U postgres && return 0
    sleep 1
  done
  docker logs --tail 40 "$c" >&2
  return 1
}

start_server() { # name image [first-start] - archiving on, like compose.backup.yml's postgres service
  docker run -d --name "$1" --label "$LABEL" --network none --init -e POSTGRES_HOST_AUTH_METHOD=trust \
    "${SERVER_VOLUMES[@]}" --entrypoint /usr/local/bin/docker-entrypoint.sh "$2" postgres \
    -c max_locks_per_transaction=4096 -c archive_mode=on \
    -c "archive_command=pgbackrest --stanza=$STANZA archive-push %p" -c archive_timeout=60 >/dev/null
  wait_ready "$1" "${3:-}"
}

switch_and_wait() { # container - force a WAL switch and wait until the archiver has pushed that segment
  local seg
  seg="$(sql "$1" postgres -c "SELECT pg_walfile_name(pg_switch_wal() - 1)")"
  for _ in $(seq 1 90); do
    [ "$(sql "$1" postgres -c "SELECT coalesce(last_archived_wal >= '$seg', false) FROM pg_stat_archiver")" = t ] && return 0
    sleep 1
  done
  return 1
}

read -r -d '' AMCHECK_SQL <<'SQL' || true
DO $$
DECLARE r record; ok int := 0; bad int := 0; nbt int := 0; ngin int := 0;
BEGIN
  FOR r IN SELECT c.oid, c.oid::regclass AS name, am.amname
             FROM pg_class c JOIN pg_am am ON am.oid = c.relam JOIN pg_index i ON i.indexrelid = c.oid
            WHERE c.relkind = 'i' AND c.relpersistence = 'p' AND i.indisvalid AND am.amname IN ('btree', 'gin')
            ORDER BY c.oid
  LOOP
    BEGIN
      IF r.amname = 'btree' THEN PERFORM bt_index_check(r.oid, true); nbt := nbt + 1;
      ELSE PERFORM gin_index_check(r.oid); ngin := ngin + 1; END IF;
      ok := ok + 1;
    EXCEPTION WHEN others THEN
      bad := bad + 1;
      RAISE NOTICE 'index % failed: %', r.name, SQLERRM;
    END;
  END LOOP;
  RAISE NOTICE 'amcheck: % ok, % failed (btree %, gin %)', ok, bad, nbt, ngin;
END $$;
SQL

amcheck_all() { sql "$1" "$DB" -c "$AMCHECK_SQL" 2>&1 | grep -E 'amcheck:|failed:' | sed 's/^NOTICE: *//' | paste -sd ';' -; }
fingerprint() { sql "$1" "$DB" -c "SELECT count(*) || ' rows, md5 ' || md5(string_agg(concat_ws('|', id, ref_code, family, given, note, embedding), E'\n' ORDER BY id)) FROM person_demo"; }
mismatch_warnings() { docker exec -u postgres "$1" psql -X -qAt -U postgres -d "${2:-$DB}" -c 'SELECT 1' 2>&1 >/dev/null | grep -c 'collation version mismatch' || true; }
insert_rows() { # container from to - more invented rows, same shape as the seed
  sql "$1" "$DB" -c "INSERT INTO person_demo (ref_code, family, given, note, embedding)
    SELECT 'Late ' || n, 'Vessa-' || n, 'Quill', 'Synthetic later note ' || n, format('[%s,%s,%s]', (n % 97) / 97.0, (n % 89) / 89.0, (n % 83) / 83.0)::vector
    FROM generate_series($2, $3) n"
}
# Every string is sorted by the en_US.utf8 collation; the md5 of that order is what a glibc change would move.
ORDER_PROBE_SQL="SELECT md5(string_agg(s, E'\n' ORDER BY s COLLATE \"en_US.utf8\", s COLLATE \"C\")) || ' over ' || count(*) || ' strings'
  FROM (SELECT 'a' || chr(a) || 'b' AS s FROM generate_series(32, 12000) a WHERE a NOT BETWEEN 55296 AND 57343
        UNION ALL SELECT chr(a) FROM generate_series(32, 131071) a WHERE a NOT BETWEEN 55296 AND 57343) x"
order_probe() { sql "$1" postgres -c "$ORDER_PROBE_SQL"; }

# Proof that amcheck is not vacuous here: an index built in C order whose recorded collation is then flipped to the
# database default (what a glibc reorder amounts to) must fail bt_index_check. Runs in a scratch database.
amcheck_negative_control() {
  sql "$1" postgres -c "CREATE DATABASE cw_negctl" >/dev/null
  sql "$1" cw_negctl -c "CREATE EXTENSION amcheck; CREATE TABLE t (s text);
    INSERT INTO t SELECT chr(65 + n % 26) || n FROM generate_series(1, 3000) n;
    INSERT INTO t SELECT chr(97 + n % 26) || n FROM generate_series(1, 3000) n;
    CREATE INDEX t_c_ix ON t (s COLLATE \"C\");
    UPDATE pg_index SET indcollation = '100'::oidvector WHERE indexrelid = 't_c_ix'::regclass" >/dev/null
  sql "$1" cw_negctl -c "SELECT bt_index_check('t_c_ix'::regclass, true)" 2>&1 | grep -m1 'order invariant violated' || true
  sql "$1" postgres -c "DROP DATABASE cw_negctl" >/dev/null
}

cleanup() {
  [ "${REHEARSAL_KEEP:-}" = 1 ] && { log "REHEARSAL_KEEP=1: leaving cw-rehearsal-$RUN_ID containers and volumes"; return 0; }
  local id
  while read -r id; do [ -n "$id" ] && docker rm -f "$id" >/dev/null 2>&1; done < <(docker ps -aq --filter "label=$LABEL")
  while read -r id; do [ -n "$id" ] && docker volume rm -f "$id" >/dev/null 2>&1; done < <(docker volume ls -q --filter "label=$LABEL")
  for id in ${BUILT_IMAGES[@]+"${BUILT_IMAGES[@]}"}; do docker rmi -f "$id" >/dev/null 2>&1 || true; done
  return 0
}

print_record() {
  local verdict=PASS commit dirty=""
  [ "$FAILED" = 0 ] || verdict=FAIL
  commit="$(git -C "$REPO_ROOT" rev-parse --short=12 HEAD)"
  [ -z "$(git -C "$REPO_ROOT" status --porcelain -- deploy scripts .github .trivyignore.yaml)" ] || dirty=" (working tree has uncommitted changes under deploy/, scripts/, .github/)"
  cat <<EOF
# Debian to Wolfi Postgres migration rehearsal - $verdict

> **Synthetic scale, private containers on one developer machine.** A few tens of thousands of invented rows prove the
> mechanism, not the duration: \`cw-refresh-collation\` rebuilds every index, so its time grows with the real database.
> Time it again on a copy of production data before the maintenance window, and size the window from that.

Run $RUN_ID at $(date -u +%Y-%m-%dT%H:%M:%SZ). Tree commit $commit$dirty. Reproduce:
\`bash scripts/backup/wolfi-migration-rehearsal.sh\` (set \`WOLFI_BACKUP_IMAGE\` to reuse a built Wolfi backup image).

## Images
| role | reference | image id | repo digest |
|---|---|---|---|
$(image_row "Debian-era backup image" "built from \`$DEBIAN_REF:deploy/production/backup/\` ($(git -C "$REPO_ROOT" rev-parse --short=12 "$DEBIAN_REF" 2>/dev/null || echo unknown))" "$DEBIAN_IMG")
$(image_row "Wolfi Postgres (base)" "${WOLFI_BASE:-built from deploy/production/postgres}" "$WOLFI_BASE")
$(image_row "Wolfi backup image" "${WOLFI_BACKUP_IMAGE:-built from deploy/production/backup}" "$WOLFI_IMG")

Docker host $(docker info --format '{{.OSType}}/{{.Architecture}}'), containers run as \`${DOCKER_DEFAULT_PLATFORM:-the host platform}\`$( [ -z "${DOCKER_DEFAULT_PLATFORM:-}" ] || echo " (emulated when it differs from the host: wall times are then inflated)" ).

## Tooling
- **Debian-era**: $DEBIAN_INFO
- **Wolfi**: $WOLFI_INFO

## Steps
| result | step | detail | wall |
|---|---|---|---|
$ROWS
## Not covered
- The cluster is a few MB; production's reindex time, WAL volume and restore time are larger. Re-time on a restored copy.
- The repository is a local posix repo with a repo cipher; S3 transport and the off-site key policies are proven by
  \`bun run backup:coordinated-drill\`, which builds the Wolfi backup image too.
- The server is started through the Postgres entrypoint with a hand-written \`pgbackrest.conf\` equal to what
  \`cw-backup.sh render-conf\` writes for repo1 (aes-256-cbc, bundle, async archive); \`cw-backup.sh entrypoint\` needs an https off-site repository.
- The ordering probe covers single characters to U+1FFFF and 'a<char>b' strings to U+2EE0 in en_US.utf8 only; text outside
  it, or another locale, is not compared. If it reports identical order, the reindex was not needed for correctness on
  that range: it still clears the warning and records the new version, so keep it, and still time it.
- Debian side is main's backup image (pgvector/pgvector:pg18-bookworm, glibc 2.36), the image compose.yml ran before this change.
EOF
}

finish() {
  local rc=$?
  trap - EXIT
  if [ "$rc" != 0 ] && [ "$FAILED" = 0 ]; then FAILED=1; row FAIL "aborted" "a command failed near line $LAST_LINE of the script (exit $rc)"; fi
  print_record
  cleanup
  exit "$rc"
}
trap 'LAST_LINE=$LINENO' ERR
trap finish EXIT

for tool in docker git perl jq openssl; do command -v "$tool" >/dev/null || { echo "missing tool: $tool" >&2; exit 2; }; done
git -C "$REPO_ROOT" rev-parse --verify -q "$DEBIAN_REF^{commit}" >/dev/null || { echo "unknown ref $DEBIAN_REF (git fetch origin?)" >&2; exit 2; }

# ---- 0. images -------------------------------------------------------------------------------------------------
t=$(now)
scratch="$(mktemp -d)"
for f in Dockerfile cw-backup.sh schema-fingerprint.sql; do
  git -C "$REPO_ROOT" show "$DEBIAN_REF:deploy/production/backup/$f" >"$scratch/$f"
done
DEBIAN_IMG="$P-debian"
docker build -q -t "$DEBIAN_IMG" "$scratch" >/dev/null
BUILT_IMAGES+=("$DEBIAN_IMG")
rm -rf "$scratch"
if [ -z "$WOLFI_IMG" ]; then
  WOLFI_BASE="$P-pg"
  docker build -q -t "$WOLFI_BASE" "$REPO_ROOT/deploy/production/postgres" >/dev/null
  WOLFI_IMG="$P-wolfi"
  docker build -q --build-arg "POSTGRES_IMAGE=$WOLFI_BASE" -t "$WOLFI_IMG" "$REPO_ROOT/deploy/production/backup" >/dev/null
  BUILT_IMAGES+=("$WOLFI_IMG" "$WOLFI_BASE")
fi
pass "images ready" "Debian-era backup image built from $DEBIAN_REF, Wolfi backup image $WOLFI_IMG"

# ---- 1. Debian-era cluster: archiving, indexes, full backup ----------------------------------------------------
for v in data repo conf restore-a restore-b; do docker volume create --label "$LABEL" "$P-$v" >/dev/null; done
CIPHER_PASS="$(openssl rand -hex 24)"
docker run --rm -i --label "$LABEL" --network none -u 0 -v "$P-conf:/etc/pgbackrest" --entrypoint sh "$DEBIAN_IMG" \
  -c 'umask 077; cat >/etc/pgbackrest/pgbackrest.conf; chown -R postgres:postgres /etc/pgbackrest' <<EOF
[global]
log-level-console=info
log-level-file=off
compress-type=zst
process-max=2
start-fast=y
archive-async=y
spool-path=/var/spool/pgbackrest
lock-path=/var/run/postgresql/pgbackrest-lock
repo1-path=/var/lib/pgbackrest
repo1-retention-full=2
repo1-cipher-type=aes-256-cbc
repo1-cipher-pass=$CIPHER_PASS
repo1-bundle=y

[$STANZA]
pg1-path=$PGDATA_DIR
pg1-socket-path=/var/run/postgresql
EOF

t=$(now)
start_server "$P-debian" "$DEBIAN_IMG" first
sql "$P-debian" postgres -c "CREATE DATABASE $DB"
sql "$P-debian" "$DB" -c "
CREATE EXTENSION pg_trgm; CREATE EXTENSION amcheck; CREATE EXTENSION vector;
CREATE TABLE person_demo (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ref_code text NOT NULL, family text NOT NULL, given text NOT NULL, note text NOT NULL, embedding vector(3) NOT NULL);
INSERT INTO person_demo (ref_code, family, given, note, embedding)
SELECT f || ' ' || g || ' ' || n, f, g, 'Synthetic note ' || n || ' ' || f || ' / ' || g,
       format('[%s,%s,%s]', (n % 97) / 97.0, (n % 89) / 89.0, (n % 83) / 83.0)::vector
  FROM (SELECT n,
          (ARRAY['Quillon','bramwell-Ode','O''Verrin','Étienne-Marq','de la Vessa','Ångström-Teal','Zephyr_Kane','abel Thorne','Ünal-Marsh','çelik Voss'])[1 + n % 10] AS f,
          (ARRAY['Élodie','mira','Joss','Ólafur-Vee','ana maría','Zoë','Ísak','nils','Åsa','tomé'])[1 + (n / 10) % 10] AS g
          FROM generate_series(1, 20000) n) s;
CREATE UNIQUE INDEX person_demo_ref_code_uq ON person_demo (ref_code);
CREATE INDEX person_demo_name_ix ON person_demo (family, given);
CREATE INDEX person_demo_given_lower_ix ON person_demo (lower(given));
CREATE INDEX person_demo_note_trgm ON person_demo USING gin (note gin_trgm_ops);
CREATE INDEX person_demo_embedding_hnsw ON person_demo USING hnsw (embedding vector_l2_ops);
ANALYZE;"
DEBIAN_INFO="$(engine_info "$P-debian")"
EXT_DEBIAN="$(sql "$P-debian" "$DB" -c "SELECT extname || ' ' || extversion FROM pg_extension WHERE extname IN ('vector','pg_trgm','amcheck') ORDER BY 1" | paste -sd ',' -)"
pgb "$P-debian" stanza-create >/dev/null
pgb "$P-debian" check >/dev/null 2>&1 || fail "Debian stanza check" "pgbackrest check failed on the Debian-era cluster"
tf=$(now)
pgb "$P-debian" --type=full backup >/dev/null 2>&1 || fail "Debian full backup" "pgbackrest full backup failed"
FULL_TIME="$(since "$tf")"
insert_rows "$P-debian" 20001 20500 >/dev/null
switch_and_wait "$P-debian" || fail "Debian WAL archive" "the 500 post-backup rows' segment was not archived"
DEBIAN_FP="$(fingerprint "$P-debian")"
ORDER_DEBIAN="$(order_probe "$P-debian")"
FULL_LABEL="$(repo_json "$P-debian" | jq -r '[.[0].backup[] | select(.type=="full")][0].label')"
pass "Debian-era cluster seeded and backed up" "$DEBIAN_FP; indexes: unique btree, 2 btree, expression btree, pg_trgm GIN, pgvector HNSW; extensions $EXT_DEBIAN; full backup $FULL_LABEL; seed + backup" "$(since "$t") (full backup $FULL_TIME)"
t=$(now)
docker stop -t 120 "$P-debian" >/dev/null
[ "$(docker logs "$P-debian" 2>&1 | grep -c 'database system is shut down')" -ge 1 ] || fail "Debian clean stop" "no 'database system is shut down' in the log"
docker rm "$P-debian" >/dev/null
pass "Debian server stopped cleanly" "shut down checkpoint written; container removed, volume and repo kept" "$(since "$t")"

# ---- 2. Wolfi on the same volume and repo ----------------------------------------------------------------------
t=$(now)
start_server "$P-wolfi" "$WOLFI_IMG"
WOLFI_INFO="$(engine_info "$P-wolfi")"
pass "Wolfi image started on the Debian-created volume" "no initdb; same PGDATA volume and repository" "$(since "$t")"

WARN_OUT="$(docker exec -u postgres "$P-wolfi" psql -X -qAt -U postgres -d "$DB" -c 'SELECT 1' 2>&1 >/dev/null || true)"
[ "$(grep -c 'collation version mismatch' <<<"$WARN_OUT")" -ge 1 ] || fail "collation mismatch warning" "expected the warning on first connect, got: $WARN_OUT"
pass "collation version mismatch is reported" "$(grep -E 'DETAIL' <<<"$WARN_OUT" | head -1 | sed 's/^DETAIL: *//')"
[ "$(fingerprint "$P-wolfi")" = "$DEBIAN_FP" ] || fail "data survives the engine swap" "fingerprint differs from the Debian side"
pass "table contents identical on Wolfi" "$DEBIAN_FP (rows 1-20500, ordered by id)"
ORDER_WOLFI="$(order_probe "$P-wolfi")"
if [ "$ORDER_WOLFI" = "$ORDER_DEBIAN" ]; then
  pass "collation order probe, en_US.utf8 on Debian glibc vs Wolfi glibc (informational)" "identical order: md5 $ORDER_WOLFI"
else
  pass "collation order probe, en_US.utf8 on Debian glibc vs Wolfi glibc (informational)" "ORDER DIFFERS (stale text indexes are inconsistent): Debian $ORDER_DEBIAN; Wolfi $ORDER_WOLFI"
fi
BEFORE="$(amcheck_all "$P-wolfi")"
pass "amcheck BEFORE cw-refresh-collation (informational: shows whether the stale indexes are actually inconsistent)" "$BEFORE"

t=$(now)
docker exec -u postgres "$P-wolfi" cw-refresh-collation >/dev/null 2>&1 || fail "cw-refresh-collation" "the script failed"
pass "cw-refresh-collation (REINDEX + REFRESH COLLATION VERSION in every connectable database)" "completed" "$(since "$t")"
AFTER="$(amcheck_all "$P-wolfi")"
case "$AFTER" in *"0 failed"*) pass "amcheck after reindex: every btree (heapallindexed) and GIN index" "$AFTER" ;; *) fail "amcheck after reindex" "$AFTER" ;; esac
NEG="$(amcheck_negative_control "$P-wolfi")"
[ -n "$NEG" ] || fail "amcheck negative control" "bt_index_check did not flag an index whose collation order was changed under it"
pass "amcheck negative control: an index whose collation order is changed under it is flagged" "$NEG"
BAD="$(sql "$P-wolfi" postgres -c "SELECT count(*) FROM pg_database WHERE datallowconn AND datcollversion IS DISTINCT FROM pg_database_collation_actual_version(oid)")"
VERSIONS="$(sql "$P-wolfi" postgres -c "SELECT string_agg(datname || ' ' || coalesce(datcollversion, '-') || '/' || coalesce(pg_database_collation_actual_version(oid), '-') || CASE WHEN datallowconn THEN '' ELSE ' (no connections)' END, ', ' ORDER BY datname) FROM pg_database")"
[ "$BAD" = 0 ] || fail "datcollversion equals the OS version" "$BAD connectable database(s) differ: $VERSIONS"
pass "datcollversion equals the OS version in every connectable database" "recorded/actual: $VERSIONS"
WARNS="$(mismatch_warnings "$P-wolfi")"
[ "$WARNS" = 0 ] || fail "no mismatch warning after refresh" "$WARNS warning(s) on connect"
pass "no collation warning on connect after the refresh" "0 warnings"
sql "$P-wolfi" postgres -c "CREATE DATABASE cw_probe TEMPLATE template0" >/dev/null
PROBE="$(mismatch_warnings "$P-wolfi" cw_probe)"
sql "$P-wolfi" postgres -c "DROP DATABASE cw_probe" >/dev/null
pass "probe: a database created from template0 after the refresh (informational)" "$PROBE collation warning(s) on its first connect"
EXT_WOLFI="$(sql "$P-wolfi" "$DB" -c "SELECT e.extname || ' ' || e.extversion || ' (available ' || a.default_version || ')' FROM pg_extension e JOIN pg_available_extensions a ON a.name = e.extname WHERE e.extname IN ('vector','pg_trgm','amcheck') ORDER BY 1" | paste -sd ',' -)"
HNSW="$(sql "$P-wolfi" "$DB" -c "SELECT count(*) FROM (SELECT id FROM person_demo ORDER BY embedding <-> '[0.5,0.5,0.5]' LIMIT 10) s")"
[ "$HNSW" = 10 ] || fail "pgvector query on Wolfi" "expected 10 neighbours, got $HNSW"
pass "extensions after the swap, and an HNSW nearest-neighbour query" "$EXT_WOLFI; 10 neighbours returned"

# ---- 3. Wolfi pgBackRest against the Debian-created stanza -------------------------------------------------------
ARCH0="$(sql "$P-wolfi" postgres -c "SELECT archived_count || ' archived, ' || failed_count || ' failed, last ' || coalesce(last_archived_wal, '-') FROM pg_stat_archiver")"
FAIL0="$(sql "$P-wolfi" postgres -c "SELECT failed_count FROM pg_stat_archiver")"
insert_rows "$P-wolfi" 20501 20800 >/dev/null
switch_and_wait "$P-wolfi" || fail "Wolfi WAL archive" "the segment switched on Wolfi was not archived in 90 s"
ARCH1="$(sql "$P-wolfi" postgres -c "SELECT archived_count || ' archived, ' || failed_count || ' failed, last ' || coalesce(last_archived_wal, '-') FROM pg_stat_archiver")"
[ "$(sql "$P-wolfi" postgres -c "SELECT failed_count FROM pg_stat_archiver")" = "$FAIL0" ] || fail "Wolfi archive-push" "failed_count rose: $ARCH0 -> $ARCH1"
pass "WAL pushed by the Wolfi pgBackRest into the Debian-created stanza" "pg_stat_archiver at Wolfi start: $ARCH0; after pg_switch_wal(): $ARCH1 (failed_count did not move; any earlier failures are the Debian run archiving before stanza-create)"
pgb "$P-wolfi" check >/dev/null 2>&1 || fail "Wolfi pgbackrest check" "check failed"
pass "pgbackrest check (Wolfi) on the Debian-created stanza" "archive and backup repository consistent"
t=$(now)
pgb "$P-wolfi" --type=incr backup >/dev/null 2>&1 || fail "Wolfi incremental backup" "backup failed"
INCR_LABEL="$(repo_json "$P-wolfi" | jq -r '[.[0].backup[] | select(.type=="incr")][-1].label')"
case "$INCR_LABEL" in "${FULL_LABEL}_"*I) ;; *) fail "incremental backup chain" "incr label '$INCR_LABEL' is not based on Debian full $FULL_LABEL" ;; esac
pass "incremental backup by the Wolfi pgBackRest on top of the Debian full backup" "$INCR_LABEL (repo: $(repo_json "$P-wolfi" | jq -r '[.[0].backup[] | .label + " " + .type] | join("; ")'))" "$(since "$t")"
insert_rows "$P-wolfi" 20801 20900 >/dev/null
FINAL_LSN="$(sql "$P-wolfi" postgres -c "SELECT pg_current_wal_lsn()")"
switch_and_wait "$P-wolfi" || fail "Wolfi final WAL archive" "final segment not archived"
FINAL_FP="$(fingerprint "$P-wolfi")"
pass "100 more rows after the incremental backup, segment archived" "final state $FINAL_FP at $FINAL_LSN"

restore_and_verify() { # volume-suffix set-label description
  local v=$1 set=$2 desc=$3 t2 fp checks warns
  t2=$(now)
  docker run --rm --label "$LABEL" --network none -u postgres -v "$P-$v:/var/lib/postgresql" -v "$P-repo:/var/lib/pgbackrest" \
    -v "$P-conf:/etc/pgbackrest" --entrypoint sh "$WOLFI_IMG" -c \
    "mkdir -p -m 0700 $PGDATA_DIR && pgbackrest --stanza=$STANZA --set=$set --type=lsn --target=$FINAL_LSN --target-action=promote --archive-mode=off restore" >/dev/null 2>&1 ||
    fail "restore $desc" "pgbackrest restore failed"
  docker run -d --name "$P-$v" --label "$LABEL" --network none --init -v "$P-$v:/var/lib/postgresql" -v "$P-repo:/var/lib/pgbackrest" \
    -v "$P-conf:/etc/pgbackrest" --entrypoint /usr/local/bin/docker-entrypoint.sh "$WOLFI_IMG" postgres \
    -c max_locks_per_transaction=4096 >/dev/null
  wait_ready "$P-$v" || fail "restore $desc" "restored server did not accept connections"
  for _ in $(seq 1 120); do [ "$(sql "$P-$v" postgres -c 'SELECT pg_is_in_recovery()')" = f ] && break; sleep 1; done
  fp="$(fingerprint "$P-$v")"
  checks="$(amcheck_all "$P-$v")"
  warns="$(mismatch_warnings "$P-$v")"
  [ "$fp" = "$FINAL_FP" ] || fail "restore $desc" "fingerprint '$fp' differs from the source '$FINAL_FP'"
  case "$checks" in *"0 failed"*) ;; *) fail "restore $desc" "amcheck on the restored cluster: $checks" ;; esac
  [ "$warns" = 0 ] || fail "restore $desc" "$warns collation warning(s) on the restored cluster"
  docker rm -f "$P-$v" >/dev/null
  pass "restore $desc into a fresh volume with the Wolfi image" "$fp equals the source; $checks; 0 collation warnings; archive_mode off, promoted at $FINAL_LSN" "$(since "$t2")"
}
restore_and_verify restore-a "$INCR_LABEL" "of the Wolfi incremental backup $INCR_LABEL"
restore_and_verify restore-b "$FULL_LABEL" "of the Debian full backup $FULL_LABEL (replays Debian- and Wolfi-pushed WAL)"
log "done"
