# 14 — Task Backlog

**0Audit date:** 2026-08-03. Implementation-ready tasks derived from the roadmap. Each is scoped for a focused session where practical. IDs are stable and cross-referenced from the finding reports.

---

## TASK-001 — Boot assertion: no in-memory store bound on a DB boot

- Priority: P0 · Severity addressed: Critical · Phase: 0/1
- Objective: fail boot (not requests) if, with `deps.db` present, any registered seam/eraser/audit impl is backed by a `createInMemory*` store.
- Evidence: ARCH-003/006/007/015; `index.ts:561,1141-1157`, `03-authorization/index.ts:108-109`.
- Files: `apps/backend/src/index.ts`, `bootstrap/seams/registry.ts`, `bootstrap/erasers/registry.ts` (tag in-memory stores with a brand symbol; assert in `onReady`).
- Tests: boot with a fake db + one in-memory registrar → boot throws naming the registrar.
- Acceptance: assertion is part of `arch:fitness` or boot; a planted in-memory binding fails.
- Risk: surfaces the full breadth of Phase 1 work. Rollback: feature-flag the assertion to warn-only for one iteration.
- Complexity: S.

## TASK-002 — Bind Drizzle stores into every seam registrar

- Priority: P0 · Severity: Critical · Phase: 1
- Objective: pass `{db}`/the module's Drizzle store to `registerCarePlanSeams`, `registerAssessmentSeams`, `registerOrderSeams`, `registerDoseSpotSeams`, `registerEmarSeams`, `registerIdgSeams`, `registerSchedulingSeams`, `registerEvvSeams`, `registerDocumentSeams`, and the M5/M6/M10 partial cases (`PatientReader`/`PatientMutator`, admission readers, HOPE readers).
- Evidence: ARCH-003. Pattern to copy: M8 `createDrizzleEncounterReaderStore` (`index.ts:557`), M21 (`:696`).
- Tests: `getSeam("PatientReader").findById` returns a row written via M5 routes; M18 EVV seams read real visits.
- Acceptance: zero argument-less `register*Seams()` for db-backed modules; TASK-001 green.
- Risk: M22 document object store needs a real storage adapter (`SignedUrlStoragePort` has no `src/` impl) — bind a `DegradedError` refusal until it exists, not a Map.
- Complexity: L.

## TASK-003 — Bind Drizzle erase stores into every eraser registrar

- Priority: P0 · Severity: Critical · Phase: 1
- Objective: pass `{db}`-backed erase stores to the 25 registrars called argument-less in `wireModuleErasers` (identity, admission, care-plan, encounter, assessment, hope, orders, dosespot, emar, idg, documents, billing, remittance, medicaid, cap, reporting, quality, cost-report, saas, terminology, messaging, mdm, consent, audit, patient).
- Evidence: ARCH-007; `index.ts:1141-1181`. Pattern: M15/M16/M28 (`deps.db ? {store: createDrizzle…} : {}`).
- Tests: erase a seeded patient subtree → real rows deleted, non-zero certificate.
- Acceptance: store-less erasers refuse on a db boot (TASK-001).
- Complexity: M.

## TASK-004 — Wire the M3 effective-permission resolver into the route mount

- Priority: P0 · Severity: Critical · Phase: 1
- Objective: replace `_fixedPerms([])` with a `createDbEffectivePermissionStore(deps.db)` adapter in `mountAuthorizationRoutes`; delete the route-local `ActorPermissionResolver` abstraction in favor of the live contract seam.
- Evidence: ARCH-015; `03-authorization/index.ts:108`.
- Tests: `GET /me/permissions` non-empty for a seeded admin; an org_admin grants a role live.
- Acceptance: gate 7 partially restored; role editor (TASK-030) becomes possible.
- Complexity: M.

## TASK-005 — Bind `audit: db` on the M3 and M4 route mounts

- Priority: P0 · Severity: Critical · Phase: 1
- Objective: replace `createInMemoryAuditExecutor()` with the Drizzle audit sink (the M2 fix) at `03-authorization/index.ts:109` and `04-audit/index.ts:78`; wire M3 engagement/notifier stores to Drizzle or fail closed.
- Evidence: ARCH-006. Tests: a role grant and an audit-search each produce a durable `audit_event` row. Complexity: S.

## TASK-006 — Build the transactional-outbox dispatcher

