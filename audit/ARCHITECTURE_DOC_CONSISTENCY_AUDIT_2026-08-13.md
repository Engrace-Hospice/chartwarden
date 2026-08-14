# Architecture Corpus Consistency Audit — 2026-08-13

Scope: all 8 documents in [`docs/architecture/`](../docs/architecture/), audited against `main`.
Method: six parallel code-grounded audits (one per doc cluster, plus a cross-document sweep),
each required to cite doc line + code evidence and to verify before asserting. The highest-stakes
code findings in §1 were re-verified by hand.

**Verdict: the corpus is substantially inconsistent with the codebase and needs enhancement.**
Four of the eight docs have not been substantively updated since 2026-06-13/14 — before any of the
40 modules landed. The drift is not cosmetic: the authoritative architecture document names a
frontend framework, a realtime backbone, an encryption mechanism, and a whole service tier that do
not exist in the repo.

This matters more here than in a normal codebase because of the repo's own **authority rule**:
architecture docs win over module specs on conflict. A conflict resolved today in favor of
`WARDENX_ARCHITECTURE_v0_11.md` would produce wrong code.

---

## 1. Code findings (not doc issues) — fix these first

The audits surfaced real defects while cross-checking claims. Each was re-verified by hand.

### 1.1 Break-glass cosign has no cosigner-distinctness check — VERIFIED

`apps/backend/src/modules/03-authorization/routes/authz-routes.ts:361-371` and
`break-glass-store.ts:92-101`: `cosign(eventId, byUserId)` sets `status:"active", cosignedBy:
byUserId` with no comparison against the invoker, and the route performs no check either. Cosign
and revoke share one permission (`breakglass.cosign`).

When tenant policy sets `breakglass_cosign_required = true`, the two-person property is the entire
control — and a holder of `breakglass.cosign` can self-cosign their own emergency PHI access.
**Every other two-person control in the repo enforces distinctness** (M34 shred co-signer ≠
approver, M30 CAP verifier ≠ assignee, M30 PIP closer ≠ charterer, M28 FHIR dual approval, M35
refund four-eyes, M21 reconciler ≠ dispatcher). This one is the outlier, and it guards the most
sensitive path.

### 1.2 `trg_tenant_step_up_tighten_only` does not exist — VERIFIED

`apps/backend/src/modules/02-identity/policy/step-up-resolver.ts:45` states the trigger
"is the at-rest guard; this is its app-layer twin." Zero occurrences across all 191 migrations.
The at-rest half of a defence-in-depth pair was never built, and the comment asserts it was.

Compounding: M3's `step_up_recent` predicate (`03-authorization/abac-predicates.ts:40-55`) passes
the platform floor directly and never invokes the tenant resolver — so on the live path the
tighten-only step-up policy is not applied at either layer.

### 1.3 Two M24 tables enable RLS without FORCE — VERIFIED

`0175_billing_m24_state_plan_code_rls.sql:20` and `0180_billing_m24_state_rate_schedule_rls.sql:5`
`ENABLE ROW LEVEL SECURITY` without `FORCE`. The catalog-driven FORCE sweeps (`0118`, `0159`) both
predate them, and no later migration covers either table (last FORCE migration is `0185`). Table
owners are therefore exempt from RLS on these two tables — the exact gap `0118` was written to close.

### 1.4 Readiness probe cannot detect a MinIO outage

`apps/backend/src/bootstrap/readiness-probe.ts:110` hard-codes `minio: "ok"`. `/ready` advertises
`minio` as a checked dependency (`routes/health.ts:33-39`), so an object-storage outage never flips
readiness. DR/BCP §6.3's storage-failover detection step depends on this signal.

### 1.5 Documented signup rate limit is not enforced

