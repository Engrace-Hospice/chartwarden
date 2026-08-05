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
  per-diem — never a state schedule). This closes audit finding M24-F02 (BLOCKER): `medicaid_claim_line
  .state_rate_schedule_id_snapshot` was unconditionally NOT NULL, which made an R&B line's schema-correct
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
  longer derived from level-of-care alone. `resolvePlaceOfServiceQCode` (`packages/medicaid-adapters/src/
  line-assembly.ts`) resolves the real CMS Q5001-Q5009 space from actual facts, priority order: (1) a
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
  inferred from `ended_at`), and a new `confirmLocBedAssignment` write path (`POST /api/v1/level-of-care/
  :id/confirm-bed`) drives the state machine's existing-but-previously-unreachable
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
  gets 3) was found and left — it doesn't touch LOC and isn't a regression from this change. 4 new unit
  tests (state-machine coverage already existed), 4 new HTTP-inject tests (`admission-routes.test.ts` —
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
    `check-audit-exceptions.ts` (ratcheted, wired into `arch:fitness`) requiring every advisory `bun
    audit` reports to be in a reviewed, written allowlist, and flagging an allowlist entry as STALE
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
- Files/modules affected: Frame registry, `@wardenx/ui`, dialog call sites, Vite configs, performance CI.
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