- Priority: P0 · Severity: Critical · Phase: 1
- Objective: a polling relay (`SELECT … WHERE status='pending' … FOR UPDATE SKIP LOCKED`), attempt counting + exponential backoff, DLQ after N, a retention purge, and a process/entry point; wire the deferred M22/M33/M14 consumer bindings.
- Evidence: OPS-001; `outbox-persister.ts`, `22-documents/outbox-consumers/bindings.ts:40`.
- Tests: an emitted event reaches a registered consumer; pending depth bounded.
- Acceptance: no unconsumed `pending` growth; a liveness test in CI.
- Risk: coordinate with the worker-topology task (TASK-040). Complexity: L.

## TASK-007 — FORCE-RLS resweep + zero-policy platform tables (migration 0154)

- Priority: P0 · Severity: High · Phase: 2
- Objective: a forward migration re-running 0118's idempotent catalog sweep (FORCE every RLS table) **and** adding `TO wardenx_admin`/`tenant_platform_writer` policies to the 11 zero-policy platform tables — in one migration so the owner path never breaks.
- Evidence: DB-002, DB-004; only 0118/0120/0139 contain FORCE; M28/M35/M37 enable-without-force verified.
- Tests: `SELECT count(*) FROM pg_class WHERE relrowsecurity AND NOT relforcerowsecurity` = 0; the `rls-isolation.live.test.ts:2317` invariant passes on a full replay; Stripe webhook ingest works as a non-owner role.
- Acceptance: gate 8 progresses. Risk: never edit applied migrations — forward only. Complexity: M.

## TASK-008 — Externalize the M13 witness signing key

- Priority: P0 · Severity: High · Phase: 2
- Objective: `M13_WITNESS_SIGNING_KEY` (≥32 bytes) read at boot, added to `bootstrap/env.ts` REQUIREMENTS; dev fallback gated on `NODE_ENV !== "production"`; shared-store single-use burn when clustered.
- Evidence: SEC-001; `emar-route-service-db.ts:75`. Tests: prod boot fails without the key; dev-key token rejected in prod. Complexity: S.

## TASK-009 — Widen the PHI read-audit perimeter to the clinical core, portal, IPU, FHIR

- Priority: P0 · Severity: High · Phase: 2
- Objective: annotate M6–M14/M17/M18/M22 + M31 + M37 GET handlers with `config.auditRead`; add their prefixes to `DEFAULT_READ_AUDIT_PREFIXES`; add `/api/v1/fhir` with disclosure-envelope waivers; flip `read-audit-coverage.test.ts:137` to a positive assertion.
- Evidence: SEC-002/API-004; `bootstrap/index.ts:117-155`. Acceptance: every mounted PHI GET prefix governed; boot fails on a new unannotated PHI read. Complexity: M.

## TASK-010 — Complete production env validation

- Priority: P1 · Severity: High · Phase: 2
- Objective: add `REDIS_URL`, `DATABASE_PLATFORM_URL`, `PASSKEY_RP_ID`/`WEBAUTHN_RP_ID`, `MESSAGING_ENCRYPTION_KEY`, cursor keys, `TRUSTED_PROXY_CIDRS`, and the witness key to `bootstrap/env.ts`; fix the `localhost` passkey fallback.
- Evidence: SEC-005/OPS-010. Tests: prod boot with only today's 6 vars fails closed. Complexity: S.

## TASK-011 — Author M29 and M35 live-RLS suites; add all missing CI matrix rows

- Priority: P1 · Severity: High · Phase: 2/7
- Objective: create `m29-`/`m35-rls-isolation.live.test.ts` (clone m26); add `test:rls:live:{m28,m29,m31,m35,m37}` scripts and ci.yml matrix rows; generate the matrix from `package.json`.
- Evidence: DB-003, TEST-002, OPS-014. Acceptance: Live column full-ratio for 40 modules; every live suite has a CI row. Complexity: M.

## TASK-012 — Split the cosignature ABAC predicate three ways

- Priority: P0 · Severity: Critical · Phase: 3
- Objective: namespace to `m8.cosigner_role_match` / `m9.` / `m11.` (M37 pattern); update the three consumer routes; make the registrar throw (not skip) on a same-name-different-resolver collision.
- Evidence: ARCH-001/002. Tests: RN cosigns an assessment and an order live; a duplicate-name registration fails the gate. Complexity: M.

## TASK-013 — Assemble `providerEntityIds`, `locationIds`, `actorKind`

- Priority: P0 · Severity: High · Phase: 3
- Objective: return membership→provider-entity + location bindings from `resolveActor`/`ActorEnrichment`; stamp them in `authenticate.ts`; add a machine-credential path stamping `actorKind:"system"`.
- Evidence: ARCH-008/009, SEC-004, API-001. Tests: a billing_manager submits a PE-scoped claim; an M20 check-in succeeds; M14 IDG CRUD works; internal system routes reachable only by a real system credential. Complexity: L.

