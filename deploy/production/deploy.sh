#!/usr/bin/env sh
# Deploy an already-published, immutable ChartWarden image on the single-VPS Compose topology.
#
# The workflow uploads this file on each release, then invokes it as:
#   ./deploy.sh ghcr.io/owner/chartwarden:sha-<sha> ghcr.io/owner/chartwarden-web:sha-<sha> \
#               ghcr.io/owner/chartwarden-docling-worker:sha-<sha>
#
# Releases published before the infra rename used the image names wardenx / wardenx-web /
# wardenx-docling-worker. Both spellings are accepted so a rollback to such a release still works.
#
# The third argument (the DocLens docling-worker image, GAP-138) is optional so a rollback or a hand
# deploy of an older release that predates the image still works; without it the already-configured
# CHARTWARDEN_DOCLING_IMAGE (if any) is left alone.
#
# The optional 4th argument is the Rust API image (CW-RUST-M02, built and signed in the chartwarden-rust repository):
#   ./deploy.sh <backend> <web> '' ghcr.io/owner/chartwarden-rust:sha-<sha>     (pass '' to skip docling-worker)
# It is verified with cosign against that repository's own workflow identity, and ONLY that image is: neither
# identity is ever accepted for the other's images. Only the verified digest is written to CHARTWARDEN_RUST_IMAGE; this
# script never pulls or starts the `rust` compose service. It is never rolled unverified (the opt-out below does not apply).
#
# It deliberately never accepts `latest`: a deploy must always be attributable to one commit and
# a rollback must always name an already-published immutable image.
set -eu

if [ "$#" -lt 2 ] || [ "$#" -gt 4 ]; then
  echo "usage: $0 <backend-image-sha-tag> <web-image-sha-tag> [<docling-worker-image-sha-tag> [<rust-image-sha-tag>]]" >&2
  exit 64
fi

backend_image=$1
web_image=$2
docling_image=${3:-}
rust_image=${4:-}
case "$backend_image" in
  ghcr.io/[!/]*/chartwarden:sha-*|ghcr.io/[!/]*/wardenx:sha-*) ;;
  *) echo "refusing non-immutable backend image: $backend_image" >&2; exit 64 ;;
esac
case "$web_image" in
  ghcr.io/[!/]*/chartwarden-web:sha-*|ghcr.io/[!/]*/wardenx-web:sha-*) ;;
  *) echo "refusing non-immutable web image: $web_image" >&2; exit 64 ;;
esac

case "$docling_image" in
  ''|ghcr.io/[!/]*/chartwarden-docling-worker:sha-*|ghcr.io/[!/]*/wardenx-docling-worker:sha-*) ;;
  *) echo "refusing non-immutable docling-worker image: $docling_image" >&2; exit 64 ;;
esac
case "$rust_image" in
  ''|ghcr.io/[!/]*/chartwarden-rust:sha-*) ;;
  *) echo "refusing non-immutable rust image: $rust_image" >&2; exit 64 ;;
esac

# Defaults to the directory this script was uploaded to (the workflow's DEPLOY_DIR, /opt/chartwarden unless overridden).
# Override with CHARTWARDEN_DEPLOY_DIR.
deploy_dir=${CHARTWARDEN_DEPLOY_DIR:-$(cd "$(dirname "$0")" && pwd)}
cd "$deploy_dir" || { echo "PREFLIGHT FAILED: deploy dir $deploy_dir does not exist" >&2; exit 67; }

if [ ! -f .env.production ] || [ ! -f compose.yml ]; then
  echo "expected .env.production and compose.yml in $deploy_dir" >&2
  exit 66
fi

# ── DEPLOY ALERT (#866): optional, best effort, never decides the deploy's outcome ──────────────────────────────
# DEPLOY_ALERT_WEBHOOK_URL (environment, else $deploy_dir/.deploy-alert.env, mode 0600) is a SECRET and is never printed
# or put on a command line. It is deliberately NOT read from .env.production: compose.yml injects that whole file into
# the api, worker, web and migrate containers, which have no business holding it. When set, any non-zero exit from here on POSTs a small JSON document: commit SHA, failing step, exit code and
# applied migration filenames (validated ledger names only). Nothing else, so no PHI and no secrets can ride along.
# Exit 75 is named "operator decision required". Unset = no-op. A failed or slow delivery is logged and swallowed.
deploy_step=preflight
# Exit status of a deploy that stopped for an operator decision (EX_TEMPFAIL), distinct from a plain failure.
HOLD_EXIT=75
alert_url=${DEPLOY_ALERT_WEBHOOK_URL:-}
alert_file=$deploy_dir/.deploy-alert.env
if [ -z "$alert_url" ] && [ -f "$alert_file" ]; then
  alert_url=$(sed -n 's/^DEPLOY_ALERT_WEBHOOK_URL=//p' "$alert_file" | tail -n 1 | tr -d '\r' | sed -e 's/^"\([^"]*\)".*$/\1/' -e "s/^'\([^']*\)'.*\$/\1/" -e 's/[[:space:]]\{1,\}#.*$//' -e 's/[[:space:]]*$//')
fi

