# M23 CM-4 internal release qualification

Date: 2026-11-14
Branch/revision inspected: `develop` / `9e854663e` plus the preserved uncommitted CM-1 through CM-4 worktree
Scope: internal Medicare notice preparation, review, tracking, issues and notification integration. No external notice transmission was enabled or attempted.

## Decision

**Internal Medicare Notices workflow: NO-GO.** The full backend TypeScript project and changed-worktree
Biome gate pass. The mandatory runtime `chartwarden_app` PostgreSQL/RLS, migration, concurrency and
notification-outbox/recipient gates remain unexecuted. The user confirmed the configured
`CHARTWARDEN_TEST_DATABASE_URL` database is disposable and managed locally, but the repository's
PreToolUse compliance guard refused the destructive live suite because it drops cluster-global roles
and requires human confirmation through `/hooks`. Only read-only PostgreSQL catalog inspection was
performed; no schema reset, migration, role operation, or live suite ran.

**External Medicare notice submission: NOT READY.** Claim.MD and Stedi notices remain
`CH_NOT_WIRED`. Direct-MAC remains held by
`M23_NOTICE_GATEWAY_ARTIFACT_CONTRACT_UNSUPPORTED`; no gateway server/deployment target or qualified
remote idempotency, lookup and acknowledgment contract exists in this repository.

## Baseline and verification matrix

| Area | Status | Evidence |
|---|---|---|
| Authoritative loaders/rendering | Passed (focused) | Renderer and protected-artifact regression suites passed; no vendor call |
| Operational issue lifecycle | Passed (focused) | Issue/worklist/worker tests passed, including evidence-based projection and PHI-free identities |
| Notification audience rules | Passed (unit); runtime unverified | M36 permission/role/assignee resolution tests passed; no live membership/preference database qualification |
| Backend composition bundle | Passed | Bun bundled `apps/backend/src/index.ts`, 7,198 modules, 24.77 MB |
| Full backend TypeScript project | Passed | `tsc -b apps/backend` exited zero with a controlled 6 GiB heap after five concrete diagnostics were corrected |
| Changed-worktree Biome | Passed | Initial 79 errors/5 warnings (55 format, 21 imports, 3 accessibility; 5 `useImportType` warnings); targeted correction on 57 diagnostic-listed files; final check zero diagnostics |
| UI/package TypeScript | Passed | `packages/ui` and `apps/web` project build completed |
| Web production build | Passed | Vite transformed 1,661 modules and completed in 17.94 s |
| OpenAPI and generated client | Passed | 2,095/2,095 routes enriched; M23 127/127; generated client current |
| Migration static gates | Passed | numbering, compatibility, tenancy, manifest mirror, ownership and DDL legality |
| Migration 1491/1492 runtime execution | Blocked / not executed | Disposable database is on a shared native PostgreSQL cluster; suite not run |
| Application-role RLS | Not executed | no claim is made from static SQL or mocks |
| External transport | Blocked by design | typed Claim.MD/Stedi and Direct-MAC holds remain present and tested |

Statuses are intentionally independent. A passed bundle or static RLS gate does not upgrade an
unexecuted TypeScript/RLS gate.

## Qualification-lot files modified

- `packages/db/migrations/__tests__/m23-rls-isolation.live.test.ts` — extends the existing M23
  application-role suite over the 1491/1492 records and transaction boundaries.
- `apps/backend/src/modules/23-billing-medicare/routes/medicare-notice-issues.routes.test.ts` — adds
  actual Fastify route-boundary authentication, permission, idempotency and AI-principal checks.
- `docs/architecture/CHARTWARDEN_OPS_RUNBOOK_v0.1.md` — replaces the stale “no unified worklist or
  assignment” posture with the current internal-only operational model.
- `docs/architecture/M23_MEDICARE_NOTICE_RENDERING.md` — records the qualification boundary and
  preserves the external transport holds.
- `docs/audits/clearinghouse-integration/M23_CM4_INTERNAL_RELEASE_QUALIFICATION.md` — this evidence
  record.

No production migration or runtime transport code was changed by CM-4C.4. All earlier uncommitted
CM-1 through CM-4 files were preserved.

## Exact verification evidence

### CM-4C.4Q gate execution (current snapshot)

The qualified source base is commit `9e854663eea41686e17ef31ca78a873875023871` on `develop`, plus
the complete dirty worktree reported by `git status --short` on 2026-11-14. No commit, push, PR,
deployment, reset or stash was performed. Generated OpenAPI coverage, OpenAPI JSON and the typed
client present in that same worktree were checked together.

