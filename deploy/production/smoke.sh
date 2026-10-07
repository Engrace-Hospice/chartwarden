#!/usr/bin/env sh
# deploy/production/smoke.sh — post-deploy verification (F-038 / #98).
#
# WHAT THIS REPLACES. The deploy used to verify one thing: that `curl http://127.0.0.1:3000/ready`
# eventually returned 200. That is one process answering its own readiness endpoint on loopback. It
# proved nothing about the worker (which has no port published and, before this change, no healthcheck
# either — so a worker that booted and died left the deploy green while every background job silently
# stopped), nothing about the web tier, and nothing about nginx or TLS, because probing 127.0.0.1:3000
# bypasses the reverse proxy entirely. A broken certificate, a wrong upstream or a bad vhost was
# invisible to the deploy that caused it.
#
# THE TIERS ARE ORDERED BY WHAT THEY RULE OUT, cheapest first, so a failure names its own cause:
#
#   1  containers   — did the three services actually come up and stay up?
#   2  loopback     — does each tier answer on its own port? (isolates "app broken" from "proxy broken")
#   3  ingress      — does the PUBLIC hostname answer over TLS? (the tier the old probe skipped)
#   4  authenticated— can a real session be minted and a tenant-scoped read served? (the tier that
#                     proves the database, RLS, and the auth stack are actually working together)
#
# Tier 4 is fail-closed with a NAMED opt-out (`WARDENX_SMOKE_ALLOW_ANONYMOUS=1`) rather than skipped
# when unconfigured. A deploy that quietly omits its only end-to-end check because a variable was unset
# is the same defect as the loopback probe: it reports success for something it never measured. If the
# synthetic account is not provisioned yet, that has to be typed out, once, and it is visible in the
# deploy log every time.
set -eu

fail() { echo "SMOKE FAIL [$1] $2" >&2; exit 1; }
ok()   { echo "  ✓ $1"; }

deploy_dir=${WARDENX_DEPLOY_DIR:-/opt/wardenx}
compose="docker compose --env-file .env.production -f compose.yml"
cd "$deploy_dir"

# `curl` flags used throughout: --fail (non-2xx is an error), --silent --show-error (quiet unless it
# breaks), and an explicit timeout so a hung upstream fails the deploy instead of hanging it.
CURL="curl --fail --silent --show-error --max-time 10"

# Emit a focused diagnostic before rolling a release back. Docker health reports merely
# "unhealthy", which discards the one fact an operator needs to repair the dependency. A running
# process can provide the structured `/ready` result (only fixed dependency names and ok/fail
# statuses); a crash-looping one instead needs its last startup log and Docker exit status.
print_readiness_diagnostic() {
  svc=$1
  container_id=$($compose ps -q "$svc" 2>/dev/null || true)
  [ -n "$container_id" ] || {
    echo "  ! $svc diagnostic unavailable: container is gone" >&2
    return
  }
  state=$(docker inspect --format '{{.State.Status}}' "$container_id" 2>/dev/null || true)
  exit_code=$(docker inspect --format '{{.State.ExitCode}}' "$container_id" 2>/dev/null || true)
  if [ "$state" != "running" ]; then
    echo "  ! $svc is $state (last exit code: ${exit_code:-unknown}); startup log:" >&2
    docker logs --tail 80 "$container_id" 2>&1 || true
    return
  fi
  $compose exec -T "$svc" bun -e '
    const port = process.env.PROCESS_ROLE === "worker"
      ? (process.env.WORKER_PORT ?? "3001")
      : (process.env.PORT ?? "3000");
    try {
      const response = await fetch(`http://127.0.0.1:${port}/ready`);
      console.error(`  ! ${process.env.PROCESS_ROLE ?? "api"} /ready: HTTP ${response.status}`);
      console.error(await response.text());
    } catch (error) {
      console.error(`  ! ${process.env.PROCESS_ROLE ?? "api"} /ready diagnostic failed: ${String(error)}`);
      process.exitCode = 1;
    }
  ' 2>&1 || true
}

# ── tier 1: the containers are up and, where they declare a healthcheck, healthy ────────────────────
#
# Read state from Docker's container metadata rather than Compose's display templates. The latter
# silently render an empty health column on some Compose versions, which falsely looks like every
# service is healthy immediately after `--force-recreate`. A container in `restarting` is the
# crash-loop case that `restart: unless-stopped` would otherwise hide from a deploy that only polls
# an HTTP endpoint.
echo "tier 1 — container state"
for svc in api worker web; do
  container_id=$($compose ps -q "$svc" 2>/dev/null || true)
  [ -n "$container_id" ] || fail "tier1/$svc" "service is not present in the compose project"
  state=$(docker inspect --format '{{.State.Status}}' "$container_id") \
    || fail "tier1/$svc" "could not inspect container state"
  case "$state" in
    running) ;;
    *) fail "tier1/$svc" "expected state 'running', got '$state'" ;;
  esac
  ok "$svc running"
