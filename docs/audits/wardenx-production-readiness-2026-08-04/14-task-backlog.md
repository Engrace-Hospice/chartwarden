# Implementation Task Backlog

## WX-PR-001 - Classify every produced outbox event

- Status: Completed (2026-08-04).
- Priority: P0
- Severity addressed: Critical
- Phase: 0
- Objective: Replace implicit record-only handling with an exhaustive live/deferred/record-only classification.
- Evidence: ARCH-001; `apps/backend/src/index.ts:2915-2933`; dispatcher `:277-288`.
- Files/modules affected: M1 dispatcher, event catalogs, all consumer subscription maps.
- Dependencies: None.
- Implementation steps: Define one typed classification registry; import live handlers; list deliberate record-only topics with owner/reason; make boot/CI reject omissions.
- Tests: Registry parity, unknown event failure, record-only explicit path.
- Acceptance criteria: Every produced event resolves exactly one classification; no default record-only branch.
- Completion evidence: `buildOutboxRoutingPlan` derives live/deferred/record-only from the boot catalog,
  requires all declared consumer modules, rejects unknown bindings, and preserves unknown legacy rows.
- Risks: Boot can expose many latent omissions.
- Rollback: Explicitly defer newly discovered consumers; never restore silent completion.
- Estimated complexity: M

## WX-PR-002 - Bind and prove the M14 and M17 clinical consumers

- Status: Completed (2026-08-04). M7/M11/M12/M16 and M8/M18 are live; neither event has unfinished fan-out.
- Priority: P0
- Severity addressed: Critical
- Phase: 0
- Objective: Close both clinical command-event paths and reconcile their catalogs to authoritative consumers.
- Evidence: ARCH-001 consumer files.
- Files/modules affected: M6, M7, M8, M11, M12, M14, M16, M17, M18, dispatcher composition, DB schemas/migrations.
- Dependencies: WX-PR-001.
- Implementation steps: Register handlers; add target projections/idempotency markers; keep failures retryable;
  remove false event consumers whose documented integration is a dedicated event or reader seam.
- Tests: Live outbox delivery, duplicate replay, cross-tenant isolation, handler failure.
- Acceptance criteria: Source action updates target exactly once and is visible after restart.
- Completion evidence: M14 publishes the full schema-versioned decision payload. M7 applies care-plan
  changes; M11 creates `idg_requested` order drafts; M12 creates unsigned, non-controlled medication drafts;
  M16 records a redacted-audit pending counselor reassessment. M17 publishes canonical scheduling/siting;
  M8 seeds one encounter and M18 upserts its EVV-owned visit registration. Target markers/unique constraints
  make every path replay safe. Catalog tests prove M14 has exactly M7/M11/M12/M16 and M17 exactly M8/M18,
  with neither event deferred. Clean migration, live consumer, and live RLS suites pass.
- Risks: Existing source events may form a backlog.
- Rollback: Disable handler as explicit deferred classification.
- Estimated complexity: M

## WX-PR-003 - Capability-gate unbound production queues and commands

- Status: Completed for the Phase 0 M23/M34 scope (2026-08-04); broader M27/M30/M33 manifests remain Phase 3.
- Priority: P0
- Severity addressed: Critical
- Phase: 0
- Objective: Refuse M23/M34 and other enabled commands before enqueue when mandatory ports are unavailable.
- Evidence: ARCH-002, FLOW-001, FLOW-002, FLOW-006.
- Files/modules affected: Worker dependency builders, command routes, readiness probe, composition root.
- Dependencies: Launch-tier decision.
- Implementation steps: Add typed required/optional port manifests; compute capability state at boot; expose sanitized state; gate route/action; omit unready workers.
- Tests: Boot matrix, 503 response, ready/unready transitions, no queued record on refusal.
- Acceptance criteria: No accepted job deterministically reaches `*WorkerPortUnbound`.
- Completion evidence: M23 defaults to a typed 503 queue port; M34 producers reject every unready queue;
  neither worker family nor its schedules are constructed; `/ready` reports sanitized disabled capabilities.
- Risks: Large feature surface becomes explicitly unavailable.
- Rollback: Change launch-tier flags, not fail-open bindings.
- Estimated complexity: L

## WX-PR-004 - Disable false document upload success

