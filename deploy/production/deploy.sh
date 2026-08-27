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

# Set by the migration step below to the number of migrations THIS deploy applied. It gates how loud the
# rollback is, because the two cases are genuinely different and were previously indistinguishable:
#
#   0 applied  — the previous image ran against this exact schema minutes ago. Restoring it is safe, and
#                the deploy can say so rather than leaving the operator to wonder.
#   N applied  — the previous image has never seen this schema. Restoring images does NOT reverse a
#                migration; it leaves old code on new tables, which is safe ONLY if every migration in
#                this release was expand-phase. Nothing in the toolchain enforces that, so the rollback
#                names the migrations and says plainly that a human has to make the call.
migrations_applied=0

restore_previous_release() {
  echo "deploy failed; restoring the previous image references" >&2
  cp "$backup_file" .env.production
  docker compose --env-file .env.production -f compose.yml up -d --no-deps --force-recreate api worker web || true
  if [ "$migrations_applied" -ne 0 ]; then
    echo "" >&2
    echo "!! SCHEMA/CODE MISMATCH — READ THIS BEFORE WALKING AWAY" >&2
    if [ "$migrations_applied" -lt 0 ]; then
      echo "!! This deploy could not determine how many migrations it applied before failing." >&2
    else
      echo "!! This deploy applied $migrations_applied migration(s) BEFORE failing." >&2
    fi
    echo "!! Migrations are" >&2
    echo "!! forward-only: the images have been rolled back, the schema has NOT." >&2
    echo "!! The restored release is now running against a schema it has never seen. That is safe only" >&2
    echo "!! if every migration in this release was expand-phase (additive, old code still valid)." >&2
    echo "!! Verify that before treating this rollback as complete:" >&2
    echo "!!   git diff --name-only <previous-sha>..<this-sha> -- packages/db/migrations" >&2
    echo "" >&2
  else
    echo "rollback is clean: this deploy applied no migrations, so the restored image is running" >&2
    echo "against the same schema it ran against before." >&2
  fi
}

# Make the new release configuration visible only after its image references have been validated.
mv "$next_file" .env.production

docker compose --env-file .env.production -f compose.yml pull migrate provision api worker web || {
  restore_previous_release
  exit 1
}

# Production migrations are forward-only. A code rollback can restore the prior image, but cannot
# reverse a successfully applied schema migration; migrations must therefore remain compatible.
#
# The output is captured rather than streamed straight through so the rollback path can tell the two
# cases apart (see `restore_previous_release`). It is echoed immediately afterwards, so the deploy log
# is unchanged for a human reading it.
migrate_log=$(mktemp)
if docker compose --env-file .env.production -f compose.yml run --rm --no-deps migrate \
  bun run scripts/db/migrate.ts --strict --schema-only >"$migrate_log" 2>&1; then
  cat "$migrate_log"
  # `migrate.ts` ends with "Applied N new migration(s)." — the one authoritative statement of what this
  # deploy changed about the schema. A parse failure defaults to 0, which errs toward the LOUD rollback
  # message only when it can prove migrations ran; claiming "rollback is clean" on a failed parse would
  # be the dangerous direction to be wrong in, so the default below is corrected right after.
  migrations_applied=$(awk '/Applied [0-9]+ new migration/ {print $2}' "$migrate_log" | tail -1)
  case "$migrations_applied" in
    ''|*[!0-9]*) migrations_applied=-1 ;;   # unparseable: treat as "unknown", which reports as unsafe
  esac
  rm -f "$migrate_log"
else
  cat "$migrate_log"
  rm -f "$migrate_log"
  # The migration step itself failed. `migrate.ts --strict` is transactional per file, but a multi-file
  # run can have committed earlier files before failing on a later one, so this is the unknown case too.
  migrations_applied=-1
  restore_previous_release
  exit 1
fi
docker compose --env-file .env.production -f compose.yml run --rm --no-deps provision || {
  restore_previous_release
  exit 1
}
docker compose --env-file .env.production -f compose.yml up -d --no-deps --force-recreate api worker web || {
  restore_previous_release
  exit 1
}

# Post-deploy verification (F-038/#98). This used to be a single loop against
# `http://127.0.0.1:3000/ready` — one process answering its own readiness endpoint on loopback, which
# proved nothing about the worker, the web tier, nginx, TLS, or whether anyone can actually log in.
# `smoke.sh` runs four tiers and fails the deploy at the first one that does not hold; see its header
# for what each tier rules out.
if ! ./smoke.sh; then
  restore_previous_release
  exit 1
fi

rm -f "$backup_file"
echo "deployed backend=$backend_image web=$web_image"
