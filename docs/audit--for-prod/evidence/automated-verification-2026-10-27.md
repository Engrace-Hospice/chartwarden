# Automated verification evidence — 2026-10-27

All commands were run from the repository root unless stated otherwise. Outputs below are concise,
verbatim result summaries; secrets and environment values are not included.

## Dependency baseline

Command: `bun install --frozen-lockfile --ignore-scripts`

Result: PASS. Bun reported 567 installs and 683 packages checked. The lockfile was unchanged.

## Type safety and build

| Command | Result | Observed output |
|---|---|---|
| `bun run typecheck` | PASS | Production project references and both test TypeScript programs completed successfully. |
| `bun run build` | PASS | Root TypeScript project-reference build completed successfully. |
| `bun run --cwd apps/web build:app` | PASS_WITH_WARNING | 1,586 modules; entry JS 562.90 kB raw / 171.02 kB gzip; Vite warned that a chunk exceeded 500 kB. |
| `bun run --cwd apps/admin build:app` | PASS_WITH_WARNING | 637 modules; entry JS 590.99 kB raw / 171.92 kB gzip; Vite warned that a chunk exceeded 500 kB. |
| `bun run --cwd apps/portal build:app` | PASS | 141 modules; entry JS 395.08 kB raw / 120.21 kB gzip; CSS 145.31 kB raw / 24.25 kB gzip. |

## Lint and formatting

Command: `bun run lint`

Result: FAIL. Biome checked 8,447 files and reported 1,108 errors and 5 warnings across 963 files;
590 suggested fixes were not applied.

| Diagnostic category | Severity | Count |
|---|---:|---:|
| `format` | error | 456 |
| `organizeImports` | error | 590 |
| `lint/a11y/useSemanticElements` | error | 23 |
| `lint/correctness/useExhaustiveDependencies` | error | 9 |
| `lint/complexity/useOptionalChain` | error | 1 |
| `lint/style/noCommaOperator` | error | 1 |
| `lint/style/useConst` | error | 1 |
| `lint/style/useNumberNamespace` | error | 2 |
| `lint/style/useTemplate` | error | 9 |
| `lint/suspicious/noArrayIndexKey` | error | 4 |
| `lint/suspicious/noAssignInExpressions` | error | 7 |
| `lint/suspicious/noConfusingVoidType` | error | 1 |
| `lint/suspicious/noControlCharactersInRegex` | error | 4 |
| `lint/style/useImportType` | warning | 2 |
| `suppressions/unused` | warning | 3 |

Aggregation command: `bunx biome check . --reporter=json --max-diagnostics=none`, grouped by
category and severity with `jq`. No formatter or fix mode was used.

## Architecture fitness

Command: `bun run arch:fitness`

Result: PASS. All 43 invoked gates passed. Notable reported coverage included 41 manifest modules,
603 migrations, 2,409 typechecked test files, 263 reachable route registrars, 484 registered live
suites represented by 487 files, 1,878/1,878 OpenAPI routes, and 569 organization-scoped tables in
the index check. These are gate-reported values, not independently hand-maintained totals.

## Non-live tests

Command: `bun run test` under Node v22.15.1, outside the restricted network sandbox.

Result: PASS.

```text
Test Files  1924 passed | 486 skipped (2410)
Tests       27236 passed | 6822 skipped | 15 todo (34086)
Duration    305.42s
```

The skipped set includes live-database tests; this result is not treated as proof those integrations
executed. The suite emitted repeated jsdom `HTMLCanvasElement.getContext` not-implemented messages,
but no test failed because of them.

An initial run inside the restricted sandbox produced socket-related failures and was interrupted.
The four affected files (69 tests) passed under both Node 22 and Node 25 when rerun outside that
sandbox, showing that first failure was an audit-environment restriction rather than a confirmed
product defect.

## Dependency advisories

| Command | Result |
|---|---|
| `bun run audit:deps` | PASS — no high-or-above advisory matched the lockfile. |
| `bun audit --json` | PASS — returned an empty advisory object. |

This does not establish license compatibility, package maintenance quality, or reproducible Python
dependencies; those require separate analysis.

## Bundle budgets

| Application | Command | Result |
|---|---|---|
| web | `bun run --cwd apps/web size:check --check` | FAIL — 549.7 kB raw versus 350 kB budget. |
| admin | `bun run --cwd apps/admin size:check --check` | FAIL — 577.1 kB raw versus 350 kB budget. |
| portal | `bun run --cwd apps/portal size:check --check` | FALSE PASS — reported 0.0 kB while the built entry JS was 395.08 kB. |

