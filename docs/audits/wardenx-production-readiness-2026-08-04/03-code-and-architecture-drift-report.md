# Code and Architecture Drift Report

## ARCH-001 - Declared outbox consumers can be silently treated as record-only

- Remediation status: Resolved in Phase 0 (2026-08-04). `buildOutboxRoutingPlan` now derives exhaustive
  routing from the boot catalog and durable receipts preserve partial fan-out. The M14 command event is
  fully bound to M7/M11/M12/M16; the M17 publication event is fully bound to M8/M18. M22/M28/M30/M31/M33
  use their specified dedicated events/read seams and are no longer falsely declared on these envelopes.

- Severity: Critical
- Priority: P0
- Confidence: Confirmed
- Category: Architecture / event integrity
- Production blocker: Yes
- Affected workflow: Clinical propagation, care-plan updates, quality recompute, reporting refresh/delivery
- Affected persona: Clinician, quality manager, billing user, operator
- Evidence: Dispatcher marks an event `dispatched` when it has neither a live route nor a deferred entry. Composition registers two live consumers and four deferred event types, while consumer maps elsewhere declare additional deferred subscriptions.
- File(s): `apps/backend/src/bootstrap/outbox-dispatcher.ts:263-288`; `apps/backend/src/index.ts:2915-2933`; `apps/backend/src/modules/07-care-plan/outbox-consumers/m14-idg-decision-recorded.ts:23-29`; `apps/backend/src/modules/08-encounters/outbox-consumers/m17-visit-scheduled.ts:26-32`; `packages/quality/src/consumers/subscription-map.ts:50-144`; `packages/reporting/src/refresh/outbox-subscriber.ts:91-101`
- Symbol(s): `tickOrganization`, `createOutboxDispatcher`, consumer subscription maps
- Description: The dispatcher has no exhaustive relationship to the declared consumer catalog. Missing wiring is indistinguishable from an intentionally subscriber-less event.
- Root cause: Event catalogs, consumer declarations, and runtime dispatcher bindings are separate registries with no parity gate.
- User impact: A source action succeeds, but downstream clinical or operational state never changes and no pending backlog signals the omission.
- Technical impact: At-least-once delivery is weakened into silent loss for omitted bindings; dispatched rows are later purgeable.
- Security or data impact: Audit evidence remains, but derived clinical/quality/reporting state may be stale.
- Recommended remediation: Generate dispatcher coverage from one subscription registry; require every produced event to be `live`, `deferred`, or explicitly `record-only` with owner/reason; reject undeclared default handling.
- Tests required: Catalog parity test; live outbox test for each declared subscription; replay/idempotency test; deferred-to-live migration test.
- Dependencies: M1 dispatcher, producing/consuming module owners.
- Acceptance criteria: CI fails on an unclassified event; representative M14->M7, M17->M8, M30/M33 events remain pending or deliver exactly once.

## ARCH-002 - Worker construction is not a runtime-readiness guarantee

- Severity: High
- Priority: P1
- Confidence: Confirmed
- Category: Architecture / composition
- Production blocker: Yes
- Affected workflow: Tenant platform, billing, cost report, quality, reporting
- Affected persona: Platform operator, biller, compliance officer, quality manager
- Evidence: The composition root constructs workers while comments acknowledge that required ports throw only when jobs run.
- File(s): `apps/backend/src/index.ts:2483-2689`; `apps/backend/src/modules/34-saas-tenant-platform/jobs/saas-jobs.ts:102-123`; `apps/backend/src/modules/30-quality/jobs/m30-jobs.ts:731-743`; `apps/backend/src/modules/33-reporting/jobs/m33-jobs.ts:401-410`
- Symbol(s): `registerM34Workers`, `registerM30Workers`, `registerM33Workers`, `registerM27Workers`, `registerM23Workers`
- Description: Health/readiness can be green while normal queued work deterministically fails on a typed unbound port.
- Root cause: Fail-closed development scaffolds were retained as production composition and no boot/readiness manifest distinguishes optional from required capabilities.
- User impact: The UI accepts work that later fails without a useful preflight.
- Technical impact: DLQ volume, retry noise, partial records, and misleading module-status reports.
- Security or data impact: Fail-closed ports prevent unauthorized fallback, but availability and integrity expectations are violated.
- Recommended remediation: Add a typed workload capability manifest with environment/launch-tier requirements; production boot/readiness must reject enabled workflows with unbound required ports.
- Tests required: Boot matrix per role/tier; one live happy-path job per queue; one unavailable-dependency preflight test.
- Dependencies: FLOW-001, FLOW-002, FLOW-006.
- Acceptance criteria: No enabled production queue is constructed with an unbound required port; `/ready` reports per-capability state.

## ARCH-003 - M22 document route and document seam use different storage composition