`SECURITY_HARDENING §22.1` specifies 5/IP/hour on `POST /api/v1/public/signup-intents`. The port
defaults to `createAllowAllRateLimiter()`
(`34-saas-tenant-platform/routes/public/signup-intents.ts:79-86`) and the composition root never
injects a real limiter — unlimited in practice. Relatedly, there is **no account lockout anywhere**
despite §5.3.1 specifying per-username lockout and captcha (`captcha`/`turnstile`: zero hits repo-wide).

### 1.6 Audit append-only claim is overbroad (nuance, not a bug)

`0157_destruction_role_grants.sql:84` grants `SELECT, DELETE ON audit_event TO wardenx_destruction`
— **intentional and documented in-file** (line 54) for the partitioned crypto-erase adapter. But
the integrity report inspects only `wardenx_app` (`04-audit/routes/audit-integrity.ts:31-33`), so
it cannot detect drift on this role, and §13.1's absolute "application code physically cannot
modify audit" needs the carve-out stated.

---

## 2. Why the corpus drifted: there is no gate

`arch:fitness` chains **20 gates**. Exactly one (`arch:ai-governance`) reads anything under
`docs/architecture/`.

This repo otherwise gates its documentation aggressively — `docs:ui` (UI screen corpus),
`arch:plan-integrity` (plans), `arch:status-matrix` / `arch:ui-parity` / `arch:frame-fidelity` /
`arch:openapi-coverage` (generated reports), `arch:design-tokens`, `arch:abac-predicates`,
`arch:audit-denylist-sync`. The authoritative architecture corpus is the conspicuous exception, and
it is the one body of prose the authority rule makes binding. It drifted freely for two months
while everything else stayed pinned.

---

## 3. Findings by document

Severity: **A** = would cause wrong action if followed · **B** = materially false ·
**C** = stale/cosmetic.

### 3.1 `WARDENX_OPS_RUNBOOK_v0.1.md` + `WARDENX_DR_BCP_v0.1.md` — severity A

A runbook with wrong commands is worse than no runbook. Both docs describe an infrastructure fleet
(Pangolin, PgBouncer, PBS, MinIO cluster, PagerDuty, Grafana, Sentry, `wardenx-app-01`…) that
exists nowhere in the repo — and unlike `Dockerfile`/`docker-compose.yml`/`deploy.yml`/
`ops/pgbackrest/*.template`, which all carry explicit "SCAFFOLD, NOT VALIDATED" headers, **neither
doc carries that caveat.**

- **Wrong ports throughout** — health/deploy commands use `4181`/`4191`; the real API is `PORT ?? 3000`,
  worker `WORKER_PORT ?? 3001` (`Dockerfile` `EXPOSE 3000 3001`). `4181` appears nowhere in the repo.
- **`packages/db/scripts/` does not exist** — all nine tenant/DSAR/legal-hold commands in §11 are
  non-executable. The entire Tenant Operations chapter is dead.
- **Shred crash-recovery command does not exist** — DR §14A.2 cites
  `packages/saas-tenant-platform/scripts/resume-shred.ts`. This guards the irreversible Phase-3
  DEK-destruction boundary: the highest-stakes procedure in either document.
- **DR §14A.3 forensic SQL is invalid** — selects `occurred_at`, `actor_membership_id`, `patient_id`
  from `audit_event`; real columns are `created_at`, `actor_user_id`, and there is no `patient_id`.
  The `actor_kind` values queried (`platform_ops_via_support_session`, `break_glass`) are not enum
  members. Query errors immediately. Runbook §12.3 uses the correct columns — the two docs disagree.
- **`/version` can never pass its check** — §4.3 expects the new SHA; `Dockerfile` and `deploy.yml`
  inject no `APP_VERSION`/`GIT_SHA`, so it always returns `{"version":"dev","gitSha":"unknown"}`.
- **Partition inventory: 5 of 9 rows wrong** — `encounter`, `message`, `feature_flag_evaluation` are
  not partitioned at all; `claim` has no RANGE sub-partition; `hope_assessment` is RANGE `target_date`,
  not `created_at`. `encounter_note` does not exist.
