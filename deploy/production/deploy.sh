#!/usr/bin/env sh
# Deploy an already-published, immutable WardenX image on the single-VPS Compose topology.
#
# The workflow uploads this file on each release, then invokes it as:
#   ./deploy.sh ghcr.io/owner/wardenx:sha-<sha> ghcr.io/owner/wardenx-web:sha-<sha> \
#               ghcr.io/owner/wardenx-docling-worker:sha-<sha>
#
# The third argument (the DocLens docling-worker image, GAP-138) is optional so a rollback or a hand
# deploy of an older release that predates the image still works; without it the already-configured
# WARDENX_DOCLING_IMAGE (if any) is left alone.
#
# It deliberately never accepts `latest`: a deploy must always be attributable to one commit and
# a rollback must always name an already-published immutable image.
set -eu

if [ "$#" -lt 2 ] || [ "$#" -gt 3 ]; then
  echo "usage: $0 <backend-image-sha-tag> <web-image-sha-tag> [<docling-worker-image-sha-tag>]" >&2
  exit 64
fi

backend_image=$1
web_image=$2
docling_image=${3:-}
case "$backend_image" in
  ghcr.io/*/wardenx:sha-*) ;;
  *) echo "refusing non-immutable backend image: $backend_image" >&2; exit 64 ;;
esac
case "$web_image" in
  ghcr.io/*/wardenx-web:sha-*) ;;
  *) echo "refusing non-immutable web image: $web_image" >&2; exit 64 ;;
esac

case "$docling_image" in
  ''|ghcr.io/*/wardenx-docling-worker:sha-*) ;;
  *) echo "refusing non-immutable docling-worker image: $docling_image" >&2; exit 64 ;;
esac

deploy_dir=${WARDENX_DEPLOY_DIR:-/opt/wardenx}
cd "$deploy_dir"

if [ ! -f .env.production ] || [ ! -f compose.yml ]; then
  echo "expected .env.production and compose.yml in $deploy_dir" >&2
  exit 66
fi

# GAP-138/139 — secrets the release needs but an older `.env.production` predates. Generated ONCE and
# appended BEFORE the rollback backup is taken, so the backup (and therefore a rollback, which runs the
# new compose.yml against the restored env file) interpolates cleanly. Existing values are never touched.
ensure_secret() {
  if ! grep -q "^$1=" .env.production; then
    printf '%s=%s\n' "$1" "$2" >> .env.production
    echo "generated $1 in .env.production"
  fi
}
# The docling-worker bearer (backend -> worker); it holds no object-store credentials.
ensure_secret DOCLING_WORKER_TOKEN "$(openssl rand -hex 32)"
# The scoped MinIO service account the api/worker use instead of the MinIO ROOT account (the
# `minio-provision` one-shot creates it with a bucket-scoped policy; see compose.yml).
ensure_secret MINIO_APP_ACCESS_KEY "wardenx-app"
ensure_secret MINIO_APP_SECRET_KEY "$(openssl rand -hex 24)"
# The bearer MinIO's audit webhook presents to the api's access-log receiver (GAP-141).
ensure_secret MINIO_ACCESS_LOG_WEBHOOK_TOKEN "$(openssl rand -hex 32)"

backup_file=$(mktemp .env.production.before-deploy.XXXXXX)
next_file=$(mktemp .env.production.next.XXXXXX)
cp .env.production "$backup_file"
chmod 600 "$backup_file" "$next_file"

cleanup() {
  rm -f "$next_file" "$backup_file"
}
trap cleanup EXIT

awk -v backend="$backend_image" -v web="$web_image" -v docling="$docling_image" '
  BEGIN { saw_backend = 0; saw_web = 0; saw_docling = 0 }
  /^WARDENX_IMAGE=/ { print "WARDENX_IMAGE=" backend; saw_backend = 1; next }
  /^WARDENX_WEB_IMAGE=/ { print "WARDENX_WEB_IMAGE=" web; saw_web = 1; next }
  /^WARDENX_DOCLING_IMAGE=/ { if (docling != "") { print "WARDENX_DOCLING_IMAGE=" docling } else { print }; saw_docling = 1; next }
  { print }
  END {
    if (!saw_backend || !saw_web) exit 1
    if (!saw_docling && docling != "") print "WARDENX_DOCLING_IMAGE=" docling
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

# ── supply-chain verification (F-040 / #100) ────────────────────────────────────────────────────────
#
# Nothing used to establish that the image this host pulls is the image CI built. `sha-<commit>` is
# immutable by CONVENTION and by nothing else — a registry will move a tag — so the deploy trusted GHCR
# to hand back the right bytes and had no way to tell if it did not.
#
# `cosign verify` checks the keyless signature the release job produced against a pinned WORKFLOW
# IDENTITY, not a key: the certificate must say this repository's `deploy.yml`, on the expected ref,
# issued by GitHub's OIDC provider. So a signature made by any other workflow, repository, branch or
# actor fails — which is the property that matters while `main` still has no branch protection (#16).
#
# It also closes the gap between "verify" and "pull": cosign reports the digest it verified, and that
# digest is written back into `.env.production`, so Compose pulls THAT artefact rather than re-resolving
# the tag a moment later and possibly getting a different one.
cosign_identity=${WARDENX_COSIGN_IDENTITY:-https://github.com/Engrace-Hospice/wardenx/.github/workflows/deploy.yml@refs/heads/main}
cosign_issuer=${WARDENX_COSIGN_ISSUER:-https://token.actions.githubusercontent.com}

# Prints the verified digest on success; anything else is a failure the caller must treat as fatal.
verify_image_digest() {
  cosign verify "$1" \
    --certificate-identity "$cosign_identity" \
    --certificate-oidc-issuer "$cosign_issuer" \
    --output json 2>/dev/null \
    | sed -n 's/.*"docker-manifest-digest":"\(sha256:[a-f0-9]\{64\}\)".*/\1/p' \
    | head -1
}