- Severity: High
- Priority: P1
- Confidence: Confirmed
- Category: Architecture / duplicate adapter path
- Production blocker: Yes
- Affected workflow: Document upload and download
- Affected persona: Clinician, intake specialist, compliance staff
- Evidence: `registerDocumentSeams` can bind the S3 object store, but `mountDocumentRoutes` separately constructs a signed-URL service with a throwing presigner. The route service itself never receives upload bytes.
- File(s): `apps/backend/src/index.ts:992-1013`; `apps/backend/src/modules/22-documents/index.ts:29-55`; `apps/backend/src/modules/22-documents/documents-route-service-db.ts:443-523`
- Symbol(s): `registerDocumentSeams`, `mountDocumentRoutes`, `createDbDocumentRouteService`
- Description: A real object adapter exists in one seam path while user-facing routes use an independent refusing adapter and metadata-only write service.
- Root cause: Incremental tasks wired published seams and HTTP routes independently.
- User impact: Upload/download surfaces appear present but cannot persist/retrieve content.
- Technical impact: Duplicate storage composition and false durable metadata.
- Security or data impact: The refusing presigner is safe; the false-success metadata is an integrity defect.
- Recommended remediation: One document application service must atomically coordinate staged object upload, digest/size verification, metadata commit, and short-lived presign under disclosure gates.
- Tests required: MinIO integration, interrupted upload rollback, digest mismatch, BAA/consent denial, version-aware deletion.
- Dependencies: BUG-001, FLOW-003, M1 object-store configuration.
- Acceptance criteria: No version becomes active without verified bytes; download uses the same configured object port.

## Specification Drift Register

| Discrepancy | Classification | Evidence | Action |
|---|---|---|---|
| Repository guide says 989/995 routes and partial M29/M35/M37 live ratios | Documentation stale | Current coverage is 1,214/1,221 and status matrix shows full live ratios | DOC-001: regenerate narrative facts from reports |
| M22 comments alternately say writes are 501 and no route is left at 501 | Implementation/documentation drift | `documents-route-service-db.ts:2`, `:77`, `:443` | Rewrite comments with the actual metadata-only limitation while fixing BUG-001 |
| M8 consumer says M17 has not landed | Documentation stale | `m17-visit-scheduled.ts:26-32`; M17 is implemented | Remove stale phase marker when wiring consumer |
| Architecture status reports modules green despite runtime deny-stubs | Intent ambiguous / metric incomplete | status matrix versus worker source | Add runtime capability status, do not redefine schema progress |
| Ops runbook describes blue-green/signed/SBOM release while deploy workflow calls itself a skeleton | Implementation incomplete | `.github/workflows/deploy.yml:3-12` | OPS-001 |

## Recommended Fitness Rules

1. `arch:outbox-routing`: produced event -> explicit live/deferred/record-only classification; consumer declaration -> runtime binding.
2. `arch:worker-capabilities`: queue processor required ports must be bound for each declared deployment tier.
3. `arch:http-storage-integrity`: upload routes must declare a binary/multipart or staged-upload contract and verified-object commit.
4. Extend the implementation matrix with `Runtime` and `Workflow E2E` columns rather than treating presence of routes/tests as operational completeness.
5. Make OpenAPI body/response coverage a ratchet by route class, not merely enrichment-entry presence.

## CODE-001 - The current main revision fails its lint gate

- Severity: Low
- Priority: P2
- Confidence: Confirmed
- Category: Code quality
- Production blocker: No by behavior; Yes for a clean release gate
- Affected workflow: CI/release
- Affected persona: Engineering
- Evidence: `bun run lint` reports `lint/complexity/useOptionalChain` on `pm !== null && pm.isActive`.
- File(s): `apps/backend/src/modules/35-subscription/routes/service-drizzle.ts:640`
- Symbol(s): payment-method mapping expression
- Description: The checked-in `main` revision does not satisfy the repository's own lint command.
- Root cause: A recent expression escaped the formatter/lint remediation merge.
- User impact: None directly.
- Technical impact: CI/release gate is red and clean-clone instructions are not fully green.
- Security or data impact: None.
- Recommended remediation: Use the equivalent optional-chain expression after behavior review.
- Tests required: Lint and M35 service tests.
- Dependencies: None.
- Acceptance criteria: `bun run lint` passes with no suppression.

## DOC-001 - Repository status narrative is stale relative to generated truth

- Severity: Medium
- Priority: P2
- Confidence: Confirmed
- Category: Documentation drift
- Production blocker: No
- Affected workflow: Engineering/release decision-making
- Affected persona: Maintainers, auditors
- Evidence: Repository guide reports 989/995 routes and partial M29/M35/M37 live coverage; current generated reports show 1,214/1,221 routes and full ratios. It also describes modules as complete without surfacing runtime unbound ports.
- File(s): `AGENTS.md`; `audit/openapi-coverage/OPENAPI_COVERAGE.md`; `audit/implementation-status/IMPLEMENTATION_STATUS.md`
- Symbol(s): generated status narrative
- Description: Hand-maintained progress prose can lag generated artifacts and overstate feature completion.
- Root cause: Facts are duplicated across generated reports and narrative instructions.
- User impact: Indirect; teams may launch or plan from incorrect assumptions.
- Technical impact: Audit/release drift and repeated rediscovery.
- Security or data impact: Can obscure known security/runtime conditions.
- Recommended remediation: Generate volatile counts and a runtime-capability summary; reserve hand prose for stable architecture intent.
- Tests required: Docs check that embedded counters match generated JSON, or remove counters.
- Dependencies: ARCH-002 runtime status.
- Acceptance criteria: Repository guide and generated matrices cannot disagree on release-relevant facts.