deploy_alert() {
  alert_rc=$1
  [ "$alert_rc" -ne 0 ] || return 0
  [ -n "$alert_url" ] || return 0
  case "$alert_url" in
    *[\"\\[:space:]]*) echo "deploy alert skipped: DEPLOY_ALERT_WEBHOOK_URL contains characters that are not allowed" >&2; return 0 ;;
    https://?*) ;;
    *) echo "deploy alert skipped: DEPLOY_ALERT_WEBHOOK_URL must be an https:// URL" >&2; return 0 ;;
  esac
  command -v curl >/dev/null 2>&1 || { echo "deploy alert skipped: curl is not installed" >&2; return 0; }
  alert_sha=$(printf '%s' "${backend_image##*:sha-}" | tr -cd 'a-zA-Z0-9' | cut -c1-64)
  alert_files=""
  if [ -n "${schema_applied:-}" ]; then
    alert_files=$(printf '%s\n' "$schema_applied" | grep -E '^[0-9]{4}_[a-z0-9_.]+\.sql$' | sed 's/.*/"&"/' | paste -sd, - || true)
  fi
  if [ "$alert_rc" -eq "$HOLD_EXIT" ] && [ -n "${held_before_schema_change:-}" ]; then
    alert_what="HELD before any schema change (exit $alert_rc): nothing applied, previous release untouched, a pending migration needs an operator"
  elif [ "$alert_rc" -eq "$HOLD_EXIT" ]; then
    alert_what="operator decision required (exit $alert_rc), automatic rollback refused"
  else
    alert_what="failed (exit $alert_rc)"
  fi
  alert_body=$(mktemp) || return 0
  printf '{"text":"ChartWarden deploy %s at step %s, sha %s","sha":"%s","step":"%s","exit_code":%s,"operator_decision_required":%s,"applied_migrations":[%s]}\n' \
    "$alert_what" "$deploy_step" "$alert_sha" "$alert_sha" "$deploy_step" "$alert_rc" \
    "$([ "$alert_rc" -eq "$HOLD_EXIT" ] && echo true || echo false)" "$alert_files" >"$alert_body"
  # The URL goes to curl on stdin (-K -), not argv, so it never shows in `ps`; curl's own output is discarded.
  if printf 'url = "%s"\n' "$alert_url" \
    | curl -sS -K - --connect-timeout 5 --max-time 10 -X POST -H 'Content-Type: application/json' \
        --data-binary "@$alert_body" >/dev/null 2>&1; then
    echo "deploy alert sent (exit $alert_rc, step $deploy_step)" >&2
  else
    echo "deploy alert delivery FAILED (exit $alert_rc, step $deploy_step); the deploy result is unchanged" >&2
  fi
  rm -f "$alert_body"
  return 0
}
# A killed deploy (ssh dropped, runner cancelled) still alerts: the signal trap turns the signal into an exit, which
# runs the EXIT trap below with the conventional 128+N status. This composes with the exit-75 hold path, which exits
# normally and never hits these.
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
# A dropped ssh session turns the next write to stdout into SIGPIPE, which would kill sh without any trap.
trap 'exit 141' PIPE
trap 'deploy_alert "$?"' EXIT

# The Postgres database name (compose.yml: ${CHARTWARDEN_DB_NAME:-chartwarden}). It is interpolated into
# connection URLs and psql/pg_dump arguments, so fail fast unless it is a plain lower-case identifier.
# An exported variable wins over .env.production, exactly as it does for compose interpolation.
db_name=${CHARTWARDEN_DB_NAME:-$(sed -n 's/^CHARTWARDEN_DB_NAME=//p' .env.production | tail -n 1 | tr -d '\r' | sed -e 's/^"\([^"]*\)".*$/\1/' -e "s/^'\([^']*\)'.*\$/\1/" -e 's/[[:space:]]\{1,\}#.*$//' -e 's/[[:space:]]*$//')}
db_name=${db_name:-chartwarden}
case "$db_name" in
  '' | [!a-z_]* | *[!a-z0-9_]*)
    echo "CHARTWARDEN_DB_NAME must match ^[a-z_][a-z0-9_]*\$ (got: $db_name)" >&2
    exit 64
    ;;
esac

# ── PREFLIGHT: read-only, fails closed (exit 67) before anything below writes or restarts anything. The same file is
# piped over SSH by the workflows before they upload; running it here covers manual deploys and rollbacks.
[ -f "$deploy_dir/preflight.sh" ] || { echo "PREFLIGHT FAILED: $deploy_dir/preflight.sh is missing" >&2; exit 67; }
(cd "$deploy_dir" && sh ./preflight.sh) || exit 67

