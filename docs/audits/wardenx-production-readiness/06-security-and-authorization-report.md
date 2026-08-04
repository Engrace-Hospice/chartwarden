# 06 — Security & Authorization Report

**Audit date:** 2026-08-03 · **Branch:** `main` @ `91e5b09` · **Method:** static review of `packages/auth`, `apps/backend/src/bootstrap`, and all 40 module route/predicate sources against the authoritative `docs/architecture/WARDENX_SECURITY_HARDENING_v0_2.md`. Read-only. Several 2026-06-27 / 2026-08-01 remediation items were re-verified against current code.

**Posture summary:** The identity/authorization *foundation* is strong — Better Auth with Argon2id + HIBP, encrypted 2FA at rest, fail-closed production env gate, RBAC+ABAC with a predicate-resolution gate, PHI-safe logging, no secrets in browser bundles, and durable break-glass with a regression test. The residual risk is concentrated in **(a) one hardcoded controlled-substance signing secret, (b) an incomplete PHI read-audit perimeter, and (c) several context fields that were declared but never assembled**, all of which fail *closed* (silently-dead authorization) rather than open.

Counts: **2 High · 4 Medium · 3 Low**, plus 10 previously-suspected items verified fixed/clean.

---

## SEC-001 — Controlled-substance witness HMAC secret is a committed literal
- **Severity: High · Priority: P1 · Confidence: High · Production blocker: Yes (controlled-substance eMAR)**
- Category: secrets / integrity of a regulatory control
- Evidence: `apps/backend/src/modules/13-emar/emar-route-service-db.ts:75` — `const WITNESS_SECRET = "wardenx-m13-witness-secret";` in the **live Drizzle route service** (token mint at :599, verify at :458). In-memory fallback `"test-witness-secret"` at `modules/13-emar/routes/service.ts:347`. No `process.env` read for any witness key exists in the repo, so `bootstrap/env.ts` cannot require one.
- Attack: anyone with source/repo access forges a valid witness token for any (org, patient, clinician) tuple, defeating the dual-signoff control on controlled-substance administration (a DEA/CoP requirement). Single-use "burn" is in-process only (`:29`), so cross-instance replay is also possible under horizontal scaling.
- Remediation: introduce `M13_WITNESS_SIGNING_KEY` (≥32 bytes), read at boot and added to `REQUIREMENTS` in `bootstrap/env.ts`; gate any dev fallback on `NODE_ENV !== "production"`; move single-use burn to a shared store when clustered.
- Acceptance: prod boot fails without the key; a token signed with the dev key is rejected in prod; unit test on the env path.

## SEC-002 — PHI read-audit perimeter excludes the clinical core, portal, IPU (and FHIR by gate)
- **Severity: High · Priority: P1 · Confidence: High · Production blocker: Yes (§164.528 accounting of disclosures)**
- Evidence: `apps/backend/src/bootstrap/index.ts:117-155` — `DEFAULT_READ_AUDIT_PREFIXES` = 25 prefixes (M5, M15/M16/M19/M20, M30, M23/M24/M25); the comment at :110-114 admits the clinical core is "NOT here yet," and the test `apps/backend/__tests__/read-audit-coverage.test.ts:137` still **asserts** the M6–M14/M17/M18/M22 core is *not* governed. Absent prefixes: all clinical-core reads, `/api/v1/portal/*` + `/api/v1/admin/portal-accounts*` (M31), `/api/v1/ipu-*` + `/api/v1/inpatient-units` (M37), `/api/v1/fhir/*` (M28).
- Mitigation: M28 FHIR reads carry their own disclosure-envelope audit (`modules/28-fhir/routes/fhir-r4.routes.ts:44,80`), so M28 is a *gate-coverage* gap, not an emission gap. The clinical core, portal, and IPU are genuine emission gaps — the densest PHI read surface in the product (~250 routes) produces no accounting rows.
- Exposure: an OCR accounting-of-disclosures request or an internal snooping investigation cannot reconstruct who read a patient's encounters, assessments, orders, eMAR, portal chart, or IPU record.
- Remediation: annotate clinical-core/portal/IPU GET handlers with `config.auditRead` and add their prefixes; add `/api/v1/fhir` with `{none: …}` waivers pointing at the disclosure envelope; flip the `:137` test into a positive assertion.
- Acceptance: every mounted PHI GET prefix is governed; boot fails on a new unannotated PHI read; read events observed per module in `audit_event`.
- Cross-ref: **API-004** (same finding from the API dimension).