## TASK-014 — Teach `check-table-ownership` the `schema.<table>` style; triage the ~35 escapes

- Priority: P1 · Severity: High · Phase: 3
- Objective: recognize `schema.<ident>` member access (camelCase→snake_case) regardless of import spelling; route M18→M17 `visit` and M30→M3 `role`/`membership_role` through seams or explicit exemptions.
- Evidence: ARCH-017. Tests: the gate flags a synthetic `schema.visit` read from M18. Complexity: M.

## TASK-015 — Register M31's three cast-resolved seams; tighten `check-fitness-gaps`

- Priority: P1 · Severity: High · Phase: 3
- Objective: add `PatientCaregiverReader`/`PatientAddressReader`/`ExternalGriefResourceReader` to `SeamName`/`REQUIRED_SEAMS` with real impls or deny-stubs; delete the `getSeam` cast; make the gate trust only canonical `REQUIRED_SEAMS` and scan aliased getSeam forms.
- Evidence: ARCH-018. Acceptance: the bereavement-resources route returns real data or 501; the gate flags an unregistered portal seam. Complexity: M.

## TASK-020 — Idempotency-Key + If-Match middleware in the shared client; fix the OpenAPI emitter

- Priority: P0 · Severity: Critical · Phase: 1/4
- Objective: teach `scripts/openapi/emit.ts` a `headers` field + `status` (200/201/202/204) in the enrichment shape; add idempotency-key/If-Match handling to `packages/ui/src/core/api/client.ts`; tighten the ratchet to flag body-less mutations.
- Evidence: PARAM-001/002, FLOW-008, API-006. Tests: openapi declares If-Match on every `requireIfMatch` route; a claim submit sends the key. Complexity: M.

## TASK-021 — Repair the M23 claim write workflow

- Priority: P0 · Severity: Critical · Phase: 4
- Objective: a "Re-run validation" action; make override trigger/require a re-run; fix replace/void payloads (reason ≥20 + `ifVersion`); pass step-up through or route to `/step-up?returnTo=`; handle 401/403; wire cursors; persist wizard state.
- Evidence: FLOW-008; depends on TASK-020. Tests: assemble→validate→override→re-validate→submit; replace/void succeed. Complexity: L.

## TASK-022 — De-cast the web/admin API layer to generated types

- Priority: P1 · Severity: High · Phase: 1/6
- Objective: remove the ~275 `as never`/`as unknown as` casts in `19-oncall`/`21-supplies`/`16-bereavement`/`20-field-safety` api files + admin M35 screens; drive types from `packages/ui/src/core/api/schema.ts`.
- Evidence: TYPE-001; depends on TASK-020 (headers). Acceptance: zero such casts in those files; `client:check` green. Complexity: M.

## TASK-030 — Onboarding: transactional email sender + set-password/MFA flow + role editor

- Priority: P0 · Severity: Critical · Phase: 4
- Objective: wire a transactional sender (or admin-visible invite link); build set-password/verify-email/MFA-enroll; add a per-member role editor calling the audited `authz-routes` (unblocked by TASK-004); pending-invite list with rescind/resend; remove the false "Invitation sent".
- Evidence: FLOW-007, SEC-008, report 09. Tests: invite→link→account→role→sign-in end-to-end. Complexity: L.

## TASK-031 — Clinical write ceremonies (sign / cosign / admit / activate)

- Priority: P0 · Severity: Critical · Phase: 4
- Objective: ship the M8 sign+cosign and M6 referral-accept→admission-create→activate write surfaces reusing a shared CeremonyModal + ConfirmDialog + toast; fix the dead `/referrals/:id` route.
- Evidence: FLOW-001/002/003; depends on TASK-012 (cosign), UI primitives. Tests: sign→cosign and referral→admit→activate end-to-end with announced feedback. Complexity: XL.

## TASK-032 — Shared UI primitives: ConfirmDialog, toast, ErrorState+retry, NavLink groups

- Priority: P1 · Severity: High · Phase: 6
- Objective: export the shared Modal/ConfirmDialog; add an aria-live toast region; split ErrorState (role="alert"+retry) from EmptyState; `NavLink`+`navGroup` sections; migrate the 9 module modal copies.
- Evidence: UI-001/002/005/010. Complexity: M.

## TASK-033 — Resilience states + code-splitting + responsive shell