# GAP-138/139 — secrets the release needs but an older `.env.production` predates. Generated ONCE and
# appended BEFORE the rollback backup is taken, so the backup (and therefore a rollback, which runs the
# new compose.yml against the restored env file) interpolates cleanly. Existing values are never touched.
append_env() {
  [ -z "$(tail -c 1 .env.production)" ] || echo >> .env.production   # file may lack a final newline
  printf '%s=%s\n' "$1" "$2" >> .env.production
}
ensure_secret() {
  if ! grep -q "^$1=" .env.production; then
    append_env "$1" "$2"
    echo "generated $1 in .env.production"
  fi
}
# ── object-store credentials ────────────────────────────────────────────────────────────────────────────────────────
# compose.yml reads the canonical names (SEAWEEDFS_* provisioning credentials, OBJECT_STORE_AUDIT_WEBHOOK_TOKEN). A host
# whose `.env.production` predates one gets it generated ONCE, before the rollback backup below is taken, so the backup
# (and any rollback) interpolates cleanly. An existing value is never touched and no value is ever printed: output names
# the variables only. The retired MINIO_* aliases of the SeaweedFS compatibility release are neither read nor written
# any more; a host that still has those lines keeps booting (they are unused).
env_has() { grep -q "^$1=" .env.production; }
# The value a name gets when it does not exist yet. The two access keys are account names, not secrets (they must differ:
# scripts/storage/seaweedfs-identities.ts); every other value is a fresh random secret.
object_store_fresh_value() {
  case "$1" in
    SEAWEEDFS_ADMIN_ACCESS_KEY) echo "chartwarden-seaweedfs-admin" ;;
    SEAWEEDFS_APP_ACCESS_KEY) echo "chartwarden-app" ;;
    SEAWEEDFS_APP_SECRET_KEY) openssl rand -hex 24 ;;
    *) openssl rand -hex 32 ;;
  esac
}
deploy_step=object-store-env
for object_store_name in SEAWEEDFS_ADMIN_ACCESS_KEY SEAWEEDFS_ADMIN_SECRET_KEY SEAWEEDFS_APP_ACCESS_KEY SEAWEEDFS_APP_SECRET_KEY OBJECT_STORE_AUDIT_WEBHOOK_TOKEN; do
  if ! env_has "$object_store_name"; then
    fresh_value=$(object_store_fresh_value "$object_store_name")
    [ -n "$fresh_value" ] || { echo "could not generate a value for $object_store_name" >&2; exit 1; }
    append_env "$object_store_name" "$fresh_value"
    echo "generated $object_store_name in .env.production"
  fi
done
unset fresh_value
# The docling-worker bearer (backend -> worker); it holds no object-store credentials.
ensure_secret DOCLING_WORKER_TOKEN "$(openssl rand -hex 32)"

# ── backup overlay names: BACKUP_SOURCE_MINIO_* -> BACKUP_SOURCE_OBJECT_STORE_* (host migration) ───────────────────────
# The read-only source key the backup overlay (compose.backup.yml) hands to the object-store provisioner and to the backup
# sidecar was named after MinIO. compose.backup.yml now reads the variable BACKUP_SOURCE_OBJECT_STORE_ACCESS_KEY and the
# Docker secret file secrets/backup_source_object_store_secret_key, but a live host still holds the OLD names. This step is
# additive and idempotent, and runs before anything is started or backed up, so the rollback backup below carries the new
# variable too:
#   secret file: the new one is missing and the old one exists -> copied atomically (cp -p to a temp name, then mv: same
#                mode and owner, and a copy that dies half way never leaves a partial file under the real name)
#   variable:    the new one is unset or empty and the old one has a value -> appended with that exact raw value (the last
#                line wins, as it does for compose)
# An existing new value or file is never changed, output names the variables and files only (never a value), and the old
# variable and file stay in place, unused, until an operator deletes them. A host with neither old name, or one that has
# migrated already, is left alone; an old name still present never fails a deploy.
# Fail closed BEFORE the backup-name migration touches .env.production: when the overlay is configured (compose.backup.yml
# present and either variable set) the new secret file must exist once the copy is done. A secrets/ directory this user
# cannot enter makes the old file invisible (`[ -f ]` is false on EACCES), so the copy is skipped; without this check the
# variable would still migrate, the overlay would be enabled and provisioning would die later on a missing bind-mount
# file, on every re-run.
env_raw() { sed -n "s/^$1=//p" .env.production | tail -n 1; }
backup_secret_old=secrets/backup_source_minio_secret_key
backup_secret_new=secrets/backup_source_object_store_secret_key
backup_names_hint() {
  echo "Copy it by hand: cp -p $deploy_dir/$backup_secret_old $deploy_dir/$backup_secret_new (same mode and owner, as a user that can enter secrets/), then re-run." >&2
  echo "No service was touched, no migration was applied and the backup-name migration did not change .env.production." >&2
}
deploy_step=backup-names
backup_overlay_configured=0
if [ -f compose.backup.yml ] && { [ -n "$(env_raw BACKUP_SOURCE_OBJECT_STORE_ACCESS_KEY)" ] || [ -n "$(env_raw BACKUP_SOURCE_MINIO_ACCESS_KEY)" ]; }; then
  backup_overlay_configured=1
fi
if [ ! -e "$backup_secret_new" ] && [ -f "$backup_secret_old" ]; then
  backup_secret_tmp=$backup_secret_new.tmp.$$
  if cp -p "$backup_secret_old" "$backup_secret_tmp" && mv "$backup_secret_tmp" "$backup_secret_new"; then
    echo "copied $backup_secret_old to $backup_secret_new"
  else
    rm -f "$backup_secret_tmp"
    echo "could not copy $deploy_dir/$backup_secret_old to $backup_secret_new (check that this user can read it and write secrets/)." >&2
    backup_names_hint
    exit 1
  fi
