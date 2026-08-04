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
  both deliberate cardinality guards), `registerBullMQQueueMetrics()` (`wardenx_bullmq_queue_jobs{queue,
  state}` via prom-client's lazy `collect()` — read from Redis only when `/metrics` is actually
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
  `.` (the M7/M9 convention). Re-verified: boot log shows the exact expected queue counts — `M7 §4.6
  BullMQ care-plan.gates cron constructed` (queues:1), `M9 §4.8 BullMQ compliance-scan crons
  constructed` (queues:3), `M10 §4.8 BullMQ HOPE watchdog crons constructed` (queues:2) — `/health`+
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

## TASK-050 — Test coverage: per-module HTTP smoke suites + real-auth conformance + jsdom

- Priority: P1 · Severity: High · Phase: 7
- Objective: a table-driven inject smoke suite per module (401/403/422/one 2xx); a fitness check requiring one per `routes/` dir; a shared conformance spec across in-memory and Drizzle backends; a jsdom smoke-render across the three registries; planted-violation self-tests for the 4 highest-value un-red-tested gates.
- Evidence: TEST-001/003/004/005. Complexity: L.

## Lower-priority (P2/P3) tasks

- TASK-060 (P2): extract `@wardenx/money`; converge the three kernels (ARCH-021).
- TASK-061 (P2): decimal-string money in M25 events; integer-cents aging sums (PARAM-003).
- TASK-062 (P2): join the AI capability catalog three ways + seed path (ARCH-019).
- TASK-063 (P2): drive per-table audit denylists from one source (ARCH-020).
- TASK-064 (P2): extend UI parity/frame gates to portal + admin (UI-011); set `/admin/staff` permission (UI-012).
- TASK-065 (P2): fix telehealth webhook to 401 on bad signature (API-008); pass through 4xx framework errors (API-009).
- TASK-066 (P3): drop time-relative CHECKs, enforce at write time (DB-005); local date-only helper (PARAM-004); react-router bump (PERF-004); confirm/remove behaviorally-suspicious dead tables (ARCH-023).