- Status: Completed (2026-08-04).
- Priority: P0
- Severity addressed: High
- Phase: 0
- Objective: Stop creating active zero-byte document versions before the real upload transaction exists.
- Evidence: BUG-001/PARAM-001.
- Files/modules affected: M22 document routes and DB route service; staff document UI.
- Dependencies: None.
- Implementation steps: Gate upload/version routes with capability 503; remove/guard UI affordance; preserve read-only document records.
- Tests: Inject asserts 503 and zero DB writes; UI shows unavailable state.
- Acceptance criteria: No new placeholder digest/byte-size row can be created.
- Completion evidence: Production upload/version methods throw `DEGRADED` before opening a DB transaction;
  Fastify inject coverage proves 503 and the DB proxy proves zero access. The staff web app has no upload
  action to hide; the portal uses a separate M31 staged-upload contract.
- Risks: Upload feature temporarily unavailable.
- Rollback: None; do not re-enable false 201.
- Estimated complexity: S

## WX-PR-005 - Implement verified staged document upload

- Status: Complete (2026-08-04)
- Priority: P0
- Severity addressed: High
- Phase: 2
- Objective: Store, verify, and retrieve bytes atomically with document metadata.
- Evidence: BUG-001, PARAM-001, ARCH-003.
- Files/modules affected: M22 routes/application service/S3 adapter/OpenAPI/client/UI.
- Dependencies: WX-PR-004; production object-store policy.
- Implementation steps: Design staged contract; tenant-bind key; validate type/size; put object; verify hash/version; commit DB; abort orphan; bind presign route.
- Tests: MinIO happy/failure/retry/idempotency/download/shred/tenant tests.
- Acceptance criteria: 201 proves durable verified bytes and authorized retrieval.
- Completion evidence: M22 now issues tenant-bound staged upload URLs, verifies object metadata,
  byte count, content type, and SHA-256 before committing the document version, and supports an
  explicit abort path. Migration `0170_document_verified_upload.sql`, M22 route/service tests,
  the 21-test live RLS suite, and the 7-test live write workflow all pass.
- Risks: Object/DB partial commits.
- Rollback: Disable initiation; reconcile or purge uncommitted staged objects.
- Estimated complexity: L

## WX-PR-006 - Complete launch-scope Medicare X12/MAC pipeline

- Status: Implementation complete; external MAC sandbox certification pending (2026-08-04)
- Priority: P0
- Severity addressed: Critical
- Phase: 4
- Objective: Execute one supported MAC submission and acknowledgment workflow.
- Evidence: FLOW-002.
- Files/modules affected: M23 worker deps/jobs, X12-837 client, MAC/HETS adapters, outbox/alerts.
- Dependencies: Credentials/KMS, M22 confirmation, M36.
- Implementation steps: Bind generation; transmit; persist correlation/control ids; poll/ingest 999/277CA; idempotent retry; capability gate.
- Tests: Sandbox/faithful fake, duplicate, timeout, reject, crash/restart, deadline alert.
- Acceptance criteria: A sandbox claim completes to visible acknowledgment with audit trail.
- Completion evidence: M23 now consumes durable submission events, generates and submits 837I
  payloads through the capability-gated NGS J6 adapter, persists terminal submission outcomes,
  derives fresh deterministic control numbers for retries, and schedules 999/277CA polling. The
  X12/M23 unit suites, 13-test live RLS/terminalization suite, clean migration chain, and full
  repository test suite pass. Real MAC sandbox upload and acknowledgment remain unverified because
  credentials and an external sandbox were unavailable.
- Risks: Payer-specific behavior and duplicate claims.
- Rollback: Disable new submissions, continue acknowledgment/reconciliation for in-flight work.
- Estimated complexity: XL

## WX-PR-007 - Complete tenant provision through first-admin login

- Status: Implementation complete; external provisioning gateway certification pending (2026-08-04)
- Priority: P0
- Severity addressed: Critical
- Phase: 2/4
- Objective: Bind M34 provision state, storage, tasks, invitation, and lifecycle transition.
- Evidence: FLOW-001, M34 ports `saas-jobs.ts:133-191`.
- Files/modules affected: M34, M1 object/KMS/outbox, M2 org/invitation, M36 email.
- Dependencies: Runtime capability gate, secret manager.
- Implementation steps: Bind each port transactionally/idempotently; add compensating/retry states; emit/audit completion; prove first login.
- Tests: Clean provision, duplicate, storage/email failure, restart, expired invite.
- Acceptance criteria: New tenant reaches active and first admin signs in exactly once.
- Completion evidence: M34 now transactionally establishes the organization, tenant account,
  status ledger, signup linkage, and provision event; the worker binds storage, key-ring,
  onboarding tasks, and first-admin invitation delivery. Invitation acceptance creates the user,
  membership, and `org_admin` role and consumes the invitation exactly once. Migration
  `0172_tenant_provision_key_ring.sql`, the 23-test live M34 RLS/key-ring suite, targeted gateway
  tests, clean migration chain, and full repository test suite pass. Production KMS, storage, and
  notification gateway behavior still requires environment certification.