fi
if [ "$backup_overlay_configured" -eq 1 ] && [ ! -e "$backup_secret_new" ]; then
  if [ -d secrets ] && [ ! -x secrets ]; then
    echo "$deploy_dir/secrets is not accessible to this user, so $backup_secret_new cannot be confirmed to exist (the backup overlay is configured)." >&2
    echo "A hand copy alone does not clear this: this user also needs search (x) permission on the directory, for example: sudo setfacl -m u:$(id -un):x $deploy_dir/secrets (names become visible, contents stay protected by the files' own mode)." >&2
    echo "Without setfacl (the acl package), sudo chmod o+x $deploy_dir/secrets does the same but opens search to every local user. If this user cannot read $deploy_dir/$backup_secret_old either, copy it by hand as root too." >&2
  else
    echo "the backup overlay is configured but $deploy_dir/$backup_secret_new does not exist (and there is no old file to copy)." >&2
  fi
  backup_names_hint
  exit 1
fi
if [ -z "$(env_raw BACKUP_SOURCE_OBJECT_STORE_ACCESS_KEY)" ] && [ -n "$(env_raw BACKUP_SOURCE_MINIO_ACCESS_KEY)" ]; then
  append_env BACKUP_SOURCE_OBJECT_STORE_ACCESS_KEY "$(env_raw BACKUP_SOURCE_MINIO_ACCESS_KEY)"
  echo "copied BACKUP_SOURCE_MINIO_ACCESS_KEY to BACKUP_SOURCE_OBJECT_STORE_ACCESS_KEY in .env.production"
fi

# The least-privilege destruction login (tenant erase, attachment reaper). compose.yml requires it and the
# `migrate` one-shot provisions the role with it, so a server whose env file predates it gets one generated.
ensure_secret CHARTWARDEN_DESTRUCTION_PASSWORD "$(openssl rand -hex 24)"

backup_file=$(mktemp .env.production.before-deploy.XXXXXX)
next_file=$(mktemp .env.production.next.XXXXXX)
cp .env.production "$backup_file"
chmod 600 "$backup_file" "$next_file"

cleanup() {
  rm -f "$next_file" "$backup_file"
  [ -z "${ledger_before:-}" ] || rm -f "$ledger_before" "$ledger_before.after"
}
# shellcheck disable=SC2154 # alert_exit is assigned inside the trap string itself
trap 'alert_exit=$?; trap "" PIPE HUP INT TERM; cleanup || :; deploy_alert "$alert_exit"; exit "$alert_exit"' EXIT

awk -v backend="$backend_image" -v web="$web_image" -v docling="$docling_image" '
  BEGIN { saw_backend = 0; saw_web = 0; saw_docling = 0 }
  /^CHARTWARDEN_IMAGE=/ { print "CHARTWARDEN_IMAGE=" backend; saw_backend = 1; next }
  /^CHARTWARDEN_WEB_IMAGE=/ { print "CHARTWARDEN_WEB_IMAGE=" web; saw_web = 1; next }
  /^CHARTWARDEN_DOCLING_IMAGE=/ { if (docling != "") { print "CHARTWARDEN_DOCLING_IMAGE=" docling } else { print }; saw_docling = 1; next }
  { print }
  END {
    if (!saw_backend || !saw_web) exit 1
    if (!saw_docling && docling != "") print "CHARTWARDEN_DOCLING_IMAGE=" docling
  }
' .env.production >"$next_file" || {
  echo "could not update immutable image references in .env.production" >&2
  exit 65
}

# #861 — what this deploy did to the schema decides what a failure may restart. Set after the migrate step from
# the runner's ledger (`_chartwarden_migration`), read before and after, never from log parsing:
#
#   none    — no migration applied: the previous image ran on this exact schema minutes ago; restore it.
#   expand  — every applied migration declares `-- compat: expand` and passes the arch:migration-compat
#             heuristic (classified by the NEW image, which holds the files): the previous image stays valid.
#   unsafe  — anything else (a `contract` or undeclared migration, or the ledger/classifier could not be read):
#             the previous image is NOT restarted. See hold_for_operator.
schema_verdict=none
schema_applied=""
# Containers are only recreated after the migrate step succeeds, so a failure before that leaves the previous,
# healthy ones running. Recreating them then would start them from the NEW compose.yml (which names the
# chartwarden_* database roles, migration 1139) against a schema that may not have been renamed yet.
migrate_ok=0
psql_admin() {
  docker compose --env-file .env.production -f compose.yml exec -T postgres \
    psql -U postgres -d "$db_name" -v ON_ERROR_STOP=1 -At "$@" </dev/null
}

# Prints the applied-migration filenames, sorted; nothing for a database with no ledger yet. Non-zero = unknown.
ledger_snapshot() {
  ledger_exists=$(psql_admin -c "SELECT to_regclass('_chartwarden_migration') IS NOT NULL") || return 1
  case "$ledger_exists" in
    t) ;;
    f) return 0 ;;
    *) return 1 ;;
  esac
  ledger_rows=$(psql_admin -c "SELECT filename FROM _chartwarden_migration") || return 1
  [ -z "$ledger_rows" ] || printf '%s\n' "$ledger_rows" | LC_ALL=C sort
}

