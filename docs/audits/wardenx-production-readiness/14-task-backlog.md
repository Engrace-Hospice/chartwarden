
# 14 — Task Backlog

**0Audit date:** 2026-08-03. Implementation-ready tasks derived from the roadmap. Each is scoped for a focused session where practical. IDs are stable and cross-referenced from the finding reports.

---

## TASK-001 — Boot assertion: no in-memory store bound on a DB boot

- Priority: P0 · Severity addressed: Critical · Phase: 0/1
- Objective: fail boot (not requests) if, with `deps.db` present, any registered seam/eraser/audit impl is backed by a `createInMemory*` store.
- Evidence: ARCH-003/006/007/015; `index.ts:561,1141-1157`, `03-authorization/index.ts:108-109`.
- Files: `apps/backend/src/index.ts`, `bootstrap/seams/registry.ts`, `bootstrap/erasers/registry.ts` (tag in-memory stores with a brand symbol; assert in `onReady`).
- Tests: boot with a fake db + one in-memory registrar → boot throws naming the registrar.
- Acceptance: assertion is part of `arch:fitness` or boot; a planted in-memory binding fails.
- Risk: surfaces the full breadth of Phase 1 work. Rollback: feature-flag the assertion to warn-only for one iteration.
- Complexity: S.

## TASK-002 — Bind Drizzle stores into every seam registrar

- Priority: P0 · Severity: Critical · Phase: 1
- Objective: pass `{db}`/the module's Drizzle store to `registerCarePlanSeams`, `registerAssessmentSeams`, `registerOrderSeams`, `registerDoseSpotSeams`, `registerEmarSeams`, `registerIdgSeams`, `registerSchedulingSeams`, `registerEvvSeams`, `registerDocumentSeams`, and the M5/M6/M10 partial cases (`PatientReader`/`PatientMutator`, admission readers, HOPE readers).
- Evidence: ARCH-003. Pattern to copy: M8 `createDrizzleEncounterReaderStore` (`index.ts:557`), M21 (`:696`).
- Tests: `getSeam("PatientReader").findById` returns a row written via M5 routes; M18 EVV seams read real visits.
- Acceptance: zero argument-less `register*Seams()` for db-backed modules; TASK-001 green.
- Risk: M22 document object store needs a real storage adapter (`SignedUrlStoragePort` has no `src/` impl) — bind a `DegradedError` refusal until it exists, not a Map.
- Complexity: L.

## TASK-003 — Bind Drizzle erase stores into every eraser registrar

- Priority: P0 · Severity: Critical · Phase: 1
- Objective: pass `{db}`-backed erase stores to the 25 registrars called argument-less in `wireModuleErasers` (identity, admission, care-plan, encounter, assessment, hope, orders, dosespot, emar, idg, documents, billing, remittance, medicaid, cap, reporting, quality, cost-report, saas, terminology, messaging, mdm, consent, audit, patient).
- Evidence: ARCH-007; `index.ts:1141-1181`. Pattern: M15/M16/M28 (`deps.db ? {store: createDrizzle…} : {}`).
- Tests: erase a seeded patient subtree → real rows deleted, non-zero certificate.
- Acceptance: store-less erasers refuse on a db boot (TASK-001).
- Complexity: M.

## TASK-004 — Wire the M3 effective-permission resolver into the route mount

- Priority: P0 · Severity: Critical · Phase: 1
- Objective: replace `_fixedPerms([])` with a `createDbEffectivePermissionStore(deps.db)` adapter in `mountAuthorizationRoutes`; delete the route-local `ActorPermissionResolver` abstraction in favor of the live contract seam.
- Evidence: ARCH-015; `03-authorization/index.ts:108`.
- Tests: `GET /me/permissions` non-empty for a seeded admin; an org_admin grants a role live.
- Acceptance: gate 7 partially restored; role editor (TASK-030) becomes possible.
- Complexity: M.

## TASK-005 — Bind `audit: db` on the M3 and M4 route mounts

- Priority: P0 · Severity: Critical · Phase: 1
- Objective: replace `createInMemoryAuditExecutor()` with the Drizzle audit sink (the M2 fix) at `03-authorization/index.ts:109` and `04-audit/index.ts:78`; wire M3 engagement/notifier stores to Drizzle or fail closed.
- Evidence: ARCH-006. Tests: a role grant and an audit-search each produce a durable `audit_event` row. Complexity: S.

## TASK-006 — Build the transactional-outbox dispatcher

- Priority: P0 · Severity: Critical · Phase: 1
- Objective: a polling relay (`SELECT … WHERE status='pending' … FOR UPDATE SKIP LOCKED`), attempt counting + exponential backoff, DLQ after N, a retention purge, and a process/entry point; wire the deferred M22/M33/M14 consumer bindings.
- Evidence: OPS-001; `outbox-persister.ts`, `22-documents/outbox-consumers/bindings.ts:40`.
- Tests: an emitted event reaches a registered consumer; pending depth bounded.
- Acceptance: no unconsumed `pending` growth; a liveness test in CI.
- Risk: coordinate with the worker-topology task (TASK-040). Complexity: L.

## TASK-007 — FORCE-RLS resweep + zero-policy platform tables (migration 0154)

- Priority: P0 · Severity: High · Phase: 2
- Objective: a forward migration re-running 0118's idempotent catalog sweep (FORCE every RLS table) **and** adding `TO wardenx_admin`/`tenant_platform_writer` policies to the 11 zero-policy platform tables — in one migration so the owner path never breaks.
- Evidence: DB-002, DB-004; only 0118/0120/0139 contain FORCE; M28/M35/M37 enable-without-force verified.
- Tests: `SELECT count(*) FROM pg_class WHERE relrowsecurity AND NOT relforcerowsecurity` = 0; the `rls-isolation.live.test.ts:2317` invariant passes on a full replay; Stripe webhook ingest works as a non-owner role.
- Acceptance: gate 8 progresses. Risk: never edit applied migrations — forward only. Complexity: M.

## TASK-008 — Externalize the M13 witness signing key

- Priority: P0 · Severity: High · Phase: 2
- Objective: `M13_WITNESS_SIGNING_KEY` (≥32 bytes) read at boot, added to `bootstrap/env.ts` REQUIREMENTS; dev fallback gated on `NODE_ENV !== "production"`; shared-store single-use burn when clustered.
- Evidence: SEC-001; `emar-route-service-db.ts:75`. Tests: prod boot fails without the key; dev-key token rejected in prod. Complexity: S.

## TASK-009 — Widen the PHI read-audit perimeter to the clinical core, portal, IPU, FHIR

- Priority: P0 · Severity: High · Phase: 2
- Objective: annotate M6–M14/M17/M18/M22 + M31 + M37 GET handlers with `config.auditRead`; add their prefixes to `DEFAULT_READ_AUDIT_PREFIXES`; add `/api/v1/fhir` with disclosure-envelope waivers; flip `read-audit-coverage.test.ts:137` to a positive assertion.
- Evidence: SEC-002/API-004; `bootstrap/index.ts:117-155`. Acceptance: every mounted PHI GET prefix governed; boot fails on a new unannotated PHI read. Complexity: M.

## TASK-010 — Complete production env validation

- Priority: P1 · Severity: High · Phase: 2
- Objective: add `REDIS_URL`, `DATABASE_PLATFORM_URL`, `PASSKEY_RP_ID`/`WEBAUTHN_RP_ID`, `MESSAGING_ENCRYPTION_KEY`, cursor keys, `TRUSTED_PROXY_CIDRS`, and the witness key to `bootstrap/env.ts`; fix the `localhost` passkey fallback.
- Evidence: SEC-005/OPS-010. Tests: prod boot with only today's 6 vars fails closed. Complexity: S.

## TASK-011 — Author M29 and M35 live-RLS suites; add all missing CI matrix rows

- Priority: P1 · Severity: High · Phase: 2/7
- Objective: create `m29-`/`m35-rls-isolation.live.test.ts` (clone m26); add `test:rls:live:{m28,m29,m31,m35,m37}` scripts and ci.yml matrix rows; generate the matrix from `package.json`.
- Evidence: DB-003, TEST-002, OPS-014. Acceptance: Live column full-ratio for 40 modules; every live suite has a CI row. Complexity: M.

## TASK-012 — Split the cosignature ABAC predicate three ways

- Priority: P0 · Severity: Critical · Phase: 3
- Objective: namespace to `m8.cosigner_role_match` / `m9.` / `m11.` (M37 pattern); update the three consumer routes; make the registrar throw (not skip) on a same-name-different-resolver collision.
- Evidence: ARCH-001/002. Tests: RN cosigns an assessment and an order live; a duplicate-name registration fails the gate. Complexity: M.

## TASK-013 — Assemble `providerEntityIds`, `locationIds`, `actorKind`

- Priority: P0 · Severity: High · Phase: 3
- Objective: return membership→provider-entity + location bindings from `resolveActor`/`ActorEnrichment`; stamp them in `authenticate.ts`; add a machine-credential path stamping `actorKind:"system"`.
- Evidence: ARCH-008/009, SEC-004, API-001. Tests: a billing_manager submits a PE-scoped claim; an M20 check-in succeeds; M14 IDG CRUD works; internal system routes reachable only by a real system credential. Complexity: L.

## TASK-014 — Teach `check-table-ownership` the `schema.<table>` style; triage the ~35 escapes

- Priority: P1 · Severity: High · Phase: 3
- Objective: recognize `schema.<ident>` member access (camelCase→snake_case) regardless of import spelling; route M18→M17 `visit` and M30→M3 `role`/`membership_role` through seams or explicit exemptions.
- Evidence: ARCH-017. Tests: the gate flags a synthetic `schema.visit` read from M18. Complexity: M.

## TASK-015 — Register M31's three cast-resolved seams; tighten `check-fitness-gaps`

- Priority: P1 · Severity: High · Phase: 3
- Objective: add `PatientCaregiverReader`/`PatientAddressReader`/`ExternalGriefResourceReader` to `SeamName`/`REQUIRED_SEAMS` with real impls or deny-stubs; delete the `getSeam` cast; make the gate trust only canonical `REQUIRED_SEAMS` and scan aliased getSeam forms.
- Evidence: ARCH-018. Acceptance: the bereavement-resources route returns real data or 501; the gate flags an unregistered portal seam. Complexity: M.

## TASK-020 — Idempotency-Key + If-Match middleware in the shared client; fix the OpenAPI emitter

- Priority: P0 · Severity: Critical · Phase: 1/4
- Objective: teach `scripts/openapi/emit.ts` a `headers` field + `status` (200/201/202/204) in the enrichment shape; add idempotency-key/If-Match handling to `packages/ui/src/core/api/client.ts`; tighten the ratchet to flag body-less mutations.
- Evidence: PARAM-001/002, FLOW-008, API-006. Tests: openapi declares If-Match on every `requireIfMatch` route; a claim submit sends the key. Complexity: M.

## TASK-021 — Repair the M23 claim write workflow

- Priority: P0 · Severity: Critical · Phase: 4
- Objective: a "Re-run validation" action; make override trigger/require a re-run; fix replace/void payloads (reason ≥20 + `ifVersion`); pass step-up through or route to `/step-up?returnTo=`; handle 401/403; wire cursors; persist wizard state.
- Evidence: FLOW-008; depends on TASK-020. Tests: assemble→validate→override→re-validate→submit; replace/void succeed. Complexity: L.

## TASK-022 — De-cast the web/admin API layer to generated types

- Priority: P1 · Severity: High · Phase: 1/6
- Objective: remove the ~275 `as never`/`as unknown as` casts in `19-oncall`/`21-supplies`/`16-bereavement`/`20-field-safety` api files + admin M35 screens; drive types from `packages/ui/src/core/api/schema.ts`.
- Evidence: TYPE-001; depends on TASK-020 (headers). Acceptance: zero such casts in those files; `client:check` green. Complexity: M.

## TASK-030 — Onboarding: transactional email sender + set-password/MFA flow + role editor

- Priority: P0 · Severity: Critical · Phase: 4
- Objective: wire a transactional sender (or admin-visible invite link); build set-password/verify-email/MFA-enroll; add a per-member role editor calling the audited `authz-routes` (unblocked by TASK-004); pending-invite list with rescind/resend; remove the false "Invitation sent".
- Evidence: FLOW-007, SEC-008, report 09. Tests: invite→link→account→role→sign-in end-to-end. Complexity: L.

## TASK-031 — Clinical write ceremonies (sign / cosign / admit / activate)

- Priority: P0 · Severity: Critical · Phase: 4
- Objective: ship the M8 sign+cosign and M6 referral-accept→admission-create→activate write surfaces reusing a shared CeremonyModal + ConfirmDialog + toast; fix the dead `/referrals/:id` route.
- Evidence: FLOW-001/002/003; depends on TASK-012 (cosign), UI primitives. Tests: sign→cosign and referral→admit→activate end-to-end with announced feedback. Complexity: XL.

## TASK-032 — Shared UI primitives: ConfirmDialog, toast, ErrorState+retry, NavLink groups

- Priority: P1 · Severity: High · Phase: 6
- Objective: export the shared Modal/ConfirmDialog; add an aria-live toast region; split ErrorState (role="alert"+retry) from EmptyState; `NavLink`+`navGroup` sections; migrate the 9 module modal copies.
- Evidence: UI-001/002/005/010. Complexity: M.

## TASK-033 — Resilience states + code-splitting + responsive shell

- Priority: P1 · Severity: High · Phase: 6
- Objective: global `onResponse` (401→/expired, 503→/maintenance, offline banner); distinguish outage from logout in `session.tsx`; route-level `React.lazy`; shell breakpoints; overflow-x table containers.
- Evidence: FLOW-004/005/006, UI-004. Acceptance: killing the backend shows an outage state with retry; initial chunk <350 kB; usable at 390px. Complexity: L.

## TASK-034 — Direct-intake admission-create + NOR-acknowledge data-integrity fixes (M6)

- Priority: P1 · Severity: High · Phase: 4
- Objective: fix four defects found live-verifying TASK-031's Activate-gate fix. `POST /api/v1/admissions`
  (direct intake) inserts at the DB's default `status='referred'` instead of `'pending'`, permanently
  stranding the row — `referred`'s only legal transition (`ADMISSION_GRAPH`) is the referral-accept path,
  so a walk-in admission can never advance. The same insert maps the form's `attendingPhysicianId` into
  the `admitted_by_physician_id` column instead of `attending_physician_id`. The required
  `hospiceMedicalDirectorId` input is validated then silently dropped — direct intake never seeds an
  election period, compliance windows, or a CTI draft, so a walk-in admission can never reach the
  activation gate either way. Separately, `POST /admissions/:id/nor`'s service layer never receives the
  validated request body — `deliveryMethod`/`acknowledgedByName`/`acknowledgedByRole`/`formVersionId` are
  parsed by the route then discarded, so the NOR row always records the same hardcoded
  patient/electronic-witnessed facts regardless of what was actually submitted.
