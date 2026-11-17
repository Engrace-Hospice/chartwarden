# M23-CM5-T1 / T1.1 — synthetic Claim.MD 837I rehearsal

## Purpose and boundary

This rehearsal exercises M23 claim assembly, validation, preparation fingerprints, submission persistence,
worker dispatch, the real `ClaimMdTransport`, the legacy tenant response poller, ACK correlation, claim state
transitions, and UI projections. The HTTP boundary is an in-memory Claim.MD fixture that rejects every URL except
the expected `https://svc.claim.md/services/` operations. It uses a test-only key and never reads environment
credentials.

T1.1 adds an authenticated Fastify injection path for claim preparation, submission, claim detail, submission
history, and acknowledgment history. It uses the production `buildServer`, `createSessionAuthenticate`, registered
Claims routes, permission evaluator, M23 ABAC predicates, step-up predicate, CSRF middleware, Drizzle route read/write
services, and the same fixture repositories as T1. The synthetic session cookie resolves through the actual session
context resolver; it does not mint a Better Auth session or replace route guards. A limited in-memory caseload fact
reader supplies only the fixture patient's membership fact. The test queue adapter enriches the production job
payload with its org derived from the deduplication key, matching the composition-root queue contract.

The HTTP flow checks anonymous/unauthorized/cross-tenant reads, missing step-up, authorized preparation and submit,
duplicate HTTP idempotency, stale version refusal, then runs the existing submit worker through strict fake Claim.MD
HTTP, processes the response with the existing legacy ACK poller, and reads the result from the registered HTTP GET
routes. It checks a transport receipt and ACK without representing either as payment.

This is an in-process integration rehearsal. It does not qualify PostgreSQL transactions, RLS, queue delivery,
the tenant encrypted response inbox, or a real Claim.MD account.

## Run it

From the repository root:

```bash
bun run test:m23:claimmd:synthetic
```

For just the HTTP injection and service/worker rehearsal:

```bash
bun run test:m23:claimmd:http-rehearsal
```

The named `T1-01` through `T1-12` tests identify the first failed stage. The tests expose only synthetic internal
identifiers and status codes. They do not print raw X12, beneficiary data, API credentials, or vendor response text.

For the broader non-live regression set:

```bash
bunx vitest run \
  apps/backend/src/modules/23-billing-medicare/__tests__/assembly.test.ts \
  apps/backend/src/modules/23-billing-medicare/__tests__/validation-service.test.ts \
  apps/backend/src/modules/23-billing-medicare/__tests__/claim-837i-loader.test.ts \
  apps/backend/src/modules/23-billing-medicare/__tests__/claim-preview-integrity.test.ts \
  apps/backend/src/modules/23-billing-medicare/jobs/clearinghouse-context.test.ts \
  apps/backend/src/modules/23-billing-medicare/jobs/clearinghouse-submission.test.ts \
  apps/backend/src/modules/23-billing-medicare/tenant-clearinghouse/resolver.test.ts \
  packages/x12-837-client/src/clearinghouse/claimmd-transport.test.ts \
  apps/web/src/modules/23-billing-medicare/__tests__/claim-history.dom.test.tsx \
  apps/web/src/modules/23-billing-medicare/__tests__/claim-submission-stale-preview.dom.test.tsx
```

## Stage qualification

| Stage | Local evidence | Qualification |
|---|---|---|
| Assembly and validation | Production assembly service, rule registry, and claim state machine | Mocked persistence integration |
| Preparation | Production 837I loader, source fingerprint, payer route fingerprint | Mocked persistence integration |
| Authorization | Production route RBAC/ABAC/step-up plus write-service guards | In-process authenticated HTTP and service integration |
| T1.1 HTTP auth and route guards | Production Fastify auth/session hook, RBAC resolver, M23 ABAC, CSRF, registered routes | In-process authenticated HTTP injection; no Better Auth session minting |
| T1.1 read APIs | Registered claim detail, submission history, ACK history | In-memory repository integration |
| T1.1 submit → worker → ACK | HTTP submit, real queue job shape, production Worker, fake transport, legacy poller | In-process mocked integration |
| Submission persistence | Production repository contract with shared in-memory repository doubles | Live PostgreSQL required |
| Worker dispatch | Production worker processor and transport upload seam | In-process worker integration |
| Claim.MD upload | Real adapter request construction and parser, injected HTTP fixture | Mocked vendor integration |
| Ambiguous recovery | Real attempt store and `/uploadlist/` reconciliation | Mocked vendor integration |
| Response polling | Existing `runTransportAckPull`, real response parser, scoped cursor port | Mocked vendor and persistence integration |
| ACK correlation/state | Production ACK router and claim state machine | Mocked persistence integration |
| UI | Existing submission and acknowledgment tables | DOM integration |
| RLS/concurrency/transactions | Not executed by this command | Authorized isolated PostgreSQL required |
| Vendor behavior | Not executed by this command | Approved Claim.MD test account required |

