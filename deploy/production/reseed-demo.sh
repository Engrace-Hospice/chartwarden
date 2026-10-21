#!/usr/bin/env bash
# Inventory, or destructively reseed, the Engrace Hospice demo tenant on the single-VPS Compose stack.
#
# Uploaded and invoked by .github/workflows/reseed-production.yml (manual dispatch only):
#   ./reseed-demo.sh inventory   read-only: organizations, users and their memberships
#   ./reseed-demo.sh reseed      pg_dump backup, then `db:seed:all` against a throwaway sign-up-open api
#
# `reseed` deletes the `chartwarden-demo` organization (and the legacy `wardenx-demo` one if still present) and every identity whose ONLY membership is that
# organization (scripts/db/seed.ts aborts before deleting if any of them belongs to another tenant),
# then rebuilds the full synthetic dataset. Generated passwords are written to
# $deploy_dir/CREDENTIALS.production.md (0600) on the VPS and are NEVER printed — the seed output is
# also passed through a redaction filter. Fetch the file over SSH; do not paste it anywhere.
set -euo pipefail

mode=${1:-}
case "$mode" in
  inventory | reseed) ;;
  *) echo "usage: $0 inventory|reseed" >&2; exit 64 ;;
esac

deploy_dir=${CHARTWARDEN_DEPLOY_DIR:-/opt/wardenx}
cd "$deploy_dir"
if [ ! -f .env.production ] || [ ! -f compose.yml ]; then
  echo "expected .env.production and compose.yml in $deploy_dir" >&2
  exit 66
fi

dc() { docker compose --env-file .env.production -f compose.yml "$@"; }
psql_admin() { dc exec -T postgres psql -U postgres -d wardenx -v ON_ERROR_STOP=1 "$@"; }

inventory() {
  echo "== organizations (members / patients) =="
  psql_admin -Atc "
    SELECT o.slug || ' | ' || o.display_name || ' | members=' ||
           (SELECT count(*) FROM membership m WHERE m.organization_id = o.id) || ' | patients=' ||
           (SELECT count(*) FROM patient p WHERE p.organization_id = o.id)
      FROM organization o ORDER BY o.slug"
  echo "== users (email | username | orgs they belong to) =="
  psql_admin -Atc "
    SELECT u.email || ' | ' || coalesce(u.username, '-') || ' | ' ||
           coalesce((SELECT string_agg(o.slug, ',' ORDER BY o.slug)
                       FROM membership m JOIN organization o ON o.id = m.organization_id
                      WHERE m.user_id = u.id), '(no membership)')
      FROM \"user\" u ORDER BY u.email"
}

inventory
if [ "$mode" = inventory ]; then exit 0; fi

# ── reseed ────────────────────────────────────────────────────────────────────────────────────────
creds_out=CREDENTIALS.production.md
run_name=chartwarden-seed-run

cleanup() {
  status=$?
  # On failure the api's own output is the only record of why it exited (a boot-time env refusal never
  # reaches the seed run), and it is deleted below — print the tail first, passwords redacted.
  if [ "$status" -ne 0 ] && docker inspect chartwarden-seed-api > /dev/null 2>&1; then
    echo "== chartwarden-seed-api logs (last 80 lines, exit $status) ==" >&2
    docker logs --tail 80 chartwarden-seed-api 2>&1 \
      | sed -E -e 's/Wx-[A-Za-z0-9_-]+-Zq9!/[REDACTED]/g' -e 's#://[^:@/ ]+:[^@ ]+@#://[REDACTED]@#g' >&2 || true
  fi
  # Pull whatever credentials were written (even from a partial run), then tear the sign-up-open api
  # down so registration is never left open.
  if docker inspect "$run_name" > /dev/null 2>&1; then
    if docker cp "$run_name:/tmp/CREDENTIALS.production.md" "$creds_out.new" 2> /dev/null; then
      chmod 600 "$creds_out.new"
      mv "$creds_out.new" "$creds_out"
    fi
    docker rm -f "$run_name" > /dev/null 2>&1 || true
  fi
  dc --profile seed rm -sf seed-api > /dev/null 2>&1 || true
}
trap cleanup EXIT

install -d -m 700 backups
backup="backups/pre-reseed-$(date -u +%Y%m%dT%H%M%SZ).sql.gz"
echo "== backup -> $deploy_dir/$backup =="
dc exec -T postgres pg_dump -U postgres -d wardenx | gzip > "$backup"
chmod 600 "$backup"
test -s "$backup"


echo "== starting throwaway sign-up-open api (no published port) =="
docker rm -f "$run_name" > /dev/null 2>&1 || true # stale container from a killed earlier run
# --no-recreate: the uploaded compose.yml must never recreate the live api/valkey/minio.
dc --profile seed up -d --wait --no-recreate seed-api

echo "== seeding (db:seed:all) =="
# Passwords are `Wx-<base64url>-Zq9!`; redact them should any step ever echo one.
dc --profile seed run -T --no-deps --name "$run_name" seed-runner \
  | sed -E 's/Wx-[A-Za-z0-9_-]+-Zq9!/[REDACTED]/g'

echo "== seeded. Result =="
inventory
echo "credentials: $deploy_dir/$creds_out (mode 600, on the VPS only)"
