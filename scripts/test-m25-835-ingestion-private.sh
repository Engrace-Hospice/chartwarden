#!/usr/bin/env bash
set -euo pipefail

# Isolated PostgreSQL runner for the existing M25 835 ingestion live suite, including the
# transaction-scoped explicit-association posting-core cases. Never reuses a shared database.
ROOT="$(git rev-parse --show-toplevel)"
IMAGE="${M25_TEST_PG_IMAGE:-chartwarden-postgres:dev}"
NAME="wardenx-m25-posting-core-${RANDOM}-${RANDOM}"
PASSWORD="$(openssl rand -hex 24)"

if ! command -v docker >/dev/null || ! command -v bun >/dev/null; then
  echo "docker and bun are required" >&2
  exit 2
fi
if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "Required test image is not present locally: $IMAGE (no implicit pull)" >&2
  exit 2
fi

cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT INT TERM

docker run -d --rm --name "$NAME" -p 127.0.0.1::5432 \
  -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD="$PASSWORD" \
  -e POSTGRES_DB=wardenx_m25_posting_core_test "$IMAGE" \
  -c max_locks_per_transaction=1024 >/dev/null

for _ in $(seq 1 60); do
  if docker exec "$NAME" pg_isready -U postgres -d wardenx_m25_posting_core_test >/dev/null 2>&1; then break; fi
  sleep 1
done
docker exec "$NAME" pg_isready -U postgres -d wardenx_m25_posting_core_test >/dev/null
PORT="$(docker port "$NAME" 5432/tcp | sed 's#.*:##')"
export CHARTWARDEN_TEST_DATABASE_URL="postgresql://postgres:${PASSWORD}@127.0.0.1:${PORT}/wardenx_m25_posting_core_test"
cd "$ROOT"

# The suite resets public and drops its application roles. This cluster is disposable and private.
bunx vitest run apps/backend/__tests__/m25-835-ingestion.live.test.ts
# Exercise the legacy manual 835 parser, receiveAdvice/postAdvice financial path and its real dispatcher.
bunx vitest run apps/backend/__tests__/m25-835-golden.live.test.ts
# Verify the existing downstream M23/M24 consumers still process M25 payment events from the durable outbox.
bunx vitest run apps/backend/__tests__/f172-m24-remittance-feedback.live.test.ts
# Verify the existing M23/M26 claim-payment and CAP accrual consumers from transactional outbox events.
bunx vitest run apps/backend/__tests__/gap-038-cap-day-backfill.live.test.ts
# Exercise the supported clearinghouse/SFTP pull adapter with synthetic transport data (no live vendor call).
bunx vitest run apps/backend/__tests__/m25-clearinghouse-pull.test.ts

echo "Private M25 835 ingestion and transaction-core suite completed."
