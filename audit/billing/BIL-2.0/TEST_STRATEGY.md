# BIL-2 Test Strategy

No tests were run for BIL-2.0. This phase is repository inspection and implementation planning; the full monorepo suite was intentionally not executed. Existing test files were inspected as evidence, not rerun.

## Existing focused coverage to reuse

| Area | Existing tests |
|---|---|
| M23 assembly / payload / validation / submit | `apps/backend/src/modules/23-billing-medicare/__tests__/assembly.test.ts`, `claim-837i-loader.test.ts`, `claim-837i-submit.test.ts`, `claim-837i-parties.test.ts`, `validation-service.test.ts`, `jobs/clearinghouse-submission.test.ts`, `jobs/submit-requests.test.ts`, `services/clearinghouse-attempt-resolution-service.test.ts` |
| M23 UI | `apps/web/src/modules/23-billing-medicare/__tests__/claim-assembly-wizard.dom.test.tsx`, `claim-history.dom.test.tsx`, `work-queue.dom.test.tsx`, `validation-remediation.test.ts` |
| M41 lifecycle / route | `apps/backend/src/modules/41-billing-commercial/services/claim-send-gate.test.ts`, `jobs/submission-worker.test.ts`, `services/claimmd-submission-reader.test.ts`, `domain/ack-transition.test.ts`, `eligibility/send-gate.test.ts` |
| M41 UI | `apps/web/src/modules/41-billing-commercial/assemble-claim.dom.test.tsx`, `claim-queue.dom.test.tsx`, `claim-detail.dom.test.tsx`, `claim-send-gate.dom.test.tsx`, `claim-timeline.dom.test.tsx` |
| M24 adapter / submission | `packages/medicaid-adapters/__tests__/registry.test.ts`, `oregon-adapter-gateway.test.ts`, `oregon-launch-gateway.test.ts`, `machines.test.ts`, module submission/validation tests under `apps/backend/src/modules/24-billing-medicaid` |
| M24 UI | `apps/web/src/modules/24-billing-medicaid/__tests__/medicaid-work.dom.test.tsx`, `claim-assembly-admission.dom.test.tsx`, `claim-editor-surveyor-link.dom.test.tsx`, validation override role tests |
| BIL-1 | `audit/billing/BIL-1.5B/TEST_COVERAGE_MATRIX.md` lists source suites and pending integration certification. |

## Per-phase execution

### BIL-2.1

Run M23 assembly, validation, loader, route and DOM tests; add payer-route mapping tests (mapped/unmapped, per-MAC, test/prod environment) and assert final preview digest equals the actual transport payload identity. Run focused M23 backend TypeScript project check and relevant architecture/tenancy checks if API or schema changes.

### BIL-2.2

Run M23 worker, attempts, evidence, response resolver/dispatcher and claim-history tests. Test failure after send-before-receipt, idempotent original attempt reconciliation, old response after replacement, and distinct status stages.

### BIL-2.3

Run M41 assembly/lifecycle/send-gate/submission worker/render/evidence/ack/timeline tests. Add payer-specific replacement route/DB tests; use private PostgreSQL for transaction uniqueness, RLS and concurrency guarantees.

### BIL-2.4

Run adapter registry/rules/state refusal/credential/worker/UI tests. Assert unsupported state refuses before queue/outbox and no Claim.MD transport is called. Oregon network remains mocked; only approved external certification can establish actual partner compatibility.

### BIL-2.5 cumulative

Run the full relevant Billing suite and complete TypeScript build/typecheck once on the integrated candidate. Use isolated PostgreSQL on the production-supported image for migration, RLS, concurrency and two-tenant scenarios. Use only synthetic tenant/patient/provider identifiers and approved vendor test-account fixtures. Run no live external operation without specific authorization.

## Cross-cutting assertions

- Tenant, provider entity, location, patient, claim, attempt, ERA and response identifiers remain scoped; authorization is enforced at API/service/DB layers.
- Historical NPI/TIN/payer/control numbers are immutable per submission evidence; current profile changes do not rewrite prior attempts.
- UI preview hash matches final transmitted bytes (or records both with explicit representation if transport intentionally transforms bytes).
- “Queued/uploaded/clearinghouse accepted/payer accepted/rejected/denied/paid” remain distinct and vendor source provenance is retained.
- Retry after uncertain send does not blindly transmit a second independent claim.
- No ordinary claim workflow transmits a hospice notice; no Claim.MD ERA review/stage triggers M25 posting.
- M24 route behavior remains state/direct and cannot silently fall back to Claim.MD.
- Metrics/logs and API errors contain no MBI, recipient ID, plaintext TIN, raw 837/835 or credentials.

## External certification is separate

Synthetic fixture/unit tests validate local logic. Claim.MD's test response from two synthetic claims is one initial connectivity result only. A payer accepted adjudication, actual MAC routing, ERA lifecycle, M41 payer enrollment and Oregon MMIS/CCO path require their own approved external test case and operator authorization.
