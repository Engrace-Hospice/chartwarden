# Remediation Roadmap

This roadmap stops at implementation planning. No production code was changed during the audit.

## Phase 0: Immediate Containment

- Status: Completed on 2026-08-04. The command-event fan-out is fully live: M14-to-M7/M11/M12/M16 and
  M17-to-M8/M18 execute with target-side idempotency and durable per-consumer receipts. M22/M28/M30/M31/M33
  were removed from these two catalog entries because the authoritative specs assign them dedicated render
  events or published reader seams, not these command envelopes. Broader M27/M30/M33 capability completion
  remains in Phases 3-4.
- Objective: Prevent false success, silent event loss, and acceptance of jobs that cannot execute.
- Findings addressed: ARCH-001, ARCH-002, FLOW-001, FLOW-002, BUG-001, PARAM-001.
- Exact files/modules: M1 outbox dispatcher/composition/receipt schema; M7/M8/M11/M12/M16/M18 handlers;
  M14/M17 event contracts and producers; M22 routes/service; M23 and M34 command routes, capability checks,
  worker composition; migrations 0165-0169.
- Dependencies: Agreement on launch tier and required integrations.
- Risks: Disabling actions reduces available functionality but is more truthful than post-acceptance failure.
- Tests required: Inject tests for 503 capability refusal; event classification parity; no metadata write
  on failed upload; live migration, RLS, partial fan-out/restart, retry, and duplicate-seed proofs.
- Acceptance criteria: Met. No P0 route returns accepted/success unless all mandatory dependencies are
  live; no produced event is unclassified; every legitimate M14/M17 command consumer is bound and replay
  safe; unrelated seam consumers no longer create false pending fan-out.
- Rollback considerations: Feature/capability flags can restore a path only after adapters are verified; schema rollback is not needed.
- Estimated complexity: L

## Phase 1: Build, Type, and Contract Stabilization

- Status: Started on 2026-08-04. The M35 optional-chain error, generated-artifact boundary false positive,
  M14 request/event schema drift, M17 publication payload drift, and generated OpenAPI/client freshness are
  fixed. The remaining launch-route contract coverage work stays in this phase.
- Objective: Restore all repository gates and make published contracts reflect runtime validation.
- Findings addressed: CODE-001, API-001, TYPE-001, TEST-003.
- Exact files/modules: M35 optional chain; OpenAPI enrichment/emit registry across M23-M35 first; seam registry; generated client; Vitest config.
- Dependencies: Phase 0 contract decisions, especially document upload.
- Risks: Contract changes affect all three SPAs and external consumers; preserve compatibility or version intentionally.
- Tests required: Forced `tsc -b`, lint, OpenAPI/client diff, compile fixtures, route response validation.
- Acceptance criteria: All gates pass; zero launch-route body/response gaps; no boundary double assertions in P0 workflows.
- Rollback considerations: Commit per module; generated artifacts and consumers move atomically.
- Estimated complexity: L

## Phase 2: Security and Data-Integrity Remediation

- Objective: Complete key management, consent, documents, and audit-redaction obligations.
- Findings addressed: FLOW-003, SEC-001, SEC-002, SEC-003, BUG-001.
- Exact files/modules: M34 KEK/KMS and worker ports; M39 lifecycle; M22 object application service; M4 audit denylist; security plugin; router dependencies.
- Dependencies: Production KMS/object-store design and privacy/legal approval.
- Risks: Cryptographic shred and consent are irreversible/legal workflows; use forward migrations only.
- Tests required: Live KMS/object-store fakes/sandbox, Part 2, consent concurrency, nested audit redaction, cluster limiter/CSRF.
- Acceptance criteria: Verified documents, operative consent, audited key/destruction behavior, zero unenforced audit paths, clean dependency audit or approved exception.
- Rollback considerations: Never undo completed shred/signature; roll forward via versioned state and adapter flags.
- Estimated complexity: XL

## Phase 3: Architecture and Module-Boundary Correction

- Objective: Make runtime bindings as enforceable as source imports and table ownership.
- Findings addressed: ARCH-001, ARCH-002, ARCH-003, DOC-001, TEST-002.
- Exact files/modules: Single event subscription registry; worker capability manifests; status/inject reports; composition root; repository guide.
- Dependencies: Phase 0 classification inventory.
- Risks: A hard boot gate can stop environments that relied on implicit partial features; introduce explicit deployment tiers.
- Tests required: Reporter self-tests, boot matrices, live consumer replay, capability endpoint.
- Acceptance criteria: CI and readiness prove every enabled workload's ports and event routes; status reports no longer equate scaffold with runtime completeness.
- Rollback considerations: Capability tiers permit explicit disablement, never silent downgrade.
- Estimated complexity: L