## T1.1 HTTP route contract exercised

| Method and path | Guards and request | Observed response/side effect |
|---|---|---|
| `GET /api/v1/billing/claims/:id/preparation` | Authenticated session, `billing.claim.read`, claim caseload/provider ABAC; no body | Safe rendered billing preview, version, route status and signed confirmation token; no X12, MBI or secret |
| `POST /api/v1/billing/claims/:id/submit` | Authenticated session, `billing.claim.submit`, provider scope, recent TOTP/WebAuthn step-up, CSRF, `Idempotency-Key`, `If-Match`; `ifVersion`, `acknowledgeAllOverrides`, preview token | `202` intent and queued job; stale source/route/version refused; duplicate key is replayed without a second job |
| `GET /api/v1/billing/claims/:id` | Authenticated session, `billing.claim.read`, claim caseload/provider ABAC | Claim state from the read service |
| `GET /api/v1/billing/claims/:id/submissions` | Same read guards | Persisted attempt and transport outcome DTO |
| `GET /api/v1/billing/claims/:id/acknowledgments` | Same read guards | Persisted ACK DTO after the legacy poller fixture processes the mocked status |

The HTTP cases assert anonymous and expired-session `401`, missing permission and step-up `403`, hidden cross-tenant
and wrong-provider resources `404`, invalid preview input `422`, and stale preparation `409`. The app uses the current
standard error envelope. The test does not exercise claim assembly through HTTP, Stedi account resolution in this
flow, real database transactions, or UI browser behavior; those remain covered only by their separate service,
resolver and DOM suites.

The legacy tenant response poller remains the receive path. The test invokes it once against the strict fake vendor
response; this does not activate a polling loop or tenant encrypted inbox handoff. Its cursor is an in-memory fixture
and does not alter a persisted historical cursor.

## T1.2 failure and recovery extension

The authenticated rehearsal also drives the following failure boundaries through the registered routes and
production worker:

- a Claim.MD upload-level refusal is returned after the HTTP route has accepted the asynchronous intent; submission
  history exposes `failed_portal` with the stable transport code, retains the failed attempt, and exposes neither the
  synthetic MBI, raw X12, credential, nor vendor message;
- a later payer-stage rejection is polled through the existing legacy response path, is appended separately from the
  successful upload receipt, moves the claim from `ack_pending` to `ack_rejected`, remains replay safe, and never
  produces a paid state;
- a socket loss after the fake upload reaches Claim.MD leaves the submission `in_doubt`; the authenticated history
  route exposes that state, a repeated worker delivery does not perform another upload, and cross-tenant history reads
  remain `404`;
- credential error code 21 and HTTP 401 finish as `failed_portal/CH_NOT_WIRED`, HTTP 429 finishes as
  `failed_portal/CH_UNAVAILABLE`, and an unreadable HTTP 200 or socket loss remains `in_doubt`. Each case uses a fresh
  transport identity so the credential hold is tested without suppressing the following independent scenario.

The strict fake counts Claim.MD uploads, response polls, and upload-list inquiries independently. Every intercepted
request must use `https://svc.claim.md/services/`, the test credential, and an implemented endpoint. Unknown hosts,
credentials, and operations fail closed. The actual external network request count is zero.

The real Claim.MD transport rehearsal covers upload-list match, positive absence, inconclusive content, and request
failure. A match reconciles without a second upload; positive absence permits the adapter's documented same-key
retake; inconclusive content and request failure remain unavailable without another upload. HTTP history exposes the
original `in_doubt` worker state. There is no registered HTTP reconciliation operation, so the lookup variants remain
transport-level coverage.

The authenticated Stedi case resolves an active test-mode row through `createTenantClearinghouseRuntime`, reaches the
Stedi-specific JSON boundary, and proves that Claim.MD is never used as fallback. Dispatch currently fails closed
before the fake Stedi endpoint: M23's canonical control number is 22 characters, while the existing Stedi JSON builder
limits `patientControlNumber` to 20. History reports `failed_portal/CH_INVALID_REQUEST`. Missing, `outside`, and inactive
rows also make no vendor request and report the worker's fail-closed preparation outcome. Altering the durable M23
control-number identity requires a separate domain and migration decision.

