# 11 — Test & Quality Report

**Audit date:** 2026-08-03 · **Branch:** `main` @ `91e5b09` · **Runner:** Bun/vitest. Read-only.

**Baseline observed:** `bun run test` → **6,746 passed · 927 skipped · 12 todo** (7,685 total across 530 files) in 43.5s; all 17 `arch:fitness` gates green; production build green. The 927 skipped are the entire live-Postgres tier (`*.live.test.ts`, guarded by `describe.skipIf(!WARDENX_TEST_DATABASE_URL)`), which the default run and local `validate` never execute.

**Headline:** Coverage is *inverted* — the modules with the most HTTP-dispatch testing are not the highest-risk ones, and ~two-thirds of mounted routes (including the entire revenue cycle) have no test that goes through the validator + guard + service chain. Three previously-flagged gaps are genuinely fixed. Two new/persisting High findings block confident change and gate two modules' isolation claims.

Counts: **2 High · 4 Medium · 3 Low.** Fixed since prior audit: 3.

Inventory: 528 `*.test.ts`; 77 `*.live.test.ts`; 256 backend test files; **39 inject HTTP suites**; 9 web/portal/admin test files (all pure-logic); CI = `.github/workflows/ci.yml` (build-and-verify + 36-suite rls-live matrix + auth-live).

---

## Behavioral coverage matrix (12 riskiest modules)

Columns: Unit · HTTP (inject) · SQL-integration (live Drizzle) · RLS-live (suite/script/CI) · Contract (enrichment) · Failure-paths (HTTP 403/422) · Cross-tenant-HTTP · E2E/UI

