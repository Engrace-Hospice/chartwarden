# 02 — Production-Readiness Report

**Audit date:** 2026-08-03 · **Branch:** `main` @ `91e5b09`.

Each gate is Pass / Conditional Pass / Fail / Not Implemented / Unable to Verify. A Conditional Pass names its exact condition.

| # | Gate | Result | Evidence / condition |
|---|---|---|---|
| 1 | Clean reproducible installation | **Pass** | `bun install --frozen-lockfile` + `bun run build` both exit 0. |
| 2 | Successful production build | **Pass** | `bun run build` green; frontend bundles (single 1.53 MB chunk — PERF-001). |
| 3 | Strict type checking | **Pass** | `tsc -b` exits 0 under `strict:true`; zero real `any`/ts-suppressions. Contract drift exists but not type errors (see report 04). |
| 4 | Passing critical tests | **Conditional Pass** | 6,746 pass, but the 927 live-RLS/write-lifecycle tests are **skipped** by default and ~66% of routes have no HTTP-dispatch test (TEST-001). Condition: unit/inject coverage only; behavioral proof of the revenue cycle and newest modules is absent. |
| 5 | Migration safety | **Conditional Pass** | Runner is idempotent with a tracking table (DB-001), but is self-declared "not the production migrator," is superuser-only, only warns on checksum drift, and has no rollback. Condition: a real production migration path + gate must be defined (OPS-013). |
| 6 | Authentication correctness | **Pass** | Better Auth, Argon2id + HIBP, encrypted 2FA, TRUSTED_ORIGINS, step-up registered. Caveat: `PASSKEY_RP_ID` falls back to `localhost` in prod (OPS-010). |
| 7 | Authorization correctness | **Fail** | `requirePermission` guards use the live resolver, but M3's own grant-management + `/me/permissions` bind an empty resolver (ARCH-015); assessment/order cosign permanently 403 (ARCH-001); `providerEntityIds`/`locationIds`/`actorKind` never assembled → whole write surfaces dead (ARCH-008/009). |
| 8 | Tenant isolation | **Fail** | FORCE RLS regressed on ~66 tables post-0118 (DB-002); M29 (0/11) & M35 (3/21) have zero executed cross-tenant proof (DB-003); 11 platform tables are RLS-enabled with zero policies, working only via the owner-bypass hole (DB-004). |
| 9 | Input validation | **Pass** | Every mutating handler runs a per-module `parse()` (Value.Check); M26 hole fixed. Caveat: 100% convention, no Fastify `schema:` enforcement (types report). |
| 10 | Secret management | **Conditional Pass** | `.gitignore` covers `.env*`; no secrets in browser bundles. Condition: one hardcoded controlled-substance witness secret (SEC-001) must be externalized; env gate must add missing keys (SEC-005/OPS-010). |
| 11 | Error handling | **Pass** | WardenXError envelope with correlation IDs, no stack/driver leakage (OPS-008). Minor: framework 4xx fall to 500 (API-009). |
| 12 | Observability | **Fail** | No metrics, no tracing, no error reporting; `/ready` cannot fail; no queue/outbox/DLQ visibility (OPS-004/005). |
| 13 | Backup & recovery | **Fail** | DR/BCP is documented-intent only; zero backup/restore tooling in the repo (OPS-016). |
| 14 | Workflow completeness | **Fail** | Clinical documentation, Medicare billing, and user onboarding cannot be completed from the UI (FLOW-001/007/008). |
| 15 | UI-state completeness | **Fail** | Failure and emptiness share one unannounced state; no retry in the clinical core; false-perfect stats; system pages unreachable (UI-002/003, FLOW-004/005/006). |
| 16 | Accessibility baseline | **Fail** | Copied modal has no focus trap (UI-005); errors rarely associated, no skip link, sidebar has no active indicator (UI-001/007). |
| 17 | Performance baseline | **Conditional Pass** | List caps and pagination sound, but a single 1.53 MB chunk and eMAR N+1 sync (PERF-001/002); no load evidence. Condition: acceptable at pilot scale, not proven at multi-tenant scale. |
| 18 | AI-provider failure containment | **Pass (by posture)** | All ten inference seams are refusing deny-stubs (`ai.full` OFF); model-output→privileged-action surface is currently nil. Re-audit when the pipeline binds (SEC-003 caveat: M28 boot validator never invoked). |
| 19 | Human approval for privileged AI actions | **Not Implemented / N/A now** | No AI pipeline is live to gate; the AI-block boot validator for FHIR is not wired (SEC-003). |
| 20 | Operational documentation | **Fail** | Ops runbook references a `drizzle:migrate` script and `__drizzle_migrations` table that do not exist; no clean-clone deploy path (OPS-012). |

## Gate tally
- **Pass:** 6 (install, build, types, auth, input validation, error handling; + AI posture)
- **Conditional Pass:** 4 (critical tests, migration safety, secrets, performance)
- **Fail:** 9 (authorization, tenant isolation, observability, backup/recovery, workflow, UI-state, accessibility, operational docs; AI human-approval N/A)

## Blocking dispositions
A production deployment requires, at minimum: all 9 P0 blockers closed (report 00); gates 7, 8, 12, 13, 14 moved off **Fail**; and the conditions on gates 4, 5, 10 satisfied. Until then the system is **Not Production Ready**.
