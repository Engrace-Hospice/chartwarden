# Test Results

All PostgreSQL tests ran serially against a private disposable `chartwarden-postgres:dev` container (PostgreSQL 18, matching `deploy/production/postgres/Dockerfile`) bound only to localhost port 55439. The container was isolated from `os-postgres-1`; the live suite reset its own `public` schema. Seeded records and identifiers were synthetic. No Claim.MD calls or production database operations occurred.

## PASS

- `bunx vitest run --reporter=verbose apps/backend/src/modules/41-billing-commercial/jobs/submission-worker.test.ts apps/backend/src/modules/41-billing-commercial/domain/ack-transition.test.ts apps/backend/src/modules/41-billing-commercial/services/claim-send-gate.test.ts` — 3 files, 49 tests passed.
- `bunx vitest run --project dom --reporter=verbose apps/web/src/modules/41-billing-commercial/claim-detail.dom.test.tsx apps/web/src/modules/41-billing-commercial/claim-timeline.dom.test.tsx` — 2 files, 15 tests passed, including correction creation and payer-side replacement hold states.
- `CHARTWARDEN_TEST_DATABASE_URL=<private disposable PostgreSQL URL> bun run test:m41:commercial-claim:live` — 36/36 tests passed. Covers correction lineage, verified clearinghouse rejection, denial of payer-stage rejection, idempotency, concurrent correction requests, historical location/frequency preservation and existing M41 claim/overlap behavior.
- `CHARTWARDEN_TEST_DATABASE_URL=<private disposable PostgreSQL URL> bun run test:m41:commercial-routes:live` — 11/11 tests passed. Covers Fastify route composition through the repository authenticated test-context adapter plus actual permission/ABAC guards, permission denial, wrong-provider denial, authorized correction, claim-detail eligibility/lineage projections, global idempotency replay, and persisted original/child state.
- `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc -b packages/db/tsconfig.json apps/backend/tsconfig.json --pretty false` — passed.
- `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc -b apps/web/tsconfig.json --pretty false` — passed. The default-heap attempt exited on V8 out-of-memory; it was rerun successfully with 8 GB.
- `bun run openapi:emit && bun run client:gen` — generated OpenAPI and client schemas.
- `bun run openapi:check && bun run client:check && bun run arch:openapi-provenance` — passed; 1,928 routes and 1,925 enriched route contracts checked.
- `bun run arch:tables` — passed.
- `bun run arch:tenancy` — passed.
- `bun run arch:ddl` — passed.
- `bun run arch:migration-compat` — passed; migration 1380 is classified `contract` because it replaces existing overlap constraints/indexes.
- `bun run arch:migration-numbering` — passed; migration ordinals unique.
- Targeted `bunx biome check` — passed after formatting.
- `git diff --check` — passed.

## Defects found and corrected

The first private PostgreSQL run exposed that the old exact-window unique index still blocked a legitimate correction child, even after the overlap exclusion was replaced. Migration 1380 now removes both old overlap enforcement structures and replaces them with a patient-serialized trigger that preserves the no-overlap rule except within the same correction chain.

The first run also showed that hard-coding `frequency_code=1` was wrong for an original claim whose TOB frequency was `2`; the correction now preserves the rejected original's TOB/frequency. An existing overlap regression assertion was updated to expect the new trigger's stable error marker.

## Not run

- Full monorepo/Billing suite and global E2E.
- PostgreSQL test under the real deployed application role/RLS for this new correction route specifically; the live service suite uses the existing `chartwarden_app` test role for application-service calls, and the route suite uses the repository's authenticated Fastify test harness.
- Payer acceptance/replacement/void certification and all live Claim.MD traffic.