| Gate | Command | Result | Evidence | Remaining action |
|---|---|---|---|---|
| Full backend TypeScript | `NODE_OPTIONS=--max-old-space-size=6144 bunx tsc -b apps/backend --pretty false` | **Pass** | First complete run exited 1 with five diagnostics at 2:25.36 / 4,620,084 KiB RSS; corrected run exited 0 at 0:21.27 / 1,921,776 KiB RSS | None for this gate |
| PostgreSQL migrations | `bun run test:rls:live:m23` through the approved private-cluster procedure | **Blocked / not executed** | URL resolves to `localhost:5432/wardenx_test` on native PG16 `main`, a shared cluster; hook and isolation prerequisites block the destructive suite | Operator must use a private cluster on its own port against this snapshot |
| Application-role RLS | Same approved live suite | **Blocked / not executed** | `chartwarden_app` absent during read-only catalog inspection; the suite did not connect as that role | Capture role `BYPASSRLS` assertion and Vitest output on isolated cluster |
| Concurrency | Same approved live suite | **Blocked / not executed** | Concurrent issue/artifact/dispatch/outbox assertions exist but were not executed on PostgreSQL | Execute in the authorized private cluster |
| Outbox/notifications | Focused M36/M23 Vitest suites; live suite for persistence | **Unit pass; runtime blocked** | Included in 143 passing backend/M36 tests; real membership/preferences and transactional outbox remain unqualified | Execute live suite and isolated M36 composition |
| Web/API | OpenAPI/client gates, web/UI TypeScript, Vite build, focused frontend tests | **Pass** | 2,095/2,095 OpenAPI; 22 frontend tests; 1,661-module production build | None for these gates |
| Transport safety | Focused renderer, artifact, dispatch, pre-run hold and clearinghouse tests | **Pass (non-live)** | Included in 143 passing backend/M36 tests; no vendor call | Keep external dispatch disabled |

The first 6 GiB compiler run found and the implementation corrected:

- `apps/backend/src/index.ts`: the notice loader was passed the claim write-service
  `ProviderCcnPort` (`ccnForProviderEntity`) instead of the loader's organization-context reader
  (`ccnFor`). Composition now uses `buildProviderEntityCcnResolver`, which establishes organization
  context and returns the loader's nullable, fail-closed result.
- `medicare-notice-worklist.test.ts`: the pagination fake incorrectly required an arbitrary string
  index signature. Its key is now a generic `keyof T`, preserving the actual view types.
- `medicare-notice-source-loader.test.ts`: the 8xD original notice fixture derived a nullable ID
  after mutation. It now retains the explicit immutable original notice ID.

The two affected suites passed 12/12 tests immediately after correction. The consolidated backend,
M36, artifact and transport-safety run then passed 143/143 tests across 14 files.

### Toolchain and host

- Bun `1.3.14`
- Node `v24.12.0`
- TypeScript `5.9.3`
- Host memory at the backend-check start: 7.6 GiB total, 3.4 GiB available, 2.0 GiB swap free
- Repository CI heap policy: bounded 6,144 MiB child processes

### Focused tests

Passed:

```text
bunx vitest run \
  apps/backend/src/modules/23-billing-medicare/services/medicare-notice-operational-issues.test.ts \
  apps/backend/src/modules/23-billing-medicare/routes/medicare-notice-worklist.test.ts \
  apps/backend/__tests__/gap-069-070-m23-workers.test.ts \
  apps/backend/__tests__/m23-clearinghouse-injection.test.ts \
  packages/messaging/__tests__/permission-holders-resolver.test.ts \
  apps/backend/src/modules/23-billing-medicare/jobs/clearinghouse-submission.test.ts

6 files, 69 tests passed
```

Passed transport/artifact safety regressions:

```text
bunx vitest run \
  packages/messaging/__tests__/body-crypto-ring.test.ts \
  packages/messaging/__tests__/body-crypto.test.ts \
  apps/backend/src/modules/23-billing-medicare/services/medicare-notice-renderer.test.ts \
  apps/backend/src/modules/23-billing-medicare/services/medicare-notice-dispatch.test.ts \
  apps/backend/src/modules/23-billing-medicare/jobs/direct-mac-notice-gateway-contract.test.ts \
  apps/backend/src/modules/23-billing-medicare/jobs/m23-pre-run-hold.test.ts \
  apps/backend/src/modules/23-billing-medicare/jobs/clearinghouse-submission.test.ts

7 files, 74 tests passed
```

Passed frontend regressions:

```text
bunx vitest run \
  apps/web/src/modules/23-billing-medicare/__tests__/medicare-notices-workspace.dom.test.tsx \
  apps/web/src/modules/23-billing-medicare/__tests__/noe-exception-review.dom.test.tsx \
  apps/web/src/shell/actor-session.test.ts

3 files, 22 tests passed
```