- Evidence: `admission-route-service-db.ts` `createAdmission`/`acknowledgeNor`; `m6.cti.drafted`'s
  declared payload (`ctiId, electionPeriodId, isRecert`) doesn't match `draftCti`'s emit (`{ctiId}` only)
  either, the same outbox-payload-schema-drift pattern TASK-031 fixed elsewhere in this module.
- Files: `apps/backend/src/modules/06-admission/admission-route-service-db.ts`, `routes/service.ts`
  (`AdmissionRouteService.acknowledgeNor` signature), `routes/admission-routes.ts` (thread the parsed
  body through), `events-by-m6.ts` (`m6.cti.drafted`).
- Tests: create a direct-intake admission → status `pending`, election period 1 + 4 open compliance
  windows + a draft CTI exist and the CTI carries the submitted hospice-MD/attending ids; acknowledge NOR
  with a non-default method/role → the persisted NOR row reflects it, not the hardcoded default.
- Complexity: M.
- **Status: DONE (2026-08-03, commit `31f75cf` `feat(task-031/034)`, already merged to main).** All
  four defects fixed exactly as scoped: `createAdmission` now runs the same `transitionAdmission`
  state-machine event `acceptReferral` uses (lands on `pending`, not the DB-default `referred`),
  writes `attendingPhysicianId` into the correct column, seeds election period 1 + the compliance
  windows, and drafts a CTI carrying the submitted `hospiceMedicalDirectorId`/`attendingPhysicianId`.
  `acknowledgeNor` now reads `input.deliveryMethod`/`input.acknowledgedByRole` (translated to the
  DB's `election_signer_kind` enum) instead of hardcoded patient/electronic-witnessed defaults.
  `m6.cti.drafted`'s declared payload matches its real emit. This entry was missing a Status line,
  which made the already-done work look unstarted in a later backlog scan — worth double-checking
  git history/source before assuming an unmarked entry is open.

## TASK-040 — Ops substrate: worker entrypoint, readiness probe, metrics, deploy + backup

- Priority: P1 · Severity: High/Critical · Phase: 8
- Objective: a dedicated worker entrypoint + Dockerfile + deploy pipeline; a real `readinessProbe` (DB/Redis/outbox depth); OTel or prom-client + BullMQ metrics; SIGTERM graceful shutdown; construct the M7/M9/M10 cron catalogs; DLQ promotion + alerts; a production migration path + gate; pgBackRest (or equivalent) backup + a restore drill.
- Evidence: OPS-002/003/004/005/006/007/012/013/016. Acceptance: `/ready` flips to 503 on a dead DB; a clean-clone deploy + a restore drill succeed. Complexity: XL.
- **Status (2026-08-03): broken down into TASK-040A…G below** — a 2026-08-03 survey (report
  12-devops-observability-and-operations.md, OPS-001…016) found the plumbing more built than the
  task text implies (TASK-006's outbox dispatcher is fully live, not pending; `/ready`'s 503 logic
  and `ReadinessProbe` type already exist, just unwired) and some areas need real infra/credentials
  this repo doesn't have (an actual deploy target, actual backup storage) and so can only be
  scaffolded, not proven working, in a coding session. Sub-tasks are ordered so the in-repo,
  fully-testable work (A–E) lands first; the infra-scaffolding work (F–G) is separated so it isn't
  mistaken for validated infrastructure.

### TASK-040A — Dedicated worker entrypoint + SIGTERM graceful shutdown

- Priority: P0 · Severity: Critical · Phase: 8
- Objective: extract the BullMQ worker/queue construction block from `apps/backend/src/index.ts`
  (~line 2347 onward: M34/M33/M30/M27/M23/M25/M26 `register*Workers`/`schedule*Jobs`, plus the
  outbox dispatcher) into a standalone entrypoint (`apps/backend/src/worker.ts` or similar) with its
  own `start`/`stop` script, so horizontally-scaled API replicas stop duplicating repeatable-cron
  registration. Add a top-level `SIGTERM`/`SIGINT` handler (repo-wide grep today finds only a stray
  comment at `29-external-interfaces/listener/supervisor.ts:3`, no real handler) that calls
  `app.close()` / the worker-process equivalent so the *already-wired* `onClose` teardown hooks
  (every module's worker/queue close, the outbox dispatcher's `.stop()`) actually fire on a
  container `docker stop`/k8s termination instead of the process being hard-killed.
  N.B. the API process still needs *some* of these (rate-limit Redis store); split carefully so
  request-path Redis usage isn't accidentally moved into the worker-only process.
- Evidence: OPS-002 (no worker entrypoint), OPS-003/OPS-013 (no SIGTERM handling).
- Tests: `bun run src/worker.ts` boots, registers all seven module queues + outbox dispatcher, and
  a `SIGTERM` triggers every registered `onClose` hook (assert via a spy/log) before exit; API
  process boots with zero duplicate queue registration when both processes run against the same
  Redis.
- Acceptance: `apps/backend/package.json` gains a `worker`/`start:worker` script; sending SIGTERM to
  either process drains within a bounded timeout and exits 0.
- Complexity: M.
- **Status (2026-08-03): DONE, not yet committed.** Rather than a literal file-move, `index.ts`'s
  ~1200-line boot block became an exported `bootWardenX(role: "all" | "api" | "worker")` (the
  `import.meta.main` guard now just calls it) — `worker.ts` is a 3-line entrypoint that imports and
  calls it with `role: "worker"`; the BullMQ worker-runner block and the outbox dispatcher are now
  ALSO gated on `role !== "api"` alongside their existing guards. Routes stay mounted in every role
  (cheap, no connections opened) rather than forking the ~1000-line `registerModuleRoutes` closure —
  a documented, deliberate scope cut, not an oversight. Worker role listens on `WORKER_PORT` (default
  3001, `/health`+`/ready` only in practice) so local dev can run both processes on one host without
  a port clash. Verified live against the local demo DB+Valkey (not the RLS-live throwaway cluster —
  this needed the app's normal boot path, not a schema reset): `start:worker` bound :3001, constructed
  all 7 module worker sets, served 200s on `/health`+`/ready`, and a `SIGTERM` logged "draining" and
  exited within 3s; `start` (default `role: "all"`, the historical shape) re-verified regression-free
  the same way on :3000 including a real `/version` route. Gate green (build/arch:fitness/test).

### TASK-040B — Real `/ready` probe: DB, Redis, outbox depth

- Priority: P0 · Severity: Critical · Phase: 8
- Objective: replace `defaultReadinessProbe` (`bootstrap/routes/health.ts:18-22`, hard-coded `"ok"`)
  with a real implementation — DB: a cheap `SELECT 1` against `dbHandle`; Redis: a PING against the
  parsed `queueConnection`; outbox: a pending-row-count query (reuse the same claim-scoped query
  shape as `outbox-dispatcher.ts`) with a depth threshold that flips `outbox` unhealthy past a
  configurable ceiling. Wire it into the `buildServer({...})` call in `index.ts` (~line 1782), which
  today never passes a `readinessProbe` at all.
- Evidence: OPS-004; `health.ts:18-33` (503 branch and `ReadinessProbe` type already exist and are
  correct — this is a probe-implementation + wiring gap, not new plumbing).
- Tests: kill the DB connection mid-test → `/ready` returns 503 with `db:"down"`; stop Redis →
  503 with `valkey:"down"`; seed >N pending outbox rows → 503 with `outbox:"degraded"`; healthy state
  → 200 with all three `"ok"`.
- Acceptance: the task's own acceptance line ("`/ready` flips to 503 on a dead DB") is met — today
  it is not, since the default probe is hard-coded.
- Complexity: S.
- **Status (2026-08-03): DONE, not yet committed.** `bootstrap/readiness-probe.ts` (new) —
  `buildReadinessProbe()`, a pure factory over injected DB/Redis/outbox pings with a per-check
  timeout. `outbox-dispatcher.ts` gained `pendingDepth()`. `index.ts` wires a dedicated long-lived
  `ioredis` health connection + a `SELECT 1` + an `outboxDispatcherRef` forward-reference (the real
  dispatcher instance is built after `buildServer()` returns). Threshold via
  `OUTBOX_READY_DEPTH_THRESHOLD` (default 500). 9 new unit tests + a live-cluster assertion
  (`pendingDepth()` verified against a throwaway local pg18+pgvector cluster, then torn down). Gate
  green.

### TASK-040C — prom-client metrics + `/metrics` route (BullMQ + outbox + HTTP)

- Priority: P1 · Severity: High · Phase: 8
- Objective: add `prom-client`, a `/metrics` route (Prometheus text exposition), default Node
  process metrics, HTTP request duration/count histograms via a Fastify hook, BullMQ queue-depth
  gauges (waiting/active/failed/delayed per queue — reuse the `M*_QUEUES` catalogs already declared
  per module) and outbox dispatcher counters (dispatched/failed/deferred, claim latency). Nothing of
  this exists today (repo-wide grep for `prom-client`/`opentelemetry`/`/metrics` is empty) —
  greenfield.
- Evidence: OPS-005/OPS-006.
- Tests: `/metrics` returns valid Prometheus exposition format; a BullMQ job processed during the
  test run moves the corresponding gauge; an outbox dispatch increments the counter.
- Acceptance: `/metrics` scrapeable, gauges/counters present for every registered queue + the outbox
  dispatcher.
- Complexity: M.
- **Status (2026-08-04): DONE, not yet committed.** `bootstrap/metrics.ts` (new) —
  `buildMetricsRegistry()` (default Node process metrics), `registerHttpMetrics()` (Fastify
  `onResponse` hook; `wardenx_http_requests_total` / `wardenx_http_request_duration_seconds`, labeled
  by the ROUTE PATTERN via `request.routeOptions.url`, never the raw URL — a 404 labels `"unmatched"`,
  both deliberate cardinality guards), `registerBullMQQueueMetrics()` (`wardenx_bullmq_queue_jobs{queue, state}` via prom-client's lazy `collect()` — read from Redis only when `/metrics` is actually
  scraped, no background polling interval to manage/leak), `registerOutboxMetrics()`
  (`wardenx_outbox_events_total{status}` + `wardenx_outbox_tick_duration_seconds` — the latter is the
  documented "claim latency" proxy, since a truer per-row age metric would need touching every
  `outbox-dispatcher.ts` finalize call — + `wardenx_outbox_pending_depth`, reusing the exact
  `outboxDispatcherRef`/`outboxPendingDepth` forward-ref closure TASK-040B already built for the
  readiness probe), `mountMetricsRoute()`. Added a matching `onTick(summary, elapsedMs)` hook to
  `OutboxDispatcherOptions` (the same shape as TASK-040D's `onDeadLetter`). Every registration function
  takes a minimal structural dependency (`QueueLike`, a `pendingDepth` thunk) instead of live
  BullMQ/Redis — same DI convention as `readiness-probe.ts`/`dlq-alerts.ts` — so the whole module unit-
  tests without infra (9 new tests, `bootstrap/__tests__/metrics.test.ts`). The BullMQ queue list is
  DERIVED from every already-constructed `Worker.name` across all 10 live modules (not a separately-
  maintained catalog import list) — self-maintaining as new modules add queues.
  Live-verified against real Redis/Postgres: `/metrics` returned 51 real queues × 5 states = 255
  `wardenx_bullmq_queue_jobs` series (including `care-plan.gates`/`hope.windows`/`hope.sfv`/
  `assessment.*` — TASK-040D's modules), several pre-existing modules' queues showing REAL accumulated
  `failed` counts from their known unbound-port gaps (the exact same failures TASK-040D's DLQ alerts
  already surface, now also graphable), and `wardenx_http_requests_total` correctly reflecting the
  prior scrape on the next one. Adding `/metrics` bumped `bootstrap`'s openapi-coverage baseline
  deficit from 6→7 (re-tightened via `openapi:coverage --update` — a Prometheus text-exposition route
  has no JSON request/response contract to enrich, same posture as `/health`/`/ready`/`/version`).

### TASK-040D — M7/M9/M10 cron catalog wiring + DLQ alerting

- Priority: P0 · Severity: Critical · Phase: 8
- Objective: each module already has a complete queue catalog + pure job logic
  (`modules/07-care-plan/jobs/index.ts` `M7_QUEUES`/`M7_JOB_SCHEDULES`/`M7_QUEUE_PARAMS`;
  `modules/09-assessments/jobs/index.ts` `M9_QUEUES`/…; `modules/10-hope/jobs/index.ts`
  `M10_QUEUES`/…) but none is constructed as an actual BullMQ `Worker`/repeatable `Queue` at boot —
  unlike M27/M23/M25/M26/M30/M33/M34, which follow a `register*Workers`/`schedule*Jobs` +
  `m*-jobs.ts` infra-binding pattern (see `modules/30-quality/jobs/m30-jobs.ts` as the template).
  Build the matching `m7-jobs.ts`/`m9-jobs.ts`/`m10-jobs.ts` files and wire them into `index.ts`
  alongside the existing seven. Separately, add DLQ-promotion alerting: the outbox dispatcher today
  only `log()`s a `☠️` line on terminal `failed` rows (`outbox-dispatcher.ts`) with no external
  signal — add a hook point (webhook/log-based alert, whatever the existing ops-alert mechanism is,
  or a new `onDlqPromotion` callback if none exists) fired for both the outbox DLQ and each new
  module's `M*_DLQ`.
- Evidence: OPS-007 (cron catalogs never constructed — HOPE window/SFV watchdogs and care-plan
  5-/15-day gates currently never fire in production, a live regulatory-clock risk, not just a code
  gap); OPS-012 (DLQ has no alerting).
- Tests: boot with `REDIS_URL` set → `M7_QUEUES.gates`/`M9_QUEUES.cadence`/`M10_QUEUES.windows` (etc.)
  exist as live BullMQ queues with their declared repeatable schedule; a job forced past
  `maxAttempts` lands in the DLQ and fires the alert hook (assert via spy).
  This is the same pattern proposed in the report's evidence — see report 12 for the exact list of
  affected clocks.
- Acceptance: M7/M9/M10 join the seven modules with live cron; a DLQ promotion (outbox or module)
  is externally observable, not just a log line.
- Complexity: L.
- **Status (2026-08-04): DONE, not yet committed.** Migration 0161 adds 4 columns to `care_plan`
  (`admissionActivatedAt`, `initialWarningEmitted`, `reviewDueEmitted`, `reviewOverdueEmitted`); the
  M7 write lifecycle now populates them (bootstrap stamps `admissionActivatedAt`, every `signVersion`
  quorum-met branch recomputes `nextReviewDueAt` + re-arms the two review markers — `gate-clock.ts`'s
  own doc comment said this should already happen on every sign; it never did, so the §7.2 review-gate
  scan would have been permanently a no-op even with a live worker). Each of M7/M9/M10 got a
  `jobs/cron-store.ts` (new org-wide Drizzle readers/writers — none existed before, only per-request/
  per-patient ones) + `jobs/cron-workers.ts` (BullMQ Worker/Queue construction, the M25 template) +
  `wiring.ts` (platform-job allowlist registration), built by 3 parallel agents against a detailed
  shared spec, then wired into `index.ts`'s worker-runner section by hand. Scope cuts, each documented
  inline rather than silently dropped: M7 wires only `gates` (not `idg`/`snapshot`, event-driven);
  M9 wires `license`/`changes`/`cadence` (not `summary`/`eraser`) and `cadence` logs-only (no
  chart-banner cache seam exists yet); M10 wires only `windows`/`sfv` (not `alerts`/`scheduling`/
  `validation`/`submission`/`retention` — those need infra that doesn't exist: cadence-dispatch
  tracking, patient-display-name/CTA-URL resolution, the multi-stage iQIES pipeline).
  DLQ-promotion alerting: `bootstrap/dlq-alerts.ts` (new) — `attachDlqPromotionAlert` (BullMQ
  `Worker.on("failed", ...)`, fires once on the final attempt) + `buildDlqPromotionSink` (log-based
  always-on + optional `OPS_ALERT_WEBHOOK_URL`), applied to EVERY constructed Worker in `index.ts`
  (the new M7/M9/M10 ones AND the 7 pre-existing modules — M23/M25/M26/M27/M30/M33/M34, none of which
  had any DLQ observability before), plus a new `onDeadLetter` hook on the outbox dispatcher wired to
  the same sink. Deliberately NOT routed through M36's `AlertEmitter` (tenant-scoped by type; a DLQ
  promotion is an ops-level failure, not always attributable to one org).
  Verified: full gate green (typecheck/build/arch:fitness/6882 unit tests); live-cluster: migration
  0161 applies cleanly, M7 write-lifecycle + read-service + RLS-isolation suites all pass against a
  throwaway pg18+pgvector cluster, outbox-dispatcher suite passes including the new `onDeadLetter`
  assertion.
  **Docker recovered + full live boot done (2026-08-04).** Restarting Docker Desktop (a hard
  kill+relaunch was needed — the daemon was wedged, not just slow) and booting `start:worker` against
  the REAL local `wardenx-postgres`/`wardenx-valkey` containers caught a genuine bug typecheck/unit
  tests structurally cannot catch: M10's `M10_QUEUES`/`M10_DLQ` used `:` as a namespace separator
  (`"hope:windows"`), which BullMQ's `Worker`/`Queue` constructors reject outright (`:` is reserved for
  BullMQ's own Redis key scheme) — a LATENT defect in that catalog that predates this task; nothing had
  ever constructed a real M10 `Worker` before TASK-040D's `cron-workers.ts` did. Fixed by switching to
  `.` (the M7/M9 convention). Re-verified: boot log shows the exact expected queue counts — `M7 §4.6 BullMQ care-plan.gates cron constructed` (queues:1), `M9 §4.8 BullMQ compliance-scan crons constructed` (queues:3), `M10 §4.8 BullMQ HOPE watchdog crons constructed` (queues:2) — `/health`+
  `/ready` both 200 (`db`/`valkey`/`outbox` all "ok"), and a live `🚨 DLQ promotion [...]` alert line
  fired for real (an M33/M23 pre-existing unbound-port failure, not a new-code failure — proves the
  DLQ-alerting retrofit onto the 7 pre-existing modules works, not just the 3 new ones). SIGTERM drained
  cleanly. The local demo DB was 18 migrations behind (`_wardenx_migration` last recorded 0143) — spot-
  checked across the range (0144/0149-153/0154/0155/0156/0158/0159/0160 target objects all already
  present in the live schema) and baselined the already-applied backlog via `db:migrate:baseline`
  (0161 held out of the migrations dir during baseline, then run for real afterward) rather than
  blindly trusting `--baseline` for a migration that hadn't actually run yet.

### TASK-040E — Production migration path + gate

- Priority: P1 · Severity: High · Phase: 8
- Objective: `scripts/db/migrate.ts` is a solid idempotent runner (checksum tracking, `--baseline`,
  production guard on `WARDENX_APP_PASSWORD`) but its own header explicitly disclaims production use
  and it requires a superuser connection with no rollback semantics. Wrap it in an actual production
  migration path: a non-superuser-scoped invocation (or documented separation of the one-time
  superuser bootstrap from the per-deploy migrate step), and a CI gate that runs migrations against
  a disposable DB as a pre-deploy check (fails the pipeline on migration error, not just on drift
  warning — today checksum drift only warns).
- Evidence: OPS-016; `scripts/db/migrate.ts` header, `WARDENX_OPS_RUNBOOK_v0.1.md`'s reference to a
  `bun --filter @wardenx/db drizzle:migrate` script that doesn't exist in `package.json`.
- Tests: a CI job applies the full migration set to a fresh disposable Postgres and fails the build
  on any migration error; a deliberately corrupted (checksum-mismatched) already-applied migration
  file fails the gate, not just warns.
- Acceptance: the runbook's migration reference resolves to a real script; CI has a migration-gate
  job.
- Complexity: M.
- **Status (2026-08-04): DONE, not yet committed.** `scripts/db/migrate.ts` split into a testable
  core + thin CLI: `applyMigrations(db, opts)` (schema application, no role/credential logic, no
  `process.exit` — throws) and `bootstrapAppRole(db, opts)` (the `wardenx_app` LOGIN/password/
  BYPASSRLS bootstrap), both exported. Kept the honest framing that DDL still needs a superuser/
  owner connection (migration files themselves `CREATE EXTENSION`/`CREATE ROLE`/own tables — not
  something a script can downgrade without rewriting 162 historical files); what's genuinely split
  out is the one thing that touched live credentials on EVERY invocation — `bootstrapAppRole` is
  now a `--schema-only`-skippable, deliberately one-time/rotation-only step, not implicit on every
  deploy. New flags: `--strict` (checksum drift on an already-applied file throws instead of only
  warning — unchanged default for local dev) and `--schema-only` (apply pending migrations only,
  skip the role/credential bootstrap — the actual per-deploy step). New script alias
  `db:migrate:deploy` = `migrate.ts --strict --schema-only`. New live test
  `scripts/__tests__/db-migrate.live.test.ts` (`test:db:migrate:live`) exercises `applyMigrations`
  directly against a throwaway Postgres — full 162-migration chain applies cleanly, a second run is
  a true no-op, `--strict` throws on a deliberately corrupted checksum while default mode only
  warns (all 3 live-verified against a local pg18+pgvector throwaway cluster). New CI job
  `migration-gate` in `.github/workflows/ci.yml` (own disposable Postgres, same
  `max_locks_per_transaction=4096` pattern as `rls-live`): runs the live test, then the real CLI
  end-to-end (`bun run db:migrate`), then corrupts a tracking-table checksum via `psql` and asserts
  `bun run db:migrate:deploy` exits non-zero (inverted-exit-code shell check, since a GH Actions
  step succeeding when failure was expected must itself fail the job) — live-verified locally with
  the same CLI invocations before wiring into the workflow. Fixed the stale
  `WARDENX_OPS_RUNBOOK_v0.1.md` §4.6 reference (`bun --filter @wardenx/db drizzle:migrate` /
  `drizzle.__drizzle_migrations` — neither ever existed) to `bun run db:migrate:deploy` /
  `_wardenx_migration`. Left `WARDENX_SYSTEM_DESIGN_v0.3.md`'s similar `drizzle:migrate` mention
  alone — it sits inside a larger block of pre-existing aspirational/stale doc content (fake dev
  ports, `test:e2e`, `drizzle:studio`) outside this task's named evidence and scope. Gate-verified:
  typecheck, build, `arch:fitness` (all 17 sub-checks), full 6891-test suite (unchanged count — new
  live test skips cleanly without `WARDENX_TEST_DATABASE_URL`), plus the full live proof above
  against a local throwaway pg18 cluster.

### TASK-040F — Dockerfile(s), docker-compose, deploy pipeline skeleton *(infra scaffold, not exercised)*

- Priority: P2 · Severity: Medium (scaffold only — no real deploy target to validate against) · Phase: 8
- Objective: no `Dockerfile`, `docker-compose.yml`, or deploy job exists anywhere in the repo today
  (only ad hoc `docker run`/`docker start` in root `package.json`'s `db:up`/`db:down`). Build a
  multi-stage `Dockerfile` for `apps/backend` (API) and the new worker entrypoint (TASK-040A), a
  `docker-compose.yml` for local dev/CI (Postgres + Redis + MinIO + the two app processes), and a
  `.github/workflows` deploy-pipeline skeleton (build → tag → push, gated behind a `workflow_dispatch`
  or manual approval since there's no real target environment configured in this repo).
  `WARDENX_OPS_RUNBOOK_v0.1.md`'s blue-green + signed-image + SBOM description is the aspirational
  spec; treat this task as scaffolding toward it, not a working blue-green deploy — that needs a
  real cloud target and credentials this session doesn't have.
- Evidence: OPS-002/OPS-003 (Dockerfile), OPS-013 (deploy pipeline).
- Tests: `docker compose up` boots API + worker + deps locally and `/health`/`/ready` respond; the
  CI build job produces an image without pushing anywhere (until a real registry/target is decided).
- Acceptance: a clean-clone `docker compose up` works end-to-end locally. Explicitly NOT claiming a
  validated production deploy — that requires a follow-up task once a real target is chosen.
- Complexity: L.
- **Do not start without the user's explicit go-ahead on target infra** (which registry/host/cloud) —
  this task produces unexercised scaffolding otherwise, per [[git-workflow-local-only]] discipline
  around anything that reaches outside this repo.
- **Status (2026-08-04): DONE, not yet committed.** User picked "full scope, push to GHCR" when
  asked (GHCR needs zero new accounts/secrets — the built-in `GITHUB_TOKEN` is sufficient — so it's
  a real answer to the infra-target question, not a placeholder).
  - **`Dockerfile`** (repo root): ONE image serves BOTH the API and worker roles —
    `bootWardenX(role)` (TASK-040A) is the single composition root, so `index.ts` vs `worker.ts` +
    `PROCESS_ROLE`/`PORT` vs `WORKER_PORT` env is the only difference; `docker-compose.yml`'s
    `api`/`worker` services both build this one image and override `command`. `oven/bun:1.3.5-slim`
    base (verified the tag exists via the Docker Hub API before pinning it — did not guess). Bun
    runs the backend's TypeScript directly (no compile/bundle step), so it's a two-step build:
    `COPY --chown=bun:bun . .` (whole monorepo — Bun workspace `@wardenx/*` deps resolve as
    node_modules SYMLINKS, so the full source tree must be present at `bun install` time, not just
    `apps/backend`) then `bun install --frozen-lockfile`. Deliberately did NOT do manifest-first
    layer caching (COPY every workspace `package.json` before the rest) — with 48 packages + 4 apps
    that COPY list would silently drift as modules are scaffolded; traded cache granularity for a
    COPY that can't go stale. Runs as the image's non-root `bun` user.
  - **`.dockerignore`**: mirrors `.gitignore`'s secret-file glob (`.env`/`.env.*` except
    `.env.example` — same load-bearing pattern that once nearly let a real `.env.bak.<epoch>` into
    a commit) plus `node_modules/`/`dist/` (regenerable) and the editor/AI-tool dirs sitting
    untracked in this working tree (`.claude/`, `.agents/`, `.codex/`, `.cursor/`) so they can never
    reach a build context/image layer.
  - **`docker-compose.yml`**: `postgres` (`pgvector/pgvector:pg18`, matching `db:up`'s image),
    `redis` (`valkey/valkey:8-alpine`), `minio` (`minio/minio:latest`, deliberately NO healthcheck —
    couldn't confirm curl/wget/mc exist in the official minimal image, and a wrong healthcheck
    command would false-negative-block the whole stack, which is worse than no healthcheck; not a
    boot-time dependency for api/worker either way since the S3 adapter binds unconditionally on
    `MINIO_*` and only touches the network per-request), a one-shot `migrate` service (plain
    `bun run scripts/db/migrate.ts`, not the TASK-040E `--strict --schema-only` deploy variant —
    this is a fresh environment, not a per-deploy re-run) that `api`/`worker` depend on via
    `condition: service_completed_successfully` so the stack genuinely waits for real schema before
    serving traffic. All app env vars are committed local-dev placeholders (not secrets) —
    `NODE_ENV=development` throughout, so `bootstrap/env.ts`'s production requirement set doesn't
    apply; only wired the handful of vars this repo's actual local `.env` sets (confirmed by
    grepping ITS VARIABLE NAMES ONLY, never its values) plus the `MINIO_*` contract so M22's real S3
    adapter binds instead of the refusing deny-stub.
  - **Found and fixed a real, independent bug while wiring MinIO**: `.env.example` had documented
    `S3_ENDPOINT`/`S3_ACCESS_KEY`/`S3_SECRET_KEY`/`S3_REGION`, but
    `s3ObjectStoreConfigFromEnv` (`apps/backend/src/modules/22-documents/seams/s3-object-store.ts`)
    actually reads `MINIO_ENDPOINT`/`MINIO_ACCESS_KEY`/`MINIO_SECRET_KEY`/`MINIO_REGION` — the
    documented var names were NEVER READ, so a fresh dev following `.env.example` literally would
    silently get the refusing object-store deny-stub instead of a live MinIO adapter. Fixed
    `.env.example` to the real names.
  - **`.github/workflows/deploy.yml`**: `build` job runs on every push/PR (build-only, never
    pushes — proves the image builds). `push` job runs ONLY on a manual `workflow_dispatch` with its
    `push` boolean input explicitly true, tags+pushes to `ghcr.io/<owner>/wardenx` (one image, one
    tag scheme — same one-image-two-roles reasoning as the Dockerfile). References a `production`
    GitHub Environment with an explicit comment that NO reviewer/branch-protection rules are
    configured on it yet — today this is an unprotected manual trigger, not a reviewed release gate;
    said so rather than implying otherwise.
  - **Left `WARDENX_SYSTEM_DESIGN_v0.3.md`'s aspirational dev-command block alone** (fake ports,
    `drizzle:studio`, `test:e2e`) — same scope call as TASK-040E, a wider pre-existing doc-drift
    problem outside this task's named evidence.
  - **Live-verified a genuine clean-clone `docker compose up`** under an isolated project name
    (`-p wardenx-f-test`, torn down after with `down -v --rmi local`, never touched the pre-existing
    manual `wardenx-postgres`/`wardenx-valkey` dev containers or their ports): `docker compose build`
    succeeded for all 3 images; `up -d` showed `migrate` apply all 162 migrations and exit 0, then
    `api`/`worker` both reached Docker's own `(healthy)` status; `curl` against both processes'
    `/health` and `/ready` returned 200 with **`minio: "ok"`** in the readiness checks (the M22 S3
    adapter genuinely round-tripped against the compose MinIO, not just "didn't crash") and
    `/metrics` served real Prometheus output; worker logs showed all 10 modules' BullMQ workers
    constructed (matching TASK-040C/D's queue counts) plus a real DLQ-promotion alert firing for the
    same known M33 unbound-port stub TASK-040D already surfaces (expected, not a new finding);
    `docker stop` on both drained cleanly via SIGTERM (TASK-040A) and exited 0.
  - Gate-verified: typecheck, build, `arch:fitness` (17/17 — no new routes, so no
    openapi/coverage/client regen needed this time), full 6891-test suite (unchanged — infra config
    files, not application code). YAML syntax of both workflow files + the compose file verified
    parseable.

### TASK-040G — pgBackRest backup config + restore drill *(infra scaffold, not exercised)*

- Priority: P2 · Severity: Medium (scaffold only — no real backup target to validate against) · Phase: 8
- Objective: `docs/architecture/WARDENX_DR_BCP_v0.1.md` §4.1/§8.2 already specifies a thorough
  pgBackRest plan (3-repo config, full/diff/incremental schedule, continuous WAL archiving, monthly
  restore-to-sandbox drill) but it is pure prose — zero implementation (`pgbackrest`/`pg_dump`/
  `wal-g`/`barman` all grep to zero outside the doc). Implement the pgBackRest config + backup
  scripts against the doc's spec, and a restore-drill script that can run against a disposable local
  Postgres (proving the mechanics) even though the doc's 3-repo/S3-off-site topology needs real
  infra to fully exercise.
- Evidence: OPS-014 (per `12-devops-observability-and-operations.md`); `WARDENX_DR_BCP_v0.1.md` §4.1/§8.2.
- Tests: a scripted backup + restore round-trip against a local disposable Postgres reproduces the
  same row counts/checksums as the source.
- Acceptance: the restore-drill script runs and passes locally. Explicitly NOT claiming the full
  3-repo/off-site topology is deployed — that needs real backup storage and credentials.
- Complexity: L.
- **Do not start without the user's explicit go-ahead on target infra** (which backup storage) — same
  reasoning as TASK-040F.
- **Status (2026-08-04): DONE, not yet committed.** User picked "reuse the MinIO from TASK-040F" for
  the off-site (repo3) target when asked.
  - **`scripts/db/backup-restore-drill.ts`** (new — installed `pgbackrest` 2.59.0 via Homebrew to
    build/verify this for real, following the session's live-verify-everything discipline): spins up
    a throwaway local PG18 cluster (own `initdb`, unique port/socket dir), generates its OWN
    repo1-only pgbackrest.conf, seeds 500 deterministic rows into a `drill_probe` table, runs
    `pgbackrest stanza-create` + `--type=full backup`, stops the source cluster, restores into a
    SEPARATE fresh data directory via `pgbackrest restore --pg1-path=<restore-dir>`, starts the
    restored cluster, and asserts row count + an md5 checksum over the ordered rows match the
    source EXACTLY. Wrapped in try/finally so both instances stop and every temp dir/socket dir is
    removed even on failure. **Genuinely a new pattern for this repo**: every other `scripts/db/*.ts`
    only ever talks to Postgres over the wire via the `pg` client; this one has to shell out to real
    OS binaries (`initdb`/`pg_ctl`/`pgbackrest`) since there is no way to drive backup/restore
    through a DB connection alone — used `execFileSync` (array-args, no shell) throughout, never
    string-interpolated into a shell command.
  - **Two real bugs found and fixed by actually running it** (typecheck alone could never have
    caught either): (1) pgBackRest's default connecting role is the CURRENT OS USER (libpq's
    `PQconnectdb` fallback), not `"postgres"` as assumed — `stanza-create` failed with `role "fabrice" does not exist` until `pg1-user=postgres` was added explicitly to the generated
    config. (2) pgBackRest's default `log-path` (`/var/log/pgbackrest/`) isn't writable/doesn't
    exist on a dev machine — added an explicit `log-path` under the script's own temp work dir.
  - **Socket-path-length gotcha reused from TASK-040E's live-migration testing**: the OS tmpdir
    (`/var/folders/.../T/wardenx-backup-drill-XXXXXX` on macOS) can exceed the ~103-byte Unix-socket
    path cap, so the socket directory is a short, separate `/tmp/wardenx-drill-sock-<pid>` path,
    while data/repo directories live under the (longer) proper tmpdir.
  - **Live-verified TWICE in a row** (proving clean, repeatable teardown — no leftover socket dirs
    or work dirs after either run): both runs produced identical checksums between source and
    restored (`a55d9ddcae84cb98cb25bb13aaf70004`), proving the backup+restore round-trip is
    deterministic and correct, not a fluke.
  - **`ops/pgbackrest/pgbackrest.conf.template`** (new): the doc-matching PRODUCTION reference config
    — mirrors `WARDENX_DR_BCP_v0.1.md` §4.1.1's 3-repo example almost verbatim. repo2 (on-prem
    backup VM) is commented out with an explicit note that no such VM exists in any environment this
    repo has ever run in. repo3 (S3-compatible off-site) points at MinIO per the user's go-ahead,
    with an explicit note that pgBackRest's S3 driver needs TLS, which the TASK-040F dev MinIO
    container deliberately doesn't have (matches the app's own zero-dep SigV4 adapter, which is
    plain-HTTP-only too) — so repo3 is documented, not live-exercised; only repo1 (local disk) is
    what the drill script above actually proves. This template is explicitly NOT what the drill
    script runs against — the drill generates its own throwaway repo1-only config; the divergence is
    called out in both files' headers so it doesn't read as an oversight.
  - Fixed `WARDENX_DR_BCP_v0.1.md` §8.2's dead references (`bun test:restore-verify` /
    `packages/db/test/restore-verify.test.ts` — neither ever existed) to point at the real
    `ops/pgbackrest/pgbackrest.conf.template` + `bun run backup:restore-drill`, while being explicit
    that the drill script is NOT a substitute for §8.2's real-schema RLS smoke test (step 5, which
    still doesn't exist — left as an honestly-marked gap, not silently claimed as closed).
  - New `package.json` script `backup:restore-drill`.
  - **Deliberate scope cut, stated explicitly (not silent)**: no CI job for this drill — the
    acceptance criteria is "runs and passes locally," not CI-gated (unlike TASK-040E's migration
    gate, which the objective explicitly required in CI). Installing `pgbackrest` + a real archiving
    Postgres in a GH Actions runner is achievable but adds meaningful CI surface for a P2
    scaffold-only task; flagging it as a legitimate follow-up rather than doing it silently or
    pretending it's out of scope by omission.
  - Gate-verified: typecheck, build, `arch:fitness` (17/17), full 6891-test suite unchanged (this is
    an operational script exercised manually, not a vitest test file)./

## TASK-050 — Test coverage: per-module HTTP smoke suites + real-auth conformance + jsdom

- Priority: P1 · Severity: High · Phase: 7
- Objective: a table-driven inject smoke suite per module (401/403/422/one 2xx); a fitness check requiring one per `routes/` dir; a shared conformance spec across in-memory and Drizzle backends; a jsdom smoke-render across the three registries; planted-violation self-tests for the 4 highest-value un-red-tested gates.
- Evidence: TEST-001/003/004/005. Complexity: L.
- **Status (2026-08-04): broken into TASK-050A–D — L-complexity, spans ~950 route defs across 22
  modules with zero HTTP-layer test, so it cannot land in one pass (same reasoning as TASK-040's
  A–G split).** As of this note only 17/39 modules with a `routes/` dir have a genuine `.inject()`
  smoke suite (`02,03,04,05,06,07,08,09,10,11,12,13,22,36,38,39,40`); the 22 missing are
  `14,15,16,17,18,19,20,21,23,24,25,26,27,28,29,30,31,32,33,34,35,37` — route-def counts per missing
  module range 28–66 (`grep -rEho '\.(get|post|put|patch|delete)\(' <module>/routes | wc -l`).
  - **TASK-050A** — TEST-001, the bulk of the L: a `scripts/report-inject-coverage.ts` ratchet gate
    (mirrors `report-openapi-coverage.ts`'s baseline pattern exactly — same shape as
    `audit/openapi-coverage/baseline.json`) wired into `arch:fitness` as `arch:inject-coverage`,
    seeded with the 22 missing modules as the starting floor so the gate lands green on day one and
    a NEW module can never ship with zero HTTP-layer coverage again; then table-driven
    401(no auth)/403(no permission)/422(empty body)/one-2xx-per-route smoke suites per missing
    module, tightening the baseline (`--update`) as each lands. Expected to span several sessions —
    tracked incrementally, not as one commit.
  - **TASK-050B** — TEST-003: a shared conformance spec run against both the in-memory and the
    Drizzle-backed service per module (session→context binding + 412/409/pagination parity), plus
    one real-session→module-route case added to `auth.live.test.ts`.
    - **Status (2026-08-04): DONE for both stated deliverables, at pilot scope.**
      - **Real-session→module-route case** — a new `it()` in `auth.live.test.ts` wires the actual
        production composition (`createSessionAuthenticate` + `getIdentitySession` +
        `createSessionContextResolver` over `createDbSessionContextStore`, `registerIdentityAuth`
        mounting Better Auth's real HTTP handler) and drives it with a genuine HTTP sign-in (`POST /api/auth/sign-in/email`) → real `Set-Cookie` → `GET /api/v1/auth/context` +
        `GET /api/v1/patients` + `POST /api/v1/auth/select-organization`, all with the SAME cookie,
        no `x-test-user` shim anywhere. Confirms a real hook distinguishes anonymous / authenticated-
        pre-org / authenticated-org-bound (401/401/200+403-then-200) — a state the header shim can't
        even express (it sets `userId`+`organizationId` atomically from one header pair). Live-
        verified: 12/12 tests in the file pass together against a throwaway pg18 cluster.
      - **Shared conformance spec** — new `care-plan-conformance.live.test.ts`, piloted on M7 Care
        Plan: one assertion function (`runConformanceSuite`) drives an identical 401→403→409→412
        HTTP scenario sequence against `createInMemoryCarePlanBackend()` and
        `createDbCarePlanRouteService()` in turn, asserting byte-identical status codes + error
        codes (`ONE_ACTIVE_PLAN_PER_ADMISSION` 409 on `bootstrapCarePlan`'s duplicate-plan guard;
        `STALE_VERSION` 412 on `patchProblem`'s optimistic-concurrency check) from both. 8/8 tests
        pass (4 per backend). M7 was chosen because both dimensions are real, independently-
        implemented behaviors on this module today (a `Map` scan vs. a `SELECT` + partial unique
        index) — unlike Idempotency-Key handling, which is a single M1 platform plugin shared by
        every route regardless of service backend, so it can't drift between backends by
        construction and isn't a useful conformance dimension.
      - **Explicit scope cut, not silently claimed as done**: PAGINATION-cursor parity is NOT
        covered — M7's list routes hardcode `nextCursor: null` in both backends (no real
        pagination on this module). M5 Patient census has real cursor pagination proven on the
        Drizzle side already (`auth.live.test.ts`'s own M5 census case) and is the natural next
        pilot for that third dimension. Extending this pattern to more modules (M5 for pagination;
        any other module for its own 409/412 pair) is follow-up work, not started.
  - **TASK-050C** — TEST-004: a jsdom vitest project (web/portal/admin all currently `environment: "node"`, no jsdom/RTL declared anywhere) + a registry-driven smoke-render of every `screens.ts`
    entry across the three SPAs.
  - **TASK-050D** — TEST-005: planted-violation (goes-red) self-tests for the 4 highest-value
    currently-un-red-tested gates (`abac-predicates`, `design-tokens`, `ui-parity`, `client:check`),
    added to `scripts/__tests__/fitness-gates.test.ts` alongside the existing 6.
  - Do this work in 050A→050D order — 050A is the highest-severity finding (TEST-001, P1) and its
    ratchet-gate pattern is the template TASK-050D's own planted-violation tests will exercise.
  - **Status (2026-08-04): 050A infra + first batch DONE.** `scripts/report-inject-coverage.ts`
    (mirrors `report-openapi-coverage.ts`'s ratchet exactly) landed wired into `arch:fitness` as
    `arch:inject-coverage`, seeded at 22/39 missing so the gate was green from commit one. First
    batch of 6 modules now covered (23/39, up from 17/39): M14 IDG (27/27 routes, 9 tests), M15
    Discipline Care Plans (28/28, 32 tests), M16 Bereavement (33/33, 10 tests), M17 Scheduling
    (29/29, 19 tests), M18 EVV (25/25, 28 tests), M19 On-Call (38/38, 10 tests) — 108 new tests,
    all green together, `arch:fitness` green, full suite 6999 passing (was 6891). Baseline
    re-tightened to the remaining 16 modules:
    `20,21,23,24,25,26,27,28,29,30,31,32,33,34,35,37`.
    - **Real defects surfaced purely by driving the route layer for the first time** (exactly what
      TEST-001 predicted a pure-function test can't catch):
      - M17 `SchedulingRouteService.publishProposal` has an admitted placeholder bug
        (`assignedMembershipId: proposal.id` — the module's own comment says the real value should
        come from the proposal). Not fixed here (out of TASK-050's scope); worth its own task.
      - M14's in-memory backend mints non-UUID sub-resource ids (`idg-att-00000001`) while every
        `:id` route param validates `format: "uuid"` — 10 of 27 routes 422 on a fully-permissioned,
        well-formed call and were asserted as such (not faked to 2xx). M18 hit the same class of
        bug in its own in-memory backend and worked around it in-test (documented inline) rather
        than leave routes uncovered. M11's in-memory backend avoids this by minting
        UUID-shaped ids from the start — worth retrofitting M14/M18 (and checking the rest) to
        match that convention. Candidate follow-up: TASK-051 "in-memory test backends must mint
        uuid-shaped ids to match TypeBox `format: uuid` params."
    - Modules without a module-exported in-memory backend (M15, M16, M19 — unlike M11/M14/M17/M18)
      got a hand-rolled in-memory service built inside the test file against the module's real
      service interfaces; each documents this choice inline. M15/M16/M19 also had to stub the
      M3-owned `step_up_recent` predicate locally (a fresh predicate registry per test starts
      empty) to get genuine 2xx coverage on step-up-gated routes rather than leaving them
      permanently 403.
    - Remaining 16 modules + 050B/C/D are follow-up work (multi-session, per the ratchet design —
      each new suite lands as a `--update` that tightens the floor further).
  - **Status (2026-08-04): 050A batch 2 DONE — 8 more modules covered (31/39, up from 23/39).**
    M20 Field Safety (30/30 routes, 8 tests), M21 Supplies (37/37, 8 tests), M23 Billing Medicare
    (43/43, 47 tests), M24 Billing Medicaid (39/39, 42 tests), M25 Remittance (31/31, 35 tests),
    M26 Cap (27/27, 10 tests), M27 Cost Report (45/45, 48 tests), M28 FHIR Gateway (32 tests,
    honest non-2xx on Phase-1 deny-stub routes) — 230 new tests, all 14 inject suites (batch 1+2)
    green together, `arch:fitness` green, full suite 7229 passing (was 6999). Baseline
    re-tightened to the final 8 modules: `29,30,31,32,33,34,35,37`.
    - **More real defects surfaced, same TEST-001 mechanism (routes driven through `.inject()` for
      the first time):**
      - **M23 (high severity):** the three rule-config mutation routes (`POST /billing/rule-configs/custom`, `PATCH .../{id}`, `DELETE .../{id}`) are **unreachable for
        every caller, including org_admin** — `RULE_PROTECTED`'s default `getTarget` maps the
        route's `:id` onto `ruleConfigId`, but `regulatory_required_rule_protected`'s
        `resolveRuleKey` only ever reads `ruleKey`/`validationResultId`, never `ruleConfigId`, and
        the resolver has no bridge method — so the predicate fail-closed-denies universally,
        surfacing as 404 (`notFoundOnDeny: true`). This is the M30 dead-`inOrg` class TEST-001
        predicted: correct predicate logic, broken wiring, invisible to any pure-function test.
      - **M26 (security-relevant):** `PATCH /cap/periods/:periodId/reopen` still requires (and
        accepts) a client-supplied `stepUpAssertionId` — the exact "caller asserts its own
        re-authentication" pattern the module's own `m26-typebox.ts` header says was deliberately
        removed from its two other step-up contracts, but a third contract
        (`ReopenCapPeriodRequest`) was missed and no server code even reads the field.
      - **A third `*-typebox.ts` self-registration gap** (after M25 — see above): `m26-typebox.ts`
        also doesn't register its own TypeBox string formats, relying on load order the same way.
        Worth a repo-wide sweep of every `*-typebox.ts` for this pattern — candidate TASK-052.
      - **M27:** `cost_report_period_active` guard is exported but composed into zero routes —
        dead code, not a defect, but worth a cleanup pass.
    - Remaining 8 modules for 050A + 050B/C/D are the last follow-up work.
  - **Status (2026-08-04): 050A COMPLETE — batch 3 (final 8 modules) landed, 39/39 modules now
    covered (was 31/39).** M29 External Interfaces (33/33 routes, 28 tests), M30 HQRP/Quality
    (60/60, 63 tests), M31 Portal (53/53, 59 tests), M32 AI Platform (32/32, 18 tests), M33
    Reporting (42/42, 24 tests), M34 SaaS Tenant Platform (48/48, 17 tests), M35 Subscription
    (54/54, 58 tests), M37 IPU (45/45, 15 tests) — 282 new tests. All 22 inject suites (620 tests)
    green together, `arch:fitness` green, full suite 7511 passing (was 6891 before 050A started).
    `TASK-050A is DONE` — every module with a `routes/` dir now carries a genuine `.inject()`
    HTTP-layer smoke suite; the ratchet baseline is empty (0 modules missing) and the gate now
    enforces "no new module ships without one" going forward with zero slack.
    - **Full defect list surfaced by TASK-050A, ranked by severity — none fixed here (out of scope
      for a coverage task), all documented inline in the relevant test file and here for
      follow-up:**
      1. **[SEVERE] M37 IPU** — `RN_COVERAGE`'s `getTarget: () => ({})` never reads the request,
         so `rn_coverage_active` always evaluates against an empty target and denies
         unconditionally. **Open admission, request-bed, assign-bed, initiate-transfer, and
         restraint are unreachable for every caller today, including a fully-permissioned,
         step-up-satisfied actor** — nobody can open an IPU admission through the API right now.
      2. **[SEVERE] M31 Portal** — `POST /portal/sessions/select-patient` reads its ABAC target
         from `context.attributes.portalPatientId`, which only gets populated by this route
         succeeding — a bootstrapping deadlock that blocks a fresh portal session from ever
         selecting its first patient.
      3. **[SEVERE, compliance] M31 Portal** — `write.routes.ts`'s local `MedSummaryArm` types the
         redaction flag `redacted?: boolean`, but the real upstream DTO
         (`PortalMedicationSummary`) names it `isRedacted`; the mismatch is hidden behind an
         unchecked cast, so the "exclude SUD-redacted orders from caregiver attestation" check is
         a permanent no-op — same field-name-drift class as the M16 bug found in a prior audit.
      4. **[HIGH] M31 Portal** — `POST /portal/documents/upload-init` hardcodes
         `magicBytes: []` into a function that unconditionally magic-byte-checks, so every
         upload-init call 415s regardless of a valid file — blocks all portal document uploads.
      5. **[HIGH] M23 Billing Medicare** — 3 rule-config mutation routes unreachable for every
         caller including org_admin (see batch-2 note above).
      6. **[MEDIUM] M33 Reporting** — `GET /reporting/dashboards/:dashboardId` has no `getTarget`
         override on its `dashboard_visibility` guard, so it reads `target.viewId` off a param
         that only carries `dashboardId` — unconditional 403, even for the dashboard's own owner.
         **Second instance of the "correct predicate, no `getTarget` override" class** (after
         M23) — worth a dedicated sweep of every route composing a predicate with
         resource-scoped semantics for a missing/wrong `getTarget`. Candidate TASK-053.
      7. **[MEDIUM, security] M26 Cap** — cap-period reopen still accepts a client-supplied
         `stepUpAssertionId` (see batch-2 note above).
      8. **Third `*-typebox.ts` FormatRegistry gap** already counted at batch 2 (M25, M26) — no
         new instances in batch 3; M29/M30(N/A, no format)/M32/M34/M35 were all checked clean.
      9. **[LOW] M30 + M27** — `actorHoldsPermission()` reads `context.attributes.permissions`,
         which is never populated anywhere in `packages/auth/src` — the "OR holds an admin
         permission grant" branch of several predicates (`ownsQapiProject`, `ownsSraCycle`,
         `incidentVisibility`, `abuseAllegationAccess`) is unreachable in production. Not a
         lockout (the ownership-based branch still works) but dead-by-construction.
      10. **[LOW] M34 SaaS Platform** — DSAR fulfill/extend/deny/download routes' target-mapper
          defaults to `request.params` (never carries `patientId`), so a non-org_admin caseload
          member fail-closes there — an existing gap the route file's own comments acknowledge.
      11. **[LOW] M27 Cost Report** — `cost_report_period_active` guard exported, composed into
          zero routes (dead code).
      12. **[Test-infra note, not a product bug] M33** — `light-my-request`'s `Response.end`
          doesn't reproduce Node's `http.ServerResponse.end(callback)` single-arg overload
          detection, so `.inject()` cannot smoke-test the CSV-export route that relies on it
          (`csvSinkOf(reply).end(resolve)`); asserted the real rejection rather than faking a pass.
    - **Candidate follow-up tasks**: TASK-051 "fix the universal-deny ABAC-wiring bugs (M23, M33,
      M37, plus the M31 select-patient deadlock)" — P0 given M37 blocked all admissions and M31
      blocked portal onboarding entirely; TASK-052 "sweep every `*-typebox.ts` for missing
      `FormatRegistry` self-registration"; TASK-053 "audit every `getTarget` on a resource-scoped
      ABAC predicate for a missing/wrong param mapping" (the M23/M33 class).
      - **TASK-051 status (2026-08-04): DONE — all four (M37, M31, M23, M33).**
        - **M37 RN_COVERAGE** (`routes/guards.ts`, `routes/ipu.routes.ts`,
          `routes/service-drizzle.ts`): removed the broken preHandler entirely — `requireAbac`'s
          `getTarget` is synchronous and can never query the materialized
          `ipu_rn_coverage_window` table, so no fix at the guard layer was possible.
          `openAdmission`/`requestBed`/`initiateTransfer` already independently re-derive and
          enforce coverage inside the write transaction (an async query is legal there);
          `applyRestraint` did not, and now does (mirrors the exact same query pattern, `arranged`
          exempt per §2.3). `assign-bed` never needed the check (the state machine gates coverage
          one step earlier, at request-bed). Live-verified against a throwaway pg18 cluster: all 7
          `m37-ipu-write.live.test.ts` cases pass, including 2 new ones added to prove
          `applyRestraint`'s new check both ways (covered → succeeds; uncovered → 412). Rewrote
          `ipu-inject.test.ts`'s "RN_COVERAGE-gated routes" describe block (previously asserting
          403) to assert genuine 2xx.
        - **M31 select-patient**: removed the redundant, broken `ABAC_GRANT` preHandler from this
          one route (`session.routes.ts`) — the handler already independently re-derives and
          checks the identical invariant correctly, against the request body
          (`store.activeGrant(org, portalAccountId, patientId)` → `ForbiddenError`), which a
          not-yet-org-bound session's `context.attributes.portalPatientId` could never satisfy.
        - **M31 SUD-redaction field-name drift**: deleted the local `MedSummaryArm` structural
          type in `write.routes.ts`; imports and uses the real `MedicationOrderProvider`/
          `PortalMedicationSummary` types from `@wardenx/types` instead, closing the drift class
          rather than just renaming the one field.
        - **M31 upload-init magicBytes**: `write-paths/document-upload.ts`'s magic-byte guard now
          skips (does not fail) when `magicBytes` is empty, honoring the two-phase design the
          function's own doc comment already promised (declared-MIME-only check at init; magic
          bytes checked later, if ever available — M31 never holds the bytes itself, per §1.2 (b)).
          A caller that does have real bytes still gets a real check (verified: MIME-allowlist
          rejection at 415 still works).
        - All 3 M31 fixes live-verified via the full portal test suite (7 files, 179 tests) plus a
          rewritten `portal-inject.test.ts` "fixed findings" block that proves each fix positively
          AND proves the surrounding checks still refuse illegitimate input (not a rubber stamp).
        - Full-suite regression: build clean, `arch:fitness` green, 7518 passing (was 7511).
        - **M23 rule-config mutations (2026-08-04): FIXED.** Root cause was a missing bridge, not a
          missing guard: `RULE_PROTECTED`'s default `getTarget` (`targetRuleConfigId`) correctly
          projected PATCH/DELETE's `:id` onto `ruleConfigId`, but `regulatory_required_rule_protected`'s
          `resolveRuleKey` (abac-predicates.ts) only ever read a target's `ruleKey` or
          `validationResultId` — never `ruleConfigId` — and `ReadingM23AbacResolver`
          (abac-resolver-drizzle.ts) had no method to bridge the two, so `resolveRuleKey` always
          returned `null` and the predicate's own fail-closed rule denied every caller. Fixed by (1)
          adding `loadRuleConfig` to the resolver (loads the overlay row's rule key by id under RLS)
          and threading it into `resolveRuleKey` as a third resolution path, and (2) giving the
          CREATE route (`POST .../rule-configs/custom`, which has no `:id` — nothing exists yet to
          load by id) its own target mapper, `targetRuleKeyFromBody`, targeting the rule key being
          created directly. `billing-medicare-inject.test.ts`'s 3 previously-404-asserting cases now
          assert their real 201/200/204.
        - **M33 dashboard-detail (2026-08-04): FIXED.** `dashboards-tiles.routes.ts`'s `VISIBILITY`
          composed `dashboard_visibility` with NO `getTarget` override, so it evaluated against the
          default target (`request.params`, carrying `{dashboardId}`) — but the predicate
          (abac-predicates.ts) reads `target.viewId`, which was never present, so it denied
          unconditionally for every actor including the dashboard's own owner. The sibling
          `views-shares.routes.ts` already had the correct pattern (`{viewId: params.id}`) two files
          over; `VISIBILITY` now does the same (`{viewId: params.dashboardId}`) plus
          `notFoundOnDeny: true` (existence non-leak, matching the sibling). `reporting-inject.test.ts`
          needed a seeded saved-view fixture (the READ dashboard catalog and the WRITE views store are
          two independent in-memory stores in this test file) so the fix could be proven end-to-end,
          not just at the route layer; its "KNOWN BUG" 403 case is now two "fixed finding" cases (owner
          reaches 200; a dashboard id with no matching view still 404s).
        - Full-suite regression: build clean, `arch:fitness` green, full suite 7809 passing (was
          7808; net +1 — M23's 3 cases kept their labels, M33's 1 case became 2).
    - TASK-050B (shared in-memory/Drizzle conformance spec) is DONE (pilot scope, see above).
    - **TASK-050C (TEST-004, jsdom smoke-render) is DONE (2026-08-04).** Root `vitest.config.ts`
      gained a jsdom carve-out (`environmentMatchGlobs: [["apps/**/*.dom.test.tsx", "jsdom"]]` —
      functional but flagged deprecated by vitest 3.2 in favor of `test.projects`; left as-is since
      migrating risks the other ~7500 tests for a cosmetic warning, noted as a follow-up) +
      `@vitejs/plugin-react` + a shared `vitest.setup.dom.ts` (jest-dom matchers, `afterEach(cleanup)`).
      New devDeps: `jsdom`, `@testing-library/react`, `@testing-library/jest-dom`,
      `@vitejs/plugin-react`. One `*.dom.test.tsx` per SPA — `apps/web/src/shell/screens-smoke.dom.test.tsx`
      (253 cases), `apps/portal/__tests__/screens-smoke.dom.test.tsx` (14), `apps/admin/__tests__/screens-smoke.dom.test.tsx`
      (15) — each **registry-driven**: `import.meta.glob`-discovers every module's `screens.ts` (web/admin)
      or reuses the existing `portalScreens` registry (portal), mounts the real app shell
      (`AppShell`/`PortalApp`/`AdminApp`, not a hand-built harness) once per registered route with a
      concrete UUID substituted for every `:param`, and asserts it settles (no leftover
      `LoadingSpinner`, no ErrorBoundary/react-router-default-error fallback, non-empty DOM).
      apps/web/tsconfig.json needed `"types": ["vite/client"]` for `import.meta.glob`'s ambient type
      (only apps/web's test lives inside its `tsc -b`-checked `src/`; portal/admin's live under
      `__tests__/`, outside their `include`).
      - **Two stubbing gotchas, both fixed in the harness, neither an app bug**: (1) jsdom's
        `Request`/`fetch` have no `document.baseURI` to resolve a relative `/api/v1/...` URL against
        (`new URL()` throws) — fixed with an explicit `baseUrl: "http://localhost"` on the test-only
        `createApiClient`. (2) Better Auth's client (`authClient.getSession()`/`passkey.*`, called
        directly by 5 identity/messaging/search screens, bypassing `@wardenx/ui`'s typed client)
        calls the global `fetch` itself; jsdom ships its own `AbortController`/`AbortSignal` (DOM
        event aborting) that is a DIFFERENT class than the one Node's real undici-backed fetch
        checks `RequestInit.signal` against, so it threw `RequestInit: Expected signal... to be an instance of AbortSignal` the moment Better Auth aborted a stale request — fixed by
        `vi.stubGlobal("fetch", ...)` in each test file's `beforeEach` (no production code changed).
      - **The stub response is a 404, not a 200-with-empty-`{}` body** — deliberately: every real
        backend 200 satisfies its TypeBox response contract, so an empty-object body is a shape no
        real endpoint ever returns; it only trips `(data as T) ?? null`-style unchecked casts into
        rendering with every field `undefined` (a synthetic crash no real deployment can hit, first
        seen on `apps/portal/src/screens/account.tsx`'s `humanize(ctx.relationship)`). A 404
        exercises the same "can't load right now" path every screen already defends against instead.
      - **A false-positive lesson**: the first crash-detection assertion queried any
        `[role="alert"]`, which also matches legitimate inline validation alerts (e.g. staff-management's
        "No active organization is bound to your session.") — narrowed to a dedicated
        `data-wardenx-error-boundary` marker added to `packages/ui/src/web/components/error-boundary.tsx`'s
        fallback (the ONLY safe way to detect it — `ServerError`'s own M1 `/error` system page
        legitimately headlines the identical "Something went wrong" text the ErrorBoundary fallback
        uses, so a text match false-positived on that route too).
      - **Two real, pre-existing bugs found and fixed** (both the same class: an error branch that
        sets an error message but never clears the `null`-means-still-loading sentinel, so the
        `LoadingSpinner` spins forever alongside the error text instead of settling): M2
        `security-passkeys.tsx`'s `load()` on a `listUserPasskeys()` error, and M2
        `staff-management.tsx` in TWO places — the `useEffect` when `authClient.getSession()`
        resolves with no bound org, and `load()` on a `members` fetch error. Both real production
        UX bugs (a genuine backend hiccup left the screen stuck on a spinner forever), not artifacts
        of the stub. Every OTHER screen across all 3 apps rendered clean on the first stub-fetch
        pass with no code changes.
      - Full-suite regression: build clean (`apps/web/tsconfig.json`'s new `vite/client` types didn't
        regress anything else), `arch:fitness` green (39/39 inject-coverage held, ui-parity/openapi
        ratchets held), full suite 7800 passing (was 7518; +282 = 253+14+15 new dom tests).
    - **TASK-050D (TEST-005, planted-violation self-tests) is DONE (2026-08-04).** Added 4 RED
      tests + 4 matching GREEN-baseline tests to `scripts/__tests__/fitness-gates.test.ts` for the
      4 highest-value previously-un-red-tested gates: `abac-predicates`, `design-tokens`,
      `ui-parity`, `client:check` (was 6/17 gates red-tested, now 10/17). One new fixture dir each
      under `scripts/__fixtures__/`: `abac-predicates/` (a `requireAbac(..., "totally_unregistered_predicate")`
      nothing declares), `ui-parity/` (a `screens.ts` that exists but the fixture's `main.tsx` never
      registers — the M30/M39 import-without-register failure class), `client-check/` (a
      `packages/ui/src/core/api/schema.ts` deliberately stale relative to the fixture's
      `docs/api/openapi.json`).
      - **`design-tokens/` needed one production-code change**, not just a fixture:
        `check-design-tokens.ts` deliberately roots itself off its OWN file location
        (`dirname(fileURLToPath(import.meta.url))`), not `process.cwd()` — unlike every other gate
        here — specifically so it always validates the real repo no matter what directory it's
        invoked from. That means the fixture-dir-as-cwd trick every other red test uses can't reach
        it. Fixed by adding a `WARDENX_FITNESS_ROOT` env-var override (falls back to the
        `import.meta.url` root when unset, so every real invocation is unaffected) rather than
        duplicating the ~115-line script into the fixture tree (which would silently drift from the
        real script on the next edit). The fixture itself plants a raw hex literal in a
        `apps/web/src/*.tsx` file, with a matching `index.css`/`colors.ts` pair so only Rule 1
        (raw-color-in-render) trips, not Rule 2 (source-of-truth sync) too.
      - `client:check` is a raw shell pipeline in `package.json`, not a standalone script file, so
        it got its own test runner (`clientCheck()`) instead of reusing `gate()`: the
        `openapi-typescript` binary is invoked by absolute path (`node_modules/.bin/...` — running
        it via `bun run` would resolve against the wrong tree once cwd is swapped to the fixture),
        and each call writes its diff target to a dedicated `/tmp/wardenx-client-schema-fixture-*.ts`
        file so a concurrent real `client:check` run can never race it.
      - All 8 new tests passed on the first real run (no fixture rework needed). Full regression:
        build clean, `arch:fitness` green, full suite 7808 passing (was 7800; +8).
      - **TASK-050 (all of A/B/C/D) is now fully complete.**

## Lower-priority (P2/P3) tasks

- TASK-060 (P2): extract `@wardenx/money`; converge the three kernels (ARCH-021).
  - **Status (2026-08-04): DONE, merged to main locally (`0792ef4`).** Extracted the byte-identical
    `toDecimal`/`fromDecimal`/`sumCents`/`ratio`/`allocateProportional` kernel — previously copied
    verbatim into `packages/billing/src/domain/money.ts` and `packages/cost-report/src/domain/money.ts`
    — into `packages/shared/src/money/kernel.ts`, exposed as the `@wardenx/shared/money` subpath export
    (precedent: `@wardenx/auth`'s `./client`, `@wardenx/db`'s `./schema`). Both module files now
    `export * from "@wardenx/shared/money"`; billing keeps only its module-specific rate primitives
    (`perDiemAmountCents`/`lineChargeCents`/`applyWageIndexFactor`/`applySequestration`), cost-report's
    file is now a pure re-export (it had no module-specific additions). `packages/cap-management/src/
    money.ts`'s `roundCents` — a differently-implemented but behaviorally-identical half-away-from-zero
    rounding (verified equivalent to `decimal.js` `ROUND_HALF_UP`) — now delegates to the shared kernel
    too; its `ratio`/`round4`/`asPercent`/`clamp` stay local since they operate on plain-`number`
    fractions with a zero-denominator-returns-0 convention, genuinely different from the shared
    Decimal-returning `ratio` (throws on zero) — not a duplicate to converge. `decimal.js` moved from a
    direct dependency of billing/cost-report to `@wardenx/shared` alone (only consumer post-refactor).
    No manifest/dependency-cruiser change needed — `packages/shared` was already a LEAF_PACKAGE
    importable by every module without a `dependsOn` edge. Full regression: build clean, `arch:fitness`
    green, full suite 7809 passing (unchanged pass count — all three money test files pass unmodified
    against the new re-exported symbols).
- TASK-061 (P2): decimal-string money in M25 events; integer-cents aging sums (PARAM-003).
  - **Status (2026-08-04): DONE, merged to main locally.** Fixed all 4 cited edges. (1)
    `events-by-m25.ts`'s shared `money` TypeBox alias changed from `Type.Number()` to
    `Type.String({ description: "Decimal string — never a float" })`, converging onto the identical
    convention already used for the same field names on the HTTP read side (`m25-typebox.ts`,
    `read-service.ts`) — every backing column is `numeric(12,2)`, never `bigint` cents, so a decimal
    string (not the `@wardenx/shared/money` integer-cents kernel) is the correct wire type here; the
    one live producer (`write-service-drizzle.ts`'s write-off-denial `prAmount` stub) updated from the
    now-invalid literal `0` to `"0.00"`. (2) `read-service-drizzle.ts`'s `denialMetrics` aging-total
    float accumulator (`totalDollar += Number(row.dollar)`) replaced with a `RegulatoryDecimal`
    accumulation (`@wardenx/shared/money`) so up to 100k open-denial dollar values sum exact, not
    float-drifted, before `.toFixed(2)` — the response contract already declared this field a decimal
    string, so the implementation now actually earns that claim. (3)
    `cap-projection-adapter.ts`'s `projectedCents` (`Math.round((pct/100) * Number(str))`) rewritten as
    `fromDecimal(new RegulatoryDecimal(str).times(pct).div(100))` — decimal-exact before rounding,
    gates real M23 claim submission. (4) the "decimal-aware weight kernel":
    `packages/cap-management/src/domain/methodology.ts`'s `agencyAllocatedCap` summed its
    `beneficiaryWeights` (up to ~5,000 `numeric(7,6)` proportional weights) via plain-float
    `Array.reduce`; changed to a `RegulatoryDecimal` accumulation with the final cents multiply done in
    the same decimal domain (`fromDecimal(unitsDecimal.times(perBeneficiaryCapCents))`) — covers both
    `write-service-drizzle.ts` call sites (`recompute` calls `agencyAllocatedCap` directly;
    `proposeSettlement` via `computeSettlement`). Left `Number(a.weight)`/`Number(period.inpatientCapPct)`
    at the Drizzle-row boundary unchanged (precision(7,6)/(5,4) values are not lossy at that single-value
    parse; the audit's flagged risk was the vector *summation*, not the individual-value parse).
    **Found but explicitly out of scope, not fixed**: M26's `handleRemittancePosted` consumer
    (`26-cap/consumers/handlers.ts:41-56`) reads field names (`p.paidAmountCents`,
    `p.remittanceLineId ?? p.remittanceAdviceId`, `p.serviceFrom ?? p.serviceFromDate`) that don't
    exist on the actual `m25.remittance.advice_posted` payload shape at all — a pre-existing,
    independent event-shape-drift bug (not float-vs-string), currently silent because nothing live
    produces this event yet (no x12-worker in this repo snapshot). Worth its own follow-up task before
    M25↔M26 remittance wiring goes live. Full regression: build clean, `arch:fitness` green, full suite
    7809 passing (unchanged count — all touched test files pass unmodified).
- TASK-062 (P2): join the AI capability catalog three ways + seed path (ARCH-019).
  - **Status (2026-08-04): DONE, merged to main locally.** Both remediation halves. (1) **Three-way
    join**: `scripts/check-ai-governance.ts` previously only checked its hardcoded `REQUIRED` id list
    against the YAML catalog (one direction, one pair) and never read the runtime registry at all.
    Rewrote it to hand-parse the catalog's `id`/`capability_key` pairs (no new YAML-parser dependency
    for one flat file) and import `AI_PHASE_1_CAPABILITIES` directly (`packages/ai-platform`), then
    check: REQUIRED ⇔ catalog ids bidirectionally; every registry row's `governanceCatalogId` resolves
    to a real catalog id AND that catalog entry's `capability_key` names the SAME registry row back (a
    broken pairing, not just a missing one); every catalog `capability_key` (when non-null) resolves to
    a real registry row. A `capability_key: null` catalog entry (e.g. `aggregate-cap-projection`) is
    treated as an explicit, documented non-registration, not a violation — matching the repo's
    established "a declared absence beats a silent one" convention. Verified the gate actually catches
    drift (temporarily corrupted one `capability_key` in the YAML — gate failed with 2 precise
    violations naming the broken join; reverted). (2) **Seed path**: added
    `scripts/db/sync-ai-capability-catalog.ts` (`bun run db:sync:ai-capabilities`), idempotent
    UPSERT into `ai_capability` following the `sync-permission-catalog.ts` precedent (additive,
    `ON CONFLICT DO UPDATE`, platform-shared table, no PHI). Discovered while building it: the schema's
    `ai_capability_approved_has_template` CHECK blocks EVERY APPROVED/MONITORING row without a
    `current_prompt_template_key`, not just non-LLM ones — so `hearthnote_layer2` and
    `idg_layer2_polish` (both APPROVED, LLM-backed) are equally unseedable right now, since no
    `ai_prompt_template` row exists anywhere in the repo (T56 not landed) and fabricating a placeholder
    key would satisfy the CHECK while pointing at nothing. Added a new documented gap
    (`approved-llm-capability-awaiting-prompt-template`) to `AI_PHASE_1_INVENTORY_GAPS` rather than
    hand-rolling parallel skip logic in the sync script — the gaps list is already the single source of
    truth "the seed tasks and a reviewer read the same list" per its own header, so the sync script
    derives its skip set generically from every gap's `blocks` array and prints each skip with the
    gap's own `detail` (no silent caps). Bumped `phase-1-inventory.test.ts`'s asserted gap count 5→6
    and added a test for the new gap. **Dry-ran the sync script against the local dev DB (port 5440)**:
    9/17 capabilities seeded (the 6 tabular-ML-backend-blocked + the now-3 template-blocked APPROVED
    rows correctly skipped with reasons), governance defaults correct (high-risk → clinical review
    required), re-run confirmed idempotent (still 9 rows, no duplicates). Confirmed no collision with
    the M32 live-RLS test's own `hearthnote_layer2` seed row — that suite runs against a separate
    throwaway cluster (port 5544), and my sync skips that exact key regardless. Full regression: build
    clean, `arch:fitness` green (including the rewritten `check-ai-governance` gate), full suite 7810
    passing (+1 new test).
- TASK-063 (P2): drive per-table audit denylists from one source (ARCH-020).
  - **Status (2026-08-04): DONE, merged to main locally — but read this before assuming the whole
    finding is closed.** Deep research first (agent-driven), since the audit's own "no live leak"
    claim turned out to be wrong in two places. Summary of what actually exists: `M*_AUDIT_DENYLIST`
    TS constants (21 modules, not 13 — audit's list omitted M10/M21) are/were zero-importer dead code;
    the mechanism that ACTUALLY protects clinical PHI tables is hand-authored `audit_scrub(...)` SQL
    inside each migration's `audit_phi_write_<table>()` trigger; a THIRD mechanism
    (`AUDIT_DENYLIST_CATALOG`, category-based + row-conditional) has exactly one entry and was never
    wired into any migration; a FOURTH (`audit_denylist_catalog` DB table) is granted, RLS'd,
    self-audited, and never seeded by anything.
    - **Built the gate** (`scripts/check-audit-denylist-sync.ts`, `bun run arch:audit-denylist-sync`,
      wired into `arch:fitness`): for every table in all 21 `M*_AUDIT_DENYLIST` constants, the
      plain-column entries must appear VERBATIM in that table's migration trigger's `audit_scrub(...)`
      array, in both directions. Imports the constants directly (TS, no regex fragility) and parses
      migration SQL via the trigger's `CREATE TRIGGER ... ON <table>` clause for the real table name
      (the function name suffix can be a Postgres-63-char-truncated abbreviation — e.g.
      `audit_phi_write_ckit_template_medication()` triggers on `comfort_kit_template_medication` — a
      naive function-name parse produces false mismatches). Verified live: 190 tables pass; a
      deliberately-planted fake column failed the gate with a precise message; reverted.
    - **Fixed 9 confirmed-safe stale-constant mismatches** (zero behavior change — in every case the
      migration was ALREADY correctly redacting the real column; the TS constant either under-claimed
      or named a column that never existed on the table): M6 admission/election_statement/
      level_of_care_period/transfer_event/compliance_window (`election_statement`'s constant said
      `"narrative"`, a phantom — the table's real free-text column is `state_addendum`, confirmed via
      schema read); M13 (moved a `caregiver_reported_snapshot` entry from `administration_record`,
      which has no such column, to `medication_reconciliation_decision`, which does and whose migration
      already scrubs it); M14 (`idg_agenda_item`'s constant said `"note_text"`, phantom — real column is
      `body_text`; `idg_patient_packet` was missing the real top-level `discipline_views` column,
      distinct from the NESTED `built_snapshot.discipline_views` key of almost the same name).
    - **Found 2 real, live PHI-redaction gaps — deliberately NOT fixed, flagged instead.** Both have a
      real compliance rationale AND a real, authoritative reason to leave the current (under-redacting)
      migration behavior alone, so picking a side is a module-owner/compliance call, not something this
      hygiene task should do unilaterally:
      - **M7 `care_plan_version.state_snapshot`**: the constant wants it redacted (it's a serialized
        snapshot of every problem/goal/intervention, including free-text narrative that already gets
        its own redaction when audited via the `problem`/`goal`/`intervention` tables directly — so
        leaving it unredacted here duplicates that PHI into a second audit-trail path). But the
        migration AND the ratified M7 module spec's own §3.5 trigger-install example both agree:
        redact only `patient_understanding_text`, not `state_snapshot` — and a version table's whole
        POINT is to record what the sealed state actually was, so fully redacting `state_snapshot`
        would make `care_plan_version`'s audit trail useless for its own stated purpose. Real tension,
        not an oversight.
      - **M29 `lab_observation_value.observation_value`** (42 CFR Part 2 stakes): `AUDIT_DENYLIST_CATALOG`'s
        one entry says this should be row-conditionally redacted when the parent observation is
        SUD-class. But the migration's own header comment explicitly documents the CURRENT empty
        denylist as deliberate and cross-checked ("the v_cols lists mirror `M29_AUDIT_DENYLIST` in
        `@wardenx/types` VERBATIM") — meaning the migration author evaluated this and chose not to
        apply the catalog's stricter rule, or never saw it (the catalog's `generateAuditTrigger()`
        consumer is itself never invoked by any real migration-generation pipeline — confirmed zero
        `v_denylist` occurrences in any shipped migration). Two authoritative-looking sources
        disagree; given real Part-2 legal stakes, this needs someone with that specific compliance
        authority to resolve, not a default I pick under a general hygiene task.
      - Also flagged (structural, not a specific-table judgment call): **`audit_scrub` cannot redact a
        nested JSONB path** — only whole top-level columns. 25 constant entries across
        `administration_record`/`idg_decision`/`idg_patient_packet`/`discipline_care_plan_version`/
        `discipline_assessment`/`bereavement_risk_score` encode nested-path intent
        (`data->>fieldName`) that no migration trigger could ever literally satisfy; the gate prints
        every one on every run (never silently ignored) but cannot fail a check the mechanism
        structurally cannot pass. Building nested-path-aware redaction (or deciding whole-column
        fallback is acceptable per table) is a real, separate task — `discipline_assessment`'s own
        schema comment explicitly rejects the whole-column-fallback shortcut ("a top-level column
        denylist would miss them"), so it isn't even a uniform fix across tables.
      - Also flagged: `form_template_version`'s constant claims `payload_schema` should be redacted,
        but that table is platform-shared (not org-scoped) and uses M1's generic baseline trigger,
        which has no per-table redaction mechanism at all — and it's genuinely unclear `payload_schema`
        (a form's serialized TypeBox render schema — field structure, not patient data) is real PHI.
      - `audit_denylist_catalog` (the DB table): left unseeded/unused as found — building the seeding
        pipeline the M4 spec originally intended is a separate undertaking from making the two
        ALREADY-LIVE mechanisms (TS constants, migration triggers) agree with each other, which is what
        ARCH-020's acceptance criteria actually asked for.
    - Full regression: build clean, `arch:fitness` green (including the new gate), full suite 7810
      passing (unchanged — none of the 9 fixed constants have test coverage, confirming they really
      were dead code as the audit said).
- TASK-064 (P2): extend UI parity/frame gates to portal + admin (UI-011); set `/admin/staff` permission (UI-012).
  - **Status (2026-08-04): DONE, merged to main locally.** UI-011: `scripts/report-ui-parity.ts`
    and `scripts/report-frame-fidelity.ts` scanned `apps/web` only, so the 27 built portal (M31) +
    admin (M35) screens were invisible to every dup-id/dup-path/permission/wiring check. Rewrote
    `report-ui-parity.ts` to scan all three apps via their actual (different) registration shapes:
    web/admin register per-module `modules/<dir>/screens.ts` files into `main.tsx` (reused the
    existing scan logic, generalized to take a `modulesRoot`/`mainTsxPath` pair); portal registers
    ONE flat manifest (`screens/manifest.ts`) bound to components in `screens/registry.ts` via
    `app.tsx`, not `main.tsx` — a structurally different pattern with no "imported but not
    registered" failure mode (the registry throws at import time if a manifest id has no bound
    component), so that path gets its own `UNBOUND PORTAL SCREEN` check instead of the
    web/admin-style `UNREGISTERED SCREENS` one. Dup-id/dup-path checks are scoped PER APP (three
    separate SPAs — `/account` legitimately existing in both portal and admin is not a collision).
    `report-frame-fidelity.ts`'s screen-id validation set widened the same way (web + admin module
    dirs + the portal manifest) so a future frame mapping for a portal/admin screen resolves
    instead of false-failing as UNKNOWN SCREEN. Verified both scanners actually work: clean run
    found 244 web + 14 admin + 13 portal = 271 screens (zero pre-existing defects in the
    newly-covered apps — the admin console and portal really were already correctly wired, just
    unchecked); planted a fake permission in `apps/admin/.../screens.ts` and confirmed the widened
    `ui-parity` gate caught it, then reverted. UI-012: **found already resolved** — `/admin/staff`
    (`apps/web/src/modules/02-identity/screens.ts:95`) already carries
    `requiredPermission: "member.manage"`, a real catalog key; git history shows this landed in an
    earlier session (task-030) after the audit's 2026-08-03 snapshot. No code change needed; verified,
    not assumed. Full regression: build clean, `arch:fitness` green (including both widened gates),
    full suite 7810 passing (unchanged — no new test coverage needed since these are report/gate
    scripts, not app code).
- TASK-065 (P2): fix telehealth webhook to 401 on bad signature (API-008); pass through 4xx framework errors (API-009).
  - **Status (2026-08-04): DONE, merged to main locally.** API-008:
    `31-portal/routes/telehealth.routes.ts`'s vendor webhook handler verified the HMAC signature but
    only surfaced the result in the response BODY (`{received: ok}`), always replying 200 — a bad
    signature (wrong shared secret, a stale rotated key) is real vendor misconfiguration evidence, and
    dropping it into a 200 masks it from the vendor's own delivery-failure alerting. Fixed to mirror
    M35's existing Stripe webhook route convention (`registerWebhookRoutes`): bad signature → 401,
    valid → 200. API-009: `bootstrap/plugins/error-handler.ts` collapsed every non-`WardenXError` into
    a blanket 500, including Fastify's OWN framework errors (malformed JSON, oversized body,
    unsupported content-type) which carry a real `statusCode`/`code` via `@fastify/error` and are
    designed to be client-facing — added a runtime shape-check (`setErrorHandler`'s `error` argument is
    typed `unknown`, so `instanceof` can't identify a `@fastify/error`-built error; no distinct class
    exists) that passes the real 4xx status + message through, while a genuinely unexpected `Error`
    still 500s with the generic no-leak envelope (verified via `.inject()`: malformed JSON body →
    real 400 `FST_ERR_CTP_INVALID_JSON_BODY`, not 500; a thrown plain `Error("...")` still 500s and its
    message never appears in the response). New test files/cases: `error-handler.test.ts` (3 cases) +
    two "fix #4"/"fix #4b" cases added to `portal-inject.test.ts`'s existing "fixed findings" describe
    block (bad-signature → 401, valid-signature still 200 — not a rubber stamp). Full regression: build
    clean, `arch:fitness` green, full suite 7815 passing (+5 new tests). Session note: hit a real
    machine-level disk-full (ENOSPC) mid-task that failed a test run; paused, user freed space, resumed
    cleanly — no code impact, flagging only because it's a real environment risk worth remembering for
    future heavy test-suite runs on this machine.
- TASK-066 (P3): drop time-relative CHECKs, enforce at write time (DB-005); local date-only helper (PARAM-004); react-router bump (PERF-004); confirm/remove behaviorally-suspicious dead tables (ARCH-023).
  - **Status (2026-08-04): DONE (scoped — see below), merged to main locally.** A P3 grab-bag of four
    independent findings; each got its own investigation and fix/decision.
  - **PERF-004 (dependency bump) — DONE.** `react-router-dom` bumped `^6.28.0` → `^7.18.2` across all
    4 consumers (web/admin/portal + `@wardenx/ui`); `bullmq` version drift fixed (`apps/backend`
    `^5.34.0` → `^5.81.3`, matching root). Confirmed the 3 originally-flagged moderate vulns
    (react-router open-redirect/SSR-deserialize, react-router-dom open-redirect XSS) are gone. Verified
    zero API breakage: our usage (`createBrowserRouter`/`RouterProvider`/`Link`/`Outlet`/`useNavigate`/
    `useLocation`/`useParams`/`useSearchParams`) is unchanged in v7's `react-router-dom` compat package;
    `bun run build` clean, all 282 router-dependent smoke tests pass, and the "React Router will begin
    wrapping... in v7" warnings that appeared in every test run this whole session are now GONE (we're
    on v7). **Residual, deliberately not chased further**: `bun audit` now flags ONE new HIGH advisory
    (GHSA-qwww-vcr4-c8h2, "RSC Mode CSRF Bypass") affecting react-router 7.12.0–8.2.x — no fixed
    version exists below 8.x, and 8.x dropped the separate `react-router-dom` package entirely (folded
    into `react-router` — `bun info react-router-dom@8.3.0` returns no such version), so clearing this
    would mean renaming the import across ~170 call sites in 4 packages, a real second migration, not a
    version bump. Confirmed zero RSC/framework-mode usage anywhere in the repo (no `react-router.config`,
    no `@react-router/dev`, no server actions) — this app runs pure client-side "library mode", so the
    advisory's actual attack surface (RSC server actions) doesn't exist in this deployment. Left as a
    known, low-real-risk residual; the 8.x package migration is its own follow-up task.
  - **DB-005 (time-relative CHECKs) — DONE, and this one had a real second-order finding.** Both CHECKs
    (`user_notif_pref_vacation_shape`: `vacation_until > NOW()`; `sequestration_policy_forward_only`:
    `effective_from > CURRENT_DATE`) re-validate on EVERY future write to the row using the CURRENT
    time/date, not the value at the time the column was set — so a legitimately-future value at INSERT
    time fails every later write (even to an unrelated column) once it naturally elapses, and fails
    `pg_restore`'s COPY-time re-validation on any row restored after that point. New migration
    `0162_drop_time_relative_checks.sql` drops both (`DROP CONSTRAINT IF EXISTS`, never editing the
    original migrations). **Investigated whether dropping the DB CHECK would remove the ONLY
    enforcement of the underlying invariant before touching anything — it would have, for
    `sequestration_policy`**: traced `forwardDateSequestrationPolicy` (write-service-drizzle.ts) and
    found NO app-level "must be forward-dated" check anywhere — the route comment claimed "the write
    service refuses a non-forward-dated effectiveFrom" but the code only ever relied on the DB CHECK.
    Added the real check (a plain date-string comparison against an injected clock, throwing
    `SEQUESTRATION_POLICY_NOT_FORWARD_DATED` 422 before any DB access) so dropping the CHECK is not a
    silent regression. Did the same for messaging's `putPreferences` (`VACATION_UNTIL_NOT_FUTURE` 422)
    — and, since that route's HTTP-layer test uses an in-memory reference store
    (`createInMemoryMessagingService`, not the real Drizzle-backed one), mirrored the same validation
    into the in-memory store too so it stays a behaviorally-accurate reference, not just a structurally
    similar one. **Testing note worth remembering**: this repo's `*-inject.test.ts` HTTP-wiring smoke
    suites deliberately use hand-rolled FAKE backends (documented in their own file banners as "not a
    re-test of write-path business rules") — a naive negative-path test added to those files silently
    tests the fake, not the real code, and passes/fails for the wrong reason. Caught this only because
    my first attempt at both negative tests failed with 200/201 instead of 422; traced why, then wrote
    the billing test as a real focused unit test of `buildDrizzleM23WriteService` directly (a `db` stub
    that throws on ANY property access proves the reject path never touches the database) instead.
    4 new tests (write-service-drizzle.test.ts) + 2 new messaging-routes.test.ts cases prove the fix.
  - **PARAM-004 (date-only helper) — DONE for the frontend half; backend half found to need new
    infrastructure, not fixed.** The audit named 4 files with a buggy `ageYears(dob)` (`new Date(dob)`
    parses a bare `YYYY-MM-DD` as a UTC instant; local getters then read it back ONE DAY EARLY in any
    negative-UTC-offset timezone — every US timezone). Grepping found **11**, not 4 — all byte-for-byte
    identical copy-pastes. Extracted one shared, fixed implementation
    (`packages/ui/src/core/dates.ts`: `parseLocalDateOnly`/`ageYears`, parsing date components directly
    via the LOCAL `Date` constructor, never `new Date(dateString)`) and replaced all 11 duplicates with
    an import. New test (`dates.test.ts`) pins `process.env.TZ = "America/Los_Angeles"` to reproduce
    the exact failure mode rather than depending on whatever timezone the test runner happens to run
    in. **The backend "UTC-today" half (09-assessments, 37-ipu, 16-bereavement, 17-scheduling's
    ABAC-serviceDate slicing) was investigated and NOT fixed**: every one of these ultimately needs to
    know the ORG's local timezone to compute a correct "today"/service-date, and `organizations` has NO
    timezone column at all — the audit's own suggested fix ("org-timezone today server-side") requires
    new schema (a column + migration + a backfill/default story for every existing org) before any of
    these 4 call sites could be correctly fixed. Building that is a real, separate feature, not a P3
    grab-bag item; flagged here rather than either skipped silently or rushed with a wrong hardcoded
    timezone.
  - **ARCH-023 (dead-table census) — scoped to the 3 items ARCH-020's own text specifically named**,
    not the full ~40-table / ~140-export sweep (that census itself is a much larger, separate audit
    task). Investigated each named item on its own merits rather than assuming the audit's
    characterization was still accurate:
    - **`encounter_signature` (M8) — RE-CLASSIFIED, escalated, NOT fixed.** Confirmed zero read/write
      path (only the destruction/eraser references it, to delete rows that can never exist) — but the
      M8 module spec ties this table directly to **CoP 418.104(c)** (Condition of Participation:
      Authentication of clinical record entries), citing 21 CFR Part 11 principles, requiring signature
      METHOD + session id + fresh-step-up provenance PER signature event. What actually shipped
      instead — plain `encounters.signedAt`/`cosignedAt` timestamp columns — does not carry that
      provenance. This is not dead code to clean up; it's a genuine, silent (no `lifecycleNotWired`-style
      marker anywhere acknowledging it, unlike M39 below) regulatory-compliance GAP that deserves
      higher priority than P3 hygiene and a real compliance/product decision on whether the timestamp
      approach is sufficient or the detailed table needs a real write path built. Neither deleting the
      table nor hastily building that write path under this task was the right call.
    - **`consent_revocation` (M39) — confirmed intentional, no action needed.** Same zero-read/write
      pattern, but `consent-store-db.ts`'s `revokeConsent()` (and 5 sibling lifecycle methods) is an
      explicit, already-documented `lifecycleNotWired("consent revocation")` deny-stub — the "confirm
      this is intentional" step ARCH-023 asks for is already satisfied by the code itself; this is the
      SAME honest-deny-stub pattern the architecture doc already credits M39/M28/M36 for elsewhere.
    - **The org-settings-registry boot gap — DONE, fixed.** `bootOrganizationSettingsRegistry`
      (packages/db) existed since M1 landed with a comment saying the real write "lands with backend
      bootstrap... wired then" — nothing ever called it. Traced the actual runtime consequence:
      migration 0003's collision-guard trigger treats an absent registry row as "unknown key, no
      opinion" (fails OPEN, never blocked a write) — so the real effect was narrower than it first
      looked: the `uniqueAcrossTenants` collision guard (W-M1-08) was permanently inert for every
      module that declared one, not a general settings-write blocker. Added
      `apps/backend/src/bootstrap/organization-settings-persister.ts`
      (`buildDbOrganizationSettingsUpserter` + `wireOrganizationSettingsRegistry`), mirroring the
      existing M1-T10 `outbox_event_catalog` boot-population shape exactly (same idempotent
      UPSERT-on-primary-key pattern, same fail-soft fire-and-forget boot-hook call site in
      `apps/backend/src/index.ts`, right below the outbox-catalog wiring it was always meant to sit
      beside). 3 new tests confirm `breakglass_cosign_required` — the specific key M3's break-glass
      cosign-policy comment names — is really in the registry now.
  - Full regression across all four sub-items: build clean, `arch:fitness` green, full suite 7829
    passing (+14 new tests across dates.test.ts, write-service-drizzle.test.ts, messaging-routes.test.ts,
    organization-settings-persister.test.ts).

## Follow-up (2026-08-04): resolving the three findings TASK-063/066 deliberately left open

TASK-063 and TASK-066 above each surfaced a finding and explicitly declined to resolve it —
correctly, at the time: a hygiene/P3 task shouldn't unilaterally pick a side on a real compliance
tension, and PARAM-004's backend half needed infrastructure that didn't exist yet. This follow-up
picks two of those three back up and resolves them for real; the third (`encounter_signature`) is
still open.

- **M7/M29 PHI-redaction disagreement — RESOLVED, both directions.**
  - **M7 `care_plan_version.state_snapshot`**: resolved in favor of the migration/module-spec side
    (redact only `patient_understanding_text`) — TASK-063's own analysis already established that
    fully redacting `state_snapshot` would defeat the version table's purpose, and the PHI it
    contains is already redacted via its own audit trail when the `problem`/`goal`/`intervention`
    tables are audited directly. New migration
    `0163_care_plan_version_state_snapshot_redaction.sql` (`CREATE OR REPLACE FUNCTION` +
    `CREATE OR REPLACE TRIGGER`, PG14+, never editing the shipped 0029 migration) makes that the
    ONE denylist, and the TS constant was the one that was wrong — `check-audit-denylist-sync.ts`
    now compares against BOTH migrations for M7 (parses the later file as authoritative on
    conflict), and `M7.care_plan_version` is removed from `KNOWN_UNRESOLVED_DISAGREEMENTS`.
  - **M29 `lab_observation_value.observation_value`**: resolved in favor of the stricter
    `AUDIT_DENYLIST_CATALOG` side (42 CFR Part 2 stakes) — invoked `generateAuditTrigger()`'s
    row-conditional denylist code path for the first time in a real migration (it existed,
    fully built, and had never been called by anything). New migration
    `0164_lab_observation_value_sud_redaction.sql` is the LITERAL generator output for
    `{table: "lab_observation_value", denylistCategories: ["sud_value"], retentionClass:
    "compliance_42cfr_part2"}` — verified byte-identical via a new golden-output test
    (`packages/audit/__tests__/generated-trigger-migrations.test.ts`) rather than by hand-copying.
    The gate gained a `CONDITIONAL_REDACTIONS` check verifying the row-conditional markers
    (`v_denylist`, the `sud_redaction_status` branch, both `audit_scrub` call sites) are present.
  - Both migrations only ADD `CREATE OR REPLACE TRIGGER` statements alongside the function
    replacement — the sync gate's table-name parse needed a `CREATE (?:OR REPLACE )?TRIGGER`
    regex fix to still resolve the owning table when a migration has no bare `CREATE TRIGGER`.
  - **Later verified against live Postgres, mid-session, once Docker recovered — and the M29 half
    was BROKEN.** Static gates (build, arch:fitness, the golden-output tests comparing the
    migration to `generateAuditTrigger()`'s own output) all stayed green because they only checked
    internal consistency between the migration and the TS catalog it was generated from — nothing
    checked the catalog's column/table references against the actually-shipped schema. Spun up a
    throwaway Postgres 18 + pgvector cluster (`docs/DEVELOPMENT.md`/local-live-RLS recipe) and ran
    the M29 live-RLS suite; it failed immediately with `column lo.sud_redaction_status does not
    exist`. Root cause: **the `AUDIT_DENYLIST_CATALOG` entry this was generated from referenced two
    columns that never existed** — `lab_observation.sud_redaction_status` and
    `lab_observation_value.observation_value` — both names lifted from the T-29.11 SUD-hardening
    forward-engineering spec, whose richer `sud_redaction_status` enum + its own migration
    (`0034_external_interfaces_sud_hardening.sql`) were never actually built (0034 in this repo is
    the unrelated M10 HOPE migration). Fixing that surfaced two MORE real bugs, each only
    reachable by actually exercising the trigger: (1) the row-conditional trigger is the first one
    in the repo to `SELECT` a sibling table from inside its `SECURITY DEFINER` body —
    `wardenx_audit_writer` had no grant or RLS policy letting it read `lab_observation`, so it hit
    `permission denied`; added a least-privilege, org-scoped `SELECT` policy mirroring the app
    policy's own condition. (2) `audit_retention_class` never actually had `compliance_42cfr_part2`
    added to it, despite five OTHER migrations' comments (0102/0106/0116/0139/0153) describing the
    enum as if it already had four values — every one of them stamps the ordinary `compliance`
    class in practice, so the gap was silent until this migration became the first to actually try
    writing that value; added the missing `ALTER TYPE ... ADD VALUE`. Repointed the catalog at
    what really shipped (`lab_observation.sud_redacted_at_ingest` boolean;
    `lab_observation_value.numeric_value`/`.string_value`, there is no single `observation_value`
    column), regenerated migration 0164 from the corrected catalog via the real generator (never
    hand-typed), updated the 3 tests that hardcoded the old phantom names. Re-ran: all 165
    migrations apply cleanly from scratch AND idempotently on replay, M7/M8/M29 live cross-tenant
    RLS suites all pass (12/15/15 tests). This is the strongest evidence in the whole session for
    why "static gates + golden-output tests" is not the same claim as "verified" — see
    `docs/audits/wardenx-production-readiness/` audit methodology notes.
  - Merged to `main` locally (branch `followup-m7-m29-redaction`, then a same-day correction commit
    `fix-m29-live-verification-corrections`); full suite 8060 passing (post-correction count; some
    pre-existing unrelated flakes in the 34-fail baseline — billing-medicare `vi.mock`
    incompatibility, jsdom portal smoke render, a 5s test-timeout on two fitness-gate subprocess
    tests — are untouched by this work, confirmed by name against the pre-fix baseline).

- **PARAM-004 backend half (org-local "today") — RESOLVED.** Built the org-timezone
  infrastructure TASK-066 identified as missing, reusing the `organization_settings_registry`
  (M1 §3.15) mechanism wired up in that same task rather than adding a raw schema column:
  - `packages/db/src/organization-settings/settings-by-m1.ts` registers a new `org_timezone`
    setting (TypeBox-validated IANA-zone pattern, `DEFAULT_ORGANIZATION_TIMEZONE =
    "America/New_York"`).
  - `packages/shared/src/dates/org-local-date.ts` (new, zero dependencies): `localDateInTimeZone`/
    `orgLocalDateToday`/`isValidTimeZone`, built on `Intl.DateTimeFormat` with `timeZone` + the
    `en-CA` locale (formats `YYYY-MM-DD` natively) rather than any manual offset arithmetic.
  - `packages/db/src/organization-settings/org-today.ts` (new): `organizationTimezone`/
    `todayForOrganization`/`serviceDateForOrganization` — the ONE shared "what calendar date is
    this for this tenant" read, composing the setting with the pure `@wardenx/shared/dates`
    helpers, failing closed to the UTC-adjacent `America/New_York` default rather than ever
    silently falling back to naive UTC slicing.
  - Fixed all 4 backend call sites the audit + a follow-up grep found:
    - **09-assessments** — `today()` (license expiry checks) → `todayForOrganization`.
    - **37-ipu** — inspection log's `lastInspectionDate` → `todayForOrganization`.
    - **16-bereavement** — `utcDateOf` → renamed `localDateOf(iso, timezone)` (this site derives a
      calendar date from a SPECIFIC recorded death instant, not "today" — a different function
      shape than the other three; the consumer stayed a pure decision core, now taking `timezone`
      as an explicit argument rather than reading anything itself).
    - **17-scheduling** — the largest site: `visit.service_date` (the persisted column, ~12
      call sites across create/list/get/edit/start/cancel/reschedule/no-show/reassign) now derives
      from `organizationTimezone` + `localDateInTimeZone` instead of `isoStr.slice(0, 10)`. The
      recurring-visit `startDate` field is left computed against literal `"UTC"` — consistent with
      that row's own `timeZone: "UTC"` policy-placeholder field (§2.2.3), not a fix of the same bug.
  - **The route-level ABAC target site scheduling-routes.ts's `createGateTarget` was the audit's
    ORIGINAL cited line** (`scheduledStartedAt.slice(0, 10)` feeding the D8 pre-schedule gate's
    `serviceDate`) — and it hit a genuine, real architectural constraint: `requireAbac`'s
    `getTarget` (`packages/auth/src/abac/require-abac.ts`) is synchronous by contract, so it cannot
    itself do the DB read `organizationTimezone` needs. Fixed WITHOUT touching that shared
    contract: added `SchedulingRouteService.orgTimezone(orgId)` (real DB read in the Drizzle
    backend; `"UTC"` in the in-memory reference slice, matching that file's existing UTC-only
    assumptions) and a new `resolveOrgTimezone` preHandler that runs after the `CREATE` RBAC check
    and before the four ABAC gates, stashing the result on `request.context.attributes` where
    `createGateTarget` reads it back synchronously.
  - New tests: `packages/shared/__tests__/org-local-date.test.ts` (6),
    `packages/db/__tests__/organization-settings.test.ts` (4, resolves `org_timezone` via the real
    reader), a new bereavement PARAM-004 test proving `America/Los_Angeles` and `UTC` disagree on
    the calendar date for the same instant. Full backend scheduling test suite (53 tests across
    4 files) and `bun run build`/`arch:fitness` both green.
  - **Later verified against live Postgres, same session, once Docker recovered.** Ran
    `m17-rls-isolation.live.test.ts` (16 tests), `m17-scheduling-read-service.live.test.ts` (4),
    `m17-scheduling-write.live.test.ts` (12), plus `m9-assessments-write.live.test.ts` (10) and
    `m37-ipu-write.live.test.ts` (7) — all pass against the same throwaway Postgres 18 + pgvector
    cluster the M7/M29 re-verification above used, confirming `organizationTimezone`/
    `todayForOrganization` correctly resolve `organization_settings_registry`'s boot-populated
    `org_timezone` default under real RLS (unlike the M29 migration, this work had no live-only
    bugs to fix — it passed clean on the first live run).

- **`encounter_signature` (CoP 418.104(c)) — RESOLVED.** Built the real write path: every primary
  sign / cosignature / addendum-sign now writes an `encounter_signature` row (method, session id,
  step-up timestamp, attestation text, discipline) inside the same transaction as the status
  transition, insert-then-emit (M11 Orders' `order_signature` idiom).
  - **Step-up moved fully server-side.** The old routes trusted a client-supplied `stepUpAuthAt`
    timestamp (`stepUpFreshFrom`, a plain `Date.parse` age check) — never a real re-authentication
    event — and the cosignature-sign route had NO step-up check at all despite the module spec's
    own route table listing one. Both fixed: `SignEncounterSchema` no longer accepts
    `stepUpAuthAt`; the sign/cosign-sign/addendum-sign routes gate on `requireStepUp("encounter.
    sign"|"encounter.cosign"|"encounter.addendum.sign")` (real, server-verified, via M3's
    `step_up_recent` predicate over M2's `SessionContextResolver` seam — the same mechanism every
    other step-up-gated route in the codebase already uses). Added `stepUpFresh` to
    `CosignatureEvent`'s `sign` variant and `transitionCosignature`'s guard — it was structurally
    absent before, a real gap this closes.
  - **The signer's real identity, not the author's.** `sign`/`cosignSign`/`signAddendum` all used
    `authoredByMembershipId`/`routedToMembershipId` as a stand-in for "who signed" — wrong whenever
    the actual caller differs from the encounter's author (the RN cosigner, an addendum author).
    Fixed: routes now thread the caller's real `membershipId` (from `request.context.attributes`,
    stamped by M2's authenticate hook) and `sessionId` through a new `SigningActor` service
    parameter; the service re-resolves the session's step-up state itself (mirrors M11's
    "re-derive, don't trust a passed-through claim" idiom) rather than trusting a boolean the route
    computed.
  - **`StepUpFactor` → `signature_method` mapping**: `webauthn` → `passkey` (the session seam
    doesn't distinguish passkey vs. platform-biometric — both are WebAuthn ceremonies), `totp` →
    `password_plus_otp`. `sms` can't reach this code path (`STEP_UP_POLICY` excludes it from
    qualifying factors) — defensively throws if it somehow did.
  - **The in-memory reference slice** (not mounted in production) accepts the same new signatures
    but always reports a fresh, `"UTC"`-flavored step-up (`method: "passkey"`, no real session
    infra) — consistent with how it already handles other unthreaded compliance fields.
  - **A real, live-caught bug of my own along the way**: the first cut added a hard "must be sited
    (provider entity + location) before signing" guard, since `encounter_signature.provider_
    entity_id`/`.location_id` are NOT NULL — but `createDraft` never actually sets an encounter's
    siting anywhere in this write-lifecycle slice (a PRE-EXISTING gap the module's own header
    comment already flags: "siting backfills from the admission/visit when present" — an
    aspiration, not yet implemented). The live write-lifecycle test's `draft()` helper had to start
    seeding real FK-valid `provider_entity`/`location` rows and stamping them onto every created
    encounter for signing to work at all — confirming this is a genuine, separate, already-existing
    gap (encounters are universally unsited today), not something this task should silently paper
    over with a fake sentinel.
  - New tests: `encounter-cosignature.test.ts` gained the cosignature stepUpFresh gate's
    stale-step-up case (matching the existing encounter/addendum machine pattern); the 3 HTTP-level
    and 1 live-Postgres test files needed real `SessionContextResolver` seam wiring (previously
    absent — those routes' step-up gate was untestable before because nothing exercised
    `requireStepUp` for real).
  - **Live-verified against real Postgres**: `m8-rls-isolation.live.test.ts` (15, including the
    `encounter_signature` cross-tenant-denial case) and `m8-encounters-write.live.test.ts` (12,
    including the stale-step-up-is-412 and both cosignature-flow cases) both pass clean.
  - Full regression: build clean, `arch:fitness` green (openapi.json + generated client
    regenerated — `SignEncounterSchema`'s shape changed), full suite 8061 passing (same 34
    pre-existing unrelated failures as before this work, confirmed by name).
