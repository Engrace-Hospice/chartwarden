#!/usr/bin/env bash
set -euo pipefail

# Disposable PostgreSQL runner for the Phase 1.1 live database suites.
# It never reads CHARTWARDEN_TEST_DATABASE_URL and refuses to reuse a container.
ROOT="$(git rev-parse --show-toplevel)"
IMAGE="${BIL1_TEST_PG_IMAGE:-pgvector/pgvector:pg18}"
NAME="wardenx-bil1-phase11-${RANDOM}-${RANDOM}"
PASSWORD="$(openssl rand -hex 24)"

if ! command -v docker >/dev/null || ! command -v bun >/dev/null; then
  echo "docker and bun are required" >&2
  exit 2
fi
if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "Required test image is not present locally: $IMAGE (no implicit pull)" >&2
  exit 2
fi

cleanup() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

docker run -d --rm --name "$NAME" -p 127.0.0.1::5432 \
  -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD="$PASSWORD" \
  -e POSTGRES_DB=wardenx_phase11_test "$IMAGE" \
  -c max_locks_per_transaction=1024 >/dev/null

for _ in $(seq 1 60); do
  if docker exec "$NAME" pg_isready -U postgres -d wardenx_phase11_test >/dev/null 2>&1; then break; fi
  sleep 1
done
docker exec "$NAME" pg_isready -U postgres -d wardenx_phase11_test >/dev/null
PORT="$(docker port "$NAME" 5432/tcp | sed 's#.*:##')"
export CHARTWARDEN_TEST_DATABASE_URL="postgresql://postgres:${PASSWORD}@127.0.0.1:${PORT}/wardenx_phase11_test"
cd "$ROOT"

# These suites reset public and cluster roles. Run serially against this disposable cluster only.
bunx vitest run apps/backend/__tests__/m23-claimmd-response-inbox.live.test.ts
bunx vitest run packages/db/migrations/__tests__/m23-rls-isolation.live.test.ts
bunx vitest run packages/db/migrations/__tests__/m25-rls-isolation.live.test.ts

echo "Phase 1.1 private PostgreSQL subset completed. This is not end-to-end pipeline certification."