Passed protected issue-route regressions:

```text
bunx vitest run \
  apps/backend/src/modules/23-billing-medicare/routes/medicare-notice-issues.routes.test.ts

1 file, 4 tests passed
```

The route tests exercise unauthenticated `401`, missing-permission `403`, transaction-specific read
filtering, submit-permission enforcement, mandatory idempotency keys, server-derived organization and
membership identity, and AI-principal refusal before a mutation reaches the service.

These suites use synthetic data and stubs only. They performed no real or sandbox transmission.

### TypeScript and builds

Passed:

```text
NODE_OPTIONS=--max-old-space-size=3072 bunx tsc -b packages/ui apps/web --pretty false
bun run --cwd apps/web build:app
bun build apps/backend/src/index.ts --target=bun \
  --outdir=/tmp/wardenx-cm4c4-backend-build-20261114 --external pg-native
```

The backend bundle is composition evidence, not a replacement for project typechecking.

The earlier 4 GiB run exhausted its heap, but CM-4C.4Q completed the authoritative backend project
check with a controlled 6 GiB heap:

```text
/usr/bin/time -v env NODE_OPTIONS=--max-old-space-size=6144 \
  bunx tsc -b apps/backend --pretty false
```

The first complete run reached five source diagnostics instead of exhausting memory (exit 1,
2:25.36, maximum RSS 4,620,084 KiB). After the typed composition and fixture corrections above, the
same command exited 0 (0:21.27, maximum RSS 1,921,776 KiB). The Bun bundle remains separate
composition evidence; the successful `tsc -b apps/backend` result is the TypeScript gate.

### API and architecture gates

Passed:

```text
bun run openapi:check
bun run client:check
bun run arch:openapi-coverage
bun run arch:openapi-provenance
bun run arch:route-reachability
bun run arch:migration-numbering
bun run arch:migration-compat
bun run arch:tenancy
bun run arch:manifest-mirror
bun run arch:tables
bun run arch:ddl
bun run arch:test-typecheck
git diff --check
```

OpenAPI reports 2,095/2,095 enriched routes. M23 reports 127/127, zero M23 mutating routes without a
request-body schema and zero M23 GET routes without a response schema. The repository-wide report
still identifies one non-M23 mutating route without a body schema and nine non-M23 GET routes without
response schemas; these do not reduce the enrichment ratio and were not changed in CM-4.

Targeted Biome checks passed for the operational issue service/routes/tests, workspace/tests and M36
rule/resolver files, and the new live-suite diff is formatter-clean. `git diff --check` passed. A
read-only `biome check --changed --since main` found 79 formatting/import diagnostics in the
larger preserved CM-1 through CM-4 worktree (including pre-existing notice builder, billing schema and
shared CSS changes). They were not bulk-rewritten in this stabilization lot and remain a separate
pre-merge cleanup gate.

## Migration qualification

The required order is:

1. `1383_m23_claim_submission_dispatch_state.sql` — dispatch state/token fencing on existing submissions.
2. `1489_m23_medicare_notice_render_identity.sql` — immutable render identity.
3. `1490_m23_medicare_notice_render_artifact.sql` — encrypted artifact bound to render identity.
4. `1491_m23_noe_exception_review.sql` — current review plus append-only history.
5. `1502_m23_medicare_notice_operational_issues.sql` — current issue, append-only events and notification outbox.

Static checks confirm expand compatibility, unique numbering, forced canonical `app.org_id` RLS,
manifest/schema ownership and legal DDL. The Drizzle exports and both manifest variants include the
1492 tables. Static checks do not prove that the migrations execute or that grants/policies work as
`chartwarden_app`.

The existing M23 live suite was extended to cover 1491/1492 records. Its intended runtime assertions now include:

- owner visibility and cross-tenant denial for reviews, issue rows, histories and outbox rows;
- active same-organization assignee enforcement;
- append-only review/issue histories;
- active-issue uniqueness;
- issue/event/outbox transaction rollback;
- publication fencing and cross-tenant outbox isolation;
- the existing render identity, encrypted artifact and dispatch-state checks.

Runtime result: **not executed**. A dedicated `chartwarden-postgres:dev` container was started with a
fresh database, an ephemeral localhost port and `max_locks_per_transaction=1024`. The repository
compliance hook still refused the destructive live command because Codex cannot provide the required
human authorization. The container was stopped and removed. The guard was not bypassed.

Approved CI/operator procedure:

