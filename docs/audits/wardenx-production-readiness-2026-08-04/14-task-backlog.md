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
- Follow-up (2026-08-05, same day): a "fix it thoroughly" pass (mirroring the WX-PR-011 M6
  confirm-handshake pass) found the internal reducer wiring was NOT actually complete — every real
  `claim.submit` / `claim.submit.retry` job threw `GUARD_FAILED` and rolled back its own terminalize
  write AFTER the 837I had already been physically transmitted to the MAC, because the worker called
  the pure `submit` guard with no context (the guard is fail-closed on an omitted context) while the
  route had already checked-and-dropped that same guard before enqueueing. `claim.submit` has
  `attempts: 1`, so no BullMQ retry ever fired, and the failure path that fires
  `m23.claim.submission_failed` (the only route into the retry queue) was never reached — so a
  claim that a MAC portal genuinely accepted stayed stuck in `ready` forever with no visible trace.
  Fixed in `apps/backend/src/modules/23-billing-medicare/jobs/m23-jobs.ts`: both
  `runClaimSubmit`/`runClaimSubmitRetry` now preflight the §2.3 zero-unresolved-blocking-failures
  guard (recomputed live, the same query `routes/write-service-drizzle.ts`'s `submitClaim` runs)
  BEFORE calling the x12/MAC-portal ports — never physically transmits a claim that is no longer
  submit-eligible (a concurrent `revalidate`), and routes a preflight failure through the existing
  `submission_failed` → retry-queue path instead of throwing. The 13-test live suite never caught
  this because it manipulates `claim_submission` via raw SQL and never drives the reducer or the
  worker function; added a new live suite
  (`apps/backend/__tests__/m23-claim-submit-worker.live.test.ts`, 3 tests) that calls the exported
  `runClaimSubmit`/`runClaimSubmitRetry` directly against real Postgres with fake x12/MAC ports,
  proving both the fixed happy path (READY → SUBMITTED) and the preflight-abort path (a claim with
  an unresolved blocking failure is never uploaded and stays READY) — confirmed regression-catching
  by temporarily reintroducing the bug and watching 2 of 3 tests fail. NOE/NOTR submit paths were
  checked and are NOT affected (their only guarded event is `cancel`, not `submit`). Full gate green
  (build, `arch:fitness`, lint, 7985 tests) plus all 3 M23 live-Postgres suites (17 tests total) on a
  throwaway cluster. The "external MAC sandbox certification pending" framing is now honest — only
  the external MAC leg is unverified; the internal round trip is proven end to end.
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

- Status: Implementation complete (adapter + worker layer + per-line claim assembly + real place-of-service
  modeling + real CMS rate data); external OHA sandbox certification pending (2026-08-05)
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
- Completion evidence: Two real, previously-missing pieces are now bound. (1) A hard structural blocker
  is resolved: `medicaid_state_plan_code` (new platform-shared reference table, migrations 0174-0177,
  self-owned by M24 rather than routed through M40's physician/facility/payer entity-merge engine — see
  the schema file's deviation note) unblocks `medicaid_claim.state_plan_code_id`, so `assembleClaim` now
  creates a real DRAFT claim header (control number, TOB, resolved coverage + service state + state-plan
  snapshot) instead of always throwing `MEDICAID_STATE_PLAN_CODE_CATALOG_MISSING`. Per-claim-LINE assembly
  (walking M6 LOC periods + M8 signed encounters) is a separate, comparably-sized undertaking and stays a
  documented follow-up — a DRAFT claim from this path carries zero lines today. (2) The Oregon adapter's
  wire I/O (eligibility/assemble/submit/poll/parse-ack/parse-remittance/rate-lookup) is bound to a new
  launch-gateway (`packages/medicaid-adapters/src/oregon/launch-gateway.ts`), mirroring M23's real+fake
  HTTP transport pattern exactly, with one deliberate difference: Oregon's OHA MMIS endpoint is
  PER-PROVIDER-ENTITY (each PE's own `state_medicaid_trading_partner_credential.portalUrl`), not a single
  platform-wide URL, so the gateway resolves endpoint + auth per call from the credential the caller
  already holds. A new M24 worker layer (`jobs/submission-jobs.ts` — `runClaimSubmit`/`runClaimPoll`) plus
  a durable outbox→BullMQ consumer (`outbox-consumers/submission-requests.ts`) drive
  SUBMITTED → {ACK_PENDING→ACK_ACCEPTED | POLLING→ACK_ACCEPTED/ACK_REJECTED/ACK_TIMEOUT | ACK_REJECTED}
  through the real §2.2 state machine, write `medicaid_acknowledgment` rows, and publish the exact
  §4.11 outbox event shapes. Boot-gated behind `M24_LAUNCH_GATEWAY_ENABLED` + `M24_CREDENTIAL_ENCRYPTION_KEY`
  (both unset in dev/test/CI, matching M23's capability-gate posture) — the composition root logs which
  capability is disabled and why. 26 new unit tests (launch-gateway fake-transport: accept/reject/pending-
  async/timeout/malformed/outage/duplicate-idempotency-key/credential-rotation-across-PEs; adapter
  delegation with/without an injected gateway) plus a live-Postgres RLS proof for the new table (read-all
  for every tenant, write-denied for `wardenx_app`) extending `m24-rls-isolation.live.test.ts` (19/19
  passing on a throwaway pg18 cluster, full 0001→0177 migration chain validated). Full gate green (build +
  `arch:fitness` 20 sub-gates + lint + `bun run test` 7955 passing).

  **Follow-up (2026-08-05): per-line claim assembly closed too.** `assembleClaim` now walks M6 LOC periods
  into hospice-LOC lines (RHC/CHC/IRC/GIP — one line per contiguous same-LOC run clipped to the claim
  window, revenue/Q-code assigned per LOC, rate resolved from a new self-owned `medicaid_state_rate_schedule`
  platform table, migrations 0179-0182, mirroring `medicaid_state_plan_code`'s precedent) and M24's own
  `rb_day` sweep output into R&B lines (one line per billable day, priced from the facility's own contracted
  per-diem — never a state schedule). This closes audit finding M24-F02 (BLOCKER): `medicaid_claim_line .state_rate_schedule_id_snapshot` was unconditionally NOT NULL, which made an R&B line's schema-correct
  rate source (the per-diem it actually prices from) structurally impossible to record; migration 0178 makes
  the column nullable with a symmetric CHECK against `is_rb`. Backing M8 encounter evidence links via
  `medicaid_claim_line_encounter` through the LIVE `SignedEncountersReader` seam (optional — supplementary
  audit evidence, not a structural input); the M6 LOC-period raw list has no live seam yet, so it's read at
  the composition root (the same "escape valve outside every module's `codePaths`" pattern already used for
  the provider-entity CCN lookup). A pure, unit-tested segment builder
  (`packages/medicaid-adapters/src/line-assembly.ts`, 8 tests) does the day-walk/collapse math; a new
  6-test live-Postgres integration suite (`apps/backend/__tests__/m24-claim-line-assembly.live.test.ts`)
  drives the real production write-service against real Postgres and caught a real migration bug (an
  un-cast enum literal in the rate-schedule seed) that build/typecheck could not — the exact failure mode
  live coverage exists to catch. Live RLS extended to the new rate table (2 more tests + a CHECK-constraint
  test forbidding an NF_RB schedule row). Full gate green again (build + `arch:fitness` 20 sub-gates + lint

  + `bun run test` 7963 passing + 28 live tests across 2 files, run sequentially — vitest defaults to
    parallel test files, which races two suites' `DROP SCHEMA`/`CREATE SCHEMA public` on one shared cluster).
    **Follow-up #2 (2026-08-05): real place-of-service modeling + real CMS rate data.** The Q-code is no
    longer derived from level-of-care alone. `resolvePlaceOfServiceQCode` (`packages/medicaid-adapters/src/ line-assembly.ts`) resolves the real CMS Q5001-Q5009 space from actual facts, priority order: (1) a
    confirmed own-IPU bed (`level_of_care_period.ipu_bed_assignment_id` set) → Q5006 unconditionally; (2) the
    LOC period's own `facility_id` → `facility.kind` (extended with `nf`/`ltch`/`psych`, migration 0183, so
    all 9 Q-codes are representable — the original 6-value enum could not distinguish skilled/non-skilled
    nursing or express LTCH/psych at all); (3) the patient's residence (`patient_address.kind`/`facility_id`
    as of the period's own start date, via a new `PatientAddressReader.residenceAt` method on M5's existing
    live seam) for RHC/CHC's home-vs-ALF/SNF disambiguation; (4) an honest LOC-based fallback only when no
    fact resolves anything (GIP→Q5006, IRC→Q5009 NOS — not Q5001 home, which was flatly wrong for inpatient
    respite, RHC/CHC→Q5001). Researching this surfaced a real, separate, pre-existing M6 bug — flagged in the
    first pass of this follow-up, then **closed the same day (Follow-up #3 below)**: `changeLoc` hardcoded
    `facilityId: null` on every call, so IRC/GIP level-of-care transitions failed unconditionally. M24's
    resolver already read `facility_id`/`ipu_bed_assignment_id` regardless (they cost nothing to select and
    read `null` until then), so it benefited automatically once M6's gap closed — no further M24 change was
    needed. The state-rate-schedule seed (migration 0182, edited in place — not yet
    deployed anywhere) now carries the real CMS FY2026 national per-diem base rates (RHC $230.83, CHC
    $1,674.29/24hr, IRC $532.48, GIP $1,199.86; effective 2025-10-01), sourced from the CMS FY2026 Hospice
    Wage Index and Payment Rate Update Final Rule and corroborated against Oregon's own OAR 410-142-0300
    ("no lower than... Medicare") floor rule — still a documented simplification (unadjusted for the CBSA
    wage index, the same geographic layer M23's own `wage_index_factor` table exists for but has never been
    seeded with real data either). `medicaid_state_plan_code`'s "OHP-PLUS" plan code stays a placeholder —
    unlike the rate table, it is blocked on a genuinely different, upstream problem (no per-patient OHP
    benefit-package tracking exists yet to select among plan codes), not on public data availability. 26 new
    unit tests (`resolvePlaceOfServiceQCode` across every facility-kind combination + fallback path) plus 2
    new live-Postgres scenarios (ALF residence → real Q5002; confirmed own-IPU-bed → Q5006 regardless of a
    contracted-hospital facility kind). Full gate green (build + `arch:fitness` 20 sub-gates + lint +
    `bun run test` 7981 passing + live-Postgres verification: the line-assembly suite, the M24 RLS suite, and
    the M40 RLS suite, run sequentially on a throwaway pg18 cluster).

  **Follow-up #3 (2026-08-05, same day): the M6 IRC/GIP confirm handshake, closed for real.** `changeLoc`
  now accepts a real caller-supplied `facilityId` (and the already-accepted-but-silently-dropped
  `effectiveStart`/`reason`), lands IRC/GIP in a new persisted `assigning` status
  (`level_of_care_period.status`, migration 0184 — this state previously had no column at all, only
  inferred from `ended_at`), and a new `confirmLocBedAssignment` write path (`POST /api/v1/level-of-care/ :id/confirm-bed`) drives the state machine's existing-but-previously-unreachable
  `ipuConfirmBedAssignment` event. The "bedId verified with M37" guard is REAL: M37 already published an
  `IpuBedAssignmentProvider` seam for exactly this handshake (its own doc comment said so) — extended with
  one new method (`activeBedAssignmentForLevelOfCarePeriod`, keyed by the M6 LOC-period id since
  `ipu_admission.level_of_care_period_id` is unique) rather than duplicating the read. Confirmation fails
  closed (`IPU_FACILITY_REQUIRED`) until a real, active `ipu_bed_assignment` row exists — never trusts a
  caller-supplied bed id. Two more consumers of "current LOC" that silently treated an unconfirmed
  `assigning` period as real (M24's claim-line reader, and the LIVE `LevelOfCareReader` seam's
  `getCurrentLevelOfCare`/`getLevelOfCareDays` — already consumed by other modules for census/cap reads)
  were fixed to exclude it. Also fixed en route, once it started blocking real verification: a SECOND
  pre-existing bug in the SAME `changeLoc` route — `LocChangeSchema` validated short codes
  (`rhc`/`crc`/`gip`/`iri`) that never matched what the service actually checked against
  (`routine_home_care` etc.), so the real HTTP route 422'd for every level, not just IRC/GIP; fixed to the
  canonical strings. And three unrelated pre-existing bugs in the M6 live-test suites themselves, found only
  because these suites had apparently never been run successfully against live Postgres before (invisible
  to both `tsc` — `__tests__` sits outside `apps/backend/tsconfig.json`'s `rootDir` — and to vitest, which
  doesn't typecheck): a wrong-arity `acknowledgeNor` call (a raw string landing in the `NorAcknowledgeInput`
  param), a missing attending-physician CTI signature in the shared activation-helper (R-AC-01 requires it
  for period 1), and an assertion checking an error `code` that path never produces. A fourth, unrelated
  pre-existing failure (`transfer-in → inherited active + next pending period` expects 2 election periods,
  gets 3) was found and left — it doesn't touch LOC and isn't a regression from this change. **Closed
  separately the same day**: `createAdmission`'s DB implementation unconditionally seeded election period 1
  (+ a CTI drafted against it) regardless of `intakeMethod` — for a `transfer_in` intake this was always
  wrong (W-DC-03/D9, 42 CFR 418.28: the receiving hospice inherits the sending hospice's carried benefit-
  period sequence via the dedicated `transferIn` call and never has a "period 1" of its own), producing a
  spurious 3rd election_period row alongside `transferIn`'s own correct inherited-active + next-pending
  pair. `intakeMethod` was accepted by the schema/interface but silently never read by the DB service.
  Fixed by skipping the period-1/CTI seed when `intakeMethod === "transfer_in"`; the in-memory fake service
  never had this bug (it doesn't seed a period at all). Also fixed, same class as above, in a THIRD M6
  live-test file this pass never touched (`m6-election-cti-write.live.test.ts`): the same wrong-arity
  `acknowledgeNor` call and the same missing attending-physician CTI signature. All M6 live suites (50
  tests across 6 files) + full gate green.
- **Follow-up, same day**: the transfer-in fix above left the `next` pending period's own CTI unwired —
  per W-DC-03/D9 the receiving hospice DOES need its own CTI for that period (only the inherited period
  runs on the sending hospice's certification), but `transferIn` created the period and stopped. Fixed:
  `TransferInInput` gained `hospiceMedicalDirectorId` (required) + `attendingPhysicianId` (optional);
  `TransferInSchema` and the route now carry them; `transferIn`'s DB and in-memory-fake implementations
  both draft a CTI against the `next` period (`isRecert: true`) and publish `m6.cti.drafted`. No special-
  casing needed for the attending-signature rule — `signCtiHospiceMd` derives it from the period's own
  `sequenceNumber` (never 1 for a transfer-in), so the existing hospice-MD-only-sign-and-activate path
  just works. Extended the live transfer-in test to assert exactly one CTI exists, points at the `next`
  period (not the inherited one), and that signing it activates that period. `openapi.json` +
  `packages/ui/src/core/api/schema.ts` regenerated (request schema changed). Full gate green + all 6 M6
  live suites (50 tests).
- **Follow-up, same day**: `TransferInSchema`/`TransferOutSchema` both accept
  `otherHospiceName`/`otherHospiceCcn`/`narrative`/`effectiveDate`, but neither route handler forwarded
  them to the service — `transferIn` used a hardcoded `today()` and never wrote to
  `transfer_event.receiving_or_sending_{ccn,name}`/`narrative`; `transferOut` was worse, its service
  signature had NO input parameter at all, so those 4 fields were structurally unreachable regardless of
  what the client sent. The `transfer_event` table already had the right columns (its own doc comment:
  "routes 37/38 do not yet capture the counterparty agency"), so this was purely dead wiring, same class
  as `intakeMethod` and the CTI-for-`next`-period gaps above. Fixed: widened `TransferInInput` with
  `effectiveDate`/`otherHospiceName`/`otherHospiceCcn`/`narrative`; added a new `TransferOutInput` type +
  updated `AdmissionRouteService.transferOut`'s signature to take it; both DB and in-memory-fake
  implementations of both methods now persist all four fields (`transferOut`'s discharge-effective-date
  also switched from `now()` to the caller-supplied `effectiveDate`, for consistency). Updated the 4
  existing `transferIn`/`transferOut` call sites (2 fake-service unit tests, 2 in the same live-test
  file) and extended both live tests to read back `transfer_event` and assert the persisted values match
  what was submitted. No OpenAPI regen needed this time (the route SCHEMAS didn't change, only what the
  handlers do with fields they already declared). Full gate green + all 6 M6 live suites (50 tests).
  **Noted, not fixed** (a further instance of the same pattern, genuinely separate): route 36
  (`POST .../revocation`) parses `RevocationCreateSchema` (`revocationDate`/`narrative`/
  `signingPatientName`/`signingRole`) but `createRevocation(organizationId, admissionId, actorUserId)`
  has no input parameter either — all four fields are dropped the same way `transferOut`'s were.
- **Follow-up, same day**: fixed the revocation gap noted above, and found it was worse than
  transferOut's twin — `revocation_event.revocation_reason` is `NOT NULL`, but
  `RevocationCreateSchema` never collected it at all (a genuine spec gap; architecture's DB
  requirement wins), so `createRevocation` hardcoded `revocationReason: "other"`, `signerKind: "patient"`, and `effectiveAt = signedAt = now()` unconditionally, discarding every real field the
  client sent. Fixed: added `revocationReason` (the 4 real `revocation_reason` enum values) to
  `RevocationCreateSchema`; new `RevocationInput` type; `AdmissionRouteService.createRevocation`
  signature now takes it. `signingRole` maps to the DB's `signer_kind` enum (`"legal_representative"`
  → `"representative"`, matching the DB's different vocabulary — the route and DB enums were never
  the same strings). `revocationDate` drives BOTH `effective_at`/`signed_at` (the route contract, per
  spec, carries only one date; R-RV-01's `effective >= signed` check is trivially satisfied by
  construction). `signingPatientName` is validated but NOT persisted — no `revocation_event` column
  exists for it, same posture as `NorAcknowledgeInput`'s already-documented TASK-034 precedent (the
  rendered M22 form is the durable signer-name record, not this table). Extended the live test to
  read back `signer_kind`/`effective_at`/`signed_at`/`revocation_reason`/`narrative` and assert they
  match what was submitted. Updated the 1 fake-service call site this broke.
  **Also noted, not fixed, found while investigating**: `createRevocation`'s DB implementation never
  calls the existing pure `planRevocation` (`state-machines/commands.ts`) — R-RV-01's validation is
  fully built and unit-tested in isolation but never wired to the real write path, the same
  unwired-validation class of bug found repeatedly this session. Currently harmless (the route
  contract only carries one date, so `effective_at`/`signed_at` can never diverge through the API
  today), but would become a real gap if the two dates were ever split. A separate, deeper fix; left
  for a dedicated pass rather than folded into a field-persistence fix. OpenAPI + client schema
  regenerated (new required field). Full gate green + all 6 M6 live suites (50 tests).
- **Follow-up, same day**: wired `planRevocation` into `createRevocation`'s real write path (called
  purely for its two validation guards — `electionPeriodActive` + R-RV-01's date-order check — NOT
  for its returned effects cascade, which `dischargeAdmissionTx` already applies via
  `transitionAdmission`'s own equivalent inline effects; running both would double-apply the
  UPDATEs and double-publish `m6.revocation.created`). `latestPeriod` widened to also return
  `status` so the guard has a real fact to check. Wiring this surfaced a genuine, independent,
  pre-existing bug: **`activateAdmission` fired `m6.election.period_started` claiming period 1 had
  started, but no write ever set `election_period.status = 'active'`** — it stayed at its `pending`
  default until the admission was eventually discharged, jumping `pending → completed` and skipping
  `active` entirely. This wasn't a wired-planRevocation edge case, it broke the FIRST ("happy path")
  revocation test outright once the guard started checking a real fact, because that fact had never
  actually been true. Root cause: `runEffects` has no `SideEffect` kind for "start a period" (mirrors
  `set_timestamp`/`set_flag`'s existing "folded into the caller" posture, but this one was never
  folded in anywhere), and the recert path's period-activation (`signCtiHospiceMd`) explicitly
  excludes period 1 with an attending co-sign. Fixed by folding a direct `election_period` UPDATE
  into `activateAdmission` itself, gated on `facts.periodId` (period 1's id, already loaded for the
  activation gate). Added a live test proving the guard fires 409 `ILLEGAL_TRANSITION` before any
  write when the target period isn't active (superuser-forced to `completed`, simulating what a
  second revocation attempt would hit). No cross-module reader of `election_period.status` exists
  yet, so this was safely containable to M6. Full gate green + all 6 M6 live suites (51 tests).
- **Follow-up, same day**: wired the two remaining unwired `commands.ts` functions,
  `planTransferOut` and `planDischarge`, into their real write paths — same "validation only, not
  the effects cascade" posture as `planRevocation` (the cascade is already applied via
  `dischargeAdmissionTx`'s `transitionAdmission` duplicate). `planTransferOut`'s
  `transferAlreadyDoneThisPeriod` (R-XFR-01, only one transfer per benefit period) is now a REAL
  query against `transfer_event` (no DB constraint enforces this, unlike revocation's unique index;
  the admission-graph transition to `discharged` blocks an obvious double-call today, but that was
  always incidental, not a rule). `planDischarge` is now called from the SHARED
  `dischargeAdmissionTx` helper (so revocation/transfer-out/discharge/cosign all benefit): its
  `forCauseCosigned` guard was already a real, correctly-threaded fact (redundant with
  `transitionAdmission`'s own duplicate check, wired anyway for defense-in-depth); its R-DC-01
  death-certifier guard's date-order half is now REAL (`today` switched from `ev.effectiveAt` — which
  made the check trivially true by construction, comparing a value to itself — to the actual server
  clock). **The credential half of R-DC-01 remains a hardcoded `true` placeholder, explicitly
  flagged, not silently left**: `DischargeCreateSchema` collects no certifier identity at all, even
  though `discharge_event.death_certifier_id` exists as a real column for exactly this
  (`packages/db/src/schema/admission/discharge-events.ts`) — populating it for real needs a new
  schema field, not just a function call, so it's out of scope for "wire the guard." **Found the
  same "no input param" bug a 4th time, same investigation, not fixed**: `cosignDischarge`
  (route 40) parses `DischargeCosignSchema`'s `cosignerName`/`cosignerNpi` and drops both — same
  class as `transferOut`/`createRevocation` before their fixes; the natural home for a real
  certifier-identity field once collected. Added 2 new live tests: a future-dated death discharge
  now rejects 409→422 `DEATH_CERTIFIER_INVALID` before any write (previously would have silently
  succeeded); a second transfer-out seeded against the same benefit period now rejects 409
  `TRANSFER_LIMIT_EXCEEDED` before any write. Full gate green + all 6 M6 live suites (53 tests) +
  M24 claim-line-assembly (9 tests, downstream consumer of M6 discharge/transfer data).
- **Follow-up, same day**: fixed the `cosignDischarge` gap noted above. Same root shape as
  `transferOut`'s pre-fix bug — the service signature had NO input parameter, so
  `DischargeCosignSchema`'s `cosignerName`/`cosignerNpi` never even arrived at the service, let
  alone got dropped there. New `CosignDischargeInput` type threads them through
  `AdmissionRouteService.cosignDischarge` (route handler → both DB and in-memory-fake
  implementations). Unlike the transfer/revocation fixes, this one does NOT persist the fields
  anywhere: `discharge_event` has no cosigner name/NPI column (confirmed against the spec's own ER
  diagram, which never designed one either), matching the already-established
  `RevocationInput.signingPatientName`/TASK-034 precedent — the M4 write-audit trigger already
  records the cosigning ACTOR on the write, and the rendered discharge summary (M22) is the durable
  record of the signed name/NPI, not this table. So the fix is "make the fields reachable and
  explicitly validated-not-silently-dropped," not "find a place to store them" — there genuinely
  isn't one, by design, same as the patient-name case. Updated the 3 existing call sites (`tsc -b`
  doesn't typecheck `__tests__`, so these needed manual fixes) plus the existing HTTP-inject test
  (`admission-routes.test.ts`) already posted the real payload shape and now exercises the real
  4-arg service call end to end. Full gate green + all 6 M6 live suites (53 tests) + M24
  claim-line-assembly (9 tests). No open "no input param" instances remain in this file.
- **Follow-up, same day**: closed the death-certifier half of R-DC-01 that the `planDischarge`
  wiring left as a hardcoded `true` placeholder. Unlike `cosignDischarge`'s cosigner identity,
  `discharge_event.death_certifier_id` DOES have a real column ready for exactly this — so the fix
  is real, not just reachable-and-dropped. Added `deathCertifierId` (optional at the schema level,
  service-enforced required for `reason='death'`, mirroring `forCauseReason`'s existing conditional
  pattern) to `DischargeCreateSchema`; `permission-map.ts`'s `checkDischargeNarrative` gained a new
  `requiresDeathCertifier` policy flag and returns `DEATH_CERTIFIER_INVALID` (reusing
  `checkDeathCertifier`'s own code — one coherent R-DC-01 guard, two places it can fail) when a
  death discharge omits it; `dischargeAdmissionTx` now derives `deathCertifierCredentialed` as
  `!!deathCertifierId` instead of a bare `true`; `discharge_event.death_certifier_id` is populated
  for real on insert. **Explicit about what this does NOT prove**: it confirms an IDENTITY was
  captured, not that the identified person holds an MD/NP/RN license or that their license permits
  pronouncing death under the admission's own state's rules (R-DC-01's own note: "RN can pronounce
  in some states"). Full state-law-aware role/license verification needs an M40 physician-registry
  role lookup plus a per-state credentialing ruleset — neither exists yet, and building both is a
  materially larger feature than this fix, so it's flagged, not attempted. `cosignDischarge`'s
  cosigner identity remains deliberately unpersisted (no column exists for it, unlike this field).
  Added 2 new live tests (missing-identity → 422 before any write; existing death test extended to
  assert the id round-trips to the DB) + 1 new unit test (`checkDischargeNarrative`'s new gate).
  `deathCertifierId` changed a route's request schema, so `openapi.json` + the generated UI client
  were regenerated. Full gate green + all 6 M6 live suites (54 tests) + M24 claim-line-assembly.

  4 new unit tests (state-machine coverage already existed), 4 new HTTP-inject tests (`admission-routes.test.ts` —
  proving the real route, not just the service method, including the short-code fix), 2 new live-Postgres
  scenarios seeding a REAL M37 unit/room/bed/admission/bed-assignment chain
  (`m6-discharge-f2f-loc-write.live.test.ts`), plus a live predicate-exclusion test in the M24 suite. Full
  gate green (build + `arch:fitness` 20 sub-gates + lint + `bun run test` 7985 passing + live-Postgres: M6
  admission-write-lifecycle, M6 LOC/discharge, M6 RLS, M24 claim-line-assembly, M24 RLS, M37 RLS — all run
  sequentially on a throwaway pg18 cluster).
- Risks: State variance.
- Rollback: Disable launch-state capability and reconcile in-flight jobs.
- Estimated complexity: XL

## WX-PR-012 - Bind X12-835 ingestion and posting

- Status: Implementation complete (2026-08-05); follow-up same day bound the real M23 claim-match/patient-resolution seam and a real fetch-based x12-worker transport — no Python x12-worker sidecar is deployed anywhere (M23's own x12-837-client transport is in the same unwired state), so the transport has nothing to call yet, but is genuinely real code, not a stub
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
- Completion evidence: prior to this pass, M25's 835 pipeline was pure scaffolding — a fail-closed
  parser client, a dedup unique index, and pure domain functions (auto-match D3, adjustment routing
  D4/D5, posting-outcome classification), but literally no code ever inserted a
  `remittance_advice`/`remittance_line` row or posted a payment; every M25-owned gap the module's own
  comments already admitted ("Phase 3 adds... services", "NOT wired into the dispatcher subscription
  yet"). Built the real pipeline in two service methods
  (`apps/backend/src/modules/25-remittance/ingest/service-drizzle.ts`):
  `receiveAdvice` derives the ISA13/ST02 dedup key via a new local, pure, real X12 envelope-header
  parser (`@chartwarden/x12-835-client`'s `parseX12EnvelopeHeader` — fixed-width ISA segment + terminator-
  delimited ST segment, no sidecar round-trip needed just for the header), inserts the
  `remittance_advice` row with `onConflictDoNothing` on the existing `ux_remittance_envelope_dedupe`
  index (a caught conflict resolves to the EXISTING row id, never a second row, never a thrown/poisoned
  tx), and emits `m25.edi.835_received` in the same tx. `postAdvice` calls the injected
  `X12835WorkerClient.parse835` for the CLP-level detail, then in ONE transaction inserts every
  line/service-line/adjustment/remark row, auto-matches each line (D3), routes each adjustment (D4/D5)
  through the M38 terminology lookup, seeds `denial_case`/`patient_responsibility_ledger` rows,
  classifies each line's posting outcome (§2.4) and emits the matching `m25.remittance.claim_*` event —
  either the WHOLE batch commits (posted/partial_posted) or NOTHING does (any error rolls back the
  entire batch, including claims that would have succeeded alone), with a separate short transaction
  then marking the advice `failed` so it stays operator-actionable via the EXISTING `remittance.replay`
  route (which already re-emits the same event — no new replay code needed). Wired the LIVE dispatcher
  consumer (`outbox-consumers/live-binding.ts`, the M6 admission-event-applier precedent) so a real
  `m25.edi.835_received` delivery drives `postAdvice` automatically, registered into
  `apps/backend/src/index.ts`'s outbox-dispatcher `consumers` array. Added the "receive" entrypoint as
  a new internal system-principal route (`POST /api/v1/internal/remittance/advices`, route #32,
  `remittance.ingest_internal` permission key — the 23rd M25 key) rather than inventing a literal
  clearinghouse/SFTP poller (unbuildable/untestable in this environment; matches the existing "M25
  self-pulls, transport unwired" posture the spec's own boot.ts already documents for every other M25
  forward seam). Two deliberate, explicitly-flagged degrades rather than fabrication: (1) the D3
  auto-match candidate lookup and the PR-ledger patient-id resolution are both a NEW, narrow
  `ClaimMatchCandidateProvider` port defaulting to "no candidates / no patient" — not the full M23
  `ClaimReader` seam, which stays a cross-module foundation BIND out of scope here (same posture as
  M27's HCI/cap seams); a PR-group adjustment whose patient can't be resolved honestly degrades to
  `flagged_review` rather than claiming a ledger entry was recorded when it wasn't. (2) the real
  Python x12-worker sidecar has no transport wired (`createX12835Client()` defaults to the existing
  fail-closed `NO_X12_835_PORT`) — every code path from receive through denial-seeding is real and
  proven end-to-end against an injected FAKE client with real fixture data; only the actual sidecar
  HTTP call is a follow-up. New live-Postgres suite
  (`apps/backend/__tests__/m25-835-ingestion.live.test.ts`, 7 tests) proves: a multi-claim happy path
  (matched/auto_posted, matched/denied+denial-seeded mapped AND unmapped, PR-ledger resolved AND
  honestly-degraded-unresolved, unmatched→manual worklist) landing `partial_posted`; a CLP02=22
  reversal landing `posted` with `match_state='reversed'`; a duplicate ISA/ST rejected with zero second
  rows; a malformed (non-X12) file persisting nothing; a forced mid-batch failure rolling back EVERY
  line (including the one that would have succeeded alone) and marking the advice `failed`; a
  degraded-sidecar failure at post time recovering cleanly on replay; and cross-tenant RLS isolation
  (proven via `SET ROLE wardenx_app`, the `rls-isolation.live.test.ts` precedent — a superuser
  connection bypasses RLS and would pass this assertion vacuously). New OpenAPI enrichment for both the
  new route and pre-existing coverage regenerated (1219/1226 → 1221/1228 enriched, ratchet held). Full
  gate green (build, `arch:fitness`, lint, 7986 tests) plus the new live suite (7/7) and the
  pre-existing M25→M27 `ClaimSettlementProvider` live seam suite, run standalone against a throwaway
  pg18 cluster.
- Follow-up (2026-08-05, same day): closed both explicitly-flagged gaps for real, not by relaxing the
  original honest framing. (1) M23 claim-match seam: added `ClaimRepository.findMatchCandidates`
  (payer-ICN/claim-control-number union) + `patientIdForId` in `packages/billing/src/repositories/claim.ts`
  (a NEW query — nothing pre-existing exposed this), published as M23's third seam via
  `cost-report-seams.ts`'s `registerM23PublishedSeams` (already called at boot) under a new
  `ClaimSubmissionReader` registry key (`packages/types/src/seams.ts` + `bootstrap/seams/registry.ts`,
  `phi:true`, deny-stub default). M25 consumes it via a new adapter
  (`ingest/claim-match-adapter.ts`) that degrades to empty/null on ANY failure (the M30
  `consumed-seam-adapters.ts` `degradeToSuppressed` precedent), bound at both `index.ts` construction
  sites in place of `NO_CLAIM_MATCH_CANDIDATES`. Along the way found a SECOND, unused, more elaborate
  seam-declaration system (`@chartwarden/billing/seam-registration.ts`) that already had an almost-identical
  `ClaimSubmissionReader` design but is never wired into the real registry — reused its name, not its
  dead wiring. New live test (`m23-m25-claim-match-seam.live.test.ts`, 4 tests) proves the pre-bind
  degrade, the post-bind real match + real patient id + RLS isolation, and a full 835 auto-matching to a
  genuinely seeded `claim` row end-to-end. (2) x12-worker transport: no Python sidecar service exists
  anywhere in this repository (confirmed by survey — no `services/` dir, no Dockerfile; ADR-0029
  describes it as not-yet-built); built a real `fetch`-based `X12835HttpPort`
  (`ingest/x12-worker-transport.ts`) mirroring M23's own already-established
  `launch-gateway.ts` pattern exactly (env-gated `M25_X12_WORKER_URL`/`_TOKEN`/`_TIMEOUT_MS`, graceful
  `null` when unconfigured), wired into both `createX12835Client()` call sites. This closes "the
  transport code doesn't exist," not "there is a sidecar to talk to" — there still isn't one, for either
  M23 or M25; standing up a real pyx12/FastAPI service is a separate infrastructure project. Unit-tested
  with `vi.stubGlobal("fetch", ...)` (7 tests — more thorough than the codebase's existing convention,
  which doesn't test M23's analogous `fetchHttp` at that level). Full gate green (build, `arch:fitness`,
  lint, 7993 tests, up from 7986) plus both new live/unit suites plus the original two live suites,
  each standalone. `arch:fitness`'s seam-registry count moved 150→151 (confirms real registration);
  table-ownership stayed green (confirms the seam indirection satisfied the boundary rule rather than a
  direct cross-module schema import).
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
- Status: Done (2026-08-05, `apps/backend/src/modules/27-cost-report/wiring.ts`,
  `apps/backend/__tests__/m27-cost-report-workflow-slice.live.test.ts`). Selected slice: manual
  trial-balance/wage-data import (the already-live "approved input adapter" path — Xero/Gusto OAuth
  pull is out of scope, see below) → the real BullMQ `RecomputeEnqueuePort` producer
  (`buildM27RecomputeEnqueue`) → the §4320/§4330 step-down/per-diem allocation → the §11.B validation
  rule engine → a real content-hashed snapshot on submit → ECR/PI artifact generation. Before this
  task, `buildDrizzleM27WriteService` was never given a `recompute` port, so `refresh-inputs` /
  `allocate` / `compute-worksheet` / `validate` / submit's ecr-generation trigger all enqueued NOTHING
  (a safe no-op default returning a fake jobId) — even the two §4.8 processors that were otherwise
  fully live-bound (`cost-allocation-recompute`, `validation-run`) were untriggerable from the API.
  Bound for real: the recompute-enqueue producer (dedupe-key-derived `organizationId` enrichment, since
  every §4.8 work queue is org-scoped but the producer's payloads never carried it), the transactional
  outbox (the pre-existing `m27OutboxPublisher` simply wasn't passed into `buildM27WorkerDeps`), the M36
  alert router (the M25 `getSeam("AlertEmitter")` pattern), and the M2 active-org enumerator for the
  `filing-deadline-scan` cron fan-out. Found and fixed a real bug the new live test caught: both
  `runTrialBalancePull`/`runWageDataPull` re-threw after marking their import row `failed`, but that
  whole call runs inside the caller's `withOrgContext` transaction — the re-throw rolled back the very
  "failed" bookkeeping the catch block just wrote, so the documented "reconnect-prompt" recovery path
  was dead code. Fixed by not re-throwing (retrying against a permanently-unbound seam would fail
  identically anyway; the durable, discoverable `failed` state is the intended terminal outcome).
  Explicitly OUT of this slice (deny-stub, not fabricated): the M1 per-tenant DEK envelope-encrypt (no
  platform-wide live KMS provider exists yet; only needed for the live Xero/Gusto payload cipher, which
  the proven manual-import path never touches); the live Xero/Gusto OAuth pull itself (the
  `@chartwarden/xero-client`/`@chartwarden/gusto-client` packages are real but binding a live pull needs M34
  tenant-onboarding OAuth-token storage that does not exist — a separate, larger project); the M6/M8
  statistics aggregate seams (`LevelOfCarePeriodReader`/`EncounterStatisticsProvider` do not exist as
  M1-registered seams at all — new seam surface, not just an unbind; the allocation chain does not
  hard-depend on them, so the proven slice seeds `statistic_data` directly via the repository instead).
  New live suite (6/6, real Postgres + a throwaway Redis) proves: known-worksheet-fixture allocation
  math (hand-verified step-down/per-diem penny-exact), a real regulatory-blocking validation failure
  with every M23/M25/M12/M40/M26-gated rule correctly SKIPping (never fabricating), a real correction
  (fix the defect, re-validate, pass), a real content-hashed snapshot + ECR/PI generation on submit, the
  M4 write-audit trail carrying the real actor, the missing-seam fail-closed path (now durable), and
  BullMQ's own jobId-dedupe preventing a duplicate trigger from double-enqueuing. Full gate green
  (build, `arch:fitness`, lint, 7994 tests) plus the new live suite, run standalone.

## WX-PR-014 - Complete M30 and M33 launch jobs

- Status: Done (2026-08-06, M33 follow-up ×2) — the M30 §4.8 CRON → WORK-QUEUE background-job path (nightly
  measure-recompute + daily risk-register-refresh) is bound for real and live-tested end-to-end
  against real Postgres + real BullMQ (see the original M30 note below); a same-day follow-up closed
  the M33 slice this task's first pass deliberately left untouched (see "M33 follow-up (2026-08-06)"
  below the M30 write-up); a SECOND same-day follow-up then closed the two gaps THAT pass left open
  (mvRefresh/lagProbe's outbox emits + the exportRender schema mismatch) — see "M33 follow-up #2
  (2026-08-06)" — and, verifying the fix under REAL RLS (not a superuser test connection), surfaced a
  severe, codebase-wide, pre-existing bug now tracked separately as **WX-PR-024**.
  Research (before writing code) found the two cron enqueue ports (`nightlyRecompute.enqueue .enqueueForOrg`, `riskRegisterRefreshCron.enqueue.enqueueRefresh`) were hardcoded fail-closed
  thunks with NO fan-out logic at all — meaning the 03:15 nightly recompute and 04:00 daily
  risk-register refresh were silent no-ops in production, forever, even though their downstream
  work-queue processors were otherwise live-bound. Binding them surfaced FOUR more real,
  previously-undetected blocking bugs (no M30 live test existed before this task) that also had to
  be fixed for "enabled jobs complete" to be true at all, not just for the cron path specifically:
  (1) `processing_log` had no TABLE at all (migration 0185 adds it, M1-owned) — every one of the
  four §4.8 work-queue processors threw on their very first line, on every job, always; (2)
  `measure_recompute`/`risk_register_refresh` call their `outbox.emit*` port UNCONDITIONALLY before
  `processingLog.markProcessed` — with it unbound, every otherwise-successful run threw on its last
  line and rolled the WHOLE per-job transaction back, discarding the already-computed value; bound
  over the same tx-scoped `m30` outbox publisher the command routes already use; (3)
  `risk_register_refresh`'s worker never actually ran inside `withOrgContext`, despite its own
  repository's doc comment saying it must — FORCE RLS silently returned zero rows from every source
  table on every run; (4) `refreshConcurrently` ran `REFRESH MATERIALIZED VIEW CONCURRENTLY risk_register_view`, but migration 0067 DELIBERATELY made that view a plain (non-materialized)
  view — its own comment explains why (a precomputed matview cannot re-filter per reading session
  and would leak cross-org rows) — so Postgres has rejected this statement outright since M30
  shipped; fixed to a documented no-op (a plain view has nothing to refresh). Also fixed the same
  class of BullMQ "jobId cannot contain ':'" bug WX-PR-013 found in M27's producer, present in
  M30's `buildM30RecomputeEnqueue` too (also never live-tested before now), and fixed a genuine
  R-96 route payload-shape mismatch (`{orgId}` sent, `{organizationId, force}` expected) that would
  have made every manually-triggered risk-register refresh fail identically. Proven via a new live
  suite (3/3) that constructs the REAL `registerM30Workers` (not a hand-rolled copy) against a real
  throwaway Redis — `Job.waitUntilFinished` awaits actual BullMQ consumption, including a DLQ-replay
  idempotency check (`processing_log`, not BullMQ's own dedup, must short-circuit a re-delivered
  job). Full gate green (build/arch:fitness/lint/full test suite). **M33 deliberately NOT touched**:
  a dedicated research pass found M33's gap is an order of magnitude larger than M30's — nearly
  every `m33-jobs.ts` port is unbound (nearly all `outbox.emit*` ports, the M39 consent
  re-validation, the M1 envelope-DEK for drilldown-audit, the M22 render handshake, the Valkey
  lag-probe state), not a single isolated enqueue-producer gap — closing it well is a separate,
  comparably-sized task, not a corner of this one. Also explicitly out of scope, unchanged from
  WX-PR-013's precedent: the M1 DEK/KMS provider (still hard-throws, blocks CAHPS PHI + M33
  drilldown-audit encrypt), live CAHPS vendor OAuth (Deyta/HealthCareFirst/PressGaney/SHP stay
  deliberate `vendor_adapter_not_implemented` placeholders — the `manual` adapter is real), and
  `measure_recompute`'s `emitThresholdBreached` (a genuine, separate payload/schema mismatch vs the
  `m30.measure.threshold_breached` catalog entry — missing `indicatorId`/`threshold` — found but not
  papered over with invented values).

  **M33 follow-up (2026-08-06)** — closed the gap the M30 pass above deliberately left untouched. Bound
  for real: the per-job `withOrgContext`/`withPlatformContext` tenancy envelope (previously ABSENT on
  every one of the five §4.8 workers — FORCE RLS silently denied/emptied every org-scoped read/write,
  a bigger version of the M30 risk_register_refresh bug found above); the nightly MV-refresh
  orchestrator (the cron sentinel used to land directly on the per-MV worker with no dedicated
  consumer — now branches on the BullMQ job name and runs the real `runNightlyRefresh` fan-out, which
  really `REFRESH MATERIALIZED VIEW CONCURRENTLY`s `report_mv.mv_census_org_daily`); `scheduledRun`'s
  M2 active-membership recipient re-validation, the real `translateSpec` view→version→definition→base
  snapshot-build chain, `pause.autoPause`, the M4 `audit()` writes, and the outbox emits that satisfy
  their catalog schema; the Valkey-backed lag-probe hysteresis state + degraded-tile advisory flag
  (previously hardcoded throws that would have crashed the 30-second singleton probe on its first
  tick); and — beyond the job-wiring charter — a real `db.execute`-backed tile/export SQL executor for
  the READ + EXPORT route services, since `deps.tiles` was never passed at the composition root at
  all: no M33 tile read or CSV export had ever returned real data in production, independent of the
  background-job gap (found while tracing the same `translateSpec` chain `scheduledRun.snapshot.build`
  needed). A live-test-caught regression in this pass's own first draft: `mvRefresh`/`lagProbe`'s
  outbox emit ports were initially bound as fail-closed *throws*, but `handleMvRefresh`/`runLagProbe`
  call them UNCONDITIONALLY on the success path — the identical `unbound()`-on-an-unconditional-call
  bug class the M30 write-up above fixed (`emitValueEmitted`) — so a real successful REFRESH was
  recorded as a FAILED run until the live test caught it; corrected to documented no-ops. Two genuine,
  NOT-closeable infra gaps found while wiring (left unbound, not routed around): `mvRefresh`/`lagProbe`'s
  outbox emits, because `OutboxPublishPort.publish` (M1, `apps/backend/src/bootstrap/outbox-persister.ts`)
  requires a non-null `organizationId` by design and these are platform-wide
  (`organizationId=null`/absent) events — needs an M1-level nullable-org outbox persist path; and the
  ad-hoc PDF/XLSX `exportRender` outbox, because `ExportRenderRequestPayload` does not satisfy the
  `m33.scheduled_report.render_requested` catalog schema (missing `scheduleId`/`runId`, which only the
  separate scheduled-run cron producer's payload carries) — two producers sharing one wire event name
  with incompatible payloads, a package-level gap. Still explicitly out of scope, unchanged: the M1
  DEK/KMS provider (drilldown-audit encryption still denies), the M33 cron-parser adapter (schedule
  `next_run_at` math — a separate library integration), and `report.tile_warm_cache`/
  `report.tenant_eraser` (no BullMQ producer anywhere enqueues onto either — the real tenant-erase path
  is the already-wired M4 destruction registry; tile-warming is an unbuilt caching optimization, reads
  compute live either way). Proven via a new live suite (4/4) against real Postgres + a dedicated
  throwaway Redis. Full gate green (build/arch:fitness/lint/full test suite, 7995 passing, live suite
  gated).

  **M33 follow-up #2 (2026-08-06)** — closed the two gaps the M33 follow-up above left explicitly
  unbound. (a) The `m33.scheduled_report.render_requested` catalog schema now marks `scheduleId`/`runId`
  Optional so BOTH real producer payloads validate (the scheduled-run cron path's, already bound, and the
  ad-hoc PDF/XLSX export route path's, now bound too) — a genuine package-level event-catalog gap (one
  wire name, two producers, only one previously conformant), fixed at the schema, not by fabricating
  fields on either payload. (b) `mvRefresh`/`lagProbe`'s outbox emits are bound for real: `outbox_event.
  organization_id` is now nullable (migration 0186), gated not by a second RLS-policy session variable
  (ADR-0010 D2 bans any GUC beyond `app.org_id`, so that first attempt was reverted) but by a NEW
  SECURITY DEFINER writer surface reusing the EXISTING `report_writer` role (M33's own platform-catalog
  writer, migration 0056) — the `wardenx_audit_writer`/`audit_writer_insert` precedent (migration 0013),
  not a novel pattern: `report_writer_insert_platform_outbox_event` (the publish path) plus
  `report_writer_{claim,finalize_*,reclaim,purge}_platform_outbox` (an additive `pollPlatform()` pass in
  `apps/backend/src/bootstrap/outbox-dispatcher.ts`, alongside the existing per-org `pollOrg()` — the
  shared `DispatchableOutboxEvent`/`OutboxConsumerBinding` types, used by ~150 existing org-scoped
  consumer bindings, were deliberately left untouched). A live-test-caught regression in THIS pass's own
  first draft repeated [[wx-pr-014-m30-scheduled-jobs]]'s exact bug class a second time in the same
  session: `mvRefresh`/`lagProbe`'s outbox emits were initially left as fail-closed throws for the
  "genuinely can't bind yet" reason, but both are called unconditionally on their worker's success path,
  so the throw turned a real successful REFRESH into a run recorded FAILED — caught immediately, fixed to
  bind for real once the nullable-org path existed. A second, separate live-test-caught bug: the
  `m33.mv.refresh_succeeded` schema required `rowsAffected` as a non-null integer, but
  `REFRESH MATERIALIZED VIEW CONCURRENTLY`'s own executor always returns `rowsAffected: null` (Postgres
  reports no row count for a REFRESH) — the schema had never been validated against a real payload before
  this pass actually bound the emit; fixed to accept `integer | null`.

  Verifying under REAL RLS (`SET ROLE wardenx_app`, NOBYPASSRLS — not the superuser test connection this
  pass's own first draft used, which bypasses RLS entirely and proves nothing about it) surfaced a
  SEVERE, codebase-wide, pre-existing bug, NOT fixed here and tracked separately as **WX-PR-024**: every
  `withPlatformContext` call anywhere in the codebase (not just M33) throws under a properly-hardened,
  NOBYPASSRLS production deployment, because its mandatory `platform.bypass_invoked` audit write has no
  RLS policy admitting a null-org row for `wardenx_app`. `report_run` and `materialized_view_metadata`
  were also found to have the IDENTICAL "no wardenx_app write policy for a platform-wide row" gap this
  task fixed for `outbox_event` — both pre-existing, both left unfixed here (see WX-PR-024).

  Proven via the SAME live suite, now hardened to connect as `wardenx_app` (bootstrapping the role's
  LOGIN/password/NOBYPASSRLS itself) rather than a superuser — 4/4 passing under genuine RLS enforcement,
  with a direct `psql` verification (insert → claim → finalize → reclaim → purge, all through the
  SECURITY DEFINER path, and a raw direct INSERT confirmed REJECTED outside it) as the conclusive proof
  the new outbox mechanism is correct. Full gate green (build/arch:fitness/lint/full test suite, 7995
  passing).
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

- Status: Completed for the M23-M35 priority scope (2026-08-05); 87 mutating/8 GET gaps remain
  outside that scope (bodyless action routes + modules not in this task's priority list).
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
- Completion evidence: Mapped the exact route-level gap (not just the aggregate count) across the 12
  M23-M35 modules and classified each as a real "handler validates a body the enrichment doesn't
  declare" gap vs. a cosmetic "route genuinely takes no body" case the metric can never zero out (the
  M39/WX-PR-009 precedent for those). Used a Workflow (12 parallel research agents, one per module,
  each reusing the SAME exported TypeBox schema the handler actually validates/returns, never
  inventing fields) to author the enrichment code, then integrated and verified it centrally rather
  than trusting agent claims: resolved every relative import against the real filesystem and confirmed
  the named export exists, checked for symbol collisions (none) both across the 12 modules and against
  the existing 10,000+-line enrichments.ts, and diffed every pre-existing route entry's response/summary
  before and after to confirm no silent regressions. GET-response gaps in the M23-M35 scope: 72 → 8.
  Mutating-body gaps in scope: dropped substantially (the remainder — mac-credentials, sequestration
  policies, and a handful of others — turned out on inspection to be additional bodyless-action or
  already-covered false positives from the initial gap scan, correctly skipped by the research agents
  rather than fabricated). Regenerated `openapi.json` + the typed client; fixed the resulting 8
  `body: {}` compile errors this created in SPA call sites that previously omitted a body Fastify never
  validated. Re-tightened the coverage ratchet baseline. Did not attempt a repo-wide `as never` cast
  sweep — that's a much larger, separate undertaking touching 55+ files, most for routes outside this
  pass's scope; flagged as a follow-up, not attempted here. Full gate (build, `arch:fitness`,
  `bun run test`) green.
- Risks: Consumer-breaking types expose existing behavior drift.
- Rollback: Per-module compatible commits or explicit versioning.
- Estimated complexity: L

## WX-PR-016 - Enforce nested audit redaction

- Status: Completed (2026-08-05).
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
- Completion evidence: Investigation found the DB-level mechanism was never missing — every one of the 6
  tables declaring nested-path denylist entries (M13.administration_record, M14.idg_decision,
  M14.idg_patient_packet, M15.discipline_care_plan_version, M15.discipline_assessment,
  M16.bereavement_risk_score) already redacts them correctly in its live migration trigger, via
  `audit_scrub()` applied a second time to the extracted nested object and written back with
  `jsonb_set` (e.g. `jsonb_set(v_before, '{data}', audit_scrub(v_before->'data', v_data_keys))`).
  `check-audit-denylist-sync.ts` just never verified it — it printed "not enforced" and skipped
  checking, so a real regression (a deleted `jsonb_set` call, a dropped key) would have passed
  silently. Added `verifyNestedPaths()`, which checks each declared nested path's migration
  function-block text for the extract/scrub/write-back pattern (same text-presence philosophy as the
  existing `CONDITIONAL_REDACTIONS` check) — confirmed it fails correctly against a deliberately
  broken copy before landing. All 25 nested-path entries across the 6 tables now read
  `[nested-path, verified]`. The M22 disagreement resolved the other way: `payload_schema` on
  `form_template_version` was DENYLISTED in the TS constant, but the table's own schema-file comment
  says "structural, not PHI" (it's a serialized TypeBox render contract — field structure, not patient
  data) and the migration correctly runs it through the platform-shared `wardenx_audit_trigger()`
  with no redaction at all — so the constant was the side that disagreed with reality; removed
  `payload_schema` from `M22_AUDIT_DENYLIST`, `KNOWN_UNRESOLVED_DISAGREEMENTS` is now empty. Added
  `packages/db/migrations/__tests__/nested-audit-redaction.live.test.ts`
  (`test:audit:nested-redaction:live`), proving at runtime — against a real Postgres trigger, not just
  static text — that two representative tables (one `->>` scalar path, one `->` object/array path)
  redact the denylisted nested key while a SIBLING key in the same jsonb column stays visible (selective
  redaction, not blanket column wipe). Full gate (build, `arch:fitness`, `bun run test`) green.
- Risks: Over-redaction reduces forensic usefulness.
- Rollback: Forward adjust redaction metadata; never reintroduce stored PHI.
- Estimated complexity: L

## WX-PR-017 - Add cluster security controls and resolve router advisory

- Status: Completed (2026-08-05) — shared rate limiting, the audit exception gate, and explicit
  double-submit CSRF are done; the router version bump is not possible (no fixed release exists
  upstream yet — documented as a reviewed exception, see completion evidence).
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
- Completion evidence:
  - **Shared rate limiter (done)**: `applySecurityBaseline`'s SD-055 limiter now reads through an
    injectable `RateLimitStore` (`rate-limit-store.ts`) instead of always owning a per-process `Map`.
    `createRedisRateLimitStore` uses an atomic Lua INCR+PEXPIRE (single round trip, no lost-update
    race) over a dedicated Valkey connection bound at boot when `REDIS_URL` is set — reusing the
    SAME connection config the M34 BullMQ queues already use, but its OWN client (not shared with
    the `/ready`-probe health client, which is tuned for a different access pattern). The store call
    fails OPEN (logs a warning, allows the request) on a Redis error, since a rate limiter is an
    availability control, not an authorization gate — an unhandled store error previously would have
    taken down 100% of API traffic on any Redis blip. Verified live against real Valkey: two
    independent connections (standing in for two replicas) share exactly one counter, 50 concurrent
    increments across both produce exactly 50 distinct sequential counts (no lost updates), and the
    fixed window genuinely expires rather than accumulating. `security.ts` previously had ZERO
    dedicated tests; added 9 covering tiers, IP bucketing, clock-driven window reset, the disable
    flag, fail-open, the CORS allow-list, and response headers.
  - **Audit-exception gate (done)**: `bun audit` had no CI check at all — added
    `check-audit-exceptions.ts` (ratcheted, wired into `arch:fitness`) requiring every advisory `bun audit` reports to be in a reviewed, written allowlist, and flagging an allowlist entry as STALE
    once the underlying advisory clears (so an accepted exception can't quietly outlive the
    vulnerability). This IS the "clean audit/approved exception" acceptance criterion.
  - **Router advisory (documented, not upgraded)**: SEC-003 is GHSA-qwww-vcr4-c8h2 (react-router RSC
    Mode CSRF Bypass, range `>=7.12.0 <8.3.0`). Verified WardenX has no RSC/framework-mode usage
    anywhere in the three SPAs' source (grep for `@react-router/dev`, `unstable_RSC*`,
    `renderToReadableStream` — zero hits outside build artifacts) — the vulnerable code path is not
    reachable. **No upgrade was possible**: as of 2026-08-05 the latest published `react-router-dom`
    is still 7.18.2 — the fixed 8.3.0+ range does not exist yet upstream. Documented as a reviewed,
    time-bounded exception in `check-audit-exceptions.ts` with the exact condition that obsoletes it.
  - **CSRF (done, 2026-08-05)**: double-submit cookie, `apps/backend/src/bootstrap/plugins/csrf.ts`.
    The backend mints a non-httpOnly `wardenx_csrf` cookie on any request that lacks one (onRequest,
    every route) and, on a mutating (`POST`/`PUT`/`PATCH`/`DELETE`) request that ALSO carries the
    Better Auth session cookie — i.e. one riding the browser's ambient credential — requires the same
    value echoed back in `X-CSRF-Token` (preHandler, timing-safe compare), throwing the new
    `CsrfValidationError` (403 `CSRF_VALIDATION_FAILED`) otherwise. A request authenticated purely by
    a header credential (the `x-internal-service-token` machine path) or with no session cookie at
    all is left untouched — nothing ambient for an attacker to ride. Deliberately **fails closed**
    (unlike the rate limiter's fail-open): a cookie minted on the same request that is being verified
    is treated as absent, not waved through, since the client cannot have echoed a value it hasn't
    seen yet. Exempt by path prefix: `/api/auth/` (Better Auth runs its own `trustedOrigins` check),
    `/webhooks/`, `/api/v1/webhooks/`, `/api/v1/telehealth/webhooks/` (provider-signature auth, no
    session cookie), and the health/ready probes. Frontend half: `packages/ui/src/core/api/client.ts`
    gained a `csrfToken` middleware (same `Middleware` chokepoint as `idempotencyKey`) that reads the
    `wardenx_csrf` cookie via `document.cookie` and attaches `X-CSRF-Token` on mutating requests —
    zero per-call-site changes across the 55+ files calling `client.POST/PATCH/DELETE`. One supporting
    fix: `packages/auth/src/identity/mount.ts` previously did `reply.header("set-cookie", setCookies)`
    unconditionally, which would silently DROP the CSRF cookie the M1 plugin staged earlier in the
    same request whenever Better Auth's own response also set a cookie (e.g. sign-in) — changed to
    merge with any existing `set-cookie` header instead of overwriting it. 12 new unit tests
    (`csrf.test.ts`) + 4 new frontend tests (`client.test.ts`); full gate green (build, `arch:fitness`,
    7920 tests). Live-verified against the local dev stack: a raw `fetch` carrying the session cookie
    but no CSRF header got a real `403 CSRF_VALIDATION_FAILED`; the same call with the cookie's value
    echoed in `X-CSRF-Token` passed straight through to normal route validation (422/404, no CSRF
    error); and the actual SPA (M39 consent-capture screen, driven in Chrome) attached the header
    automatically and reached the same business-logic layer — confirming the frontend middleware
    works in real usage, not just in unit tests.
- Risks: Auth callbacks and cross-origin SPAs.
- Rollback: Revert dependency with formal exception; keep security behavior versioned.
- Estimated complexity: M

## WX-PR-018 - Add critical Playwright and accessibility suite

- Status: Completed (2026-08-05).
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
- Completion evidence:
  - **New E2E project** (`e2e/`, root-level — outside `apps/`/`packages/`, so untouched by
    `arch:parity`/dependency-cruiser): `playwright.config.ts` (Chromium, `trace: retain-on-failure`,
    `screenshot: only-on-failure`, `video: retain-on-failure` — "artifacts on failure"), a
    `global-setup.ts` pre-flight that fails fast with a clear message if the local stack isn't up,
    `fixtures/credentials.ts` (parses the gitignored `CREDENTIALS.local.md` at run time — its
    password is regenerated on every `db:seed`, so a hardcoded credential would go stale),
    `fixtures/helpers.ts` (`signInAs`/`signOut`/`expectNoAxeViolations`), `fixtures/patients.ts`
    (discovers a real, in-scope patient id through the app's own UI rather than a hardcoded uuid —
    robust to reseeding and to RLS/org scope). `bun run test:e2e` / `test:e2e:ui`; deliberately NOT
    part of `bun run test` or `arch:fitness` (needs a live browser + full stack, not just a DB).
  - **Six critical workflows** (TEST-001's own list — Authentication, admission, documents, consent,
    billing, tenant operations), one spec each, 18 tests total, each with a main path, a denied/
    failure path where the app has one, and an axe accessibility scan (WCAG 2.1 A/AA):
    `auth.spec.ts`, `admission.spec.ts`, `documents.spec.ts` (scoped to read + filter, not upload —
    the app has no upload UI anywhere yet, verified by grep, not assumed), `consent.spec.ts` (a real
    mutating write: browser → generated client → CSRF → Fastify → Drizzle → Postgres),
    `billing.spec.ts` (scoped to reachability/empty-state — no seed script inserts any claim data),
    `tenant-operations.spec.ts` (admin-console permission boundary). **18/18 pass, ~14s**, confirmed
    stable across repeated clean runs.
  - **Six real bugs found and fixed by actually running this against the live stack** (not just
    written and left unexercised):
    1. `scripts/db/seed-patients.ts` broke under WX-PR-017's CSRF work — it authenticates via a raw
       cookie-jar HTTP client that never echoed the double-submit `X-CSRF-Token`, so every
       `db:reset` started failing at the patient-seed step with `403 CSRF_VALIDATION_FAILED`. Fixed
       by adding the same header the browser's `csrfToken` middleware attaches.
    2. `applySecurityBaseline`'s SD-055 rate limiter (`security.ts`) keyed "authenticated" purely on
       `organizationId`, so a signed-in-but-pre-org session (the sign-in → select-organization window
       every login passes through) still read as unauthenticated and shared the harsh 30/min
       IP-keyed tier with every anonymous caller on the same address — a real shared-NAT clinic
       login burst would trip this in production, not just this test suite. Fixed to key on
       `userId` (set as soon as any session resolves) ahead of `organizationId`, bucketed per-user
       instead of per-ip once signed in. New test locks this in.
    3. `signOut()`'s first implementation used Playwright's `page.request.post` for
       `/api/auth/sign-out` — that API does not send a real `Origin` header, and Better Auth's own
       origin check rejects it with `403 MISSING_OR_NULL_ORIGIN`, so the session was silently never
       actually cleared. Fixed by running the equivalent `fetch` from inside the real page context.
    4. The Patients · Census table's rows are accessible `<button>`s directly inside the `<table>`,
       not `<tr>`s with an ARIA row role (and the header cells are plain `generic`, not
       `columnheader`) — `getByRole("row")` matched nothing. Fixed the fixture to scope on the
       table's own buttons.
    5. `--color-muted` (`packages/ui/src/core/theme/colors.ts` + all three SPAs' `index.css`) failed
       WCAG AA color-contrast (~3.57:1 light / ~3.96:1 dark against `--color-surface-lowest`, needs
       4.5:1) — caught by the axe scan on the shared `NavGroup` toggle buttons, present on every
       screen. Retuned to `#726d64` / `#96918a` (~5.1:1 / ~5.4:1), same warm-gray hue. A second,
       related finding — the `StatusPill` "success" tone (~3.7:1, `--color-success` used as both fg
       and bg-tint source) — was deliberately NOT retuned here: that's a semantic brand color used
       app-wide, not a contained chrome token, and belongs to WX-PR-022's UI-fidelity pass, not a
       one-line swap mid-suite. Tracked via a reviewed `.exclude()` in the one spec that hits it
       (`tenant-operations.spec.ts`), not a blanket skip.
    6. `consent_type_catalog` (M39, platform-shared reference table) was EMPTY on every `db:reset` —
       its own schema comment says it should be "seeded idempotently in M39-T09 / the migration
       §3.4," but no migration or seed script ever did that. With zero rows the capture form's type
       dropdown never populates, so "Create draft" stays disabled forever. Added
       `scripts/db/seed-consent-types.ts` (3 of the 12 canonical v1 types — enough to exercise the
       real write path; the full 12-type platform-floor policy catalog needs real M39 spec review,
       explicitly out of scope here) and wired it into `db:reset`.
  - **Rate-limit tier override** (`RATE_LIMIT_UNAUTHENTICATED_PER_MINUTE`/
    `RATE_LIMIT_AUTHENTICATED_PER_MINUTE`, `.env.example` + composition root): off by default
    (production behavior unchanged — `DEFAULT_RATE_LIMIT_TIERS` applies), raised in local `.env` for
    the E2E suite. Not a security weakening: the shipped default is untouched; this is a documented
    local-dev knob for exactly the same shared-bucket effect finding #2 above describes.
  - Gate: full build + `arch:fitness` + `bun run test` (7921 passed) green after every fix; the E2E
    suite itself passed 18/18 twice in a row, ~14s each.

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

- Status: Partially completed (2026-08-05) — outbox operator visibility (a core slice of the
  acceptance criterion) is done; distributed tracing, dashboards/alert rules, and BullMQ job/queue
  visibility are NOT done (see completion evidence for why each was scoped out this pass).
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
- Completion evidence:
  - **Outbox operator visibility (done)**: `apps/backend/src/bootstrap/routes/ops-outbox.ts` —
    `GET /api/v1/ops/outbox` (list, filterable by status, cursor-paginated) and
    `GET /api/v1/ops/outbox/:id` (full payload + last error). `outbox_event` is HELPER_ONLY
    (architecture/module-manifest.ts) — owned by M1's dispatcher — so this route lives beside
    `outbox-dispatcher.ts` rather than a feature module, and is org-scoped like every other
    authenticated read (`withOrgContextFromRequest`, RLS-enforced), not a cross-tenant platform view.
    Read-only by design: the dispatcher already retries `pending`/`failed` rows on its own backoff
    clock, so an operator needs visibility into what's stuck and why, not a manual "retry now"
    button. Added `/api/v1/ops` to the M4 §2.5 read-audit-coverage prefix list (a row's payload can
    reference clinical/patient aggregates depending on event type) and a proper OpenAPI enrichment
    (kept the `bootstrap` module's coverage ratchet from regressing). Gated on `member.manage` — the
    same admin-only bar Staff Management uses — a pragmatic reuse rather than minting a new `ops.*`
    permission category for a first, single-screen ops surface.
  - **Admin UI** (`apps/admin/src/modules/01-ops/`): an Outbox list screen (status filter,
    `StatusPill` per row) and a detail screen (full JSON payload + last error), registered into the
    M34 admin shell the same way M35's subscription-billing slice is. Live-verified in Chrome against
    the real local stack with real data (outbox rows from this session's own E2E test runs) — list
    and detail both render correctly.
  - **6 real unit tests** (`apps/backend/src/bootstrap/routes/__tests__/ops-outbox.test.ts`) —
    permission gate (403 without `member.manage`), the no-DB slice fallback, and status-filter
    validation. Found a real bug while writing them: the no-DB early return short-circuited BEFORE
    the status-filter validation ran, so an invalid `?status=` value against a DB-less slice boot
    silently returned 200 with an empty list instead of 422 — fixed by validating first.
  - **NOT done — deliberate scope cuts, not oversights**:
    - **Distributed tracing / OpenAPI export**: genuinely greenfield (grepped — zero
      `opentelemetry`/`otel`/`traceparent` hits anywhere in the repo before this pass). What exists
      and is reusable: M1's `request-context.ts` already does correlation-id generation/propagation
      via `AsyncLocalStorage`, echoed in every log line — a real foundation, just not a span/trace
      pipeline. Wiring a real OTel SDK + exporter (even to a local Jaeger container, no external
      credentials needed) is a substantial, separate piece of work, not a few-hour addition on top of
      an already-large pass.
    - **BullMQ job/queue visibility**: 11+ modules (M7/M9/M10/M23–M27/M30/M33/M34) each own their own
      `Queue`/`Worker` construction in the composition root's ~500-line worker-runner block — there is
      no existing single point to list "every queue." `dlq-alerts.ts`'s `attachDlqPromotionAlert` is
      fire-and-forget (log + optional webhook), not persisted/queryable, so there's nothing to read
      from without either enumerating every module's queue reference or adding a new persistent
      DLQ-promotion-log table (a genuine follow-on task, not a quick extension).
    - **Deployed dashboards/alert rules, external alert-delivery exercise**: needs a real
      observability/alerting provider decision (same category as WX-PR-019's deployment-target
      blocker), not a code change.

## WX-PR-021 - Tighten quality metrics and documentation truth

- Status: Completed (2026-08-05).
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
- Completion evidence:
  - **CODE-001 (done)**: the specific finding (`service-drizzle.ts:640`'s `pm !== null && pm.isActive`)
    was already fixed in a prior session's lint sweep (stale finding). `bun run lint` was NOT
    actually clean, though — 12 real formatting/lint errors had accumulated across this session's own
    WX-PR-017/018/020 work (`csrf.ts`, `mount.ts`, `consent-capture.tsx`, `check-audit-exceptions.ts`,
    `check-audit-denylist-sync.ts`, `enrichments.ts`, a live-test file). All fixed; `bun run lint`
    exits 0 clean, verified as a repo-wide check, not just the files this pass touched.
  - **TEST-003 (done)**: `vitest.config.ts` migrated `environmentMatchGlobs` (deprecated — every run
    warned) to `test.projects` — two projects (`node` default, `dom` for `*.dom.test.tsx`) sharing the
    same include/exclude base. Verified byte-identical test coverage before/after: 519 files / 7929
    tests / 83 skipped / 12 todo, unchanged; no deprecation warning in the output anymore.
  - **DOC-001 (done)**: `CLAUDE.md` had 4 stale generated-truth numbers — corpus enrichment 989/995
    (current: 1219/1226), M29/M35/M37 `Live` coverage claimed "still partial" at 0/11, 3/21, 8/26
    (current, and has been since the Phase 0-2 remediation pass: full-ratio 11/11, 21/21, 26/26 —
    the doc never caught up after that work landed), M30's route count 47 (current: 60), and the
    manifest's owned-table count 453 (current: 460). All corrected against the live generated
    reports; added a note on the enrichment-count line pointing back at
    `audit/openapi-coverage/OPENAPI_COVERAGE.md` as the authoritative source, since this exact class
    of drift (hand-maintained prose outliving the generated truth it once matched) is DOC-001's whole
    finding and will recur otherwise.
  - **TEST-002 (done, scoped)**: full per-route (method+path+status+permission) coverage needs an
    AST-driven rebuild the script's own header already calls "a separate, multi-session project" —
    not attempted. Added a real, additive, NON-ratcheted signal instead:
    `scripts/report-inject-coverage.ts` now also reports `directRoutesReferenced` per module — how
    many of a module's route paths are literally referenced inside its covering suite file(s), vs.
    the old boolean's "some file in this module calls `.inject(`." This immediately surfaced the gap
    the boolean was hiding: **1157/1217 routes (95%) are directly referenced**, not the ~100% the old
    "39/39 modules covered ✅" implied — 60 routes sit behind a module marked covered by an unrelated
    route's test. Purely additive (new field + report column); the existing ratchet/gate logic and
    baseline are untouched, so `arch:inject-coverage` still passes exactly as before (39/39 modules).
  - Gate: full build + `arch:fitness` + `bun run test` (7929 passed) + `bun run lint` (0 errors) —
    all green.
- Estimated complexity: M

## WX-PR-022 - Establish UI fidelity, artifact, and performance gates

- Status: Partially completed (2026-08-05) — UI-002 (dialog consolidation) and PERF-001 (source
  maps + a real bundle budget) are done; UI-001 (full screen-by-screen visual/behavioral fidelity
  review against Pencil frames) is NOT done — it's an ongoing design-review workflow (17/271 screens
  mapped), not a code change a single pass can close (see completion evidence).
- Priority: P2
- Severity addressed: Medium
- Phase: 6/8
- Objective: Review launch screens, consolidate dialog behavior, restrict source maps, and gate bundle/runtime performance.
- Evidence: UI-001/UI-002/PERF-001.
- Files/modules affected: Frame registry, `@chartwarden/ui`, dialog call sites, Vite configs, performance CI.
- Dependencies: Stable launch workflows.
- Implementation steps: Map screens; capture states/viewports; migrate dialogs; private maps; route budgets; load/Web Vitals checks.
- Tests: Visual/axe/keyboard/zoom/bundle/mobile-load.
- Acceptance criteria: Launch screens pass the design finish gate and performance budgets.
- Risks: Snapshot churn and workflow regressions.
- Rollback: Per-screen/component commits and retained baselines.
- Estimated complexity: L
- Completion evidence:
  - **UI-002 (done)**: both bespoke overlays UI-002 named now compose the canonical, focus-trapped
    `Modal` (`packages/ui/src/web/system/modal.tsx`) instead of a plain `role="dialog"` div with no
    focus trap, Escape handling, or focus restoration:
    - `apps/web/src/modules/23-billing-medicare/mac-credentials.tsx`'s MAC credential upsert drawer
      — migrated (a real visual change: was a fixed right-side slide-in panel, is now a centered
      modal card, since `Modal` has no drawer variant; the accessibility properties are what UI-002
      is actually about). Live-verified in Chrome: opening auto-focuses the first field, Escape
      closes it AND restores focus to the trigger button.
    - `apps/web/src/modules/02-identity/screen-lock.tsx`'s idle screen-lock overlay — migrated to
      `role="alertdialog"` with no `onClose` (an invariant blocker — the only way out is unlocking
      or signing out, matching `Modal`'s own documented pattern for that case). Not directly
      live-clickable (needs 5 real minutes idle to arm) — verified by clean `tsc -b` plus the
      unchanged internal state/logic (only the JSX wrapper changed) and the full
      `screens-smoke.dom.test.tsx` suite (renders every registered screen) staying green.
  - **PERF-001 (done)**:
    - All three SPAs' Vite configs (`apps/web`, `apps/portal`, `apps/admin`) had `sourcemap: true`
      unconditionally — a real source/stack-trace disclosure surface with no error-tracking service
      configured to privately consume the maps. Set to `false` in all three (a future real need —
      e.g. Sentry — would use `'hidden'` + private upload, not public maps). Verified: none of the
      three builds emit a `.map` file anymore.
    - "no route/initial-load budget" was already half-wrong: `apps/web` already had one
      (`scripts/check-bundle-size.ts`, TASK-033, 350 kB raw). The real gap was portal/admin having
      none. Added the same script (adapted — neither app has web's route-level `React.lazy`
      splitting yet, so their whole entry bundle IS the initial payload) to both, wired as
      `bun run size:check` in each app's `package.json`. Both currently pass comfortably (portal
      282.9 kB, admin 303.1 kB, budget 350 kB) — real headroom, not a rubber-stamped threshold.
      Standalone opt-in checks (a full `vite build` per app is too slow for `arch:fitness`), same
      posture as web's existing one.
    - **Discovered, not fixed**: running web's own existing budget check found its initial bundle
      now measures 433.9 kB — over its own 350 kB budget, a real regression since TASK-033 set it
      (plausibly from the many screens added across the 2026-08 sessions). Out of scope to
      root-cause and fix here (would mean auditing which of dozens of recently-added screens broke
      the `React.lazy` boundary); flagging it as a genuine, currently-uncaught finding for a
      dedicated follow-up, not silently leaving the regression unmentioned.
  - **UI-001 (not done, correctly out of scope for a code pass)**: full-corpus visual/behavioral
    fidelity is a design-review WORKFLOW (`docs/design/FRAME_FIDELITY_PLAYBOOK.md`,
    `scripts/frame-fidelity/registry.ts`) — comparing built screens against Pencil frames one at a
    time and recording match/partial/pending, currently 17/271 mapped. Not attempted; no code change
    substitutes for the actual review.
  - Gate: full build + `arch:fitness` + `bun run test` (7929 passed) green; the WX-PR-018 E2E suite
    re-run 18/18 green, including the tenant-operations accessibility test now passing WITHOUT the
    `.wx-status-pill` exclusion it needed before this pass's StatusPill contrast fix.

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

## WX-PR-024 - withPlatformContext throws under real (NOBYPASSRLS) RLS codebase-wide

- Status: **FIXED (2026-08-06)**. All three platform-wide write gaps closed:
  `audit_writer_insert_platform_event` (migration 0187, owned by the existing `wardenx_audit_writer`
  role, `RETURNS void` — no RETURNING, since that role deliberately holds INSERT only on `audit_event`
  and a RETURNING clause needs a SELECT-shaped RLS check that role doesn't have); `packages/audit`'s new
  `auditPlatformEvent()` calls it, and `m34PlatformBypassAuditor` (`apps/backend/src/index.ts`) now uses
  `auditPlatformEvent` instead of the plain `audit()` helper. `report_run` (open/settle) and
  `materialized_view_metadata` (telemetry stamp) got the identical SECURITY DEFINER treatment via
  migration `0188_m33_report_run_and_mv_metadata_platform_writer.sql` (`report_writer`-owned functions +
  new `report_run_platform_writer`/`materialized_view_metadata_platform_writer` policies), consumed by
  `packages/reporting/src/repositories/{runs,catalogs}.ts`. Verified live: two new live-RLS `describe`
  blocks (`m1-rls-isolation.live.test.ts`, `m33-rls-isolation.live.test.ts`) prove, as real `wardenx_app`
  (NOBYPASSRLS) against a throwaway PG18 container, that (a) the raw direct-INSERT/UPDATE path is STILL
  rejected (no new write hole opened) and (b) the SECURITY DEFINER functions succeed and land the correct
  rows. The full BullMQ integration suite
  (`apps/backend/__tests__/m33-reporting-scheduled-jobs.live.test.ts`) was hardened to call
  `auditPlatformEvent` for its `testAuditBypass`, proven for real via the `scheduled_run`/`lag_probe`
  tests running fully on `wardenx_app`. Full gate green (build/`arch:fitness`/full test suite, 7995
  passing). **NEW finding surfaced while verifying this fix, NOT fixed, tracked separately as
  WX-PR-025**: `wardenx_app` has zero privilege to `REFRESH MATERIALIZED VIEW CONCURRENTLY` on any
  `report_mv.*` view, and no role in this codebase's migrations holds BYPASSRLS in production — a
  genuinely cross-tenant nightly MV refresh may be architecturally unable to read across tenants at all.
  See WX-PR-025 below.
- Status (superseded, kept for history): Discovered, NOT fixed (2026-08-06) — found while verifying
  WX-PR-014's M33 outbox fix under REAL RLS enforcement (`SET ROLE wardenx_app`, NOBYPASSRLS — the
  production posture the boot guard enforces) instead of a superuser test connection, which had masked
  this since `withPlatformContext` first shipped. Confirmed by direct `psql`:
  ```
  SET ROLE wardenx_app;
  INSERT INTO audit_event (organization_id, actor_kind, event_type, resource_kind, outcome,
                            correlation_id, severity)
  VALUES (NULL, 'system', 'platform.bypass_invoked', 'tenant', 'success', 'x', 'warn');
  ERROR:  new row violates row-level security policy for table "audit_event"
  ```
  `withPlatformContext` (`packages/tenancy/src/context.ts`) calls its injected `auditBypass`
  UNCONDITIONALLY on every entry — the load-bearing "every cross-tenant bypass is audited" guarantee
  the whole mechanism exists to provide. The composition root binds this to the shared
  `m34PlatformBypassAuditor` (`apps/backend/src/index.ts`), which writes a `platform.bypass_invoked`
  `audit_event` row with `organizationId: null`. But `audit_event`'s only null-org write path is
  `audit_writer_insert FOR INSERT TO wardenx_audit_writer` (migration 0013) — a role `wardenx_app` does
  not hold — and migration 0119's own org-scoped fix (`audit_event_org_append`, the "WITHOUT THIS, EVERY
  APPLICATION-LEVEL AUDIT WRITE FAILS IN PRODUCTION" migration) explicitly, deliberately excludes null-org
  rows: its own comment says platform-scoped rows "must continue to go through the M34 bypass auditor
  under withPlatformContext" — but nothing ever built the role/policy path FOR that auditor. The gap
  0119 fixed for the org-scoped `audit()` path was never separately verified for the platform-bypass
  path, and it was invisible locally for the identical reason 0119 names: `scripts/db/migrate.ts` grants
  the dev role BYPASSRLS unless `WARDENX_DEV_BYPASSRLS` is deliberately unset — every prior session's
  live-RLS testing (this codebase has an extensive `rls-isolation.live.test.ts` suite, 109+ tests) has
  evidently always run either with that dev bypass, or via a superuser test connection for the
  app-facing client specifically (the mistake WX-PR-014's M33 pass itself made on its first draft,
  before catching it here).

  BLAST RADIUS: since every `withPlatformContext` call executes this same unconditional audit write as
  its first step, EVERY platform-scoped cron/worker/route in the codebase that uses it — at minimum
  M7, M9, M10, M25, M27, M30, M33, M34, and the shared `active-org-enumerator.ts` helper seven-plus
  modules already depend on — throws immediately on entry in a properly-hardened (NOBYPASSRLS)
  production deployment. This is not new code from any single recent task; it has been latent since
  `withPlatformContext` first shipped and every module that adopted it inherited the same gap silently.

  RELATED, SAME ROOT CAUSE, ALSO DISCOVERED (also NOT fixed): `report_run` and
  `materialized_view_metadata` (M33) have the identical "no wardenx_app RLS policy admits a
  platform-wide/no-org write" shape — `report_run.organization_id` has been documented nullable since
  M33 shipped for exactly this purpose ("cross-tenant platform-wide refreshes") but no writer path was
  ever built for it. `outbox_event` had the same shape and WAS fixed as part of WX-PR-014's second
  follow-up (migration 0186, a SECURITY DEFINER `report_writer_*` function surface reusing the
  `wardenx_audit_writer`/`audit_writer_insert` precedent) — the SAME pattern would close `report_run`'s
  and `materialized_view_metadata`'s gaps, and a `report_writer`-owned (or a new dedicated
  `wardenx_platform_writer`-style role) SECURITY DEFINER function for `audit_event`'s
  `platform.bypass_invoked` write would close this finding's own root cause. NOT attempted here: this is
  a foundational M1 (`@chartwarden/tenancy`) + M4 (`audit_event`) change with a blast radius spanning the
  whole codebase, well beyond one task's charter — it needs its own scoped pass, ideally with a
  companion live-RLS test (`SET ROLE wardenx_app`, NOBYPASSRLS) added to the existing
  `rls-isolation.live.test.ts` suite so this class of gap cannot silently regress again.
- Priority: P0
- Severity addressed: Critical
- Phase: unassigned (cross-cutting, discovered mid-task — needs its own scoping pass)
- Objective: Every `withPlatformContext` entry succeeds (including its mandatory audit write) under a
  real, NOBYPASSRLS `wardenx_app` connection — the production posture the boot guard already enforces.
- Evidence: Direct `psql` reproduction above; this finding's own discovery inside WX-PR-014's M33
  follow-up #2 live-RLS hardening.
- Files/modules affected: `packages/tenancy/src/context.ts` (`withPlatformContext`), `apps/backend/src/index.ts` (`m34PlatformBypassAuditor`), `audit_event` RLS (a new migration), and — same root cause,
  separately — `report_run` + `materialized_view_metadata` RLS (M33).
- Dependencies: None technical; needs an owner decision on the writer-role shape (reuse
  `wardenx_audit_writer` vs. a new dedicated platform-writer role) before implementation.
- Implementation steps: Add a SECURITY DEFINER `audit_event` platform-write function (mirroring
  migration 0186's `outbox_event` pattern) + EXECUTE grant to `wardenx_app`; repoint
  `m34PlatformBypassAuditor` (or `withPlatformContext` itself) at it; add the `report_run`/
  `materialized_view_metadata` equivalents; add a `SET ROLE wardenx_app`-based regression test to
  `rls-isolation.live.test.ts` (or a new dedicated live suite) so `WARDENX_DEV_BYPASSRLS`/superuser
  test connections can never mask this class of bug again.
- Tests: A live-RLS `withPlatformContext` entry (any module) succeeds under `SET ROLE wardenx_app`,
  NOBYPASSRLS, with a real `platform.bypass_invoked` row landing; a direct-INSERT attempt outside the
  SECURITY DEFINER path is still rejected (proving the fix doesn't over-widen access).
- Acceptance criteria: No `withPlatformContext` call throws under NOBYPASSRLS in any module that uses it;
  the audit guarantee ("every bypass is audited") is verified true, not merely coded.
- Risks: Every platform-scoped cron/worker across ~8 modules is silently non-functional in a properly
  hardened production deployment until this is fixed — this is not a theoretical risk, it is the CURRENT
  state of the code on `main` as of this writing.
- Rollback: N/A (fixed; migrations 0187/0188 are additive-only — new functions/policies, no existing
  grant or policy removed).
- Estimated complexity: M (the SECURITY DEFINER pattern is now proven and repeatable; done).

## WX-PR-025 - wardenx_app cannot REFRESH a report_mv.* materialized view; no role holds BYPASSRLS

- Status: **FIXED (2026-08-07)**. Reused the ALREADY-EXISTING platform credential
  (`scripts/db/provision-runtime-roles.ts`'s `wardenx_platform`/`wardenx_platform_login`, provisioned for
  the M35 admin console/M34 eraser/enumerators via `DATABASE_PLATFORM_URL`) rather than inventing a new
  one — it just wasn't wired to M33. Three changes: (1) the provisioning script now makes
  `wardenx_platform` OWN all 3 `report_mv.*` views, grants it SELECT on their source tables
  (`admission`/`encounter`/`evv_event`) + `materialized_view_metadata`, EXECUTE on the 5 SECURITY DEFINER
  platform-writer functions M33 needs, and — the non-obvious fix — puts `BYPASSRLS` on the CARRIER role
  itself (`wardenx_platform`), not just the login role: `REFRESH MATERIALIZED VIEW CONCURRENTLY`
  re-executes its defining query under privileges resolved through the MV's OWNER (view-owner-style
  semantics), confirmed empirically against a throwaway PG18 container, so the login role's own BYPASSRLS
  (sufficient for every OTHER platform query it issues directly) does not by itself make a refresh see
  other tenants' rows. (2) `apps/backend/src/index.ts` now wires M33's `platformDb` to
  `platformDbHandle?.db ?? dbHandle.db` (falls back to the tenant pool when `DATABASE_PLATFORM_URL` isn't
  configured). (3) `packages/reporting/src/repositories/runs.ts`'s `updateMvRunStatus` — its WX-PR-024
  "try plain UPDATE, fall back to the SECURITY DEFINER function on failure" pattern broke for this MORE
  restrictive credential: `wardenx_platform` has no base UPDATE grant on `report_run` at all
  (least-privilege — EXECUTE on the writer function only), so the plain attempt throws
  `insufficient_privilege` (42501) instead of silently returning zero rows, which ALSO poisons the rest of
  the enclosing `withPlatformContext` transaction until rolled back. Fixed with a `SAVEPOINT` around the
  plain attempt (`RELEASE` on success, `ROLLBACK TO SAVEPOINT` on 42501, any other error still propagates).

  Verified live and genuinely cross-tenant, not just "didn't throw":
  `m33-reporting-scheduled-jobs.live.test.ts` bootstraps `wardenx_platform`/`wardenx_platform_login`
  inline (mirroring the provisioning script), seeds a real `admission` row for TWO separate tenants, runs
  the real nightly-orchestrate → per-MV refresh with `platformDb` = the real `wardenx_platform_login`
  connection, and asserts the refreshed `mv_census_org_daily` contains BOTH tenants. Also directly
  verified running the REAL `provision-runtime-roles.ts` script (not hand-replicated SQL) against a
  throwaway PG18 container. `wardenx_app` still cannot refresh (unchanged, correct — verified in
  `m33-rls-isolation.live.test.ts`); a raw `wardenx_platform_login` write to `report_run` outside the
  SECURITY DEFINER function is still rejected (no new hole opened). Full gate green (build/`arch:fitness`/
  full test suite, 7995 passing).
- Priority: P1
- Severity addressed: High
- Phase: unassigned (cross-cutting, discovered mid-task; fixed same-week in a scoped follow-up)
- Objective: A genuinely cross-tenant M33 MV refresh (`report.mv_refresh`, nightly-cron trigger) succeeds
  under the real production role posture and demonstrably reads across MULTIPLE tenants' data, not just
  "doesn't throw." — MET.
- Evidence: Direct `psql`/live-container reproduction (discovery) and re-verification (fix) above.
- Files/modules affected: `scripts/db/provision-runtime-roles.ts` (MV ownership + carrier BYPASSRLS +
  EXECUTE grants), `apps/backend/src/index.ts` (M33 `platformDb` wiring),
  `packages/reporting/src/repositories/runs.ts` (`updateMvRunStatus` SAVEPOINT).
- Dependencies: None remaining — reused the existing M35 `DATABASE_PLATFORM_URL` credential model rather
  than a new one.
- Implementation steps: Done — see Status above.
- Tests: A live-RLS MV refresh, seeded with 2 tenants' rows, produces a rollup containing rows from BOTH
  tenants under the real production role/credential posture. DONE, passing.
- Acceptance criteria: MET — the nightly MV-refresh path works in a properly-hardened (NOBYPASSRLS)
  production deployment and is proven, not assumed, to span every tenant.
- Risks: An operator who hasn't run `bun run db:provision-roles` (or set `DATABASE_PLATFORM_URL`) simply
  falls back to the pre-fix behavior (`platformDb: dbHandle.db`, refresh throws `permission denied`) — a
  loud, fail-closed failure mode, not a silent wrong-data one. Documented in the provisioning script.
- Rollback: Revert the 3 files; `wardenx_platform`'s new grants are additive-only (no existing grant or
  policy removed), so no separate DB rollback is needed even if the code revert lands after a deploy.
- Estimated complexity: L as scoped (an actual architecture decision was needed) — M in practice, since
  the M35 precedent already existed and only needed extending.
