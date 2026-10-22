#!/usr/bin/env sh
# OPERATOR-RUN helper for the volume rename (INFRA_RENAME_RUNBOOK.md, Window 2). Docker cannot rename a volume, so this
# COPIES <from>_<name> -> <to>_<name> for the four data volumes and proves the copy is identical. It never deletes, never
# overwrites and never touches the source: the old volumes stay as the rollback until the operator removes them.
#
#   sh volumes-copy.sh copy   <from-prefix> <to-prefix>     e.g. wardenx chartwarden
#   sh volumes-copy.sh verify <from-prefix> <to-prefix>     read-only; safe to re-run
#
# Refuses (exit 1, nothing changed) when: a container still uses a source volume (stop the stack first, a live postgres
# directory is not a consistent copy); a destination volume already holds data (remove the incomplete one yourself
# after looking at it); the postgres or minio source is missing (valkey/clamav are caches and are skipped when absent).
# Destination volumes get the labels Compose puts on its own volumes, so `compose up` adopts them without a warning.
# Env: COPY_IMAGE (default alpine:3), TO_PROJECT (compose project label, default <to-prefix>), VERIFY_DEEP=0 skips the
# per-file sha256 pass (sizes, modes, owners and the file list are still compared).
set -eu

die() { echo "volumes-copy: $1" >&2; exit 1; }

mode=${1:-}; from=${2:-}; to=${3:-}
case "$mode" in copy | verify) ;; *) die "usage: sh volumes-copy.sh copy|verify <from-prefix> <to-prefix>" ;; esac
for p in "$from" "$to"; do
  case "$p" in '' | [!a-z]* | *[!a-z0-9_-]*) die "prefix must match ^[a-z][a-z0-9_-]*\$ (got: '$p')" ;; esac
done
[ "$from" != "$to" ] || die "from and to prefix are the same"
image=${COPY_IMAGE:-alpine:3}
project=${TO_PROJECT:-$to}
deep=${VERIFY_DEEP:-1}
required="postgres-data minio-data"
optional="valkey-data clamav-data"

docker info >/dev/null 2>&1 </dev/null || die "docker is not reachable"
vol_exists() { docker volume inspect "$1" >/dev/null 2>&1 </dev/null; }
# Empty means no entry besides the volume root; checked in a throwaway container because the mountpoint is root-owned.
vol_empty() { [ -z "$(docker run --rm -v "$1:/v:ro" "$image" sh -c 'ls -A /v' </dev/null)" ]; }
in_use() { [ -n "$(docker ps -q --filter "volume=$1" </dev/null)" ]; }

# Prints one digest for a directory tree: file list + type/mode/owner (+ size, + content hash when deep).
manifest() {
  docker run --rm -v "$1:/v:ro" -e DEEP="$deep" "$image" sh -c '
    cd /v
    find . ! -type f -exec stat -c "%n|%F|%a|%u:%g" {} + | LC_ALL=C sort
    find . -type f -exec stat -c "%n|%s|%a|%u:%g" {} + | LC_ALL=C sort
    if [ "$DEEP" = 1 ]; then find . -type f -exec sha256sum {} + | LC_ALL=C sort; fi
  ' </dev/null | sha256sum | cut -d" " -f1
}

names=""
for n in $required; do
  vol_exists "${from}_$n" || die "source volume ${from}_$n does not exist"
  names="$names $n"
done
for n in $optional; do
  if vol_exists "${from}_$n"; then names="$names $n"; else echo "skip ${from}_$n (absent)"; fi
done

# Refuse before copying anything: one busy source or one non-empty destination must not leave a half-copied set.
if [ "$mode" = copy ]; then
  for n in $names; do
    src="${from}_$n"; dst="${to}_$n"
    in_use "$src" && die "$src is in use by a container; stop the stack first (docker compose ... down, never -v)"
    if vol_exists "$dst" && ! vol_empty "$dst"; then
      die "$dst already exists and holds data; inspect it and 'docker volume rm $dst' yourself, then re-run"
    fi
  done
fi

for n in $names; do
  src="${from}_$n"; dst="${to}_$n"
  if [ "$mode" = copy ]; then
    vol_exists "$dst" || docker volume create --label "com.docker.compose.project=$project" --label "com.docker.compose.volume=$n" "$dst" >/dev/null
    echo "copy $src -> $dst"
    docker run --rm -v "$src:/from:ro" -v "$dst:/to" "$image" sh -c 'cp -a /from/. /to/' </dev/null
  fi
  vol_exists "$dst" || die "destination volume $dst does not exist"
  a=$(manifest "$src"); b=$(manifest "$dst")
  [ "$a" = "$b" ] || die "VERIFY FAILED for $n: $src ($a) differs from $dst ($b)"
  echo "ok   $n identical ($a)"
done
echo "volumes-copy $mode done: $from -> $to. Source volumes were not modified."