1. Obtain explicit authorization for cluster-global test-role management.
2. Build/use `chartwarden-postgres:dev` from `deploy/production/postgres`.
3. Start a new private container on its own port and database with
   `-c max_locks_per_transaction=1024`; never use the shared development cluster.
4. Set `CHARTWARDEN_TEST_DATABASE_URL` only to that fresh database.
5. Run `bun run test:rls:live:m23` (the script and CI matrix row already exist).
6. Capture Vitest/JUnit output, confirm `chartwarden_app.rolbypassrls = false`, then destroy the
   database/container.

Until this succeeds, migrations 1491/1492 and application-role isolation remain unqualified.

## Notification and issue-lifecycle findings

Focused tests establish the pure/domain behavior: stable occurrence deduplication, escalation,
evidence-driven absence resolution, stale-projection non-reopening, PHI-free deep links, M36
permission/role/assignee audiences, and no false MAC acceptance. The implementation writes issue
events and notification intent in one database transaction, uses the immutable event ID as the M36
correlation key, keeps zero-recipient/failure rows pending, and bounds selection at 12 attempts.

What remains unverified at runtime is material: real membership/preferences resolution, concurrent
database writers, restart recovery, atomic issue/outbox commit, and recovery after a recipient becomes
eligible. Those require the approved disposable PostgreSQL test and, for full end-to-end notification
delivery, an isolated M36 test composition. No-recipient rows are visible as pending/retry-exhausted;
they are not falsely marked published.

## Security and transport-safety review

- Worklist/issue reads use metadata and do not decrypt MBI or X12.
- Notification payloads contain typed notice/issue IDs, stable codes, generic messages and internal
  routes; no X12, MBI, diagnosis, credential or exception narrative is included.
- Assignment is checked against active same-organization membership and notice permission; provider
  scope remains enforced by the API.
- There is no manual resolve, force-send, resend-in-doubt, mark-accepted or automatic exception-approval API.
- Finalized artifacts are recovered rather than rerendered; integrity/key failures remain distinct.
- Dispatch receipt is not MAC acceptance. Operator-attested exception evidence is not an acknowledgment.
- Claim.MD/Stedi notice refusal and Direct-MAC contract holds passed focused regressions.
- The proposed Direct-MAC v1 adapter remains outside live dispatch composition.

No PHI or credential exposure was observed in the changed operational payloads/tests. This is a
source/test review, not a runtime log certification.

## Capability matrix

| Capability | NOE 81A | NOTR 81B | 8xC transfer | Supported 8xD cancellation |
|---|---|---|---|---|
| Authoritative source loading | Implemented; focused verified | Implemented; focused verified | Implemented; focused verified | Implemented for supported relationship; focused verified |
| Internal X12 generation | Implemented; focused verified | Implemented; focused verified | Implemented; focused verified | Implemented for supported case; focused verified |
| Encrypted artifact persistence/recovery | Implemented; focused verified; DB runtime unverified | Same | Same | Same |
| Dispatch fencing/in-doubt protection | Implemented; focused verified; DB concurrency unverified | Same | Same | Same |
| Deadline policy | Implemented; focused verified | Implemented for qualifying events; focused verified | Not applicable | Not applicable |
| Lifecycle/readiness/worklist | Implemented; focused verified | Implemented; focused verified | Implemented; focused verified | Implemented; focused verified |
| Operational issues/notifications | Implemented; focused verified; runtime delivery unverified | Same | Same | Same |
| MAC acknowledgment processing | Existing evidence projection only; external end-to-end unverified | Same | Same | Same |
| Claim.MD/Stedi notice transport | Unsupported / held | Unsupported / held | Unsupported / held | Unsupported / held |
| Direct-MAC transport | Blocked by external gateway qualification | Same | Same | Same |

## Rollout and rollback prerequisites

No rollout should proceed until the backend project check and application-role live suite pass in an
approved environment. Then stage in this order:

1. Take and verify a database backup/restore point.
2. Apply 1383 if absent, then 1489, 1490, 1491 and 1492 in ordinal order before the new API/Worker.
3. Deploy compatible API/Worker versions, then the generated-client-compatible web build.
4. Verify tenant permissions and eligible M36 recipients before enabling watchdog evaluation.
5. Observe issue/outbox pending, exhausted and deduplicated states; do not manually mark rows published.
6. Preserve all held jobs and require explicit evidence revalidation; do not automatically release them.

Rollback the application binaries without contracting the expand migrations. Preserve encrypted
artifacts, render identities, dispatch tokens, issue/event history, exception evidence, notification
outbox and queue state. Do not purge queues, reset control numbers, rewrite acceptance evidence or
resend an in-doubt attempt. External Direct-MAC, Claim.MD and Stedi notice uploads remain disabled.

