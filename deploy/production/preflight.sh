#!/usr/bin/env sh
# PREFLIGHT for the chartwarden infra rename (INFRA_RENAME_RUNBOOK.md, "Merge order"). READ-ONLY: it writes nothing,
# starts nothing, and fails closed (exit 67) when it cannot prove the host matches the configured names.
#
# Single source of truth, used two ways:
#   * the deploy/reseed workflows pipe it over SSH BEFORE uploading anything:
#       ssh host "cd $DEPLOY_DIR && sh -s" < deploy/production/preflight.sh
#   * deploy.sh runs it from the deploy dir (manual deploys, rollbacks).
# The working directory must be the deploy dir (it holds .env.production).
set -eu

fail() {
  echo "PREFLIGHT FAILED: $1" >&2
  echo "  nothing was changed. See deploy/production/INFRA_RENAME_RUNBOOK.md (Merge order)." >&2
  exit 67
}

deploy_dir=$(pwd)
[ -f .env.production ] || fail "$deploy_dir/.env.production does not exist; the host was not cut over (Step C)"
# Reads a value like Compose does: last assignment wins, CR / surrounding quotes / inline " #" comment stripped.
env_get() { sed -n "s/^$1=//p" .env.production | tail -n 1 | tr -d '\r' | sed -e 's/^"\([^"]*\)".*$/\1/' -e "s/^'\([^']*\)'.*\$/\1/" -e 's/[[:space:]]\{1,\}#.*$//' -e 's/[[:space:]]*$//'; }
# An exported variable wins over .env.production, exactly as for compose interpolation.
resolve() { v=$(eval "printf '%s' \"\${$1:-}\""); [ -n "$v" ] || v=$(env_get "$1"); printf '%s' "$v"; }
# True only for a NON-EMPTY value (exported variable or .env.production).
has_key() { [ -n "$(resolve "$1")" ]; }

docker info >/dev/null 2>&1 </dev/null || fail "docker is not reachable (docker info failed); cannot verify the host"

# 1. Layout. Supported: the real directory is /opt/chartwarden (optionally with a /opt/wardenx symlink to it).
#    The reverse (real /opt/wardenx, /opt/chartwarden a symlink or fresh) and a live /opt/wardenx elsewhere are refused.
legacy_dir=/opt/wardenx
if [ "$deploy_dir" != "$legacy_dir" ] && [ -d "$legacy_dir" ] && [ ! -L "$legacy_dir" ] && [ -f "$legacy_dir/.env.production" ]; then
  fail "$legacy_dir is a live directory (with .env.production) but the deploy dir is $deploy_dir; finish the move (Step C)"
fi
real_dir=$(cd "$deploy_dir" && pwd -P)
case "$real_dir" in
  /opt/wardenx) fail "the real deploy dir is $real_dir (/opt/chartwarden would be a symlink); the supported layout is the reverse (Step C)" ;;
esac

project=$(resolve CHARTWARDEN_COMPOSE_PROJECT); project=${project:-chartwarden}
volume_prefix=$(resolve CHARTWARDEN_VOLUME_PREFIX); volume_prefix=${volume_prefix:-$project}
pg_volume="${volume_prefix}_postgres-data"
db_name=$(resolve CHARTWARDEN_DB_NAME); db_name=${db_name:-chartwarden}
case "$db_name" in
  '' | [!a-z_]* | *[!a-z0-9_]*) fail "CHARTWARDEN_DB_NAME must match ^[a-z_][a-z0-9_]*\$ (got: $db_name)" ;;
esac

existing_pg_volumes=$(docker volume ls -q --filter 'name=_postgres-data$' </dev/null 2>/dev/null) || fail "docker volume ls failed"
pg_ps=$(docker ps -a --filter 'label=com.docker.compose.service=postgres' --format '{{.Label "com.docker.compose.project"}}' </dev/null 2>/dev/null) || fail "docker ps failed"
pg_projects=$(printf '%s\n' "$pg_ps" | sort -u)
existing_stack=0
if [ -n "$existing_pg_volumes" ] || [ -n "$pg_projects" ]; then existing_stack=1; fi

# 2. Volumes: the configured postgres volume must exist if any does (a fresh host has none).
if [ -n "$existing_pg_volumes" ] && ! printf '%s\n' "$existing_pg_volumes" | grep -qx "$pg_volume"; then
  fail "configured postgres volume '$pg_volume' does not exist but these do: $(echo $existing_pg_volumes). Set CHARTWARDEN_VOLUME_PREFIX in .env.production to the existing prefix, or finish the volume copy (Runbook, Window 2)"
fi
# A half-finished volume copy: postgres moved but the object store did not, so 'up' would create an EMPTY minio volume
# and every uploaded document would look lost. Same rule as above for the object store (the one volume whose loss is
# invisible to the database).
minio_volume="${volume_prefix}_minio-data"
existing_minio_volumes=$(docker volume ls -q --filter 'name=_minio-data$' </dev/null 2>/dev/null) || fail "docker volume ls failed"
if [ -n "$existing_minio_volumes" ] && ! printf '%s\n' "$existing_minio_volumes" | grep -qx "$minio_volume"; then
  fail "configured object-store volume '$minio_volume' does not exist but these do: $(echo $existing_minio_volumes). The volume copy is incomplete (Runbook, Window 2); do not deploy"
fi

# 3. Compose project: a differently named project already holds postgres, so 'up' would start a second stack.
if [ -n "$pg_projects" ] && ! printf '%s\n' "$pg_projects" | grep -qx "$project"; then
  fail "compose project '$project' has no postgres container but these projects do: $(echo $pg_projects). Set CHARTWARDEN_COMPOSE_PROJECT or finish the cutover"
fi

if [ "$existing_stack" -eq 1 ]; then
  # 4. An existing stack must name its database and smoke hosts explicitly: the defaults are only for fresh installs.
  has_key CHARTWARDEN_DB_NAME || fail "an existing stack was found but CHARTWARDEN_DB_NAME is not set in .env.production (the default is 'chartwarden'; the live database may still be 'wardenx'). Add the line with the real name (Runbook, Merge order step 2)"
  has_key CHARTWARDEN_SMOKE_APP_URL && has_key CHARTWARDEN_SMOKE_API_URL \
    || fail "an existing stack was found but CHARTWARDEN_SMOKE_APP_URL / CHARTWARDEN_SMOKE_API_URL are not both set in .env.production (the defaults are the new hosts, which may not serve yet; Runbook, Merge order step 3)"

  # 5. If postgres is running, the configured database must exist. Found by label, so it works with a stopped or
  #    half-configured compose file. Not running: only the explicit key above can be checked.
  pg_ids=$(docker ps -q --filter "label=com.docker.compose.project=$project" --filter 'label=com.docker.compose.service=postgres' </dev/null 2>/dev/null) || fail "docker ps failed"
  pg_container=$(printf '%s\n' "$pg_ids" | head -n 1)
  if [ -n "$pg_container" ]; then
    databases=$(docker exec "$pg_container" psql -U postgres -d postgres -tAc 'SELECT datname FROM pg_database' </dev/null 2>/dev/null) \
      || fail "could not list databases in the running postgres container $pg_container"
    printf '%s\n' "$databases" | grep -qx "$db_name" \
      || fail "database '$db_name' does not exist in the running cluster (found: $(echo $databases)). Fix CHARTWARDEN_DB_NAME or run the database rename (Step E)"
  fi
fi

echo "preflight ok (dir=$deploy_dir project=$project volume=$pg_volume db=$db_name existing_stack=$existing_stack)"