## SEC-003 — M28 FHIR AI-prohibited-zone boot validator is implemented but never invoked
- **Severity: Medium · Priority: P2 · Confidence: High · Production blocker: No**
- Evidence: `packages/fhir/src/ai-block.ts:58` defines `validateFhirAIBlock` (unit-tested) but it has **no call site** outside its own package/tests. Contrast M37, whose equivalent `validateIpuAIBlock` **is** invoked in `onReady` at `apps/backend/src/index.ts:1946`. The comment at `index.ts:936-946` claiming M28 "runs at its own boot" is false.
- Impact: the W-FHIR-11 boot guard that should refuse to start if an AI prompt targets the FHIR egress zone does not run. Residual risk is low today because the central `AI_PROHIBITED_ZONES` table plus the deny-stub inference seams still hold, but the defense-in-depth guard the architecture mandates is dormant.
- Remediation: mirror the M37 wiring — in `onReady`, call `validateFhirAIBlock(getSeam("AIPromptRegistry"))` when the DB is present.

## SEC-004 — `providerEntityIds` never assembled; `actorKind` only ever `"user"`
- **Severity: Medium · Priority: P2 · Confidence: High · Production blocker: No (fails closed)**
- Evidence: `apps/backend/src/bootstrap/plugins/request-context.ts:38` initializes `providerEntityIds: []` and `authenticate.ts` never writes it; `authenticate.ts:48` always stamps `actorKind: "user"`. Predicates that read the empty PE list and therefore *always deny*: `packages/auth/src/abac/registry.ts:72` (`provider_entity_scope`), `modules/06-admission/abac-predicates.ts:78`, `modules/24-billing-medicaid/abac-predicates.ts:133`, `modules/20-field-safety/routes/actor.ts:117-126`, `modules/32-ai-platform/routes/actor.ts:114`. Only `modules/27-cost-report/abac-predicates.ts:265-274` has an RLS-backed fallback. Because `actorKind` is always `"user"`, `requireSystemPrincipal()` (M23/M15/M25 internal seam routes) 403s permanently — see **API-001**.
- Impact: provider-entity-scoped authorization is silently dead across ~6 modules; it fails closed (no data leak) but presents as broken features. `rejectAiActor()` coalesces the missing kind to `"user"` (fail-open in shape), moot only while no AI principal can authenticate.
- Remediation: return provider-entity bindings from `resolveActor` and stamp them into the context; add a machine-credential authentication path that stamps `actorKind: "system"` (never from a client header).