| Module | Unit | HTTP | SQL-int | RLS-live | Contract | Fail | X-ten | E2E |
|---|---|---|---|---|---|---|---|---|
| M05 Patient | ✅ | ✅ | ◐ | ✅/✅/✅ | 14/14 | ✅ | ✅ | ❌ |
| M06 Admission | ✅ | ✅ | ✅ (no CI) | ✅/✅/✅ | 47/47 | ✅ | ✅ | ❌ |
| M11 Orders | ✅ | ✅ | ✅ (no CI) | ✅/✅/✅ | 28/28 | ✅ | ◐ | ❌ |
| M13 eMAR | ✅ | ✅ | ✅ (no CI) | ✅/✅/✅ | 28/28 | ✅ | ◐ | ❌ |
| M23 Billing-MCR | ✅ | ❌ | ❌ | ✅/✅/✅ | 43/43 | ❌ | ❌ | ❌ |
| M25 Remittance | ✅ | ❌ | ◐ seam | ✅/✅/✅ | 31/31 | ❌ | ❌ | ❌ |
| M29 Ext-Interfaces | ✅ | ❌ | ❌ | **❌/❌/❌ (0/11)** | 33/33 | ❌ | ❌ | ❌ |
| M30 Quality | ✅ | ❌ | ❌ | ✅/✅/✅ | 60/60 | ❌ | ❌ | ❌ |
| M31 Portal | ✅ | ❌ | ◐ eraser | ✅/**❌/❌** | 53/53 | ❌ | ❌ | ❌ |
| M34 SaaS | ✅ | ❌ | ❌ | ✅/✅/✅ | 48/48 | ❌ | ❌ | ❌ |
| M35 Subscription | ✅ | ❌ | ❌ | **❌/❌/❌ (3/21)** | 54/54 | ❌ | ❌ | ❌ |
| M37 IPU | ✅ (~90) | ❌ | ✅ (script, **no CI**) | ✅/✅/**❌ (8/26)** | 45/45 | ❌ | ◐ | ❌ |

HTTP-tested modules (18): M2–M13, M22, M28, M36, M38–M40 (~410 routes). Untested over HTTP: ~21 modules, ~800 of 1,211 matrix-counted routes (~66%), including the whole revenue cycle.

---

## TEST-001 — Two-thirds of mounted routes have no HTTP-layer test
- **Severity: High · Priority: P1 · Confidence: High · Production blocker: No (but blocks safe change)**
- Evidence: only 39 files call `.inject(`; the "route tests" for M14–M21/M23–M27/M29–M35/M37 assert permission catalogs and ABAC predicates as pure functions. Headers are explicit: `apps/backend/__tests__/oncall-routes.test.ts:6-8`, `ai-platform-routes.test.ts:5-7`, `field-safety-routes.test.ts:5-7` — "tests are about the DECISIONS, not the SQL."
- Risk: a mis-wired guard/schema/service on a route (the M30 dead-`inOrg` class; the Claim Workbench 404) is invisible — the ABAC gate catches unregistered names, not mis-wiring. This is exactly the class of defect the workflow audit found live in M23 (FLOW-008).
- Minimal fix: a per-module table-driven inject smoke suite (clone `orders-routes.test.ts`): 401 (no auth), 403 (no permission), 422 (empty body), one 2xx per route.
- Acceptance: zero modules that have a `routes/` dir and no inject suite.

## TEST-002 — Live-RLS gaps on the newest modules; write-live suites outside CI
- **Severity: High · Priority: P1 · Confidence: High · Production blocker: Yes for M29/M35 GA**
- Evidence: no `m29-`/`m35-rls-isolation.live.test.ts` exists; `package.json:36-103` has no `test:rls:live:{m29,m31,m35}`; `m31-rls-isolation.live.test.ts` is orphaned (no script, no CI row); `test:rls:live:m28` and the M37 scripts exist but are absent from the ci.yml matrix; no `test:mN:{read,write}:live` script is in any CI job. M35's "3/21" are incidental name-matches, not a real suite (per the matrix generator's own comment).
- Minimal fix: author m29/m35 suites (clone m26); add 5 scripts + CI rows (M28, M29, M31, M35, M37).
- Acceptance: Live column full-ratio for 40 modules; every live suite reachable from a ci.yml row.
- Cross-ref: **DB-003 / OPS-014**.

## TEST-003 — Inject tests bypass the real auth plugin and Drizzle services
- **Severity: Medium-High · Priority: P2 · Confidence: High**
- Evidence: 30 inject files use the `x-test-user`/`x-test-org` header shim (`buildServer({authenticate: headerAuth})`, e.g. `orders-routes.test.ts:28-36,76`); 98 files mount `createInMemory*` backends while production mounts `*-route-service-db.ts`. The real session→context binding is exercised only in `auth.live.test.ts`. Positive: the shim still runs the real RBAC/ABAC contract.
- Risk: session→context binding bugs (the historical `membershipId`-unpopulated defect) and in-memory-vs-Drizzle behavioral drift (412/409/pagination) are invisible.
- Minimal fix: a shared conformance spec run against both backends per module; one real-session→module-route case in `auth.live`.

## TEST-004 — No component/E2E test infrastructure for web, portal, admin
- **Severity: Medium · Priority: P2 · Confidence: High**
- Evidence: `vitest.config.ts:12` is `environment: "node"`; no jsdom/RTL/Playwright declared in any package.json; 9 pure-logic tests total; no e2e directory. Component rendering is not merely untested — it is untestable.
- Minimal fix: a jsdom vitest project plus a registry-driven smoke-render of every `screens.ts` entry per app.

## TEST-005 — Only 6 of 17 gates have a planted-violation (goes-red) self-test
- **Severity: Medium · Priority: P2 · Confidence: High**
- Evidence: `scripts/__tests__/fitness-gates.test.ts:25-72` red-tests exactly tenancy, table-ownership, ddl-legality, fitness-gaps, boundaries, openapi-coverage. No red test exists for abac-predicates, design-tokens, ui-parity, client:check, status-matrix, frame-fidelity, ai-governance, plan-integrity, scaffold-parity, openapi:check. A gate with no red test can silently stop catching its target class (the historical ui-parity `includes()` hole).
- Minimal fix: planted-violation fixtures for abac-predicates, design-tokens, ui-parity, client:check first.

## TEST-006 — `Live` column is now a ratio (FIXED); residual: name-match ≠ executed proof
- **Severity: Low** — `scripts/report-implementation-status.ts:174-183` computes `{tables, covered}`. Residual: M31 reads 3/3 from a suite that no script or CI job ever runs — the ratio is honest about coverage but not about execution.

## TEST-007 — Clean-DB migration proof uses the tests' own applier, not the production runner
- **Severity: Low-Medium · Priority: P3** — each rls-live job boots a fresh pg16 and replays the full chain via `applyMigrations()` (`rls-isolation.live.test.ts:69-94`), not `scripts/db/migrate.ts`. Add one gated test that shells the real runner from an empty DB and asserts `rolbypassrls=false` afterward.

## TEST-009 — Determinism: low flake risk, one wall-clock coupling
- **Severity: Low · Priority: P3** — 0 fake-timer usage; `messaging-webhooks.test.ts:43,86` couples to a signature freshness window (flake risk on slow CI). Shared-registry order-dependence is actively managed via before/afterEach resets but relies on every suite remembering to reset.

## TEST-010 — CI is comprehensive on paper but dormant in practice
- **Severity: Low · Priority: P3** — all 77 live files `skipIf` on the env var, so local `validate` never runs them, and the local-only/no-push workflow means the rls-live matrix rarely executes at all. Recommend a documented local `test:live:all` pre-merge step (throwaway cluster, `max_locks_per_transaction=4096`).

---

## Verified fixed
- **CI now executes real SQL** — a 36-suite live-Postgres RLS matrix + an auth-live job (`ci.yml`). The prior "0% of CI executes real SQL" is resolved.
- **m24/m25/m26 RLS suites** now have scripts (`package.json:97-99`) and CI matrix rows.
- **`Live` column** is a ratio, not a boolean `some()` — the M35-false-✅ hole is closed (TEST-006).

## Recommended quality gates (smallest effective set)
1. A fitness check that every module with a `routes/` dir has an inject suite (drives TEST-001).
2. Generate the rls-live CI matrix from `package.json` scripts so a new module's live suite cannot silently sit outside CI (TEST-002/OPS-014).
3. Planted-violation self-tests for the 4 highest-value un-red-tested gates (TEST-005).
4. A jsdom smoke-render project across the three SPAs' registries (TEST-004).
