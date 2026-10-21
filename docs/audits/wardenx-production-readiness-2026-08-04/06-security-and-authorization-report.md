# Security and Authorization Report

## Positive Evidence

- Better Auth sign-up/sign-in/reset, TOTP encryption at rest, real cookie authentication, organization selection, RBAC, and RLS-backed reads passed 12 live tests with a test-only encryption key.
- Production boot validates database, auth, 2FA, M24 credential, M13 witness, messaging, cursor, proxy, Redis, platform DB, passkey, and internal-service secrets.
- Authentication material and cookies are redacted from structured logs; request URLs are path-only.
- Named ABAC resolution, read-audit coverage, table ownership, FORCE RLS, platform-bypass auditing, and live cross-tenant tests are substantial controls.
- Basic repository scanning found only published AWS test-vector example credentials, not a real committed secret.
- AI provider execution is absent, so no current general model-to-privileged-action path was found.

## SEC-001 - Nested PHI audit-redaction rules are not mechanically enforced

- Severity: High
- Priority: P1
- Confidence: Confirmed
- Category: Privacy / audit logging
- Production blocker: Yes for HIPAA/Part 2 sign-off
- Affected workflow: Any audited mutation containing nested clinical JSON
- Affected persona: Patient, privacy/security officer
- Evidence: The sync checker explicitly excludes 25 nested-path entries and allowlists one unresolved `M22.form_template_version` disagreement. Runtime redaction is leaf-name based, while DB trigger denylist parity cannot express nested paths.
- File(s): `scripts/check-audit-denylist-sync.ts:13-24,187-199,263-311`; `packages/audit/src/denylist.ts:9-88`
- Symbol(s): `KNOWN_UNRESOLVED_DISAGREEMENTS`, nested-path handling, `redact`
- Description: CI can pass while nested schema-specific PHI paths are not proven to be removed from audit snapshots.
- Root cause: Runtime leaf redaction and DB-trigger/schema path rules use different capabilities.
- User impact: No visible user symptom; privacy breach risk exists in audit data.
- Technical impact: Compliance evidence has a documented unenforced area.
- Security or data impact: Potential secondary PHI copy in audit records.
- Recommended remediation: Implement structured nested-path redaction in the DB audit function or prohibit audited snapshots of those JSON columns; eliminate the M22 disagreement.
- Tests required: Live DB mutation for every nested path, arrays, mixed casing, before/after snapshot, and Part 2 fields.
- Dependencies: Module denylist owners, M4 audit schema.
- Acceptance criteria: Zero unenforced nested paths/disagreements; live tests prove censored values never enter audit rows.

## SEC-002 - Application rate limiting is per-process and application CSRF remains a tracked follow-up

- Severity: Medium
- Priority: P1
- Confidence: Confirmed
- Category: Web security / abuse controls
- Production blocker: No for a single protected pilot; Yes for multi-replica Internet launch
- Affected workflow: Sign-in/public endpoints and authenticated mutations
- Affected persona: All users
- Evidence: Security plugin comments state the `Map` fixed-window limiter is single-instance and that Valkey-backed rate limiting plus a CSRF double-submit plugin are follow-ups.
- File(s): `apps/backend/src/bootstrap/plugins/security.ts:1-15,60-113`; `packages/auth/src/identity/auth.ts:121-132`
- Symbol(s): `applySecurityBaseline`
- Description: Attackers can distribute requests across replicas/restarts; Better Auth protects its endpoints with origin/CSRF checks, but there is no explicit application-wide mutation CSRF token.
- Root cause: Dependency-light vertical-slice hooks remain in production composition.
- User impact: Login throttling can be inconsistent; defense in depth for cookie-authenticated mutations is incomplete.
- Technical impact: No shared counters or route-specific sensitive-action policy.
- Security or data impact: Abuse and CSRF risk depends on deployment/cookie/request-content behavior.
- Recommended remediation: Use a Valkey-backed limiter with endpoint tiers and a tested CSRF strategy for cookie-authenticated mutations; retain strict origin allowlists and SameSite/Secure cookies.
- Tests required: Multi-replica limiter, spoofed proxy, cross-origin form/fetch, preflight, auth callback, rate-limit recovery.
- Dependencies: Trusted proxy configuration, Valkey.
- Acceptance criteria: Limits are cluster-wide and application mutations reject forged cross-site requests.