Focused command: `bun run test:m23:claimmd:http-rehearsal`. T1.2B result: 1 file, 6 tests passed. Biome and
`git diff --check` are the remaining local formatting checks. Global build, full TypeScript, architecture fitness,
PostgreSQL claim submission, and vendor-account qualification are deferred.

The complete Better Auth session issuance lifecycle, PostgreSQL claim submission transactions/RLS, and a real
Claim.MD test account remain separate qualifications. The prior isolated tenant-inbox live suite does not qualify
these claim-submission paths.

## Controlled Claim.MD test-account checklist

No step below authorizes a submission. Obtain explicit operator approval immediately before the one controlled
request.

### Account and test data

- Obtain a dedicated Claim.MD test account through Claim.MD; do not repurpose a production account.
- Confirm the account's current API, 837I, upload, upload-list, and response-service capabilities with Claim.MD.
- Keep its API key in the tenant encrypted credential store with `usage=test`; do not place it in source, logs, or
  shell history.
- Review the provider list already supplied in the test account. Use its existing sample identity when present.
- If Claim.MD instructs the team to add a provider and no sample exists, its current disclaimer lists NPI
  `1111111112` and Tax ID `741111111`; verify those instructions again before use.
- Use a fully fictional patient, address, dates, MBI/member identifier, diagnoses, services, and charges approved for
  that account. The local fixture is not automatically vendor-approved.
- Do not enter or submit enrollment, banking, ERA, production provider, or real patient information. Test-account
  enrollment links can reach external live systems.
- Keep test and production credentials, tenant configuration, payer routes, and observation dashboards separate.

### ChartWarden configuration

- Create a synthetic test organization and authorized billing-manager membership.
- Configure one active tenant clearinghouse row with `vendor=claimmd` and `usage=test`; verify BAA and subscription
  gates through the normal resolver.
- Configure the approved test provider entity, billing EDI profile, and an explicit test payer route.
- Confirm preparation and submission resolve the same organization, provider, account reference, usage, payer ID,
  and route fingerprint.
- Run the local rehearsal and the broader regression command above from the exact candidate revision.
- Review the rendered claim through the protected preparation flow. Confirm the fixture contains no real data and
  record only PHI-safe correlation identifiers.
- Obtain the required step-up authorization and a separate operator approval for the single test submission.

### Execution and stop conditions

- Capture request metadata without logging the AccountKey or raw 837I.
- Submit exactly one approved synthetic claim. Stop on production mode, unexpected host, route drift, provider drift,
  credential rejection, malformed response, or an uncertain outcome.
- On an uncertain outcome, use the existing idempotency key and upload-list reconciliation. Do not submit a new claim
  blindly.
- Observe the upload receipt as clearinghouse transport evidence only. It is not payer acceptance, adjudication, or
  payment.
- Allow only the existing tenant response poller to read `/services/response/`; do not activate the new archive path.
- Confirm the legacy cursor advances only after supported ACK processing and that replay creates no duplicate ACK or
  claim transition.
- Confirm the UI shows the submission, any in-doubt state, and response history without showing `Paid` absent M25 ERA
  evidence.

Claim.MD currently documents `REJECT` as a test policy number that forces a rejection and `DENY` as one that causes a
denial on the test ERA. Confirm these values and the account's behavior with Claim.MD before a later approved test;
do not assume either represents a real payer response.

## Vendor references reviewed

## M23-CM5-T1.2C — identity and routing fence

M23's 22-character `claimControlNumber` remains the internal claim and idempotency identity. Each new logical 837I submission attempt
gets a durable, random 17-character uppercase alphanumeric external PCN, protected by provider-scoped uniqueness. A duplicate request
returns the stored PCN; a retry that creates a new attempt gets its own PCN. Historical transmitted numbers are not rewritten. The
same external value is rendered as X12 CLM01 and Stedi JSON `patientControlNumber`, within Stedi's 20-character limit and 17-character
recommendation. Claim.MD ACK and ERA matching prefer this PCN, with a historical-only internal-number fallback.

