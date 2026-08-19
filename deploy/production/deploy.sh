#!/usr/bin/env sh
# Deploy an already-published, immutable WardenX image on the single-VPS Compose topology.
#
# The workflow uploads this file on each release, then invokes it as:
#   ./deploy.sh ghcr.io/owner/wardenx:sha-<sha> ghcr.io/owner/wardenx-web:sha-<sha>
#
# It deliberately never accepts `latest`: a deploy must always be attributable to one commit and
# a rollback must always name an already-published immutable image.
set -eu

if [ "$#" -ne 2 ]; then
  echo "usage: $0 <backend-image-sha-tag> <web-image-sha-tag>" >&2
  exit 64
fi

backend_image=$1
web_image=$2
case "$backend_image" in
  ghcr.io/*/wardenx:sha-*) ;;
  *) echo "refusing non-immutable backend image: $backend_image" >&2; exit 64 ;;
esac
case "$web_image" in
  ghcr.io/*/wardenx-web:sha-*) ;;
  *) echo "refusing non-immutable web image: $web_image" >&2; exit 64 ;;
esac

deploy_dir=${WARDENX_DEPLOY_DIR:-/opt/wardenx}
cd "$deploy_dir"

if [ ! -f .env.production ] || [ ! -f compose.yml ]; then
  echo "expected .env.production and compose.yml in $deploy_dir" >&2
  exit 66
fi

backup_file=$(mktemp .env.production.before-deploy.XXXXXX)
next_file=$(mktemp .env.production.next.XXXXXX)
cp .env.production "$backup_file"
chmod 600 "$backup_file" "$next_file"

cleanup() {
  rm -f "$next_file" "$backup_file"
}
trap cleanup EXIT

awk -v backend="$backend_image" -v web="$web_image" '
  BEGIN { saw_backend = 0; saw_web = 0 }
  /^WARDENX_IMAGE=/ { print "WARDENX_IMAGE=" backend; saw_backend = 1; next }
  /^WARDENX_WEB_IMAGE=/ { print "WARDENX_WEB_IMAGE=" web; saw_web = 1; next }
  { print }
  END {
    if (!saw_backend || !saw_web) exit 1
  }
' .env.production >"$next_file" || {
  echo "could not update immutable image references in .env.production" >&2
  exit 65
}

restore_previous_release() {
  echo "deploy failed; restoring the previous image references" >&2
  cp "$backup_file" .env.production
  docker compose --env-file .env.production -f compose.yml up -d --no-deps --force-recreate api worker web || true
}

# Make the new release configuration visible only after its image references have been validated.
mv "$next_file" .env.production

docker compose --env-file .env.production -f compose.yml pull migrate provision api worker web || {
  restore_previous_release
  exit 1
}

# Production migrations are forward-only. A code rollback can restore the prior image, but cannot
# reverse a successfully applied schema migration; migrations must therefore remain compatible.
docker compose --env-file .env.production -f compose.yml run --rm --no-deps migrate \
  bun run scripts/db/migrate.ts --strict --schema-only || {
  restore_previous_release
  exit 1
}
docker compose --env-file .env.production -f compose.yml run --rm --no-deps provision || {
  restore_previous_release
  exit 1
}
docker compose --env-file .env.production -f compose.yml up -d --no-deps --force-recreate api worker web || {
  restore_previous_release
  exit 1
}

attempt=0
until curl --fail --silent --show-error http://127.0.0.1:3000/ready >/dev/null; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 45 ]; then
    restore_previous_release
    exit 1
  fi
  sleep 2
done

rm -f "$backup_file"
echo "deployed backend=$backend_image web=$web_image"