## SEC-005 — Production env validation misses several security-critical keys
- **Severity: Medium · Priority: P2 · Confidence: High · Production blocker: Partial (deployment checklist)**
- Evidence: `apps/backend/src/bootstrap/env.ts:27-61` requires only `DATABASE_URL`, `BETTER_AUTH_SECRET` (≥32), `BETTER_AUTH_URL` (https), `TRUSTED_ORIGINS`, `M24_CREDENTIAL_ENCRYPTION_KEY`, `TWO_FACTOR_ENCRYPTION_KEY`. Not validated (silently degrade): the M13 witness key (doesn't exist — SEC-001); `DATABASE_PLATFORM_URL` (`index.ts:1264` — absent ⇒ admin console/platform crons silently undefined; also requires a least-privilege platform login role to be provisioned, an ops precondition); `REDIS_URL` (`index.ts:1293` — absent ⇒ **zero background workers**, see OPS-002; limiter stays in-memory); `PASSKEY_RP_ID` (`packages/auth/src/identity/auth.ts:179` — production fallback `"localhost"`); no KEK/KMS key (per-tenant DEK envelope unbound platform-wide, fail-closed at `index.ts:1783,1836`). `MESSAGING_ENCRYPTION_KEY` and M19/M20 `CURSOR_SIGNING_KEY` also unvalidated (the latter falls back to an ephemeral random — availability-only).
- Remediation: extend `REQUIREMENTS` with every security-critical key; where a missing value merely degrades a feature, still validate-or-warn explicitly at boot.
- Cross-ref: **OPS-010**.

## SEC-006 — Rate limiting is in-memory, fixed-window, single-instance; no brute-force tier
- **Severity: Medium (Low single-instance) · Priority: P3 · Confidence: High**
- Evidence: `apps/backend/src/bootstrap/plugins/security.ts:93-113` — Map counters, 30/min unauthenticated per IP, 600/min per org (the whole org shares one bucket); the forward note at :14-15 says a Valkey-backed limiter is TODO. `trustProxy` correctly requires an explicit `TRUSTED_PROXY_CIDRS` allowlist (`bootstrap/index.ts:189-199`). Auth endpoints share the unauthenticated bucket — there is no dedicated brute-force tier on `/api/v1/auth/*` or step-up.
- Remediation: shared-store (Valkey) sliding-window limiter with a stricter tier for auth/step-up; document that behind a proxy, `TRUSTED_PROXY_CIDRS` must be set or per-IP limiting collapses to one bucket.
- Cross-ref: **API-005 / OPS-015**.

## SEC-007 — No CSRF double-submit protection on API mutations
- **Severity: Low · Priority: P3 · Confidence: Medium**
- Evidence: `security.ts:12-13` (the SEC-027 forward note is unimplemented). Better Auth's own origin/CSRF check covers its auth routes (`packages/auth/src/identity/auth.ts:106-114`). Residual risk is low given the strict CORS allowlist, JSON content-type preflight requirement, and server-bound session fields — but the declared contract is unmet for the app's own mutations.

## SEC-008 — `org_admin` fixed for seed/sync, but production provisioning cannot yet mint a first org_admin
- **Severity: Low (fails closed) · Priority: P3 · Confidence: High · Production blocker: Yes for self-serve onboarding only**
- Evidence of fix on main: role template `packages/auth/src/roles/templates.ts:247`; `scripts/db/seed.ts:61,72`; `scripts/db/seed-org-admin.ts`; `scripts/db/sync-permission-catalog.ts:28` maintaining `GRANT_ALL_ROLE_KEYS = ["administrator","org_admin"]` (the `org_admin ⊇ administrator` invariant). Remaining gap: M34 first-admin acceptance is a 503 deny-stub (`modules/34-saas-tenant-platform/index.ts:228-230`; Phase-2D TODO at `routes/public/signup-intents.ts:197-204`), and catalog sync is per-existing-org, so a freshly-provisioned org gets an empty-permission `org_admin` until sync re-runs. Production provisioning must create the role and its grants transactionally with the org.
- Cross-ref: **FLOW-007** (onboarding impossible from the UI).

## SEC-009 — Portal family-member chart reads emit no §164.528 rows
- **Severity: Low · Priority: P3** — a corollary of SEC-002; patient/family access is a disclosure category OCR asks about. Fold into the SEC-002 perimeter widening.

---

## Verified fixed / clean (re-checked against current `main`)

1. **Break-glass wildcard** — FIXED, both halves + regression tests: required non-null uuid `targetPatientId` (`modules/03-authorization/routes/authz-typebox.ts:187-210`), both-sides-non-null match in `break-glass-store.ts:127-152`, tests `authz-validation.test.ts:191-239` + `break-glass-contract.test.ts`.
2. **`membershipId` unpopulated** — FIXED at `authenticate.ts:64`.
3. **PHI-safe logging** — VERIFIED: `bootstrap/plugins/logger.ts` uses path-only URLs and redacts authorization/cookie; no module logs request bodies.
4. **Secrets hygiene** — `.gitignore` covers `.env` / `.env.*`; the only hardcoded secret found is SEC-001; **zero** `import.meta.env` secret reads in apps/web, apps/portal, apps/admin.
5. **Env gate present, fail-closed, invoked** (`index.ts:1243`).
6. **Session / step-up** — Better Auth single surface, Argon2id + HIBP, 2FA encrypted at rest, TRUSTED_ORIGINS origin check, all session `additionalFields` server-bound; `step_up_recent` registered at boot (`index.ts:522`, fail-closed logic in `packages/auth/src/abac/step-up.ts`).
7. **IDOR spot-checks (M5/M8/M23/M31/M37/M13)** — all derive org from server context in queries besides RLS; none accept a client-supplied org id.
8. **Platform context** — `DATABASE_PLATFORM_URL` is a separate pooled handle (`index.ts:1260-1265`); `withPlatformContext` is job-allowlisted (empty list = fail-closed) and audited via `platform.bypass_invoked` (`index.ts:1066,1578-1582`).
9. **M32 AI platform** — kill-switch is a platform+tenant disjunction; ledger is RECORD-ONCE (`invocation/service.ts:16-25`); the M37 D16 validator is invoked; `AIPromptRegistry` deny-stub throws when unwired. The model-output→privileged-action surface is currently **nil** — all ten inference seams are refusing deny-stubs (`ai.full` OFF). Prompt-injection must be re-audited when the inference pipeline binds. Exception: SEC-003.
10. **dependency vuln posture** — `bun audit`: 3 moderate (react-router family), 0 high/critical (see PERF-004).
