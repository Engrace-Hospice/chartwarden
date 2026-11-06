#!/usr/bin/env bash
# Start a throwaway SeaweedFS (all-in-one `weed server -s3`) plus a Fluent Bit that forwards SeaweedFS's
# S3 audit log (Fluent forward protocol) to the conformance suite's HTTP sink as JSON. Used by the
# `object-store-conformance-live` CI job and for local runs:
#
#   scripts/object-store-conformance/seaweedfs-up.sh                   # start (recreates)
#   eval "$(scripts/object-store-conformance/seaweedfs-up.sh --env)"   # the suite's env
#   bun run test:object-store:conformance:live
#   scripts/object-store-conformance/seaweedfs-up.sh --down
#
# The two identities in s3.json mirror production: an admin key (bucket versioning, the out-of-scope
# bucket) and an app key scoped to tenant-* / chartwarden-*. The credentials are test-only literals.
#
# audit.json is fluent-logger-golang's Config: `timeout` / `write_timeout` are Go time.Duration, i.e. NANOSECONDS.
# The SeaweedFS wiki's sample `"timeout": 3000` is 3 microseconds and silently drops every audit record (found
# by this suite). Production config must use the same units.
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
NET=cw-osc-net
S3_PORT="${OSC_S3_PORT:-18333}"
SINK_PORT="${OSC_AUDIT_SINK_PORT:-18334}"
SEAWEEDFS_IMAGE="${OSC_SEAWEEDFS_IMAGE:-chrislusf/seaweedfs:4.52}"
FLUENT_BIT_IMAGE="${OSC_FLUENT_BIT_IMAGE:-fluent/fluent-bit:5.1.5}"
READY_ATTEMPTS=60

down() {
  docker rm -fv cw-osc-seaweedfs cw-osc-fluent-bit >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
}

if [ "${1:-}" = "--down" ]; then down; exit 0; fi
if [ "${1:-}" = "--env" ]; then
  cat <<EOF
export OBJECT_STORE_ENDPOINT=http://127.0.0.1:$S3_PORT
export OBJECT_STORE_REGION=us-east-1
export OBJECT_STORE_ADMIN_ACCESS_KEY=conformance-admin
export OBJECT_STORE_ADMIN_SECRET_KEY=conformance-admin-test-secret-not-real
export OBJECT_STORE_APP_ACCESS_KEY=conformance-app
export OBJECT_STORE_APP_SECRET_KEY=conformance-app-test-secret-not-real
export OBJECT_STORE_AUDIT_SINK_PORT=$SINK_PORT
EOF
  exit 0
fi

# Refuse the wiki's millisecond-looking timeouts (see header): anything under 1s in nanoseconds drops every record.
bun -e '
  const c = JSON.parse(await Bun.file(process.argv[1]).text());
  const bad = ["timeout", "write_timeout"].filter((k) => k in c && c[k] < 1e9);
  if (bad.length) { console.error(`audit.json: ${bad.join(", ")} must be Go nanoseconds (>= 1e9 = 1s)`); process.exit(1); }
' "$DIR/audit.json"

down
docker network create "$NET" >/dev/null

# Fluent Bit reaches the suite's sink on the host. host-gateway makes host.docker.internal resolve on Linux too.
docker run -d --name cw-osc-fluent-bit --network "$NET" --network-alias fluent-bit \
  --add-host=host.docker.internal:host-gateway \
  -e AUDIT_SINK_HOST=host.docker.internal -e AUDIT_SINK_PORT="$SINK_PORT" \
  -v "$DIR/fluent-bit.yaml:/fluent-bit/etc/fluent-bit.yaml:ro" \
  "$FLUENT_BIT_IMAGE" -c /fluent-bit/etc/fluent-bit.yaml >/dev/null

docker run -d --name cw-osc-seaweedfs --network "$NET" -p "127.0.0.1:$S3_PORT:8333" \
  -v "$DIR/s3.json:/etc/seaweedfs/s3.json:ro" -v "$DIR/audit.json:/etc/seaweedfs/audit.json:ro" \
  "$SEAWEEDFS_IMAGE" server -dir=/data -ip.bind=0.0.0.0 -master.volumeSizeLimitMB=64 \
  -s3 -s3.port=8333 -s3.config=/etc/seaweedfs/s3.json -s3.auditLogConfig=/etc/seaweedfs/audit.json >/dev/null

# Ready = the S3 gateway answers a request (any HTTP status; an anonymous request gets 403).
for _ in $(seq "$READY_ATTEMPTS"); do
  if curl -s -o /dev/null "http://127.0.0.1:$S3_PORT/"; then
    echo "SeaweedFS S3 ready on 127.0.0.1:$S3_PORT; audit -> host:$SINK_PORT"
    exit 0
  fi
  sleep 1
done
echo "SeaweedFS did not become ready" >&2
docker logs cw-osc-seaweedfs >&2 || true
exit 1
