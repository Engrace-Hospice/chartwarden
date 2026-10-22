# /ChartWarden Production Readiness Audit - Executive Summary

**iAudit date:** 2026-08-04
**Audited revision:** `dbb5aaff` on `main`
**Verdict:** **Not production ready**
**Production-readiness score:** **3.0 / 5**
**Recommendation:** **NO-GO for production workloads** until the P0 runtime-composition defects are closed and exercised with real dependencies.

## What Exists

ChartWarden is a large, coherent modular-monolith implementation rather than a UI mock. It contains four applications, 48 shared/domain packages, 40 manifest-owned modules, 453 owned tables, 165 forward migrations, 1,221 registered API routes, and 271 registered screens across the staff, portal, and platform-admin SPAs. The core security posture is materially strong: strict TypeScript passes; RBAC, ABAC, RLS, step-up, read-audit coverage, production-env validation, PHI-safe logging, and live authentication tests are present; a clean PostgreSQL 18 migration and representative cross-tenant suites passed.

The implementation-status matrix is not a production-completeness oracle. It records all 40 modules as green because schemas, routes, tests, screens, and adapters exist. Several registered workers still receive deliberate lazy `*WorkerPortUnbound` implementations, and several HTTP routes return success for persistence that is not operationally complete.

## Top Release Blockers

| Finding             | Severity / priority | Release impact                                                                                                                                                                                     |
| ------------------- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ARCH-001            | Critical / P0       | Declared event consumers omitted from dispatcher configuration are marked`dispatched` as record-only; clinical, quality, and reporting reactions can be silently lost.                           |
| FLOW-001            | Critical / P0       | M34 registers tenant provision, DEK rotation, shred, DSAR/export, and onboarding workers with many required ports deliberately unbound. A SaaS tenant cannot be reliably provisioned or destroyed. |
| FLOW-002            | Critical / P0       | Medicare submission/acknowledgment workers are registered without X12, MAC portal, HETS, validation, outbox, and alert ports. Accepted work fails only after enqueue.                              |
| BUG-001             | High / P0           | `POST /api/v1/documents` returns `201` after writing a zero-byte, zero-hash version row without receiving or storing document bytes; content retrieval remains unavailable.                    |
| FLOW-003            | High / P1           | All legally operative M39 consent create/sign/revoke/supersede/renew writes throw`lifecycleNotWired`; the UI is read-only.                                                                       |
| FLOW-004 / FLOW-005 | High / P1           | Medicaid Oregon transport methods and X12-835 remittance ingestion are explicit not-wired adapters.                                                                                                |
| FLOW-006            | High / P1           | M27 cost-report, M30 quality/CAHPS, and M33 reporting workers contain broad lazy-unbound dependency sets.                                                                                          |
| OPS-001 / OPS-002   | High / P1           | Deployment is an image-build/push skeleton; recovery evidence is synthetic and does not prove a real restore plus RLS smoke.                                                                       |

## Architecture Risks

1. Runtime readiness is not represented in the module/status or boot gates. Constructing a worker is currently counted as wiring it, even when its first normal job throws an unbound-port error.
2. Transactional-outbox routing has no exhaustive consumer/deferred coverage invariant. The default record-only branch is unsafe for event types that declare a consumer elsewhere.
3. Route/runtime schema and OpenAPI contracts are not equivalent: 113 of 697 mutating routes expose no request-body schema and 80 of 494 GET routes expose no response schema.
4. Double assertions occur 347 times across 166 TypeScript files; the most consequential casts sit at seam, generated-client, and persistence boundaries.

## Workflow Failures

- Platform operator tenant onboarding: the command is accepted and queued, then provision stops on storage, onboarding-task, invitation, or transition ports.
- Medicare billing: submit/retry reaches BullMQ but cannot generate/transmit X12 or interact with the MAC.
- Document intake: metadata is persisted as though a version exists while no upload payload crosses the API boundary.
- Consent capture: no staff path can create and sign the consent records that disclosure policy evaluates.
- Medicaid/remittance: UI and route surfaces exist, but state adapter and 835 transport are unavailable.
- Quality/reporting/cost report: scheduled workers exist but important input, encryption, outbox, and delivery ports fail at execution time.

## Production-Critical Missing Screens

1. Consent capture/signature ceremony and consent lifecycle management.
2. Durable background-job detail/retry view for billing, reports, quality, and tenant operations.
3. Integration readiness view showing X12/MAC/Medicaid/CAHPS/object-store/KMS status before an action is offered.
4. Document upload ceremony that actually transfers bytes, shows progress, verifies the digest, and recovers from interruption.
5. Operator outbox/dead-letter inspection and replay surface with tenant-safe controls.

## Finding Totals

| Severity | Count | Priority posture                                                                          |
| -------- | ----: | ----------------------------------------------------------------------------------------- |
| Critical |     3 | All P0                                                                                    |
| High     |    13 | BUG-001 and PARAM-001 describe the same P0 document-integrity root; remaining findings P1 |
| Medium   |    11 | P1-P3                                                                                     |
| Low      |     3 | P2-P4                                                                                     |

## Remediation Phases

| Phase | Objective                                                                               | Complexity |
| ----- | --------------------------------------------------------------------------------------- | ---------- |
| 0     | Contain false-success APIs and prevent unbound workers/event routes from accepting work | L          |
| 1     | Restore lint and make OpenAPI/generated-client contracts truthful                       | L          |
| 2     | Complete tenant-key, consent, document, and audit-redaction controls                    | XL         |
| 3     | Add runtime seam/worker/event-routing fitness gates                                     | L          |
| 4     | Complete revenue, quality, reporting, and tenant lifecycle workflows                    | XL         |
| 5     | Add the missing production-critical recovery and operator screens                       | L          |
| 6     | Consolidate UI patterns and verify accessibility/fidelity                               | L          |
| 7     | Add browser E2E, dependency-failure, and live workflow tests                            | XL         |
| 8     | Validate deployment, restore, observability, performance, and rollback                  | XL         |

## Go / No-Go

**NO-GO.** Green compilation, migrations, RLS suites, and architecture checks demonstrate a strong foundation, but they do not offset accepted commands that deterministically fail after enqueue or an upload endpoint that persists a version without content. Production authorization should be reconsidered only after every P0 acceptance criterion in `13-remediation-roadmap.md` passes in a production-like environment.