backend_ref=$backend_image
web_ref=$web_image
docling_ref=$docling_image

if [ "${WARDENX_DEPLOY_ALLOW_UNVERIFIED:-}" = "1" ]; then
  # A named opt-out, not a fallback. It exists so a first deploy predating the signing workflow can
  # still land, and it is printed on every deploy that uses it — an unverified deploy must never be
  # indistinguishable from a verified one in the log.
  echo "!! WARDENX_DEPLOY_ALLOW_UNVERIFIED=1 — image signatures were NOT checked for this deploy." >&2
  echo "!! Nothing establishes that these images are the ones CI built." >&2
elif ! command -v cosign >/dev/null 2>&1; then
  echo "cosign is not installed on this host, so image signatures cannot be verified." >&2
  echo "Install it (see deploy/production/README.md) or set WARDENX_DEPLOY_ALLOW_UNVERIFIED=1." >&2
  restore_previous_release
  exit 1
else
  backend_digest=$(verify_image_digest "$backend_image")
  case "$backend_digest" in
    sha256:*) ;;
    *) echo "signature verification FAILED for $backend_image" >&2
       echo "expected identity: $cosign_identity" >&2
       restore_previous_release; exit 1 ;;
  esac
  web_digest=$(verify_image_digest "$web_image")
  case "$web_digest" in
    sha256:*) ;;
    *) echo "signature verification FAILED for $web_image" >&2
       echo "expected identity: $cosign_identity" >&2
       restore_previous_release; exit 1 ;;
  esac

  if [ -n "$docling_image" ]; then
    docling_digest=$(verify_image_digest "$docling_image")
    case "$docling_digest" in
      sha256:*) ;;
      *) echo "signature verification FAILED for $docling_image" >&2
         echo "expected identity: $cosign_identity" >&2
         restore_previous_release; exit 1 ;;
    esac
    docling_ref="${docling_image%%:sha-*}@${docling_digest}"
    echo "verified $docling_image -> $docling_digest"
  fi

  # Pin to the digest cosign actually verified. `${image%%:*}` strips the `:sha-<commit>` tag, leaving
  # the repository, so the pull can only resolve to the verified artefact.
  backend_ref="${backend_image%%:sha-*}@${backend_digest}"
  web_ref="${web_image%%:sha-*}@${web_digest}"
  echo "verified $backend_image -> $backend_digest"
  echo "verified $web_image -> $web_digest"

  # Rewrite the staged file with the digest-pinned references before it becomes live.
  awk -v backend="$backend_ref" -v web="$web_ref" -v docling="$docling_ref" '
    /^WARDENX_IMAGE=/ { print "WARDENX_IMAGE=" backend; next }
    /^WARDENX_WEB_IMAGE=/ { print "WARDENX_WEB_IMAGE=" web; next }
    /^WARDENX_DOCLING_IMAGE=/ { if (docling != "") { print "WARDENX_DOCLING_IMAGE=" docling } else { print }; next }
    { print }
  ' "$next_file" >"$next_file.pinned" && mv "$next_file.pinned" "$next_file"
  chmod 600 "$next_file"
fi

# Make the new release configuration visible only after its image references have been validated.
mv "$next_file" .env.production

docker compose --env-file .env.production -f compose.yml pull migrate provision api worker web docling-worker minio-provision || {
  restore_previous_release
  exit 1
}

# A release can add a fail-closed production setting. Validate that contract in the NEW image before
# touching the schema or recreating a live service: otherwise a missing secret presents only as two
# crash-looping API/worker containers after an otherwise successful migration. This import is pure
# environment validation — it opens no database, Redis, or storage connection — and its error names
# variable keys and rules, never their values.
if ! docker compose --env-file .env.production -f compose.yml run --rm --no-deps api \
  bun -e 'import { assertProductionEnv } from "./apps/backend/src/bootstrap/env.ts"; assertProductionEnv(); console.log("production environment contract validated");'; then
  echo "new release environment validation failed; no migrations were applied and no new release service was started" >&2
  restore_previous_release
  exit 1
fi

# `up --no-deps` below never starts dependency services. Create/refresh the scoped MinIO
# service account before the new api/worker credentials are used (including secret rotations).
docker compose --env-file .env.production -f compose.yml run --rm minio-provision || {
  echo "MinIO application account provisioning failed; no migrations were applied" >&2
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
docker compose --env-file .env.production -f compose.yml up -d --no-deps --force-recreate api worker web docling-worker || {
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
echo "deployed backend=$backend_ref web=$web_ref docling=${docling_ref:-unchanged}"
