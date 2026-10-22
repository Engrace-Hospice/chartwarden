# Test and Quality Report

## Current Inventory

| Test class | Evidence | Assessment |
|---|---|---|
| Unit/domain | Hundreds of Vitest files across packages/modules | Strong pure-domain coverage |
| API/Fastify inject | 39 feature modules represented | Broad, but module-level metric overstates route behavior |
| Database/migration | Empty migration, strict checksum, many live RLS suites | Strong and unusually comprehensive |
| Auth/security | Live Better Auth/RBAC/RLS suite; static ABAC/read-audit gates | Strong sampled coverage |
| Contract | OpenAPI regeneration/client check and ratchets | Structural pass; body/response gaps remain |
| Component/DOM | DOM smoke tests and component tests | Useful render signal, not browser workflow coverage |
| Browser E2E | No Playwright/Cypress/E2E files found | Missing |
| Accessibility | Biome a11y rules and local keyboard logic | No axe/browser baseline |
| Performance/load | No load/DB query-plan/browser budget gate found | Missing |
| Dependency/security | `bun audit` available | Currently fails one high advisory |

Main suite result: **504 test files passed, 79 skipped; 7,850 tests passed, 1,011 skipped, 12 todo**. Database-dependent suites skip without `CHARTWARDEN_TEST_DATABASE_URL`; CI defines a broad live matrix, and selected live suites passed during this audit.

## TEST-001 - Critical workflows have no browser E2E coverage

- Severity: High
- Priority: P1
- Confidence: Confirmed
- Category: Quality engineering
- Production blocker: Yes
- Affected workflow: Authentication, admission, documents, consent, billing, tenant operations
- Affected persona: All
- Evidence: Repository search found no Playwright, Cypress, `.e2e.*`, `/e2e/`, or axe files. Tests pass despite explicit lifecycle stubs and unbound production worker ports.
- File(s): root test configuration and application tests; absence of E2E configuration
- Symbol(s): N/A
- Description: No test crosses real browser navigation, form validation, generated client, API authorization, DB, queue, external fake, and resumed UI state.
- Root cause: Quality gates emphasize domain/API/static architecture layers.
- User impact: Broken transitions, focus, status/retry, and false-success behavior reach release undetected.
- Technical impact: Integration gaps remain green.
- Security or data impact: Permission/step-up/tenant failures are not verified in the actual client flow.
- Recommended remediation: Add a small risk-based Playwright suite with real PostgreSQL/Valkey/MinIO and deterministic fake external services.
- Tests required: Sign-in/org select/denial; document upload/download; consent lifecycle; Medicare sandbox; tenant provision; failure/retry/reload.
- Dependencies: Complete P0 backends and test fixtures.
- Acceptance criteria: Critical main and failure paths pass in CI from clean services with screenshots/traces on failure.

## TEST-002 - Inject coverage is module presence, not route behavior coverage

- Severity: Medium
- Priority: P2
- Confidence: Confirmed
- Category: Quality metric
- Production blocker: No
- Affected workflow: API release assessment
- Affected persona: Engineering/release owners
- Evidence: Fitness reports 39/39 modules and 1,214/1,214 route definitions “behind a covered module,” even though explicit stubs and contract gaps remain.
- File(s): `scripts/report-inject-coverage.ts`; generated inject coverage report
- Symbol(s): module-to-test matching
- Description: One inject suite can cause every route in a module to appear covered.
- Root cause: The report maps tests to module directories, not method/path/status/permission cases.
- User impact: Indirect: release confidence is overstated.
- Technical impact: Untested routes and failure states are hidden by a green ratio.
- Security or data impact: Missing negative authorization cases can be overlooked.
- Recommended remediation: Instrument registered method/path pairs and record direct inject assertions for success, validation, authn, authz, and expected errors.
- Tests required: Self-test the reporter with an untested route fixture.
- Dependencies: Route metadata.
- Acceptance criteria: Coverage output distinguishes direct route tests from module proximity.

## TEST-003 - Vitest configuration uses a deprecated environment selector

- Severity: Low
- Priority: P3
- Confidence: Confirmed
- Category: Test maintainability
- Production blocker: No
- Affected workflow: Test execution
- Affected persona: Engineering
- Evidence: Every Vitest run warns that `environmentMatchGlobs` is deprecated.
- File(s): `vitest.config.ts:22`
- Symbol(s): `environmentMatchGlobs`
- Description: Future Vitest upgrades may break DOM environment assignment.
- Root cause: Configuration predates project-based Vitest setup.
- User impact: None today.
- Technical impact: Upgrade friction and warning noise.
- Security or data impact: None.
- Recommended remediation: Move DOM tests to `test.projects`.
- Tests required: Run full and DOM suites.
- Dependencies: None.
- Acceptance criteria: No deprecation warning; DOM tests still use jsdom.

## Behavioral Coverage Matrix

| Module/workflow | Unit | Integration/API | Contract | Browser E2E | Failure paths | Security | Status |
|---|---|---|---|---|---|---|---|
| Auth/org session | Strong | Live pass | Good | Missing | Partial | Strong live sample | Conditional |
| Clinical core M5-M18 | Strong | Broad | Mostly strong | Missing | Mixed | RLS/ABAC broad | Conditional |
| Documents | Unit/API | DB writes tested | Body contract misleading | Missing | Storage path absent | Disclosure gates present | Fail |
| Consent | Domain/read | Write routes stub | Partial | Missing | No lifecycle | Evaluator fail-closed | Fail |
| Medicare | Pure workers/routes | No live payer path | Gaps | Missing | Stub failures | Credentials/step-up present | Fail |
| Medicaid/remittance | Pure/routes | No live state/835 | Gaps | Missing | Adapter stubs | Secret controls present | Fail |
| Cost/quality/reporting | Strong pure processors | Partial live ports | Gaps | Missing | Unbound ports | Consent/DEK fail-closed | Fail |
| Tenant lifecycle | Strong pure worker tests | No full live provision/shred | Mixed | Missing | Ports stubbed | Step-up/RLS strong | Fail |
| UI system/accessibility | DOM smoke | N/A | Generated client | Missing | Mixed | Guard tests | Conditional |

## Minimum New Quality Gates

1. Runtime capability/worker-port parity test.
2. Outbox declaration-to-binding parity and live delivery tests.
3. Document MinIO integration test.
4. One live external sandbox/faithful fake per launch integration.
5. Playwright critical workflow suite with axe checks.
6. OpenAPI body/response completeness ratchets.
7. Query/load budgets for census, worklists, dashboards, and queue throughput.