# Sets schema_verdict / schema_applied from the ledger snapshot taken before migrating ($1) and the ledger now.
assess_schema_change() {
  if ! ledger_snapshot >"$1.after"; then
    echo "could not read the migration ledger after migrating; treating the schema as unverified" >&2
    schema_verdict=unsafe; return 0
  fi
  # A bare failing assignment would end the script under `set -e` with neither a restore nor a hold.
  schema_applied=$(LC_ALL=C comm -13 "$1" "$1.after") || { schema_verdict=unsafe; return 0; }
  if [ -z "$schema_applied" ]; then schema_verdict=none; return 0; fi
  echo "this deploy applied: $(printf '%s' "$schema_applied" | tr '\n' ' ')"
  for f in $schema_applied; do
    case "$f" in
      *[!a-z0-9_.]*) schema_verdict=unsafe; return 0 ;;
      [0-9][0-9][0-9][0-9]_*.sql) ;;
      *) schema_verdict=unsafe; return 0 ;;
    esac
  done
  # shellcheck disable=SC2086 # filenames validated above, one argument each
  if docker compose --env-file .env.production -f compose.yml run --rm --no-deps migrate \
    bun run scripts/check-migration-compat.ts --classify $schema_applied; then
    schema_verdict="expand"
  else
    schema_verdict=unsafe
  fi
}

# The unsafe case. Neither image is verified against this schema, so this path (re)starts nothing: the previous
# release is not brought back and the new one is not forced up. Whatever is running stays running. For an EHR a
# clinician reading a chart through a partly working app beats every container stopped, and there is no maintenance
# page to put in front of a stopped stack (#865). .env.production keeps the NEW release, the only code
# written for this schema, so a later `up` does not quietly start the old one; the previous file is kept beside it
# for an operator who has verified that rolling back is safe.
hold_for_operator() {
  cp "$backup_file" .env.production.previous-release
  chmod 600 .env.production.previous-release
  {
    echo ""
    echo "!! DEPLOY HALTED FOR AN OPERATOR DECISION: AUTOMATIC ROLLBACK REFUSED (#861)"
    echo "!! The deploy failed after changing the schema, and the change is not proven expand-compatible:"
    if [ -n "$schema_applied" ]; then
      printf '%s\n' "$schema_applied" | sed 's/^/!!     /'
    else
      echo "!!     (the migration ledger could not be read, so what was applied is unknown)"
    fi
    echo "!! The previous release was NOT restarted and no container was recreated by this failure path. Whatever"
    echo "!! was running is still running: the previous api/worker/web if the failure came at or before 'provision',"
    echo "!! the new ones if it came at 'up' or smoke. .env.production names the NEW release; the previous one is"
    echo "!! saved as $deploy_dir/.env.production.previous-release."
    echo "!! Decide, then act (deploy/production/README.md, 'When a deploy halts for an operator decision'):"
    echo "!!   roll forward: fix the cause and re-run deploy.sh with the new (or a fixed) release; migrate is idempotent"
    echo "!!   roll back:    ONLY after confirming the previous code works on this schema:"
    echo "!!     cp .env.production.previous-release .env.production"
    echo "!!     docker compose --env-file .env.production -f compose.yml up -d --no-deps --force-recreate api worker web"
    echo ""
  } >&2
  exit "$HOLD_EXIT"
}