## Remaining blockers and next work

Confirmed qualification defects fixed in this lot were missing 1491/1492 coverage in the existing
M23 live suite, missing direct route-boundary tests for operational issue APIs, and stale runbook text.
No production behavior defect was claimed or hidden: the new database assertions remain unexecuted
until the approved live environment runs them.

Internal release blockers:

- successful migration 1491/1492 execution and real `chartwarden_app` RLS/concurrency suite;
- isolated runtime qualification of recipient preferences and outbox restart/recovery in an
  approved M36 test composition.

External submission blockers:

- a real deployed Direct-MAC gateway implementing and passing the v1 conformance contract;
- durable remote idempotency, lookup, receipt and acknowledgment correlation;
- provider/jurisdiction credential and EDI enrollment qualification;
- verified Claim.MD/Stedi support for each hospice notice transaction, or continued refusal;
- authoritative acknowledgment reconciliation before any payer/MAC acceptance transition.

Recommended next step: have an authorized operator execute the existing M23 live suite against a
fresh private PostgreSQL cluster using the exact dirty snapshot, then qualify real M36 recipients
and recovery. Do not begin CM-5 or CM-6 and do not enable external notice transmission on the strength
of the focused evidence above.

## CM-4C.4R — runtime qualification and Biome remediation

### Snapshot and database authorization

At the start of this lot the source was `develop` at
`9e854663eea41686e17ef31ca78a873875023871`; the worktree had 48 status entries. No commit, push,
stash, reset, deployment or vendor call was made. Qualification ran against that same checkout plus
this lot's fixes. The final worktree contains 99 status entries, including the preserved earlier
CM-1 through CM-4 changes, targeted formatting/import updates and this report; it is not represented
by the commit alone.

The configured `CHARTWARDEN_TEST_DATABASE_URL` resolves to `localhost:5432/wardenx_test`; the user
confirmed this database is disposable and managed locally. Read-only host inspection established
that the listener is native PostgreSQL 16 `main` at `/var/lib/postgresql/16/main`, port 5432, not a
private per-suite cluster. A read-only catalog query found 25 non-template databases on that cluster
(including WardenX and unrelated databases), with login role `postgres`; `chartwarden_app` did not
exist at inspection time. Docker inspection separately showed containers mapped to ports 32855 and
55432, neither of which serves this URL. Thus the database is disposable but the cluster is shared
and **not qualified for the destructive suite**. `DATABASE_URL` was not used for a database command.
No schema reset, migration, role operation, or live suite was executed.

The suite command is blocked by PreToolUse because it drops cluster-global roles. `/hooks` approval
has not been requested/applied in this turn: the independent private-cluster prerequisite failed, so
the destructive operation must not proceed even if the hook were trusted. Configure a fresh private
PostgreSQL cluster on its own port and fresh database first; only then should a human trust the
existing guarded command through `/hooks` and authorize execution.

The repository-supported path remains the operator/CI live-suite procedure below, with an explicit
authorization for cluster-global test-role management and a private Postgres instance built from
`deploy/production/postgres`, on a dedicated port, with a fresh database and
`max_locks_per_transaction=1024`. The current dirty worktree must be present in that environment;
the ordinary remote CI job tests a committed revision and cannot substantiate this dirty snapshot.
Because this task forbids publishing the source, the remaining action is to provision the approved
private cluster, then authorize `bun run test:rls:live:m23` through the human-controlled `/hooks`
flow and run it against that cluster. No CI publication was attempted.

### Follow-up: skipped suite and cross-tenant unique index review

The M23 live file contains exactly one conditional suite declaration:
`describe.skipIf(!DB_URL)(...)`, where `DB_URL` is captured from
`process.env.CHARTWARDEN_TEST_DATABASE_URL` at module load. It contains 17 `it(...)` cases and no
per-test `.skip` conditions. Therefore, a Vitest result of 17 skipped means `DB_URL` was falsy in
that Vitest process: Vitest skipped the entire suite, including `beforeAll`, so it did not connect,
reset the schema, replay migrations, or test RLS. This is separate from the PreToolUse `/hooks`
approval: that hook refuses the command before Vitest starts. Safe probes using both direct
`bunx vitest` and `bun run vitest` did not inherit the `.env` value (the probes failed with a redacted
“variable must reach Vitest” assertion). A temporary Bun script that explicitly passed its process
environment to a real Vitest worker passed without printing credentials; its files were removed.
Thus `bun run test:rls:live:m23` can skip when the URL is only Bun-loaded from `.env` and not exported
to the child process. The earlier reported 17 skips are explained by the suite's falsy `DB_URL`
condition; no individual case failed because none ran. For eventual authorized execution, export the
URL into the runner process and require 17 executed, zero skipped.