## Phase 4: Core Workflow Completion

- Objective: Finish launch revenue, tenant, quality, and reporting paths end to end.
- Findings addressed: FLOW-001, FLOW-002, FLOW-004, FLOW-005, FLOW-006, AI-001 if AI is in scope.
- Exact files/modules: M23/M24/M25/M27/M30/M33/M34 workers and adapters; X12 clients; Medicaid/CAHPS; M36 alerts; M22 render.
- Dependencies: Phases 2-3, launch state/MAC/vendor agreements.
- Risks: External sandboxes differ from production; idempotency and retries can create duplicates.
- Tests required: Sandbox/faithful fake workflows, duplicate/replay, timeout, partial response, crash/redeploy, audit/UI status.
- Acceptance criteria: Each enabled workflow reaches a durable completion state and is recoverable from expected failures.
- Rollback considerations: Disable new submission, drain/reconcile queues, retain immutable ledgers; never delete failed evidence.
- Estimated complexity: XL

## Phase 5: Missing Screen Implementation

- Objective: Expose complete capture, readiness, progress, and recovery paths.
- Findings addressed: FLOW-003, BUG-001, TEST-001, UI operational gaps.
- Exact files/modules: New M39 capture/detail, M22 verified upload, shared job detail, readiness, event operations screens and APIs.
- Dependencies: Backends from phases 2-4.
- Risks: Building UI before backend completion would recreate false affordances.
- Tests required: Component state tests and Playwright main/failure/reload/permission paths.
- Acceptance criteria: Each screen satisfies the mini-spec in `09-missing-screens-specification.md`.
- Rollback considerations: Routes may remain feature-disabled while preserving completed backend records.
- Estimated complexity: L

## Phase 6: UI/UX and Design-System Consolidation

- Objective: Make launch workflows coherent, accessible, responsive, and visually reviewed.
- Findings addressed: UI-001, UI-002, PERF-001.
- Exact files/modules: `@wardenx/ui`, MAC drawer, screen lock, launch-critical frame registry, Vite configs.
- Dependencies: Stable workflow/data contracts.
- Risks: Broad styling changes can regress dense clinical workflows; use incremental screen acceptance.
- Tests required: Axe, keyboard/focus, 200% zoom, desktop/mobile screenshots, bundle budgets.
- Acceptance criteria: All launch screens mapped/reviewed; no dialog exceptions; performance/source-map policy enforced.
- Rollback considerations: Small component/screen commits with visual baselines.
- Estimated complexity: L

## Phase 7: Testing and Reliability Hardening

- Objective: Convert workflow claims into repeatable production-shaped evidence.
- Findings addressed: TEST-001, TEST-002, TEST-003, OPS-004.
- Exact files/modules: Playwright project, compose test topology, route coverage reporter, external fakes, trace/alert tests.
- Dependencies: Completed workflows.
- Risks: Flaky time/queue/provider tests; use deterministic clocks and isolated tenants.
- Tests required: Main, failure, denial, retry, cancel, reload, duplicate, crash, and deployment-during-job paths.
- Acceptance criteria: Critical E2E suite is deterministic and required in CI; direct route coverage is accurately reported.
- Rollback considerations: Quarantine only with owner/expiry; never silently skip release-critical suites.
- Estimated complexity: XL

## Phase 8: Performance and Production Validation

- Objective: Prove deployability, recoverability, observability, and operating limits.
- Findings addressed: OPS-001, OPS-002, OPS-003, OPS-004, OPS-005, PERF-001.
- Exact files/modules: Deployment workflow/manifests, secret references, dashboards/alerts/tracing, backup drill, image pins, load suites.
- Dependencies: Production-like target and monitoring/KMS/object storage.
- Risks: Load and restore tests can be destructive; isolate environments and use approved datasets.
- Tests required: SHA deploy, migration, smoke, rollback, restore/RLS, active jobs, large census/findings/report, provider limits, connection exhaustion.
- Acceptance criteria: Protected release and restore drills meet approved SLO/RPO/RTO and produce retained evidence.
- Rollback considerations: Immutable prior image, compatible forward schema, queue drain/compatibility, documented incident command.
- Estimated complexity: XL

## Recommended First Remediation Phase

Phase 0 is complete. Continue Phase 1 with the remaining launch-route body/response contract coverage;
the build, lint, type, architecture, migration, and current full test gates are green.