## SEC-003 - Installed React Router version has a current high advisory

- Severity: Medium
- Priority: P1
- Confidence: Confirmed dependency; exploitability conditional
- Category: Dependency security
- Production blocker: Conditional
- Affected workflow: Frontend routing/build
- Affected persona: SPA users
- Evidence: `bun audit` reports GHSA-qwww-vcr4-c8h2 for `react-router` 7.18.2 (`>=7.12.0 <8.3.0`). Advisory concerns unstable React Server Component APIs; ChartWarden builds client SPAs and no RSC use was found.
- File(s): `bun.lock`; app package manifests
- Symbol(s): `react-router`, `react-router-dom`
- Description: The vulnerable range is installed even though the known exploit path appears outside current SPA usage.
- Root cause: Fixed dependency predates the July 2026 advisory.
- User impact: Likely none if RSC APIs are definitively absent.
- Technical impact: Dependency gate is red and future adoption could expose the issue.
- Security or data impact: Advisory CVSS 7.1 under affected RSC usage.
- Recommended remediation: Prove no RSC server APIs are bundled, then upgrade to a fixed compatible release with router regression tests.
- Tests required: Route/auth/navigation builds and E2E after upgrade.
- Dependencies: Review React Router 8.3 migration changes.
- Acceptance criteria: `bun audit` clean or formal time-bounded exception with reachability proof.

## AI Security

M32 treats output as capability results behind governance policy, but the live invocation service returns a phase-1 shell when `ai.full` is disabled and no general provider/tool execution is composed. This currently contains prompt-injection and autonomous-action risk by non-availability, not by a fully verified provider boundary. Before enabling a provider, require schema validation, PHI policy, model/tool authorization, immutable provenance, budget/timeout/cancellation, and human confirmation for any clinical or privileged write.

## AI-001 - AI capability inventory is not a live provider-neutral execution platform

- Severity: Medium
- Priority: P2
- Confidence: Confirmed
- Category: AI functionality and resilience
- Production blocker: No if AI remains disabled
- Affected workflow: AI-assisted extraction, prediction, narrative, and recommendation
- Affected persona: Clinician, quality user, AI safety owner
- Evidence: Invocation returns `phase_1_capability_shell` when full AI is off; inventory records missing tabular backends, prompt templates, and catalog/schema contradictions; provider adapters are not composed into general dispatch.
- File(s): `apps/backend/src/modules/32-ai-platform/invocation/service.ts:252-281`; `packages/ai-platform/src/capabilities.ts:260-291`; provider backend files under `packages/ai-platform/src/backends`
- Symbol(s): invocation service, AI capability registry
- Description: Governance and fail-closed contracts exist, but availability, provider differences, fallback, streaming/cancellation, structured-output validation, cost, and consensus behavior are not live end to end.
- Root cause: Phase-1 governance shell was included in module-complete reporting.
- User impact: AI features are unavailable or placeholders, not resilient assistance.
- Technical impact: Provider-neutral claims are not exercised against multiple providers.
- Security or data impact: Current non-availability is safe; enabling prematurely would create unverified prompt/tool/PHI paths.
- Recommended remediation: Keep disabled until one capability passes provider adapter, policy, schema, timeout/cancel, provenance, cost, evaluation, and human-approval gates; then test a second provider before claiming neutrality.
- Tests required: Malformed output, prompt injection, refusal, timeout, partial stream, duplicate result, provider outage/fallback, budget exhaustion, unauthorized tool.
- Dependencies: M34 keys/config, audit, usage metering, clinical approval.
- Acceptance criteria: Enabled output is validated untrusted data, provenance is visible, and no model can directly execute a privileged clinical action.

## Tenant Isolation Assessment

Static tenancy checks passed for 388 org-scoped tables. An isolated PostgreSQL instance passed the 109-test baseline and all tests for the previously newest M29/M35/M37 table sets. This is strong sampled evidence, not a claim that every business query was manually traced. Release CI must retain the full live matrix and test direct-ID cross-tenant reads/writes for each P0 workflow.