The test named ``claim_ack_file_uq` is NOT org-scoped — a cross-tenant write oracle` was checked
against the actual schema and DDL. Migration 0075 and Drizzle define global uniqueness on
`(mac_jurisdiction, ack_file_uri)`; migration 0077 applies organization RLS to rows. PostgreSQL
enforces unique indexes below RLS, so an insert that collides with another tenant's key fails even
though a tenant-scoped `SELECT` cannot see the row. Thus the constraint-level existence signal is
real if a caller can supply/guess the same URI. The test demonstrates that database behavior; its
name alone is not proof of an externally exploitable application vulnerability. The inspected M23
transport mapper derives the key from the vendor event ID and, for tenant accounts, prefixes the
organization ID. No tenant-facing arbitrary-URI acknowledgment write path was found in the inspected
callers. Global uniqueness also preserves deduplication for the platform-wide shared event stream.
No schema change was made: changing uniqueness to include `organization_id` without redesigning
platform-stream deduplication could allow one shared acknowledgment to be ingested repeatedly, and
current evidence does not establish an application-level disclosure path. Keep this as a documented
low-severity database side-channel/design tradeoff; any future change should first establish URI
entropy, exposure paths and platform-feed deduplication semantics.

Approval/execution status: the database is disposable but its PostgreSQL cluster is shared, so the
private-cluster prerequisite fails. The live suite remains **not executed** and all 17 cases remain
**unverified**, not passed. Separately, the Codex PreToolUse guard requires a human to trust/approve
the pinned hook through `/hooks`; Codex cannot grant that approval or bypass it. The
test's cross-tenant collision fixture was narrowly corrected to use org B's own `claim_submission`
row; this isolates the unique-index signal from any cross-organization submission-FK behavior. That
test-file change was not run because the same harness treats commands naming `*.live.test.ts` as
approval-gated. `git diff --check` passed after the edit.

### Biome remediation

The initial changed-worktree command, `bunx biome check --changed --since main --reporter=json`,
reported 79 errors and 5 warnings: 55 formatting diagnostics, 21 import-order diagnostics, three
`lint/a11y/useSemanticElements` errors, and five `lint/style/useImportType` warnings. The formatting
and import diagnostics were confined to 57 explicitly reported changed files. Those files were
formatted/reordered with the repository's configured Biome version; the semantic diagnostics in
`apps/web/src/modules/23-billing-medicare/mac-credentials.tsx` were fixed by using semantic
`output` elements for the three status messages. No rules, baselines, or ignore patterns changed.

Final command: `bunx biome check --changed --since main` — **Passed**, exit 0, zero errors and zero
warnings. The 57-file set was the diagnostic-reported changed-file set (not a repository-wide
rewrite). The visible semantic correction is included in the file above; remaining changes from
this remediation are formatting/import organization only.

### Commands and results in this lot

| Gate | Command | Result | Evidence | Remaining action |
|---|---|---|---|---|
| Full backend TypeScript | `NODE_OPTIONS=--max-old-space-size=6144 bunx tsc -b apps/backend --pretty false` | **Passed** | Post-remediation run exited 0 in 53.06 s; peak RSS 2,847,472 KiB | None for this gate |
| Backend/M36/notice regressions | Focused Vitest command covering issue lifecycle/worklist/routes, loaders, renderer, artifact dispatch, gateway holds, claim submission and M36 crypto/recipients | **Passed** | 14 files, 143 tests passed; no network/vendor calls | Runtime persistence remains unverified |
| Frontend regressions | Focused Vitest command for notice workspace, NOE exception review and actor session | **Passed** | 3 files, 22 tests passed | None for these focused suites |
| UI/web TypeScript and build | `NODE_OPTIONS=--max-old-space-size=3072 bunx tsc -b packages/ui apps/web --pretty false && bun run --cwd apps/web build:app` | **Passed** | TypeScript exit 0; Vite built 1,661 modules | None for this gate |
| OpenAPI/client | `bun run openapi:check && bun run client:check && bun run arch:openapi-coverage && bun run arch:openapi-provenance` | **Passed** | 2,095/2,095 routes enriched; generated client consistent | None for these static/API gates |
| Architecture/migration static gates | `bun run arch:migration-numbering && bun run arch:migration-compat && bun run arch:tenancy && bun run arch:manifest-mirror && bun run arch:tables && bun run arch:ddl && bun run arch:test-typecheck` | **Passed** | All listed gates exited 0, including tenancy, manifest/table ownership, DDL and test typecheck coverage | Runtime DDL/RLS still required |
| Changed-worktree Biome | `bunx biome check --changed --since main` | **Passed** | Exit 0; no diagnostics after scoped remediation | None for this gate |
| PostgreSQL migrations/RLS/concurrency/outbox | `bun run test:rls:live:m23` | **Blocked; not executed** | Read-only inventory proved the configured DB is in a shared cluster; no destructive test was run | Authorized operator must provision private fresh cluster, export DB URL, then approve hook |
| Runtime M36 recipients/preferences | No approved runtime command/environment available | **Not executed** | Unit tests only; no real membership/preferences database qualification | Qualify in isolated M36 composition |
| Transport safety | Focused notice dispatch/pre-run hold/clearinghouse tests within backend regression run | **Passed (non-live)** | Claim.MD/Stedi `CH_NOT_WIRED`; Direct-MAC artifact-contract hold retained; no transmission | External qualification remains separate and blocked |