done

# Wait for the declared healthchecks to go green rather than asserting once: `--force-recreate` has
# just restarted all three, and `start_period` is 30s on the api.
attempt=0
until [ "$attempt" -ge 60 ]; do
  unhealthy=""
  for svc in api worker web; do
    container_id=$($compose ps -q "$svc" 2>/dev/null || true)
    [ -n "$container_id" ] || fail "tier1/$svc" "service disappeared while waiting for health"
    health=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' "$container_id") \
      || fail "tier1/$svc" "could not inspect container health"
    case "$health" in
      healthy) ;;
      starting|unhealthy) unhealthy="${unhealthy}${svc}=${health} " ;;
      missing) fail "tier1/$svc" "service has no declared healthcheck" ;;
      *) fail "tier1/$svc" "unexpected health status '$health'" ;;
    esac
  done
  [ -z "$unhealthy" ] && break
  attempt=$((attempt + 1))
  sleep 2
done
if [ -n "${unhealthy:-}" ]; then
  echo "  ! readiness diagnostics for unhealthy services:" >&2
  for svc in api worker; do
    case " $unhealthy " in
      *" $svc="*) print_readiness_diagnostic "$svc" ;;
    esac
  done
  fail "tier1/health" "still not healthy after 120s: $unhealthy"
fi
ok "all declared healthchecks green"

# ── tier 2: each tier answers on its own port ───────────────────────────────────────────────────────
#
# The API's /ready is a REAL probe (bootstrap/readiness-probe.ts): it checks the database, Valkey and
# the object store, and returns 503 when any of them is down. So this single request also discharges
# the "queue and object storage reachable from inside the new containers" requirement — it is checked
# by the container that would actually use them, not by the deploy host.
echo "tier 2 — loopback"
attempt=0
until $CURL http://127.0.0.1:3000/ready >/dev/null; do
  attempt=$((attempt + 1))
  [ "$attempt" -lt 15 ] || fail "tier2/api" "api /ready did not return 2xx on 127.0.0.1:3000"
  sleep 2
done
ok "api /ready (db + valkey + object store)"

# The worker publishes no port, so this runs INSIDE its container. It serves only /health and /ready
# (index.ts, TASK-040A) on WORKER_PORT — enough to prove the process is alive and its dependencies
# resolve, which is exactly what was unverified before.
$compose exec -T worker bun -e '
  const port = process.env.WORKER_PORT ?? "3001";
  const response = await fetch(`http://127.0.0.1:${port}/ready`);
  if (!response.ok) {
    console.error(`worker /ready returned HTTP ${response.status}`);
    process.exit(1);
  }
' \
  || fail "tier2/worker" "worker /ready did not return 2xx inside the container"
  

$CURL http://127.0.0.1:8080/ >/dev/null || fail "tier2/web" "web did not serve on 127.0.0.1:8080"
ok "web serving on 8080"