- Risks: Partial tenant resources.
- Rollback: Quarantine failed tenant and run explicit cleanup; never silently mark active.
- Estimated complexity: XL

## WX-PR-008 - Complete M34 key rotation and cryptographic shred

- Status: Implementation complete; external KMS/object-store ceremony certification pending (2026-08-04)
- Priority: P1
- Severity addressed: Critical/High
- Phase: 2/4
- Objective: Bind KMS unwrap/wrap, eraser registry, object destruction, certificate, audit, and lifecycle.
- Evidence: FLOW-001; `wiring.ts:94-110`; `saas-jobs.ts:194-294`.
- Files/modules affected: M1 KMS/object, M4 destruction, M34 workers/migrations.
- Dependencies: KMS and legal retention approval.
- Implementation steps: Implement KEK adapter; bind rotation; preflight certificate/hold; invoke all erasers; destroy object versions/key; file certificate; commit state.
- Tests: Part 2 refusal, legal hold, crash at every phase, replay, destroyed-key proof.
- Acceptance criteria: Rotation preserves access; approved shred is irreversible, complete, and auditable; refusal destroys nothing.
- Completion evidence: M34 now binds the configured wrap/unwrap gateway, audited rotation worker,
  all registered erasers, version-aware tenant object destruction, certificate/legal-hold/co-signer
  preflight, critical audit, canonical `m34.tenant.destroyed` outbox, and terminal lifecycle commit.
  Phase receipts are certificate-scoped and replay safe, so a Part 2 refusal preserves the DEK and a
  later approved ceremony can proceed after retention lapses. Migration
  `0173_m34_key_lifecycle_shred.sql` makes key destruction same-certificate idempotent, revokes the
  request role, clears the current KEK id/ciphertext and all prior versions, and persists certificate
  timestamps/refusal evidence. The 24-test live M34 suite, targeted 33-test key-lifecycle suite,
  architecture fitness, typecheck, lint, and full 7,888-test repository suite pass. Real production
  KMS/object-store behavior and the operational dual-control ceremony still require environment certification.
- Risks: Irreversible data loss.
- Rollback: Rotation can roll forward; shred cannot rollback and requires ceremony/backup-retention policy.
- Estimated complexity: XL

## WX-PR-009 - Implement M39 consent lifecycle service

- Status: Completed (2026-08-04).
- Priority: P1
- Severity addressed: High
- Phase: 2
- Objective: Replace every `lifecycleNotWired` mutation with a transactional, encrypted state machine.
- Evidence: FLOW-003.
- Files/modules affected: M39 DB store/routes/domain, M4, M22, M34, M5 relations.
- Dependencies: KMS and document render.
- Implementation steps: Draft/edit; signer authority; sign/evidence; supersede/revoke/renew; outbox/render; evaluator cache invalidation.
- Tests: State/concurrency, Part 2, proxy, expiry, failed render, disclosure change.
- Acceptance criteria: All lifecycle methods are live and immutable with audit evidence.
- Completion evidence: `createDbConsentRouteService` implements every lifecycle command
  (draft/edit, signConsent with per-capture-method evidence floors, supersede/revoke/renew,
  bereavement-outreach draft, document re-render, cascade retry, tenant-overlay upsert) as real
  transactional Drizzle writes under `withOrgContext`, guarded by an optimistic version check
  (stale writes surface as `invalid_transition`). `consent-crypto.ts` seals internal notes with
  the tenant DEK; `render-consumer.ts` binds the M22 render handshake; boot wiring
  (`apps/backend/src/index.ts`) injects the real outbox/cipher/patient-reader ports at
  composition. 42 CFR Part 2 disclosures require an active named recipient
  (`validateRecipientRoster`) before becoming operative. Unit suites pass, and the new
  `m39-consent-lifecycle.live.test.ts` passes against live Postgres (row-lock serialization,
  transactional outbox writes, Part 2 recipient gating, immutable signed rows, single-success
  renewal under concurrent requests). Full gate (build, `arch:fitness`, `bun run test`) green.
- Risks: Legal semantics and concurrent disclosures.
- Rollback: Versioned forward fixes; never mutate signed evidence.
- Estimated complexity: XL