Files directly changed by this lot:

- `apps/backend/src/index.ts` — corrected the notice provider-CCN resolver wiring found by strict
  project typechecking; also included in the targeted formatting/import pass.
- `apps/backend/src/modules/23-billing-medicare/routes/medicare-notice-worklist.test.ts` — corrected
  the pagination test helper's generic key typing.
- `apps/backend/src/modules/23-billing-medicare/services/medicare-notice-source-loader.test.ts` —
  preserved the original immutable notice ID in the 8xD fixture.
- `apps/web/src/modules/23-billing-medicare/mac-credentials.tsx` — replaced three paragraph/status
  combinations with semantic `output` status elements and applied its reported Biome formatting.
- 53 additional explicitly Biome-reported changed files — formatting/import organization only.
- This qualification report.

The focused Vitest commands executed were:

```sh
bunx vitest run apps/backend/src/modules/23-billing-medicare/services/medicare-notice-operational-issues.test.ts apps/backend/src/modules/23-billing-medicare/routes/medicare-notice-worklist.test.ts apps/backend/src/modules/23-billing-medicare/services/medicare-notice-source-loader.test.ts apps/backend/src/modules/23-billing-medicare/routes/medicare-notice-issues.routes.test.ts apps/backend/__tests__/gap-069-070-m23-workers.test.ts apps/backend/__tests__/m23-clearinghouse-injection.test.ts packages/messaging/__tests__/permission-holders-resolver.test.ts packages/messaging/__tests__/body-crypto-ring.test.ts packages/messaging/__tests__/body-crypto.test.ts apps/backend/src/modules/23-billing-medicare/services/medicare-notice-renderer.test.ts apps/backend/src/modules/23-billing-medicare/services/medicare-notice-dispatch.test.ts apps/backend/src/modules/23-billing-medicare/jobs/direct-mac-notice-gateway-contract.test.ts apps/backend/src/modules/23-billing-medicare/jobs/m23-pre-run-hold.test.ts apps/backend/src/modules/23-billing-medicare/jobs/clearinghouse-submission.test.ts
bunx vitest run apps/web/src/modules/23-billing-medicare/__tests__/medicare-notices-workspace.dom.test.tsx apps/web/src/modules/23-billing-medicare/__tests__/noe-exception-review.dom.test.tsx apps/web/src/shell/actor-session.test.ts
```

No database or runtime integration defect could be confirmed because PostgreSQL runtime tests were
not executed. The internal release remains **NO-GO** until mandatory real application-role
migration, RLS, concurrency/outbox and recipient qualification pass. External notice transmission
remains **NO-GO** independently.

### Follow-up: CM-4C.4S isolated local PostgreSQL runner (2026-11-15)

Exact implementation snapshot: `develop@9e854663eea41686e17ef31ca78a873875023871` plus the
pre-existing dirty CM-1 through CM-4 worktree and this lot's four modified files listed below. The
dirty tree was not reset, stashed, or committed.

The repository already builds its production PostgreSQL image from `deploy/production/postgres`
(PostgreSQL 18.6; the local Docker cache contains `chartwarden-postgres:dev`). The existing M23 live
suite command was referenced by the CI matrix but had no root `package.json` script. The test file
still intentionally uses `describe.skipIf(!DB_URL)` so ordinary non-live Vitest runs remain opt-in;
that skip made the explicit live command unsafe to trust because it could exit successfully with no
assertions.