- **cosign/SBOM/Trivy verification steps** reference tooling with zero hits repo-wide; the image name
  is wrong (`ghcr.io/<owner>/wardenx`, not `ghcr.io/wardenx/backend`).
- **RTO/RPO targets have no implementing mechanism** — no streaming replication, no WAL archiving,
  no replica promotion. pgBackRest exists only as `ops/pgbackrest/pgbackrest.conf.template`,
  self-labelled all-placeholder. `bun run backup:restore-drill` **does** exist and is described
  accurately, but no workflow ever invokes it.
- **Undocumented ops surface**: the separate `worker.ts` process (blue-green procedures would leave
  it on the old image), `/metrics` + real Prometheus metric names, DLQ alerting via
  `OPS_ALERT_WEBHOOK_URL`, the `db:provision-roles` precondition, and the ~22-var production env
  contract in `bootstrap/env.ts` (§8.1 lists 3 of them and invents two that don't exist).

### 3.2 `WARDENX_ARCHITECTURE_v0_11.md` — severity B (authoritative doc)

- **Frontend is not TanStack Start.** All three SPAs are Vite 6 + `react-router-dom` ^7. No
  `@tanstack/*` anywhere. Affects §4, §5, §11.
- **`apps/frontend` does not exist** — it is `apps/web`.
- **Socket.IO and the entire realtime backbone are absent.** No dependency, no import, no server.
  §25.13 prescribes "modules communicate via Socket.IO events" — a cross-module channel with no
  implementation. (`packages/messaging/src/realtime/*` are pure room-name builders that explicitly
  state they import no socket.io.)
- **The Python sidecar tier does not exist.** Zero `.py` files, no `pyproject.toml`, no `services/`,
  no `infra/`. §12 describes zero code. X12/cost-report work is TypeScript.
- **pgcrypto envelope encryption is the wrong mechanism at the wrong layer** — compliance-weighted.
  `pgcrypto` is installed but used only for `gen_random_uuid()`; zero `pgp_sym_encrypt`/`encrypt(`
  calls across 191 migrations. Real encryption is application-layer AES-256-GCM with HKDF-derived
  per-tenant DEKs.
- **XState is explicitly rejected in code** (§25.1 mandates it); state machines are pure transition
  functions, with in-file comments saying so.
- **Eleven named dependencies are not installed**: OpenTelemetry, Sentry, MinIO client, react-pdf,
  Puppeteer, Testcontainers, MSW, Recharts, iconsax, shadcn/ui, every `@fastify/*` plugin, the
  Stripe SDK, the Anthropic SDK.
- **§20 dependency table contradicts the manifest that claims to mirror it verbatim** — M9/M10/M11
  dropped M8 (the ADR-0007 seam inversion, recorded in the doc's own changelog but never propagated),
  plus M22→39 and M35→34 divergences with no cover.
- **~60 roles catalogued, 13 shipped.** **Idempotency documented as Valkey; it is Postgres.**
  `packages/rules-engine`, `packages/db/src/repos`, `apps/mobile` and 5 other cited paths don't exist.
  26 of 47 real packages are undocumented.

### 3.3 `WARDENX_INTEGRATIONS_v0_1.md` — severity B

- **15 of 33 adapter package paths are wrong** — superseded by ADR-0028/0029, which post-date the
  doc by one day. `packages/hl7-worker`, `packages/anthropic-client`, `packages/nppes-client`,
  `packages/storage`, `packages/webpush`, `packages/vendor-edi`, `packages/pharmacy-client`,
  `packages/terminology-loader` were never created. `packages/ai-platform/src/backends/anthropic.ts`
  rebuts the doc by name: *"That package does not exist and must not be created."*
- **Wrong EVV vendor** — doc names "OR-PTC DCI"; the built launch adapter is **Sandata**.
- **§11's entire open-items table cites ADR numbers belonging to unrelated ADRs** (ADR-001/003/005/
  006/007 are taken by RHC rates, room-and-board revenue codes, manifest SSOT, etc.). The real
  governing ADRs are 0019/0026/0028/0029.
- **`better-auth` — the only installed third-party SDK — has no inventory row**, an INT-002 violation
  by the doc's own rule.
- **Reality check on wiring** (important for planning): essentially **no integration is live**.
  There is no MAC transport at all (not just "J6 only") — `X12_WORKER_NOT_WIRED` fronts a sidecar
  that doesn't exist. HETS 270/271, DoseSpot HTTP, iQIES, web-push, local AI, terminology loaders,
  triage vendors are absent. SHP CAHPS is transport-unwired (only `manual` needs none). M28 FHIR
  reads return hardcoded 404/empty-Bundle — not fail-closed, no data path — and bulk `$export` has
  no route or worker. The most-wired vendor surface in the repo is **inbound Twilio/Postmark webhooks**;
  outbound email is a no-op in production. Real network `fetch` exists in exactly 6 non-test files.

### 3.4 `WARDENX_SECURITY_HARDENING_v0_2.md` — severity B

- **§1.4 states "fail closed… never default to allow on error" with no carve-out**, but the rate
  limiter deliberately fails open on store outage. The code is right (it's an availability control);
  the doc's stated principle forbids it. This carve-out must be documented.
- **§6.5 service-to-service auth describes mTLS + short-lived signed tokens.** Actual: a static
  shared secret, no mTLS, no signature, no expiry — and the tenant comes from a **caller-supplied
  `x-internal-org-id` header**.
- **Rate-limit numbers are fiction** (§5.3.1): no per-username lockout, no lockout at all, no captcha,
  fixed 60 s window not 10 min, no per-route limiting.
- **Session timeouts are declared but never enforced** — `SESSION_POLICY.byClass` has no runtime
  reader; `betterAuth({session})` sets only `additionalFields`, no `expiresIn`/`updateAge`, no cookie
  config, no IP/UA binding.
- **§6.2's route example shows an API that no longer exists** — inline predicate closure vs. the real
  registry-resolved name string. Every reader following it writes uncompilable code.
- Headers drift (HSTS 31536000 vs documented 63072000; `SameSite=Lax` not `Strict`; no Origin/Referer
  check; `Permissions-Policy` documented but never set); §4.2 field encryption named as pgcrypto;
  §22.2 DEK lifecycle presented as operational while `kekUnwrap` is a throwing stub.
- **Undocumented controls that are among the strongest in the codebase**: the PHI read-audit
  **boot-time** gate (an undeclared PHI read route means the server cannot boot), the ABAC registry's
  fail-closed unknown-name behavior + `arch:abac-predicates`, `assertNoEscalation`, application-level
  break-glass (§17 covers only infrastructure credentials), the seven separation-of-duties controls,
  tighten-only overrides, `withPlatformContext`, RLS **FORCE** (370 tables + 429 partition leaves),
  and the production env validator.

### 3.5 `ARCHITECTURE_25_15_FITNESS.md` — severity B

- **Documents `arch:fitness` as 4 gates; it is 20.** `ci.yml` already carries a comment noting its
  own label went stale. This is the most load-bearing false statement in the file.
- **Checks 8 and 9 (Biome `require-explicit-authz` / `require-read-audit`) do not exist** — listed as
  "already in place". `biome.json` has no custom rules and Biome 1.9.4 has no plugin API; zero hits
  repo-wide. The real enforcers are the runtime `read-audit.ts` plugin and `check-abac-predicates.ts`.
  Lint is also `continue-on-error: true` in CI, contradicting the doc's pipeline.
- **"Manifest is authoritative for Modules 1–4"** — it is authoritative for all 40, with 463 owned
  tables and no empty `ownedTables`. (Note: `CLAUDE.md`'s "460 tables" is also stale — actual 463.)
- 16 gates exist with no doc coverage; `audit-fitness.ts` is wired to no script or CI step.

### 3.6 `WARDENX_SYSTEM_DESIGN_v0.3.md` — severity B

Same TanStack / Socket.IO / Python-sidecar / Valkey-idempotency drift as §3.2, plus: dev topology
describes `docker compose -f infra/docker/dev.compose.yaml` with valkey/minio/mailpit/mlflow
containers (real: a bare `docker run` of Postgres on **port 5440**); ports 4180/4181 (real: 5173 /
3000); lefthook (real: `.githooks`); and five `bun` commands in §12.6 that don't exist.

### 3.7 `WARDENX_AI_GOVERNANCE_v0.2.md` — severity B, but best-maintained

The capability inventory is **current and correct** (18 catalogued, matching `docs/ai/`, with
`level_of_care_prediction` ratified High), the 8-state lifecycle FSM matches code edge-for-edge, and
the backend inventory matches. Problems:

- **`ai.full` is never mentioned in 1756 lines.** It is the outermost gate, it is OFF platform-wide,
  and it is why no model is dispatched today and all 10 M32 inference seams resolve to deny-stubs.
  A governance doc that omits the mechanism holding the entire AI platform inert is missing its
  single most important operational fact.
- **The kill switch is described as a feature flag.** It is an `ai_kill_switch_state` row with
  `platformRow.active OR tenantRow.active` semantics; no `ai.*_kill` flag is seeded anywhere. The
  capability catalog the doc points at says in capitals that killing is not a flag flip.
- **§4.4's 14-section per-capability template describes none of the 18 real docs** (all carry 5
  headings), and `arch:ai-governance` enforces the 5, not the 14.
- §16.1's event names (`ai.*`) can never be outbox names — the `mN.` prefix is gate-enforced; real
  events are `m32.*`. The 8-gate invocation order, the four unbound ports, the DB-trigger
  immutability substrate, and SEV-1 **auto-demotion** are all undocumented.

### 3.8 Cross-document contradictions

- **RTO/RPO conflict, 4×.** `SYSTEM_DESIGN:1384` states a blanket production **4 hr RTO / 15 min RPO**;
  `DR_BCP:134` sets Tier 1 at **1 hr / 5 min**. SYSTEM_DESIGN's own §10.1 per-component row
  (`<1 hr / <5 min`) contradicts its §10.2 header.
- **HOPE retention conflict.** `OPS_RUNBOOK:425` says 6 years; ADR-0004 closed OPEN-021 moving
  clinical-record + HOPE retention **6 → 7 years**, and `ARCHITECTURE:2874` says 7. The runbook
  carries the pre-ADR value.
- **Filename vs. content version mismatches**: `WARDENX_ARCHITECTURE_v0_11.md` declares "v0.12";
  `WARDENX_INTEGRATIONS_v0_1.md` declares "v0.2". Two v0.2 files end with "End of … v0.1."
- **11 stale cross-doc version citations** — every `Companion to:` line but one cites a superseded
  architecture version (v0.9/v0.10 against v0.12 on disk).
- **63 distinct nonexistent repo paths** (~78 occurrences) cited across the corpus. `infra/`,
  `docs/ops/`, `docs/policies/`, `docs/runbooks/`, `docs/dr-drills/`, `docs/feature-flags/` and
  `docs/architecture/vendor-escalation.md` do not exist.
- **Module-spec path convention wrong in three docs** — two variants cited, neither matching the real
  flat `docs/modules/WARDENX_MODULE_NN_*_SPEC_vX_Y.md`.
- **"Phase" is overloaded** — audit-remediation phases vs. product-launch phases, with no
  disambiguation. A live reader trap.
- Clean: module identifiers (M1–M40 all resolve), session timeouts (agree across four docs),
  core technology (Postgres 18/pgvector/Fastify 5/Bun) where it is right at all.

---

## 4. What the docs get right

Worth stating, because the corpus is not worthless — the *spine* is accurate:
Bun · Fastify 5 · TypeBox · Drizzle + `pg` · PostgreSQL 18 · pgvector (real, one `vector(384)` column
+ HNSW) · Valkey/ioredis · BullMQ · Better Auth as a surface · prom-client (fully wired) ·
Vite/React/Tailwind v4 · Vitest · Playwright · Biome · GitHub Actions · the transactional outbox ·
RLS + `withOrgContext` · monthly-partitioned `audit_event` · typed error classes · the M23 claim-
validation and M27 cost-report frameworks · Argon2id + HIBP password policy · the 41-suite live-RLS
CI matrix (understated, if anything).

The AI governance capability inventory and lifecycle FSM are current. `ARCHITECTURE_25_15_FITNESS.md`'s
enforcement paths all resolve. `backup:restore-drill` is described accurately.

---

## 5. Recommendation

Three tracks, in priority order.

### Track 1 — Fix the code findings (§1). Not doc work.
1.1 break-glass distinctness and 1.3 the un-FORCEd M24 tables are security-relevant and small.
1.2 should be resolved by *deciding*: either write the trigger or delete the comment and wire the
tenant resolver into `step_up_recent`. 1.4 and 1.5 are honest-signal fixes.

### Track 2 — Correct the corpus, and separate *target* from *as-built*
Most of the severity-B drift is not rot — it is **unrecorded divergence**. The build deliberately
chose react-router over TanStack, no Socket.IO, TypeScript X12 over Python sidecars, app-layer AES
over pgcrypto, hand-rolled state machines over XState, and no `@fastify/*` plugins. Those were
decisions; none of them produced an ADR.

So the highest-leverage edit is not a rewrite — it is:
- **Write the missing ADRs** for those six divergences. That converts "the doc is wrong" into "the
  doc records what we chose," which is what an architecture corpus is for.
- **Mark aspirational sections explicitly** (`STATUS: TARGET — NOT BUILT`), the way
  `ops/pgbackrest/*.template` and `docker-compose.yml` already do. §12 sidecars, §7's 60-role
  catalog, the DR fleet, and the realtime backbone are all legitimate target state — they are only
  harmful because they read as present tense.
- **Fix the A-severity runbook errors outright** (ports, dead script paths, invalid forensic SQL,
  partition table). These have no aspirational reading.
- **Reconcile the two hard conflicts**: RTO/RPO and HOPE retention.
- **Add the undocumented patterns** — the fitness kit, seam registry + deny-stubs, the typed-port /
  fail-closed-vendor idiom, step-up, read-audit boot gate, `withPlatformContext`, tighten-only
  overrides, and `ai.full`. A new engineer hits most of these within an hour, and
  `docs/APP_OVERVIEW.md` currently documents them better than the authoritative corpus does.

### Track 3 — Add a freshness gate (the structural fix)
The corpus drifted because nothing checks it (§2). A cheap `scripts/check-architecture-docs.ts`
wired into `arch:fitness` — matching how this repo already treats every other body of documentation —
would mechanically catch a large share of these findings:

1. **Every repo path cited in an architecture doc must exist.** Catches all 63 dead paths, and would
   have caught the 15 wrong adapter paths and the dead runbook scripts on the commit that introduced them.
2. **Filename version == header version.** Catches both mismatches.
3. **Every `Companion to: X vN.M` must match the on-disk version.** Catches all 11.
4. **Every `ADR-NNNN` citation must resolve to an existing ADR.** Catches the §11 integrations table.
5. Optionally: a `<!-- verified-against: <sha> -->` stamp per doc, warning past a staleness threshold.

Rules 1–4 are pure string-and-filesystem checks with no false-positive risk, and together they cover
the majority of the mechanical findings in this report. The judgment-dependent drift (TanStack,
Socket.IO, pgcrypto) still needs human review — but that is exactly what the ADRs in Track 2 pin down.