- Priority: P1 · Severity: High · Phase: 6
- Objective: global `onResponse` (401→/expired, 503→/maintenance, offline banner); distinguish outage from logout in `session.tsx`; route-level `React.lazy`; shell breakpoints; overflow-x table containers.
- Evidence: FLOW-004/005/006, UI-004. Acceptance: killing the backend shows an outage state with retry; initial chunk <350 kB; usable at 390px. Complexity: L.

## TASK-034 — Direct-intake admission-create + NOR-acknowledge data-integrity fixes (M6)

- Priority: P1 · Severity: High · Phase: 4
- Objective: fix four defects found live-verifying TASK-031's Activate-gate fix. `POST /api/v1/admissions`
  (direct intake) inserts at the DB's default `status='referred'` instead of `'pending'`, permanently
  stranding the row — `referred`'s only legal transition (`ADMISSION_GRAPH`) is the referral-accept path,
  so a walk-in admission can never advance. The same insert maps the form's `attendingPhysicianId` into
  the `admitted_by_physician_id` column instead of `attending_physician_id`. The required
  `hospiceMedicalDirectorId` input is validated then silently dropped — direct intake never seeds an
  election period, compliance windows, or a CTI draft, so a walk-in admission can never reach the
  activation gate either way. Separately, `POST /admissions/:id/nor`'s service layer never receives the
  validated request body — `deliveryMethod`/`acknowledgedByName`/`acknowledgedByRole`/`formVersionId` are
  parsed by the route then discarded, so the NOR row always records the same hardcoded
  patient/electronic-witnessed facts regardless of what was actually submitted.
- Evidence: `admission-route-service-db.ts` `createAdmission`/`acknowledgeNor`; `m6.cti.drafted`'s
  declared payload (`ctiId, electionPeriodId, isRecert`) doesn't match `draftCti`'s emit (`{ctiId}` only)
  either, the same outbox-payload-schema-drift pattern TASK-031 fixed elsewhere in this module.
- Files: `apps/backend/src/modules/06-admission/admission-route-service-db.ts`, `routes/service.ts`
  (`AdmissionRouteService.acknowledgeNor` signature), `routes/admission-routes.ts` (thread the parsed
  body through), `events-by-m6.ts` (`m6.cti.drafted`).
- Tests: create a direct-intake admission → status `pending`, election period 1 + 4 open compliance
  windows + a draft CTI exist and the CTI carries the submitted hospice-MD/attending ids; acknowledge NOR
  with a non-default method/role → the persisted NOR row reflects it, not the hardcoded default.
- Complexity: M.

## TASK-040 — Ops substrate: worker entrypoint, readiness probe, metrics, deploy + backup

- Priority: P1 · Severity: High/Critical · Phase: 8
- Objective: a dedicated worker entrypoint + Dockerfile + deploy pipeline; a real `readinessProbe` (DB/Redis/outbox depth); OTel or prom-client + BullMQ metrics; SIGTERM graceful shutdown; construct the M7/M9/M10 cron catalogs; DLQ promotion + alerts; a production migration path + gate; pgBackRest (or equivalent) backup + a restore drill.
- Evidence: OPS-002/003/004/005/006/007/012/013/016. Acceptance: `/ready` flips to 503 on a dead DB; a clean-clone deploy + a restore drill succeed. Complexity: XL.

## TASK-050 — Test coverage: per-module HTTP smoke suites + real-auth conformance + jsdom

- Priority: P1 · Severity: High · Phase: 7
- Objective: a table-driven inject smoke suite per module (401/403/422/one 2xx); a fitness check requiring one per `routes/` dir; a shared conformance spec across in-memory and Drizzle backends; a jsdom smoke-render across the three registries; planted-violation self-tests for the 4 highest-value un-red-tested gates.
- Evidence: TEST-001/003/004/005. Complexity: L.

## Lower-priority (P2/P3) tasks

- TASK-060 (P2): extract `@wardenx/money`; converge the three kernels (ARCH-021).
- TASK-061 (P2): decimal-string money in M25 events; integer-cents aging sums (PARAM-003).
- TASK-062 (P2): join the AI capability catalog three ways + seed path (ARCH-019).
- TASK-063 (P2): drive per-table audit denylists from one source (ARCH-020).
- TASK-064 (P2): extend UI parity/frame gates to portal + admin (UI-011); set `/admin/staff` permission (UI-012).
- TASK-065 (P2): fix telehealth webhook to 401 on bad signature (API-008); pass through 4xx framework errors (API-009).
- TASK-066 (P3): drop time-relative CHECKs, enforce at write time (DB-005); local date-only helper (PARAM-004); react-router bump (PERF-004); confirm/remove behaviorally-suspicious dead tables (ARCH-023).
