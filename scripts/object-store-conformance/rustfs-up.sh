#!/usr/bin/env bash
# Start a throwaway RustFS for the conformance suite: the local/CI object store (it replaced MinIO in the dev
# stack) and the second copy of the primary store. The app key is provisioned with RustFS's `rc` admin CLI from the SAME policy `deploy/production/compose.yml` gives the app account; a policy
# that is wrong for production is wrong here too. RustFS posts its audit records straight to the suite's sink.
#
#   scripts/object-store-conformance/rustfs-up.sh                   # start (recreates)
#   eval "$(scripts/object-store-conformance/rustfs-up.sh --env)"   # the suite's env
#   bun run test:object-store:conformance:live
#   scripts/object-store-conformance/rustfs-up.sh --down
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$DIR/../.." && pwd)"
S3_PORT="${OSC_S3_PORT:-18433}"
SINK_PORT="${OSC_AUDIT_SINK_PORT:-18434}"
RUSTFS_IMAGE="${OSC_RUSTFS_IMAGE:-rustfs/rustfs:1.0.4}"
# RustFS's own admin CLI (`rc`, MinIO-mc-compatible admin commands): no MinIO image anywhere.
RC_IMAGE="${OSC_RC_IMAGE:-rustfs/rc:v0.1.37}"
ROOT_USER=conformance-admin
ROOT_PASSWORD=conformance-admin-test-secret-not-real
APP_USER=conformance-app
APP_PASSWORD=conformance-app-test-secret-not-real
READY_ATTEMPTS=60

down() { docker rm -fv cw-osc-rustfs >/dev/null 2>&1 || true; }

if [ "${1:-}" = "--down" ]; then down; exit 0; fi
if [ "${1:-}" = "--env" ]; then
  cat <<EOF
export OBJECT_STORE_ENDPOINT=http://127.0.0.1:$S3_PORT
export OBJECT_STORE_REGION=us-east-1
export OBJECT_STORE_ADMIN_ACCESS_KEY=$ROOT_USER
export OBJECT_STORE_ADMIN_SECRET_KEY=$ROOT_PASSWORD
export OBJECT_STORE_APP_ACCESS_KEY=$APP_USER
export OBJECT_STORE_APP_SECRET_KEY=$APP_PASSWORD
export OBJECT_STORE_AUDIT_SINK_PORT=$SINK_PORT
EOF
  exit 0
fi
# The same store as the resilience suite's second copy (admin key: the copy job lists and writes every bucket).
if [ "${1:-}" = "--backup-env" ]; then
  cat <<EOF
export BACKUP_STORE_ENDPOINT=http://127.0.0.1:$S3_PORT
export BACKUP_STORE_ACCESS_KEY=$ROOT_USER
export BACKUP_STORE_SECRET_KEY=$ROOT_PASSWORD
export BACKUP_STORE_CONTAINER=cw-osc-rustfs
EOF
  exit 0
fi

# The production app policy, verbatim: the heredoc between <<'POLICY' and POLICY in compose.yml.
POLICY_FILE="$(mktemp)"
trap 'rm -f "$POLICY_FILE"' EXIT
awk "/<<'POLICY'/{on=1;next} /^ *POLICY\$/{on=0} on" "$REPO/deploy/production/compose.yml" > "$POLICY_FILE"
[ -s "$POLICY_FILE" ] || { echo "app policy not found in deploy/production/compose.yml" >&2; exit 1; }
# RustFS names the lifecycle actions s3:Get/PutBucketLifecycle; AWS and MinIO use s3:Get/PutLifecycleConfiguration,
# and RustFS rejects a policy carrying the AWS names. Translate only those two.
sed -i.orig -e 's/s3:GetLifecycleConfiguration/s3:GetBucketLifecycle/' -e 's/s3:PutLifecycleConfiguration/s3:PutBucketLifecycle/' \
  "$POLICY_FILE" && rm -f "$POLICY_FILE.orig"
# mktemp is 0600 and the rc image runs as uid 100: on a Linux bind mount it could not read it. Not a secret.
chmod 0644 "$POLICY_FILE"

down
SINK="http://host.docker.internal:$SINK_PORT"
docker run -d --name cw-osc-rustfs -p "127.0.0.1:$S3_PORT:9000" --add-host=host.docker.internal:host-gateway \
  -e RUSTFS_ACCESS_KEY="$ROOT_USER" -e RUSTFS_SECRET_KEY="$ROOT_PASSWORD" -e RUSTFS_VOLUMES=/data \
  -e RUSTFS_CONSOLE_ENABLE=false -e RUSTFS_AUDIT_ENABLE=true \
  -e RUSTFS_AUDIT_WEBHOOK_ENABLE_PRIMARY=on -e RUSTFS_AUDIT_WEBHOOK_ENDPOINT_PRIMARY="$SINK/audit" \
  -e RUSTFS_OUTBOUND_ALLOW_ORIGINS="$SINK" \
  "$RUSTFS_IMAGE" >/dev/null

for _ in $(seq "$READY_ATTEMPTS"); do
  curl -sf -o /dev/null "http://127.0.0.1:$S3_PORT/health/ready" && break
  sleep 1
done
curl -sf -o /dev/null "http://127.0.0.1:$S3_PORT/health/ready" ||
  { echo "RustFS did not become ready" >&2; docker logs cw-osc-rustfs >&2 || true; exit 1; }

docker run --rm --network host -v "$POLICY_FILE:/tmp/app-policy.json:ro" --entrypoint /bin/sh "$RC_IMAGE" -c "
    set -e
    rc alias set local http://127.0.0.1:$S3_PORT $ROOT_USER $ROOT_PASSWORD >/dev/null
    rc admin policy create local/ conformance-app /tmp/app-policy.json >/dev/null
    rc admin user add local/ $APP_USER $APP_PASSWORD >/dev/null
    rc admin policy attach local/ conformance-app --user $APP_USER >/dev/null"
echo "RustFS S3 ready on 127.0.0.1:$S3_PORT (app key from the compose policy); audit -> host:$SINK_PORT"