restore_previous_release() {
  if [ "$schema_verdict" = unsafe ]; then
    hold_for_operator
  fi
  echo "deploy failed; restoring the previous image references" >&2
  cp "$backup_file" .env.production
  if [ "$migrate_ok" -eq 1 ]; then
    docker compose --env-file .env.production -f compose.yml up -d --no-deps --force-recreate api worker web || true
  else
    echo "migrations did not complete; leaving the running containers untouched" >&2
  fi
  if [ "$schema_verdict" = expand ]; then
    echo "rollback is expand-safe: every migration this deploy applied declares 'compat: expand' and passed" >&2
    echo "the contracting-DDL check, so the previous release stays valid on the new schema." >&2
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
# The certificate identity embeds `<owner>/<repo>`. The default is the CURRENT repository's identity ONLY. Accepting a second
# one (the GitHub rename, INFRA_RENAME_RUNBOOK.md Step B) is an explicit, time-boxed opt-in: set CHARTWARDEN_COSIGN_IDENTITY
# (space-separated for several) in the environment or in .env.production, and remove it again afterwards. Never leave an old
# or future repository name listed: whoever could recreate that repository could then sign images this host accepts.
cosign_identities=${CHARTWARDEN_COSIGN_IDENTITY:-$(sed -n 's/^CHARTWARDEN_COSIGN_IDENTITY=//p' .env.production | tail -n 1 | tr -d '\r' | sed -e 's/^"\([^"]*\)".*$/\1/' -e "s/^'\([^']*\)'.*\$/\1/" -e 's/[[:space:]]\{1,\}#.*$//' -e 's/[[:space:]]*$//')}
cosign_identities=${cosign_identities:-https://github.com/Engrace-Hospice/chartwarden/.github/workflows/deploy.yml@refs/heads/main}
cosign_issuer=${CHARTWARDEN_COSIGN_ISSUER:-https://token.actions.githubusercontent.com}
# The Rust image is built and signed by the chartwarden-rust repository's image workflow, so it is verified against THAT
# identity and no other; it is a fixed value on purpose (no override), and the lists above never apply to it.
rust_cosign_identity=https://github.com/Engrace-Hospice/chartwarden-rust/.github/workflows/rust-image.yml@refs/heads/main

# `https://github.com/<owner>/<repo>/.github/...` -> `<owner>/<repo>`, so the certificate's repository claim is checked as well.
identity_repo() { r=${1#https://github.com/}; printf '%s\n' "${r%%/.github/*}"; }

# Prints the verified digest on success; anything else (empty output) is a failure the caller must treat as fatal.
# $2 is the space-separated list of identities acceptable for this image (default: this repository's own).
verify_image_digest() {
  for identity in ${2:-$cosign_identities}; do
    digest=$(cosign verify "$1" \
      --certificate-identity "$identity" \
      --certificate-github-workflow-repository "$(identity_repo "$identity")" \
      --certificate-oidc-issuer "$cosign_issuer" \
      --output json 2>/dev/null \
      | sed -n 's/.*"docker-manifest-digest":"\(sha256:[a-f0-9]\{64\}\)".*/\1/p' \
      | head -1)
    case "$digest" in
      sha256:*) printf '%s\n' "$digest"; return 0 ;;
    esac
  done
  return 0
}

deploy_step=verify-signatures
backend_ref=$backend_image
web_ref=$web_image
docling_ref=$docling_image
rust_ref=

if [ "${CHARTWARDEN_DEPLOY_ALLOW_UNVERIFIED:-}" = "1" ]; then
  # A named opt-out, not a fallback. It exists so a first deploy predating the signing workflow can
  # still land, and it is printed on every deploy that uses it — an unverified deploy must never be
  # indistinguishable from a verified one in the log.
  echo "!! CHARTWARDEN_DEPLOY_ALLOW_UNVERIFIED=1 — image signatures were NOT checked for this deploy." >&2
  echo "!! Nothing establishes that these images are the ones CI built." >&2
  [ -z "$rust_image" ] || {
    echo "refusing to roll the Rust image without verifying its signature (CHARTWARDEN_DEPLOY_ALLOW_UNVERIFIED does not apply to it)" >&2
    restore_previous_release
    exit 1
  }
elif ! command -v cosign >/dev/null 2>&1; then
  echo "cosign is not installed on this host, so image signatures cannot be verified." >&2
  echo "Install it (see deploy/production/README.md) or set CHARTWARDEN_DEPLOY_ALLOW_UNVERIFIED=1." >&2
  restore_previous_release
  exit 1
else
  backend_digest=$(verify_image_digest "$backend_image")
  case "$backend_digest" in
    sha256:*) ;;
    *) echo "signature verification FAILED for $backend_image" >&2
       echo "expected identity (any of): $cosign_identities" >&2
       restore_previous_release; exit 1 ;;
  esac
  web_digest=$(verify_image_digest "$web_image")
  case "$web_digest" in
    sha256:*) ;;
    *) echo "signature verification FAILED for $web_image" >&2
       echo "expected identity (any of): $cosign_identities" >&2
       restore_previous_release; exit 1 ;;
  esac

  if [ -n "$docling_image" ]; then
    docling_digest=$(verify_image_digest "$docling_image")
    case "$docling_digest" in
      sha256:*) ;;
      *) echo "signature verification FAILED for $docling_image" >&2
         echo "expected identity (any of): $cosign_identities" >&2
         restore_previous_release; exit 1 ;;
    esac
    docling_ref="${docling_image%%:sha-*}@${docling_digest}"
    echo "verified $docling_image -> $docling_digest"
  fi

  if [ -n "$rust_image" ]; then
    rust_digest=$(verify_image_digest "$rust_image" "$rust_cosign_identity")
    case "$rust_digest" in
      sha256:*) ;;
      *) echo "signature verification FAILED for $rust_image" >&2
         echo "expected identity: $rust_cosign_identity" >&2
         restore_previous_release; exit 1 ;;
    esac
    rust_ref="${rust_image%%:sha-*}@${rust_digest}"
    echo "verified $rust_image -> $rust_digest"
  fi

  # Pin to the digest cosign actually verified. `${image%%:*}` strips the `:sha-<commit>` tag, leaving
  # the repository, so the pull can only resolve to the verified artefact.
  backend_ref="${backend_image%%:sha-*}@${backend_digest}"
  web_ref="${web_image%%:sha-*}@${web_digest}"
  echo "verified $backend_image -> $backend_digest"
  echo "verified $web_image -> $web_digest"

  # Rewrite the staged file with the digest-pinned references before it becomes live.
  awk -v backend="$backend_ref" -v web="$web_ref" -v docling="$docling_ref" '
    /^CHARTWARDEN_IMAGE=/ { print "CHARTWARDEN_IMAGE=" backend; next }
    /^CHARTWARDEN_WEB_IMAGE=/ { print "CHARTWARDEN_WEB_IMAGE=" web; next }
    /^CHARTWARDEN_DOCLING_IMAGE=/ { if (docling != "") { print "CHARTWARDEN_DOCLING_IMAGE=" docling } else { print }; next }
    { print }
  ' "$next_file" >"$next_file.pinned" && mv "$next_file.pinned" "$next_file"
  chmod 600 "$next_file"

  # The Rust image: replace in place or append, and only ever by the digest cosign verified. Nothing here pulls or starts it.
  if [ -n "$rust_ref" ]; then
    awk -v rust="$rust_ref" '
      /^CHARTWARDEN_RUST_IMAGE=/ { if (!seen) print "CHARTWARDEN_RUST_IMAGE=" rust; seen = 1; next }
      { print }
      END { if (!seen) print "CHARTWARDEN_RUST_IMAGE=" rust }
    ' "$next_file" >"$next_file.pinned" && mv "$next_file.pinned" "$next_file"
    chmod 600 "$next_file"
  fi