The portal false pass is independently explained by its path resolution: the built HTML references
`/portal/assets/...`, while the checker joins that value beneath `dist/app`, looks for the nonexistent
`dist/app/portal/assets/...`, silently skips the missing file, and accepts a zero-byte total.

## Live PostgreSQL verification

Infrastructure: separately named `wardenx-prod-audit-pg-20261026`, image
`pgvector/pgvector:pg18`, loopback port 55777, and
`max_locks_per_transaction=4096`. Existing `wardenx4-*` containers were not used or modified.

| Suite | Fresh database | Result |
|---|---|---|
| `test:db:migrate:live` | `audit_bootstrap` | PASS — 13/13 tests; full migration replay. |
| `test:rls:live` | `audit_rls` | PASS — 109/109 tests under the suite's real app-role setup. |

Additional targeted suites were each run against a newly recreated database in the same isolated
container. All passed after their database was recreated:

| Area | Suites | Result |
|---|---|---|
| Authentication | core, hardening, auditor enrolment, auditor redemption | PASS — 26 + 6 + enrolment suite + 12 tests |
| Admission/election | write, election guards, addendum, certification, readmission | PASS — 14 + 19 + 10 + 9 + 10 tests |
| HOPE | specification foundation, answer engine, write path, retention | PASS — 13 + 22 + 24 + 2 tests |
| Medicare billing | claim assembly, validation overview, override, rate table, submit worker, DDE | PASS — 129 tests |
| Remittance | 835 golden, ingestion, manual match, payer guard, commercial remittance | PASS — 83 tests |

The first HOPE specification-foundation run failed because stale cluster-global roles remained from
an earlier suite. Its test carries a handwritten four-role cleanup list rather than the repository's
canonical `LIVE_DROP_ROLES`. After canonical role cleanup and database recreation, it passed 13/13.
That sequence is retained as evidence of an order-dependent test-isolation defect, not reported as a
HOPE product failure.

## Runtime reproduction — same-day payer transition

Harness: `evidence/repro-m23-payer-transition.ts`. It inserted synthetic, tenant-scoped payer rows in
the isolated audit database, executed the real M5 coverage reader and M23 payer adapter under the
non-superuser app role, then removed the fixture. The previous Medicare rank-1 row ended on
2026-01-15 and a commercial rank-1 row began on 2026-01-15. Both were active under the inclusive
reader on that date, while M23 returned `medicarePrimary: true`. Exit status: 0.

```json
{
  "transitionDate": "2026-01-15",
  "medicareAtTransition": { "rank": 1, "coverageKind": "medicare_ffs" },
  "commercialAtTransition": { "rank": 1, "coverageKind": "commercial" },
  "m23Resolution": { "medicarePrimary": true, "medicareAdvantageEnrollee": false }
}
```

No real patient data or production credentials were used.

## Browser verification

`bun run test:e2e` was not executed. The Playwright configuration expects a complete already-running
stack and seeded data; using the shared Docker cluster would violate the repository's live-suite
isolation rule. Browser console, viewport, keyboard, screen-reader, and screenshot verification are
therefore **BLOCKED**, not passed. Static coverage reports show 26/211 statically routable web screens
E2E-reached and 199/211 axe-reached; 116 dynamic web screens plus all 47 admin/portal screens are
outside that static measurement.

## Regulatory sources consulted

Primary sources only were used for regulatory comparisons:

- 45 CFR 164.308 and 164.312 from eCFR (administrative and technical safeguards).
- 42 CFR Part 418 from eCFR (Hospice Conditions of Participation).
- CMS HOPE page, HOPE Guidance Manual v1.03, and the v1.02-to-v1.03 change table.
- CMS Medicare Claims Processing Manual transmittal R12847CP and the CMS Hospice Information Center.

The CMS HOPE page current on the audit date states that the October 2026 manual changes do not
change the current HOPE data specifications; repository use of `v1_00_1` was therefore not classified
as stale solely from its version label. The v1.03 manual/change table does, however, permit an LPN/LVN
to conduct and complete an SFV where the hospice considers that discipline appropriate.

The first migration-suite attempt was blocked by the restricted sandbox (`connect EPERM
127.0.0.1:55777`) and is classified as an environment limitation. The same command passed when
granted loopback access.

After all runtime work completed, the exact disposable container
`wardenx-prod-audit-pg-20261026` was stopped and removed. The pre-existing shared ChartWarden
containers and their volumes were not touched.

## Final checkout recheck

The shared repository changed concurrently after the baseline runtime work. On the later
`ac87c7b4c7b853041e1f43d63187171f7c74ea19` / `fix/platform-pool-guard` checkout, a fresh
`bun run arch:fitness` passed all 43 gates. This result is kept separate from the baseline's full
build/test/live evidence; no claim is made that the later revision received the same runtime suite.