This lot adds `scripts/test-m23-rls-isolated.ts` and binds it to the exact command
`bun run test:rls:live:m23`. On invocation it builds a uniquely tagged image from the production
Dockerfile, creates a uniquely named Docker `--internal` network and a single uniquely labeled
container, publishes PostgreSQL only on `127.0.0.1` at a Docker-assigned port, stores `PGDATA` on
container-local tmpfs, starts a fresh UUID-named database with `max_locks_per_transaction=1024`,
and passes `CHARTWARDEN_TEST_DATABASE_URL` explicitly in the actual Vitest child environment. It
does not read/fall back to the caller's `.env` database URL. Before Vitest, a read-only SQL and Docker
inspection verifies PostgreSQL 18, the unique cluster marker and system identifier, a superuser test
connection, exactly the bootstrap `postgres` plus fresh test database, one internal network, one
tmpfs mount, and no persistent volume. Any failed preflight stops before the suite can drop schema or
roles. Vitest's JSON report is inspected and the command fails if zero tests ran, any test failed, or
any were skipped. Cleanup names only the unique container, network, image and temporary report path
created by that invocation; unrelated containers/volumes are not enumerated for deletion.

The live test's own `beforeAll` now independently checks that the **actual Vitest connection** sees
the expected unique database, cluster name, PostgreSQL system identifier and superuser role **before**
`DROP SCHEMA` or role cleanup. This is defense in depth, not a replacement for the outer hook approval.
The existing suite currently contains 17 cases. It is not changed to stop skipping during normal
non-live test runs.

Local read-only environment inspection on 2026-11-15 found Docker 29.7.2 available, with unrelated
containers already running on ports 32855 and 55432. The host-native PostgreSQL 16 cluster on 5432
remains shared and is never targeted by the new runner. No container, network, image, database, or
role was created or removed in this lot. The new live command was **not run**: its required human
approval through `/hooks` has not been granted in this session. Therefore the 17 PostgreSQL tests,
migrations 1491/1492, app-role RLS, actual concurrency, outbox transactions and `claim_ack_file_uq`
collision remain **not executed**, not passed. The M23 live suite covers issue/outbox persistence and
tenant isolation; it does not qualify the full M36 recipient/preferences runtime. Existing M36
recipient unit tests and M23 operational-issue unit tests are reported separately below.

The local authorized run is now reproducible with one command after reviewing/trusting the unchanged
project hook: `bun run test:rls:live:m23`. The command itself owns the private test-cluster lifecycle;
the operator should review its exact target description and grant approval via `/hooks` before
invocation. Do not export the host's `CHARTWARDEN_TEST_DATABASE_URL` or point the suite at
`localhost:5432/wardenx_test`. External notice dispatch remains disabled.

Focused checks executed for this lot:

| Gate | Command | Result | Evidence |
|---|---|---|---|
| Script TypeScript | `bunx tsc -b scripts --pretty false` | **Passed** | Exit 0 after correcting the runner to use standard Node URL/path and timer APIs supported by the scripts tsconfig |
| M36 audience + M23 issue regression | `bunx vitest run packages/messaging/__tests__/permission-holders-resolver.test.ts apps/backend/src/modules/23-billing-medicare/services/medicare-notice-operational-issues.test.ts` | **Passed** | 2 files, 14 tests passed; synthetic unit tests, no database or vendor calls |
| Test typecheck coverage | `bun run arch:test-typecheck` | **Passed** | All 2,878 test files remain assigned to a TypeScript test program |
| Live suite wiring | `bun run arch:live-suites` | **Passed** | 534 live scripts and 536 live files are mapped to package scripts/CI |
| Changed-worktree Biome | `bunx biome check --changed --since main` | **Passed** | 9,163 files scanned, no diagnostics |
| Diff whitespace | `git diff --check` | **Passed** | Exit 0 |
| Full test-tree TypeScript | `bun run typecheck:tests` | **Not completed** | Started shard 1/7, then execution session was interrupted; no pass is claimed |
| Runtime M23 PostgreSQL | `bun run test:rls:live:m23` | **Not executed** | `/hooks` human approval not granted; no destructive operation attempted |
| Runtime M36 recipients/preferences | None | **Not executed** | The M23 RLS suite does not exercise M36 membership/preference delivery; existing unit coverage is not runtime qualification |

Files changed specifically in CM-4C.4S:

- `package.json` — route the existing M23 live-suite script through the isolated runner.
- `scripts/test-m23-rls-isolated.ts` — unique private Docker cluster lifecycle, identity preflight, explicit Vitest environment, nonzero/no-skip report gate and exact-resource cleanup.
- `packages/db/migrations/__tests__/m23-rls-isolation.live.test.ts` — repeat database/cluster/system-identifier/superuser assertions in the Vitest process before destructive setup.
- `docs/audits/clearinghouse-integration/M23_CM4_INTERNAL_RELEASE_QUALIFICATION.md` — record this infrastructure and its unexecuted runtime gate accurately.