fi

# Make the new release configuration visible only after its image references have been validated.
mv "$next_file" .env.production

deploy_step=pull
docker compose --env-file .env.production -f compose.yml pull migrate provision api worker web docling-worker || {
  restore_previous_release
  exit 1
}

# A release can add a fail-closed production setting. Validate that contract in the NEW image before
# touching the schema or recreating a live service: otherwise a missing secret presents only as two
# crash-looping API/worker containers after an otherwise successful migration. This import is pure
# environment validation — it opens no database, Redis, or storage connection — and its error names
# variable keys and rules, never their values.
deploy_step=env-validation
if ! docker compose --env-file .env.production -f compose.yml run --rm --no-deps api \
  bun -e 'import { assertProductionEnv } from "./apps/backend/src/bootstrap/env.ts"; assertProductionEnv(); console.log("production environment contract validated");'; then
  echo "new release environment validation failed; no migrations were applied and no new release service was started" >&2
  restore_previous_release
  exit 1
fi

# ── object store (SeaweedFS) ─────────────────────────────────────────────────────────────────────────
#
# `up --no-deps` below never starts dependency services. Render SeaweedFS's identities (s3.json) before the new
# api/worker credentials are used (including secret rotations), and recreate seaweedfs when they changed: it reads
# the file at start only. The backup overlay's read-only key is included when the overlay is configured, or the
# next deploy would drop the backup sidecar's access.
deploy_step=object-store
object_store_backup_enabled=0
if [ -f compose.backup.yml ] && grep -q '^BACKUP_SOURCE_OBJECT_STORE_ACCESS_KEY=.' .env.production; then
  object_store_backup_enabled=1
fi
for f in object-store/audit.json object-store/fluent-bit.yaml; do
  [ -f "$f" ] || { echo "missing $deploy_dir/$f (deploy.yml uploads it); nothing was changed" >&2; restore_previous_release; exit 1; }
done
provision_object_store() {
  if [ "$object_store_backup_enabled" -eq 1 ]; then
    docker compose --env-file .env.production -f compose.yml -f compose.backup.yml run --rm object-store-provision
  else
    docker compose --env-file .env.production -f compose.yml run --rm object-store-provision
  fi
}
if ! provision_out=$(provision_object_store); then
  echo "object-store identity provisioning failed; no migrations were applied" >&2
  restore_previous_release
  exit 1
fi
echo "$provision_out"
# audit.json and fluent-bit.yaml are bind mounts, and s3.json is read at start: `up` alone applies none of them, so
# recreate both containers when any changed (same pattern as clamd.conf below).
object_store_conf_hash=$( { cat object-store/audit.json object-store/fluent-bit.yaml | { sha256sum 2>/dev/null || shasum -a 256; }; } | awk '{print $1}')
object_store_recreate=""
case "$provision_out" in *"s3.json changed"*) object_store_recreate="--force-recreate" ;; esac
[ "$object_store_conf_hash" = "$(cat .object-store-conf.sha256 2>/dev/null || true)" ] || object_store_recreate="--force-recreate"
docker compose --env-file .env.production -f compose.yml up -d --no-deps $object_store_recreate --wait seaweedfs || {
  echo "SeaweedFS did not become healthy; no migrations were applied" >&2
  restore_previous_release
  exit 1
}
# The audit sink (GAP-141, download confirmation for signed URLs). The new api serves ONLY the canonical audit path (the
# former /api/v1/webhooks/minio/access-log answers 404), so a fluent-bit that keeps posting to the old path would silently
# lose every confirmation (the records are dropped after retry_limit) once the api is swapped. This used to be best-effort;
# it is not any more: fluent-bit must start AND the running container must carry the canonical AUDIT_SINK_PATH (compose.yml),
# or the deploy stops here, before any migration, with the previous release untouched.
object_store_audit_path=/api/v1/webhooks/object-store/access-log
if ! docker compose --env-file .env.production -f compose.yml up -d --no-deps $object_store_recreate fluent-bit; then
  echo "fluent-bit did not start; the new api serves only $object_store_audit_path, so signed-URL download confirmations would be lost. No migrations were applied and the previous release is untouched." >&2
  restore_previous_release
  exit 1
fi
fluent_bit_id=$(docker compose --env-file .env.production -f compose.yml ps -q fluent-bit </dev/null) || fluent_bit_id=""
fluent_bit_env=""
if [ -n "$fluent_bit_id" ]; then
  fluent_bit_env=$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$fluent_bit_id" </dev/null) || fluent_bit_env=""
fi
if ! printf '%s\n' "$fluent_bit_env" | grep -qxF "AUDIT_SINK_PATH=$object_store_audit_path"; then
  echo "the running fluent-bit is not posting to $object_store_audit_path (it may still be on the removed /api/v1/webhooks/minio/access-log, or it was not found): the new api answers 404 there and every access-log record would be dropped. No migrations were applied and the previous release is untouched." >&2
  restore_previous_release
  exit 1