## WX-PR-010 - Build consent capture and lifecycle screens

- Status: Completed (2026-08-04).
- Priority: P1
- Severity addressed: High
- Phase: 5
- Objective: Implement the first two mini-specs in report 09.
- Evidence: FLOW-003/UI inventory.
- Files/modules affected: `apps/web/src/modules/39-consent`, screen registry/nav, generated client.
- Dependencies: WX-PR-009.
- Implementation steps: Capture ceremony; detail/history; revoke/supersede/renew; states/focus/feedback.
- Tests: Component, axe, Playwright main/denied/concurrent/render-failure.
- Acceptance criteria: Screen definition-of-complete and mini-spec criteria pass.
- Completion evidence: `consent-capture.tsx` (route `/patients/:patientId/consents/new`) runs the
  draft → conditional recipient/DPOA-agent → sign ceremony over the real WX-PR-009 writes, gated
  per catalog `scopeDiscriminator`; `consent-detail.tsx` (route
  `/patients/:patientId/consents/:consentId`) presents the record, version-chain history, and
  renewal-cycle status, with revoke/supersede/renew as optimistic-version-guarded ceremonies.
  `consent-evidence-fields.tsx` shares the per-capture-method evidence sub-form (mirrors the
  backend's `validateCaptureEvidence` floor) across all three sign ceremonies. `screens.ts` and
  `consent-record-manager.tsx` wire the new routes in. Driven live in Chrome against local
  Postgres: draft creation, conditional-section gating, and the step-up redirect all verified
  working end-to-end (full ceremony completion needs a real passkey, unavailable in this
  environment). Along the way, fixed two real bugs found by live-driving rather than only
  typechecking: `write-workflow.ts`'s step-up detection used a `STEP_UP_REQUIRED` error *code*
  that `requireStepUp()` (an ABAC `step_up_recent` predicate) never actually emits — routes on
  `error.message` instead; and `consent-routes.ts`'s create-draft route was the only mutation
  route missing the `try/catch → mapError` wrapping every sibling route has, so "patient not
  found" surfaced as a raw 500 instead of 404. Full gate (build, `arch:fitness`, `bun run test`)
  green.
- Risks: UI can imply legal effect before backend completion.
- Rollback: Feature flag route; preserve records.
- Estimated complexity: L

## WX-PR-011 - Bind launch-state Medicaid adapter

- Priority: P1
- Severity addressed: High
- Phase: 4
- Objective: Make one explicitly supported state operational end to end.
- Evidence: FLOW-004.
- Files/modules affected: Oregon/state adapter, M24 worker/composition, credentials, UI readiness.
- Dependencies: State sandbox/agreement, X12 transport.
- Implementation steps: Eligibility, assemble, submit, poll, parse, rate lookup, retries, capability status.
- Tests: State sandbox/fake, credential rotation, rate limit, duplicate, outage.
- Acceptance criteria: Launch-state claim completes and unsupported states remain visibly disabled.
- Risks: State variance.
- Rollback: Disable launch-state capability and reconcile in-flight jobs.
- Estimated complexity: XL

## WX-PR-012 - Bind X12-835 ingestion and posting

- Priority: P1
- Severity addressed: High
- Phase: 4
- Objective: Receive and post ERA exactly once.
- Evidence: FLOW-005.
- Files/modules affected: X12-835 client, M25 ingestion/posting/denials, queue/UI.
- Dependencies: Payer transport, claim identity mapping.
- Implementation steps: Secure receive; validate; dedup; parse; transactionally post; create denial; surface partial failure.
- Tests: Fixture matrix, duplicate, malformed, unmatched claim, rollback, cross-tenant collision.
- Acceptance criteria: One ERA produces one reconciled posting/denial trail.
- Risks: Financial double posting.
- Rollback: Stop intake and reverse via explicit accounting adjustment, not row deletion.
- Estimated complexity: L

## WX-PR-013 - Complete one cost-report workflow slice

- Priority: P1
- Severity addressed: High
- Phase: 4
- Objective: Bind a launch-defined M27 import/statistics/validation/allocation path.
- Evidence: FLOW-006/M27 ports.
- Files/modules affected: M27 jobs, Xero/Gusto or approved input adapters, M6/M8/M23/M26 seams, DEK/outbox/alerts.
- Dependencies: Launch accounting integrations.
- Implementation steps: Select slice; bind ports; preserve source snapshots; calculate/validate; expose status/recovery.
- Tests: Known worksheet fixtures, missing seam, duplicate import, correction, audit.
- Acceptance criteria: Selected filing workflow completes with reproducible calculation evidence.
- Risks: Regulatory calculation correctness.
- Rollback: Superseding version/adjustment only.
- Estimated complexity: XL

## WX-PR-014 - Complete M30 and M33 launch jobs

- Priority: P1
- Severity addressed: High
- Phase: 4
- Objective: Bind selected measure/CAHPS/report schedule paths; disable the rest explicitly.
- Evidence: FLOW-006.
- Files/modules affected: M30/M33 jobs, processing log, M34 DEK, M39 consent, M22 render, M36 alerts.
- Dependencies: ARCH-001, KMS, report renderer.
- Implementation steps: Define launch set; bind inputs/encryption/outbox/consent/snapshot/delivery; capability-gate non-launch jobs.
- Tests: Measure golden data, CAHPS fake vendor, revoked recipient, report render/delivery, crash/replay.
- Acceptance criteria: Enabled jobs complete/recover; disabled jobs cannot be queued.
- Risks: PHI export and stale measures.
- Rollback: Pause schedules and retain run ledger.
- Estimated complexity: XL

## WX-PR-015 - Close OpenAPI body and response gaps

- Priority: P1
- Severity addressed: High/Medium
- Phase: 1
- Objective: Make launch APIs fully typed and ratcheted.
- Evidence: API-001/TYPE-001.
- Files/modules affected: Enrichment registry, route TypeBox schemas, emitter/client, SPAs.
- Dependencies: Stable upload/job/capability contracts.
- Implementation steps: Prioritize M23-M35; share runtime schemas; define success/error responses; regenerate; remove casts.
- Tests: Contract parity and generated client compile fixtures.
- Acceptance criteria: Zero launch-route missing bodies/responses and no client double casts for those routes.
- Risks: Consumer-breaking types expose existing behavior drift.
- Rollback: Per-module compatible commits or explicit versioning.
- Estimated complexity: L

## WX-PR-016 - Enforce nested audit redaction

- Priority: P1
- Severity addressed: High
- Phase: 2
- Objective: Remove all unenforced nested paths and the M22 disagreement.
- Evidence: SEC-001.
- Files/modules affected: M4 audit DB functions/migrations, denylist registry/checker, affected module schemas.
- Dependencies: Privacy review.
- Implementation steps: Choose structured DB redaction/prohibit snapshots; add forward migration; remove allowlists.
- Tests: Live audit rows for every path/array/case.
- Acceptance criteria: Gate reports zero exceptions and values are absent in DB.
- Risks: Over-redaction reduces forensic usefulness.
- Rollback: Forward adjust redaction metadata; never reintroduce stored PHI.
- Estimated complexity: L

## WX-PR-017 - Add cluster security controls and resolve router advisory

- Priority: P1
- Severity addressed: Medium
- Phase: 2
- Objective: Shared rate limiting, explicit application CSRF, and fixed router version/reachability proof.
- Evidence: SEC-002/SEC-003.
- Files/modules affected: Security plugin, auth cookies/origins, dependencies, CI audit.
- Dependencies: Proxy/Valkey topology; router migration review.
- Implementation steps: Bind shared limiter; route tiers; CSRF strategy; upgrade router; document RSC absence.
- Tests: Multi-instance rate, proxy spoof, cross-origin mutation, router E2E.
- Acceptance criteria: Cluster-wide limits, forged mutation rejection, clean audit/approved exception.
- Risks: Auth callbacks and cross-origin SPAs.
- Rollback: Revert dependency with formal exception; keep security behavior versioned.
- Estimated complexity: M

## WX-PR-018 - Add critical Playwright and accessibility suite

- Priority: P1
- Severity addressed: High/Medium
- Phase: 7
- Objective: Exercise real browser-to-DB/queue/object workflows.
- Evidence: TEST-001/UI-002.
- Files/modules affected: New E2E project, compose fixtures, CI, canonical dialogs.
- Dependencies: Completed P0 workflows.
- Implementation steps: Deterministic users/tenants; main/denied/failure/reload tests; axe and focus assertions; artifacts on failure.
- Tests: The suite itself, repeated/parallel runs.
- Acceptance criteria: Required CI suite is deterministic and covers the six critical workflows.
- Risks: Flakiness and test data leakage.
- Rollback: Quarantine only with issue/owner/expiry; preserve core smoke.
- Estimated complexity: L

## WX-PR-019 - Implement production deployment and recovery evidence

- Priority: P1
- Severity addressed: High/Medium
- Phase: 8
- Objective: Deploy, verify, rollback, back up, and restore immutable releases.
- Evidence: OPS-001/OPS-002/OPS-003/OPS-005.
- Files/modules affected: Deploy workflows/manifests, env reference, image pins, DR scripts/docs.
- Dependencies: Production-like target, secret manager, KMS/storage.
- Implementation steps: Protect environment; sign/SBOM; deploy SHA; migrate/smoke; rollback; automated backup/restore/RLS/object/queue drill.
- Tests: Staging promotion, active-job deploy, failed migration, rollback, restore.
- Acceptance criteria: Retained evidence meets approved SLO/RPO/RTO and security checks.
- Risks: Destructive restore/rollback mistakes.
- Rollback: Immutable previous artifact and documented forward-schema compatibility.
- Estimated complexity: XL

## WX-PR-020 - Operational telemetry and recovery UI

- Priority: P2
- Severity addressed: Medium/High
- Phase: 5/8
- Objective: Add traces, tested alerts, job detail, readiness, and outbox/DLQ operations screens.
- Evidence: OPS-004 and report 09 mini-specs.
- Files/modules affected: Backend telemetry/capability/job APIs, M1 outbox, web/admin screens, monitoring config.
- Dependencies: Capability registry and deployment target.
- Implementation steps: Trace propagation; sanitized spans; dashboards/alerts; job/event APIs; UI retry/replay ceremonies.
- Tests: Synthetic outage/stuck queue/alert, permission/step-up, replay idempotency, browser resume.
- Acceptance criteria: Operator can diagnose and safely recover a failed workflow without DB access.
- Risks: Cross-tenant operations and PHI in telemetry.
- Rollback: Disable operator mutations; preserve read-only telemetry.
- Estimated complexity: XL

## WX-PR-021 - Tighten quality metrics and documentation truth

- Priority: P2
- Severity addressed: Medium/Low
- Phase: 1/3/7
- Objective: Fix lint/Vitest warnings, direct-route coverage, runtime status, and stale repository counts.
- Evidence: CODE-001, TEST-002, TEST-003, DOC-001.
- Files/modules affected: M35, Vitest config, inject/status reporters, `AGENTS.md`/generated docs.
- Dependencies: Runtime capability model.
- Implementation steps: Fix lint; migrate Vitest projects; measure direct routes; add runtime/E2E matrix; generate volatile counts.
- Tests: All repository gates and reporter fixtures.
- Acceptance criteria: Clean commands and no hand-maintained release count contradicts generated truth.
- Risks: Coverage ratio drops honestly.
- Rollback: None; do not restore misleading metrics.
- Estimated complexity: M

## WX-PR-022 - Establish UI fidelity, artifact, and performance gates

- Priority: P2
- Severity addressed: Medium
- Phase: 6/8
- Objective: Review launch screens, consolidate dialog behavior, restrict source maps, and gate bundle/runtime performance.
- Evidence: UI-001/UI-002/PERF-001.
- Files/modules affected: Frame registry, `@wardenx/ui`, dialog call sites, Vite configs, performance CI.
- Dependencies: Stable launch workflows.
- Implementation steps: Map screens; capture states/viewports; migrate dialogs; private maps; route budgets; load/Web Vitals checks.
- Tests: Visual/axe/keyboard/zoom/bundle/mobile-load.
- Acceptance criteria: Launch screens pass the design finish gate and performance budgets.
- Risks: Snapshot churn and workflow regressions.
- Rollback: Per-screen/component commits and retained baselines.
- Estimated complexity: L

## WX-PR-023 - Validate one governed AI capability before enablement

- Priority: P2
- Severity addressed: Medium
- Phase: 4/7
- Objective: Prove provider-neutral, policy-controlled, human-reviewed AI behavior or keep AI disabled.
- Evidence: AI-001.
- Files/modules affected: M32 invocation/backends/governance/usage and the chosen consuming UI.
- Dependencies: Provider BAA/credentials, evaluation and approval owner.
- Implementation steps: Select one capability; bind provider; validate output; enforce PHI/tool/budget policy; provenance; approval; second-provider compatibility test.
- Tests: Injection, malformed/refusal/timeout/stream/cancel/outage/budget/unauthorized tool.
- Acceptance criteria: Capability passes safety/effectiveness gates and cannot directly execute privileged writes.
- Risks: Clinical harm, PHI disclosure, cost.
- Rollback: Kill switch and binding disable; preserve audit/provenance.
- Estimated complexity: XL