The preparation token and immutable submission row bind vendor, account reference, mode, tenant config ID/version, keyed credential
fingerprint, route/source fingerprints and external PCN. The Worker checks the selected vendor and current tenant config before send;
inactive/revoked accounts or changed config are held. It never stores API key text. The authenticated rehearsal reaches the strict fake
Stedi endpoint once in test mode, confirms its external PCN, and confirms no Claim.MD upload occurred for the Stedi claim. No live
polling, encrypted inbox cutover or vendor account qualification is implied.

Focused tests for T1.2C:

```bash
bunx vitest run \
  apps/backend/src/modules/23-billing-medicare/__tests__/claimmd-synthetic-rehearsal.test.ts \
  apps/backend/src/modules/23-billing-medicare/jobs/claim-submission-binding.test.ts \
  apps/backend/src/modules/23-billing-medicare/outbox-consumers/submit-requests.test.ts \
  apps/backend/src/modules/23-billing-medicare/services/claim-837i-loader.test.ts \
  apps/backend/src/modules/23-billing-medicare/claimmd-identity/candidate-provider.test.ts \
  packages/billing/src/external-patient-control-number.test.ts \
  packages/billing/src/control-number.test.ts \
  packages/x12-837-client/src/clearinghouse/claimmd-transport.test.ts \
  packages/x12-837-client/src/clearinghouse/stedi-claim-json.test.ts \
  packages/x12-837-client/src/clearinghouse/stedi-transport.test.ts
```

This local mocked command does not qualify migration execution, PostgreSQL/RLS, database concurrency, vendor enrollment, or a real
clearinghouse account. These remain for CM5-T1.3 and separately approved vendor verification.

## T1.3 focused PostgreSQL qualification

The existing M23 claim-submit live suite now uses `scripts/db/migrate.ts`'s checksum-aware `applyMigrations()` and verifies
migrations 1505/1507, their ledger checksums and a no-op rerun. Its added database cases cover persisted external PCNs, provider-scoped
uniqueness and shape, historical NULL PCNs, immutable routing identity, repository replay/collision behavior, tenant-scoped Claim.MD
and Stedi rows, cross-tenant read/write refusal, pooled tenant-context cleanup, and concurrent Worker send fencing. The app-role
connection is created through `_live-app-role.ts`, which verifies `chartwarden_app` is neither SUPERUSER nor BYPASSRLS.

Inspection found that migration 1505 stored `clearinghouse_config_id` without a database-enforced organization relationship. Migration
1506 adds a composite `(config_id, organization_id)` foreign key. The first operator-run live attempt applied migrations 1505/1506
and reported 8/15 tests passing, 7 failing. The second run applied all 756 migrations, reran with 0 pending, and reported 13/15
passing. It verified the empty-context RLS fix and corrected fixture, but exposed two remaining issues: the synthetic evidence port
lacked receipt observation, and repository idempotency looked up the external PCN instead of the internal claim control number.
Migration 1507 allows the existing explicit hold reasons and makes an empty `app.org_id` deny access as an empty scope; the Worker
now sends through the already-validated transport. The repository now keeps idempotency on the internal control number, and the
fake evidence port records receipt observation. The third isolated run applied all 756 migrations (0 pending on rerun) and passed
all 15 tests, including worker hold, dispatch, tenant RLS, PCN, immutable routing, and repository restart-recovery cases. This is
runtime evidence for this disposable PostgreSQL suite only; it is not vendor or production qualification.

Run only against the private disposable production Postgres image with the established launcher:

```bash
BIL_TEST_ONLY=m23-claim-submission bash scripts/test-m25-835-ingestion-private.sh
```

This launcher binds a random loopback port, uses no persistent volume, runs the one selected live test file, and removes only its own
container. The suite refuses a missing database URL when `CHARTWARDEN_REQUIRE_LIVE=1`, so the selected test cannot silently pass by
skipping. The latest operator run completed successfully. No external vendor was contacted. The suite does not exercise authenticated
Fastify routes over PostgreSQL; it exercises production database repositories and Worker functions, with transport behavior faked.
Build, full TypeScript, architecture fitness, and vendor test-account verification remain deferred.

## Vendor references reviewed

- [Claim.MD test account disclaimer](https://docs.claim.md/docs/test-account-disclaimer-read-this-before-using-a-test-account)
- [Claim.MD API quickstart](https://docs.claim.md/docs/test-account-quickstart-guide)
- [Claim.MD API reference](https://api.claim.md/)

The API reference describes `/services/upload/`, `/services/uploadlist/`, and account-scoped `/services/response/`
with `ResponseID` followed by `last_responseid`. Recheck the live documentation before the authorized exercise.