fi
echo "$object_store_conf_hash" > .object-store-conf.sha256

# Production migrations are forward-only and commit one file at a time. A code rollback can restore the prior
# image but cannot reverse a migration, so the ledger is read before and after, and the difference decides what
# a later failure may restart (schema_verdict). Reading it first is the last point where failing costs nothing.
deploy_step=ledger
ledger_before=$(mktemp)
# `exec` needs a running, healthy postgres; `run migrate` used to start it through depends_on. Never recreated here.
if ! { docker compose --env-file .env.production -f compose.yml up -d --no-recreate --wait postgres \
  && ledger_snapshot >"$ledger_before"; }; then
  rm -f "$ledger_before"
  echo "could not read the migration ledger (_chartwarden_migration); no migrations were applied" >&2
  restore_previous_release
  exit 1
fi
deploy_step=migrate
if docker compose --env-file .env.production -f compose.yml run --rm --no-deps migrate \
  bun run scripts/db/migrate.ts --strict --schema-only --hold-contract; then
  migrate_ok=1
  assess_schema_change "$ledger_before"
  rm -f "$ledger_before" "$ledger_before.after"
else
  migrate_rc=$?
  # A multi-file run can have committed earlier files before failing on a later one; the ledger says which.
  assess_schema_change "$ledger_before"
  rm -f "$ledger_before" "$ledger_before.after"
  # --hold-contract refuses the WHOLE batch before the first DDL when a pending migration is not a verified
  # `expand` (1508 needs its old M25 writers drained, and this script never stops them before migrating). Nothing
  # was applied, so the clean restore below leaves the running release untouched; the exit code tells the alert
  # and the operator it is a decision, not a fault.
  if [ "$migrate_rc" -eq "$HOLD_EXIT" ]; then
    {
      echo ""
      echo "!! DEPLOY HELD BEFORE ANY SCHEMA CHANGE: a pending migration is not proven expand-compatible."
      echo "!! Nothing was applied and the running release is untouched. Drain whatever the migration's header and"
      echo "!! runbook name (1508: docs/runbooks/m25-835-deployment.md), then apply it by hand with the NEW release's"
      echo "!! image (this script is about to put .env.production back on the previous one) and WITHOUT --hold-contract:"
      echo "!!   cd $deploy_dir && CHARTWARDEN_IMAGE='$backend_ref' docker compose --env-file .env.production -f compose.yml \\"
      echo "!!     run --rm --no-deps migrate bun run scripts/db/migrate.ts --strict --schema-only"
      echo "!! then re-run this deploy."
      echo ""
    } >&2
    held_before_schema_change=1
    restore_previous_release
    exit "$HOLD_EXIT"
  fi
  restore_previous_release
  exit 1
fi
deploy_step=provision
docker compose --env-file .env.production -f compose.yml run --rm --no-deps provision || {
  restore_previous_release
  exit 1
}
# M36 WP 1.5 — keep the ClamAV sidecar up WITHOUT recreating it (no scan gap, signature DB kept). Not fatal: a scanner
# that is down leaves attachments `pending` (nothing delivered), so it must not roll back an otherwise good release.
docker compose --env-file .env.production -f compose.yml up -d --no-deps clamav \
  || echo "WARNING: clamav sidecar did not start; message attachments stay pending until it does" >&2
# clamd.conf is a bind mount: `up -d --no-deps` does not recreate the container for a changed file, so a new config would
# never reach the running scanner. Restart it (only) when the file's hash differs from the one last applied.
clamd_conf_hash=$( { sha256sum clamav/clamd.conf 2>/dev/null || shasum -a 256 clamav/clamd.conf 2>/dev/null; } | awk '{print $1}')
clamd_conf_applied=$(cat .clamd.conf.sha256 2>/dev/null || true)
if [ -n "$clamd_conf_hash" ] && [ "$clamd_conf_hash" != "$clamd_conf_applied" ]; then
  if docker compose --env-file .env.production -f compose.yml restart clamav; then
    echo "$clamd_conf_hash" > .clamd.conf.sha256
  else
    echo "WARNING: clamav restart for a changed clamd.conf failed; the scanner keeps its previous config" >&2
  fi
fi
docker compose --env-file .env.production -f compose.yml run --rm --no-deps tenant-buckets \
  || echo "WARNING: tenant bucket backfill failed; uploads create a missing bucket on demand" >&2
deploy_step=up
docker compose --env-file .env.production -f compose.yml up -d --no-deps --force-recreate api worker web docling-worker || {
  restore_previous_release
  exit 1
}

# Post-deploy verification (F-038/#98). This used to be a single loop against
# `http://127.0.0.1:3000/ready` — one process answering its own readiness endpoint on loopback, which
# proved nothing about the worker, the web tier, nginx, TLS, or whether anyone can actually log in.
# `smoke.sh` runs four tiers and fails the deploy at the first one that does not hold; see its header
# for what each tier rules out.
deploy_step=smoke
if ! ./smoke.sh; then
  restore_previous_release
  exit 1
fi

rm -f "$backup_file"
echo "deployed backend=$backend_ref web=$web_ref docling=${docling_ref:-unchanged}"
[ -z "$rust_ref" ] || echo "rolled rust=$rust_ref (CHARTWARDEN_RUST_IMAGE only; the rust service is not started by this script)"
