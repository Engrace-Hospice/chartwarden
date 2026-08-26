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

  # Pin to the digest cosign actually verified. `${image%%:*}` strips the `:sha-<commit>` tag, leaving
  # the repository, so the pull can only resolve to the verified artefact.
  backend_ref="${backend_image%%:sha-*}@${backend_digest}"
  web_ref="${web_image%%:sha-*}@${web_digest}"
  echo "verified $backend_image -> $backend_digest"
  echo "verified $web_image -> $web_digest"

  # Rewrite the staged file with the digest-pinned references before it becomes live.
  awk -v backend="$backend_ref" -v web="$web_ref" '
    /^WARDENX_IMAGE=/ { print "WARDENX_IMAGE=" backend; next }
    /^WARDENX_WEB_IMAGE=/ { print "WARDENX_WEB_IMAGE=" web; next }
    { print }
  ' "$next_file" >"$next_file.pinned" && mv "$next_file.pinned" "$next_file"
  chmod 600 "$next_file"
fi

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
echo "deployed backend=$backend_ref web=$web_ref"
