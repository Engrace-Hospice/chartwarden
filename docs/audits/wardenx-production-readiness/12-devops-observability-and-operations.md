# 12 — DevOps, Observability & Operations

**Audit date:** 2026-08-03 · **Branch:** `main` @ `91e5b09` · **Method:** static review of `apps/backend/src/index.ts` (composition root), `bootstrap/`, `.github/workflows/ci.yml`, `scripts/db/`, the ops/DR docs under `docs/architecture/`, and `bun audit`. Read-only.

**Headline:** This is the weakest dimension. The application code quality is high, but **there is no path from clone to running production**: no container image, no deploy pipeline, no worker process, no readiness probe that can fail, no metrics/tracing, and no implemented backup/restore. Most severely, the transactional outbox that every module publishes into **has no consumer** — a Critical correctness-and-growth defect.

Counts: **1 Critical · 6 High · 7 Medium · 4 Low.**

---

## OPS-001 — Transactional outbox has no dispatcher (rows written, never consumed)
- **Severity: Critical · Priority: P0 · Confidence: High (independently verified) · Production blocker: Yes**
- Evidence: `packages/db/src/schema/outbox-events.ts:21-25` defines `status` (default `pending`), `attempt_count`, `last_error`, `dispatched_at`. The **only** writer is `apps/backend/src/bootstrap/outbox-persister.ts:96-102` (insert inside the caller's transaction). A repo-wide search finds **no code that selects `outbox_event`/`outboxEvents` by `status='pending'`, and zero `SKIP LOCKED` anywhere**. The composition root imports only the write-side helpers (`buildTxOutboxPublisher`, `buildBootOutboxCatalog`, `wireOutboxCatalog` — `index.ts:41-46`). `modules/22-documents/outbox-consumers/bindings.ts:39-40`: `M22_DOCUMENT_REQUEST_BINDINGS_DEFERRED = true` — "declared but not wired into the dispatcher." `modules/30-quality/jobs/m30-jobs.ts:1268` carries the acknowledged TODO to bind the dispatcher.
- Impact: every cross-module event consumer is dead wiring — M22 document render handshake, M33 materialized-view refresh (`packages/reporting/src/refresh/outbox-subscriber.ts:57`), the M14→M7/M11/M12 `idg.decision_recorded` fan-out. Cross-module eventual consistency silently never happens. `outbox_event` grows **unbounded** — there is no purge/retention job anywhere.
- Remediation: a polling relay (`SELECT … WHERE status='pending' … FOR UPDATE SKIP LOCKED`), marking rows dispatched/failed with attempt counting + exponential backoff, a dead-letter path after N attempts, a retention purge, and an explicit process to run it. Wire the deferred M22/M33/M14 bindings to it.
- Acceptance: an integration test proves an emitted event reaches a registered consumer; pending depth is bounded and observable.

## OPS-002 — No worker deployment topology; all workers run in the API process, only if `REDIS_URL` is set
- **Severity: High · Priority: P0 · Confidence: High · Production blocker: Yes**
- Evidence: `apps/backend/src/index.ts:1963-1967` — workers are not constructed when `REDIS_URL` is unset (the host still boots); the worker-runner block spans `index.ts:1960-2218`. The only entrypoints are `apps/backend/package.json:11-13` (`dev`/`start` = `bun src/index.ts`). No Dockerfile/compose/systemd exists.
- Impact: production boot without `REDIS_URL` (which env validation does not require — OPS-010) silently runs **zero** background jobs; horizontal API scaling duplicates repeatable-cron registration and mixes cron load into request latency.
- Remediation: a dedicated worker entrypoint + deploy artifact; require `REDIS_URL` in production validation; put Redis in the readiness probe.

## OPS-003 — Clinical-core compliance crons (M7/M9/M10) are data-only, never constructed
- **Severity: High · Priority: P1 · Confidence: High · Production blocker: Yes (regulatory timers)**
- Evidence: `modules/07-care-plan/jobs/index.ts:1-45` declares `M7_JOB_SCHEDULES` with a comment that "the scheduler binds repeatables at boot," but no such registration exists — `index.ts` constructs workers only for M34/M33/M30/M27/M23/M25/M26 (lines 1968/1996/2074/2118/2143/2188/2206). Same for `modules/10-hope/jobs/index.ts:66-72` (HOPE window/SFV watchdogs) and `modules/09-assessments/jobs/index.ts`.
- Impact: care-plan 5-day-warning / 15-day-overdue scans and HOPE window watchdogs never fire; regulatory clocks are enforced only by a human opening a screen.
- Remediation: construct these catalogs in the worker-runner section, or explicitly track the deferral; add a test that every `*_JOB_SCHEDULES` entry has a constructed repeatable.

## OPS-004 — `/ready` is hard-wired healthy
- **Severity: High · Priority: P0 · Confidence: High · Production blocker: Yes**
- Evidence: `bootstrap/routes/health.ts:18-22` — `defaultReadinessProbe` returns db/valkey/minio all `"ok"`; `bootstrap/index.ts:223` uses `deps.readinessProbe ?? defaultReadinessProbe`; there are **zero** `readinessProbe` references in `apps/backend/src/index.ts`, so the real probe is never injected. No outbox-depth, queue-depth, or failed-job check exists.
- Impact: an orchestrator routes traffic into an instance with a dead database; the runbook's "wait for health on green" gates on a probe that cannot fail.
- Acceptance: stopping the database flips `/ready` to 503.

## OPS-005 — No metrics, no tracing, no error reporting
- **Severity: High · Priority: P1 · Confidence: High · Production blocker: Yes (SLO posture)**
- Evidence: a repo-wide search for `prom-client`, `@opentelemetry`, `sentry`, `pagerduty`, `alertmanager` in `apps/` + `packages/` returns zero hits. The only telemetry is Pino logs. The DR/BCP and ops runbook reference an observability tier and SEV alerting with no implementation.
- Remediation: an OTel SDK (HTTP + pg + ioredis) or prom-client with BullMQ metrics; alerts on DLQ depth and outbox pending depth.

## OPS-010 — Env validation covers 6 vars; 12+ runtime reads are unvalidated, several with dangerous fallbacks
- **Severity: High · Priority: P1 · Confidence: High · Production blocker: Yes**
- Evidence: `bootstrap/env.ts:27-61` requires 6 vars (called at `index.ts:1246`). Unvalidated reads: `REDIS_URL` (zero workers — OPS-002); `DATABASE_PLATFORM_URL` (`index.ts:1264-1265` — admin console/crons fail closed at runtime, precondition undocumented); **`PASSKEY_RP_ID` → default `"localhost"`** (`packages/auth/src/identity/auth.ts:179`) and `WEBAUTHN_RP_ID` (`modules/02-identity/routes/session-step-up.ts:87`) — production passkeys bind rpID `localhost`; `MESSAGING_ENCRYPTION_KEY` (`packages/messaging/src/crypto/body-crypto.ts:28`); M19/M20 `CURSOR_SIGNING_KEY`; `TRUSTED_PROXY_CIDRS` (`bootstrap/index.ts:199` — wrong client IPs behind a proxy).
- Acceptance: a boot with `NODE_ENV=production` and only today's 6 vars fails closed.
- Cross-ref: **SEC-005**.

## OPS-012 — No deployment pipeline; the runbook references infrastructure that doesn't exist
- **Severity: High · Priority: P1 · Confidence: High · Production blocker: Yes**
- Evidence: `.github/workflows/ci.yml` is the only workflow (build, `arch:fitness`, vitest, rls-live matrix, auth-live — no deploy or image-build job). No Dockerfile/k8s/terraform anywhere. `docs/architecture/WARDENX_OPS_RUNBOOK_v0.1.md:170-224` describes blue-green with signed images + SBOM; its migration section (:308-324) references `bun --filter @wardenx/db drizzle:migrate` (**no such script exists**) and verifies `drizzle.__drizzle_migrations` (the real tracking table is `_wardenx_migration`, `scripts/db/migrate.ts:40`).
- Classification: documented-intent, not implemented — a clean-clone deploy per the docs is impossible.

## OPS-016 — Backup/recovery: thorough DR/BCP document, zero implementation
- **Severity: High · Priority: P1 · Confidence: High · Production blocker: Yes (HIPAA §164.308(a)(7))**
- Evidence: `docs/architecture/WARDENX_DR_BCP_v0.1.md` specifies pgBackRest (§4.1.1), WAL archiving with a 60s RPO cap, a backup-verify cron, and tiered RTO/RPO. A repo-wide search for `pg_dump|pgbackrest|wal-g|barman` outside the docs returns nothing. Restore is undemonstrable from repo artifacts.

## OPS-006 — No graceful shutdown or global rejection/exception handlers
- **Severity: Medium · Priority: P1** — grep of `apps/backend/src` (non-test) for `SIGTERM|process.on|unhandledRejection|uncaughtException` finds only a comment (`modules/29-external-interfaces/listener/supervisor.ts:3`). Worker `onClose` teardown never runs on deploy signals; unhandled rejections crash without context.

## OPS-007 — Dead-letter queues named but never consumed or monitored
- **Severity: Medium · Priority: P2** — `modules/07-care-plan/jobs/index.ts:26-31` (`M7_DLQ`), `modules/10-hope/jobs/index.ts:45`. Retry policy exists where queues are *constructed* (attempts 3-5, backoff), but nothing promotes failed jobs to a DLQ and nothing pages.

## OPS-011 — Redis failure behavior is implicit; no boot verification
- **Severity: Medium · Priority: P2** — `index.ts:2259-2270` parses the URL only; no PING, no error listeners, no `maxRetriesPerRequest`. Redis is *optional-and-silent* rather than hard-required, which is worse than a hard requirement.

## OPS-013 — Migration runner is now idempotent (FIXED) but is "not the production migrator"; superuser; no rollback
- **Severity: Medium · Priority: P1** — `scripts/db/migrate.ts:1-14` now tracks per-file sha256 in `_wardenx_migration`, applies pending-only, and offers `--baseline`. It still requires superuser, only *warns* on checksum drift (:110-113), has no down-migrations, and its header disclaims production use while no other migrator exists. Cross-ref **DB-001**.

## OPS-014 — CI live-RLS matrix lags the module set
- **Severity: Medium · Priority: P2** — the 36-suite matrix omits M28 (a `test:rls:live:m28` script exists), M29, M31 (its suite file exists with no script), M35, and M37. Generate the matrix from `package.json` to prevent drift. Cross-ref **TEST-002 / DB-009**.

## OPS-015 — Rate limiting in-memory, fixed-window, per-instance
- **Severity: Medium · Priority: P2** — see **SEC-006 / API-005**. Combined with an unset `TRUSTED_PROXY_CIDRS`, per-IP limiting can collapse to one bucket behind a proxy.

## OPS-008 / OPS-009 — Error lifecycle and logging are well-built (Low)
- The Fastify error handler (`bootstrap/plugins/error-handler.ts:16-42`) maps `WardenXError` to a `{code,message,details,correlationId,documentationUrl}` envelope, logs unknown errors fully, and returns a generic `INTERNAL_ERROR` with no stack/driver leakage. Logging is Pino, PHI-safe (redacts authorization/cookie, strips query strings), with a per-request child logger carrying correlation + request IDs. Gaps: correlationId is echoed only in error bodies (no success header); the inbound correlation header is accepted unvalidated; org/user ids are never added to the child logger post-auth.

---

## Performance

## PERF-001 — Frontend ships one 1.53 MB JS chunk with sourcemaps, no code splitting
- **Severity: Medium · Priority: P2** — `apps/web/dist/app/assets/index-*.js` = 1,531,069 bytes (single chunk); `apps/web/vite.config.ts:20` has `sourcemap: true`, no `manualChunks`, no route-level `React.lazy`. Blocker-adjacent for the ADR-0035 Capacitor mobile wrap. Cross-ref **UI-004**.

## PERF-002 — eMAR offline-sync is a sequential per-row transaction loop (N+1)
- **Severity: Medium · Priority: P2** — `modules/13-emar/emar-route-service-db.ts:769-773` runs `for (const r of rows) await this.recordAdministration(...)`, each opening its own `withOrgContext` transaction (reads + outbox emit); a shift's sync serializes dozens of transactions in one request.

## PERF-003 — Pagination/caps good; DB pool default 10, not env-configurable
- **Severity: Low · Priority: P3** — list caps are clamped throughout (max 200). `packages/db/src/client.ts:38-40` sets `max: 10` with no env override and no statement timeout.

## PERF-004 — Dependencies: 3 moderate vulns; universal `^` ranges pinned by lockfile
- **Severity: Low · Priority: P3** — `bun audit` (2026-08-03): 3 moderate, 0 high/critical — react-router `<7.18.0` (open-redirect CVE-2025-68470; SSR deserializeErrors) and react-router-dom `6.30.2-6.30.4` (open-redirect XSS), via the three SPAs. Intra-workspace drift `bullmq ^5.34.0` vs `^5.81.3`. CI uses `--frozen-lockfile`.

---

## Operator-readiness scorecard

| Can an operator answer… | Today? | Why |
|---|---|---|
| Is the system healthy right now? | **No** | `/ready` always green (OPS-004); no metrics (OPS-005) |
| Which dependency is failing? | **No** | probe is a stub; no connection instrumentation |
| Did last night's compliance crons fire? | **No** | half the catalogs are never constructed (OPS-003) |
| Are outbox events being delivered? | **No — they are not** | no dispatcher (OPS-001); no surface reports it |
| How deep is the DLQ/failed-job backlog? | **No** | DLQs named, never wired or measured (OPS-007) |
| Can I trace a user error through logs? | **Partially** | correlationId in error envelope + logs; no success header |
| What version is deployed? | **Only if** `APP_VERSION`/`GIT_SHA` set | nothing sets them; no pipeline |
| Can I deploy from a clean clone per docs? | **No** | no artifacts; runbook references nonexistent tooling (OPS-012) |
| Can I restore from backup? | **No** | documented only; no drill evidence (OPS-016) |
| Will boot flag incomplete prod config? | **Partially** | 6 secrets fail closed; REDIS/PLATFORM/rpIDs degrade silently (OPS-010) |
| Is a crashed instance drained cleanly? | **No** | no supervisor; no SIGTERM handling (OPS-006) |