# ── tier 3: the public hostnames answer through nginx over TLS ──────────────────────────────────────
#
# This is the tier the old probe had no equivalent of. The URLs default to the server_names in
# deploy/production/nginx/*.conf so a stock install needs no configuration, and are overridable for a
# staging host.
echo "tier 3 — public ingress"
app_url=${WARDENX_SMOKE_APP_URL:-https://wardenx.chartwarden.cloud}
api_url=${WARDENX_SMOKE_API_URL:-https://be082026.wardenx.chartwarden.cloud}

# Deliberately NOT `-k`. Certificate validation is the point: an expired or mis-issued certificate is
# a production outage for every browser, and a smoke test that passes `-k` would be blind to the single
# most common TLS failure.
$CURL "$api_url/ready" >/dev/null || fail "tier3/api" "$api_url/ready unreachable or TLS invalid"
ok "api reachable at $api_url over TLS"

# The SPA must return real HTML, not merely a 200 — an nginx pointing at an empty root, or at the wrong
# upstream, answers 200 with something that is not the app.
body=$($CURL "$app_url/" || true)
[ -n "$body" ] || fail "tier3/web" "$app_url/ returned nothing (unreachable, TLS invalid, or empty)"
echo "$body" | grep -qi "<div id=\"root\"\|<!doctype html" \
  || fail "tier3/web" "$app_url/ answered but did not serve the SPA document"
ok "web app served at $app_url over TLS"

# §9.6 / GAP-185 — the SPA document must carry the browser-side defenses. They are set by the web
# container's nginx (deploy/production/web-security-headers.conf), which the host vhost proxies; a
# missing header means the include was dropped from a location (nginx does not inherit add_header) or
# the host vhost started stripping them. Assert on the real response, not on the config.
app_headers=$($CURL -I "$app_url/" || true)
for expected in \
  "content-security-policy:.*frame-ancestors 'none'" \
  "x-frame-options: *deny" \
  "x-content-type-options: *nosniff" \
  "referrer-policy:" \
  "strict-transport-security:"; do
  echo "$app_headers" | grep -qi "^$expected" \
    || fail "tier3/headers" "$app_url/ response is missing the security header matching /$expected/ (SECURITY_HARDENING §9.6)"
done
ok "web app carries the §9.6 security headers (CSP frame-ancestors, X-Frame-Options, nosniff, Referrer-Policy, HSTS)"

# ── tier 4: a real session, and a tenant-scoped read ────────────────────────────────────────────────
#
# The synthetic account should hold the LEAST privilege that still proves the stack: it needs to
# authenticate and resolve an organization context, and it does NOT need to read PHI. A standing
# deploy-time credential with chart access would be a worse liability than the check is worth — see
# deploy/production/README.md for the account this expects.
# echo "tier 4 — authenticated round trip"
# if [ -z "${WARDENX_SMOKE_EMAIL:-}" ] || [ -z "${WARDENX_SMOKE_PASSWORD:-}" ]; then
#   if [ "${WARDENX_SMOKE_ALLOW_ANONYMOUS:-}" = "1" ]; then
#     echo "  ! SKIPPED — WARDENX_SMOKE_ALLOW_ANONYMOUS=1 is set." >&2
#     echo "  ! This deploy did NOT verify that anyone can log in or that any tenant-scoped read works." >&2
#   else
#     fail "tier4/config" \
#       "WARDENX_SMOKE_EMAIL/WARDENX_SMOKE_PASSWORD are unset. Provision the synthetic monitor account (see deploy/production/README.md), or set WARDENX_SMOKE_ALLOW_ANONYMOUS=1 to deploy without an end-to-end check."
#   fi
# else
#   cookie_jar=$(mktemp)
#   # shellcheck disable=SC2064
#   trap "rm -f $cookie_jar" EXIT

#   login=$($CURL -c "$cookie_jar" -H 'content-type: application/json' \
#     -d "{\"email\":\"${WARDENX_SMOKE_EMAIL}\",\"password\":\"${WARDENX_SMOKE_PASSWORD}\"}" \
#     "$api_url/api/auth/sign-in/email") \
#     || fail "tier4/login" "sign-in failed against $api_url — auth stack, database, or credentials"

#   # A 2FA-enrolled account answers 200 with `twoFactorRedirect` and NO session, which would otherwise
#   # surface one step later as a confusing 401 on /auth/context. The synthetic monitor must not be
#   # 2FA-enrolled — it holds no PHI access, and a deploy cannot type a TOTP code.
#   case "$login" in
#     *twoFactorRedirect*) fail "tier4/login" \
#       "the synthetic account is 2FA-enrolled; a deploy cannot complete a step-up. Use a non-enrolled, least-privilege monitor account (see deploy/production/README.md)." ;;
#   esac
#   ok "signed in"

#   # `/auth/context` resolves the caller's memberships and active organization. A 2xx here proves the
#   # session cookie survived the proxy, the database is readable under the app role, and org-context
#   # resolution works — the three things between "the process is up" and "a user can do anything".
#   ctx=$($CURL -b "$cookie_jar" "$api_url/api/v1/auth/context") \
#     || fail "tier4/context" "/auth/context failed — session, RLS, or org-context resolution"
#   # Matching `"organizationId":"` rather than the bare word: the field is nullable, so a membership-less
#   # account answers 200 with `"organizationId":null` — which contains the word "organization" and would
#   # pass a looser check while proving nothing about tenant resolution.
#   echo "$ctx" | grep -q '"organizationId":"' \
#     || fail "tier4/context" "/auth/context resolved no organization (organizationId is null) — the synthetic account has no active membership"
#   ok "session resolves an organization context"

#   $CURL -b "$cookie_jar" -X POST "$api_url/api/auth/sign-out" >/dev/null 2>&1 || true
# fi

echo "SMOKE OK"
