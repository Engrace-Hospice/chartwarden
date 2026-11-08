# Cross-payer workflow matrix

| Workflow | Current source behavior | Validation result |
|---|---|---|
| M23 Medicare | Renderer-backed preview and short-lived confirmation are bound to tenant, claim, provider, actor, claim version, route, account/environment and renderer source fingerprint. Submit rechecks these values. Worker prepares under a short transaction, revalidates source, reserves dispatch, sends outside the transaction, then finalizes. | Focused preview, loader, submit, worker, outbox and PostgreSQL worker tests passed. This validates mocked transport only; no Medicare payer acceptance was inferred. |
| M41 Commercial | Original claim send gate is server-authoritative. Submission is persisted with idempotency and outbox atomically; worker sends outside the request transaction and uses `in_doubt` on uncertain delivery. A verified pre-payer clearinghouse rejection can create one linked original-frequency correction draft. | Focused send-gate, acknowledgment and worker tests passed. PostgreSQL correction suite passed 37/37; route and submission live suites passed 11/11 and 88 tests (4 skipped). Added detail-page send-gate review and explicit queue confirmation because the API existed but the detail screen had no submit action. |
| M24 Medicaid | Local claim preparation/validation remains available. Every current program route has `submissionAvailable: false`; missing MCO remains unresolved, and a durable stale job rechecks readiness before credentials/adapters. | Medicaid route/injection/registry and UI tests passed. Unsupported submit is refused before an attempt or outbox item can be created; worker rechecks and refuses. No state transmission attempted. |

## Persisted lifecycle distinctions

- M23 upload, clearinghouse response, payer response and adjudication remain distinct. M23 submit route enforces `If-Match`, preview token and current route/source checks in `apps/backend/src/modules/23-billing-medicare/routes/claims.routes.ts:452-513`; the worker follows Prepare/Send/Finalize in `apps/backend/src/modules/23-billing-medicare/jobs/m23-jobs.ts:1371-1449`.
- M41 API `202 queued` means queued only. Its route contract says worker receipt moves the claim to submitted; it does not claim payer acceptance (`apps/backend/src/modules/41-billing-commercial/routes/commercial-billing.routes.ts:265-283`).
- M24 route readiness is not equivalent to claim submission readiness and never implies an external route is active.

## Cross-tenant boundary

M23 RLS live suite: 13/13 passed as NOBYPASSRLS application role. M24 RLS live suite: 22/22 passed as the same role. M41 PostgreSQL claim assembly/correction, routes and submission suites were separately run with synthetic data. These are module-level integrated scenarios, not one all-payer transaction or a new full shared-Claim.MD cross-tenant collision certification.
