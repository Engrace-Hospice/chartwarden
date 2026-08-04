# 03 — Code & Architecture Drift Report

Dimension: architecture drift, module boundaries, seams, duplicate abstractions, dead/stub code.
Scope: read-only audit of /Users/fabrice/Apps/WardenX @ main (91e5b09).

> **Lead-auditor verification:** the five Critical findings (ARCH-001, ARCH-003, ARCH-006,
> ARCH-007, ARCH-015) were independently re-checked against source. All confirmed. The
> "in-memory store bound in production" cluster (ARCH-003/006/007/015) is **one root cause** —
> the composition root threads a live `db` into the outer `wireModuleSeams`/`wireModuleErasers`/
> mount functions, but the per-module registrars are invoked argument-less, so their
> `deps.store ?? createInMemory…Store()` fallback fires despite the DB (verified at
> `index.ts:561`, `index.ts:1141-1157`, `06-admission/erasers/admission-eraser.ts:112`,
> `03-authorization/index.ts:108-109`). Recommended single fix that closes all four: a boot
> assertion that, with `deps.db` present, no registered seam/eraser/audit impl may be backed by
> a `createInMemory*` store.

## Recommended architecture-fitness rules (new gates this audit motivates)
1. **No in-memory in prod:** boot-time assertion above (closes ARCH-003/006/007/015 class).
2. **ABAC ownership:** fail `arch:abac-predicates` on any predicate name declared by two modules' `M*_ABAC_PREDICATES` (ARCH-001/002).
3. **Seam ownership:** `registerSeam` warns/throws on overwrite of a non-deny-stub, verifying the caller against `ownerModule` (ARCH-012).
4. **Table-ownership `schema.<table>` awareness:** teach `check-table-ownership` the member-access style (ARCH-017).
5. **Canonical seam census:** `check-fitness-gaps` must trust only the canonical `REQUIRED_SEAMS` and scan aliased/cast `getSeam` forms (ARCH-018).
6. **Outbox liveness:** a test proving an emitted event reaches a registered consumer (OPS-001).

---

## Repository & architecture map

- **Apps** (`apps/`): `backend` (Fastify, composition root `apps/backend/src/index.ts`, ~2271 lines; bootstrap kernel `apps/backend/src/bootstrap/`), `web` (staff React SPA), `portal` (patient/family SPA, own registry), `admin` (M34/M35 platform console).
- **Backend modules**: `apps/backend/src/modules/02-identity … 40-mdm` — 39 numbered module directories (M1 "Foundation" is the bootstrap kernel + seam/eraser registries, not a numbered dir).
- **Packages** (`packages/`, 48): leaf `types` (seam interfaces, `packages/types/src/seams.ts`), `auth` (RBAC/ABAC registry, permissions catalog), `db` (Drizzle schema + 150+ migrations), one domain package per major module (`billing`, `quality`, `cost-report`, `inpatient`, `subscription-billing`, `fhir`, …) and vendor clients (`x12-835-client`, `iqies-client`, `gusto-client`, `xero-client`, …).
- **Boundary enforcement**: `architecture/module-manifest.ts` (codePaths / dependsOn / ownedTables — 453 tables), `architecture/.dependency-cruiser.cjs` (import rules). Gate: `bun run arch:fitness` = parity → boundaries → tables → tenancy → ddl → gaps → ai-governance → plan-integrity → status-matrix → ui-parity → frame-fidelity → design-tokens → abac-predicates → docs:ui → openapi:check → openapi-coverage → client:check (package.json:121).
- **Seam system**: `apps/backend/src/bootstrap/seams/registry.ts` — `REQUIRED_SEAMS` (~138 entries, each `{key, ownerModule, phi, denyStub}`); `registerSeam` = plain `Map.set` (last-wins, registry.ts:1167-1169); `getSeam` throws pre-registration; `validateSeams()` (registry.ts:1184) fills unregistered keys with fail-closed deny-stubs at boot. `wireModuleSeams(deps)` (index.ts:513-1062) is where producers stand real impls over the stubs; it runs before route mounting.
- **ABAC**: `packages/auth/src/abac/registry.ts` — single-owner named-predicate registry (`register` throws on duplicate, registry.ts:183-185); modules register at boot/mount via per-module `register*AbacPredicates` helpers; `registerAbacRegistry()` (index.ts:1060) flips the evaluator live. `arch:abac-predicates` proves every `requireAbac` name is declared *somewhere* — not that the right module's resolver answers it (see ARCH-001).
- **Production switch**: no NODE_ENV gating of implementations anywhere. Everything is decided by `const dbHandle = process.env.DATABASE_URL ? createDbClient(...) : undefined` (index.ts:1256); `assertProductionEnv()` (bootstrap/env.ts:83-93) validates env vars only.
- **Erasers**: `apps/backend/src/bootstrap/erasers/registry.ts` — per-DataClass eraser registry, wired by `wireModuleErasers` (index.ts:1140-1237).

---

## ARCH-001 — `cosigner_role_match` registered by M8, M9 AND M11 with incompatible target contracts; silent first-wins kills the M9 and M11 cosign surfaces
- Severity: Critical
- Priority: P0
- Confidence: Confirmed
- Production blocker: Yes
- Evidence:
  - Three owners, three incompatible resolvers:
    - `apps/backend/src/modules/08-encounters/abac-predicates.ts:19,50-58` — M8: requires RN, reads `target["encounterId"]` (`targetId(target, "encounterId")`, line 52), loads via `resolver.loadEncounter(...)`.
    - `apps/backend/src/modules/09-assessments/abac-predicates.ts:27,74-82` — M9: allows RN **or clinical_supervisor**, reads `target["id"] ?? target["assessmentId"]`, loads via `resolver.loadAssessment(...)`.
    - `apps/backend/src/modules/11-orders/abac-predicates.ts:28,84-92` — M11: role from `facts.cosignerRoleNeeded`, reads `target["id"] ?? target["orderId"]`, loads via `resolver.loadOrder(...)`.
  - Silent first-wins skip in every registrar: `if (abacRegistry.has(name)) continue;` — 08-encounters/abac-predicates.ts:70, 09-assessments/abac-predicates.ts:94, 11-orders/abac-predicates.ts:104. (The registry itself throws on duplicates — packages/auth/src/abac/registry.ts:183-185 — but the registrars swallow the collision first.)
  - Registration happens at mount, in mount order: `mountEncounterRoutes` (index.ts:1471 → 08-encounters/index.ts:29) → `mountAssessmentRoutes` (index.ts:1472 → 09-assessments/index.ts:30) → `mountOrderRoutes` (index.ts:1474 → 11-orders/index.ts:20). **M8 wins; M9's and M11's registrations are silently skipped.**
  - Consumers all bind the one name: 08-encounters/routes/encounters-routes.ts:94 (`requireAbac("encounter.cosign", "cosigner_role_match")`), 09-assessments/routes/assessments-routes.ts:96 (target = params → `id`), 11-orders/routes/orders-routes.ts:80 (target = `:id`).
- Description / Root cause: Three modules each declare themselves single owner of the same predicate name; the idempotency guard intended for test re-boots converts the ownership conflict into silent first-wins ordered by route-mount order.
- Impact: M8's resolver evaluates every cosign. For M9's assessment-cosign route and M11's order-cosign route the target carries `id`, never `encounterId`, so `targetId(target,"encounterId")` returns null → deny. **Assessment LPN cosignature (§7.4) and order cosignature (§7.3) return 403 for every caller, permanently** (break-glass excepted). Even with a matching key, `loadEncounter(orgId, assessmentId)` would miss. M9's clinical_supervisor eligibility is silently narrowed out of existence. `arch:abac-predicates` is green because the *name* resolves — exactly the failure class the gate cannot see.
- Recommended remediation: Namespace the predicates (`m8.cosigner_role_match` etc. — the M37 pattern, cf. 37-ipu/abac/predicates.ts `m37.*` names), or one shared resolver dispatching on target shape. Make the registrar skip throw (or error-log) when the same name arrives with a different resolver.
- Acceptance criteria: An RN can cosign an assessment and an order end-to-end in a live-DB test; a duplicate-name registration by a second module fails boot or the fitness gate.

## ARCH-002 — Systemic silent first-wins in ALL ABAC registrars (the ARCH-001 trap is a platform-wide pattern)
- Severity: High
- Priority: P1
- Confidence: Confirmed
- Production blocker: No (latent)
- Evidence: `if (abacRegistry.has(name)) continue;` appears in ~20 module registrars: 22-documents/abac-predicates.ts:180, 13-emar:178, 12-dosespot:102, 07-care-plan:233, 31-portal:394, 39-consent:54, 37-ipu/abac/predicates.ts:59, 33-reporting:221, 14-idg:130, 16-bereavement:344, 34-saas-tenant-platform:197, 32-ai-platform:344, 35-subscription:148, 36-messaging/routes/messaging-routes.ts:70, 05-patient/seams/caseload-provider.ts:56, plus M8/M9/M11. index.ts:846-851 documents the mechanic: "every registrar skips a name the registry already holds, so a later re-registration is silently ignored."
- Description / Root cause: The single-owner invariant is enforced by the registry (throw) but universally bypassed by the registrars (skip). Any two modules that pick the same predicate name degrade to mount-order first-wins with zero signal.
- Impact: Ownership conflicts are undetectable at build, boot, and test time; behavior depends on mount order in index.ts. ARCH-001 is the first realized instance; nothing prevents the next.
- Recommended remediation: Static check: collect every module's `M*_ABAC_PREDICATES` export and fail `arch:abac-predicates` on intersection. At runtime, skip silently only for the same function reference; otherwise throw.
- Acceptance criteria: Registering the same name from two modules fails the fitness gate; boot logs zero skipped-name collisions.

## ARCH-003 — Seams registered over EMPTY in-memory stores on the production (db-present) boot: fabricated-empty answers across ~15 modules
- Severity: Critical
- Priority: P0
- Confidence: Confirmed
- Production blocker: Yes
- Evidence (binding sites all in `wireModuleSeams`, apps/backend/src/index.ts, called with a live db in production):
  - Called with NO store argument, so `?? createInMemory…Store()` fires **even with a DB**: `registerCarePlanSeams()` index.ts:550 (07-care-plan/seams/index.ts:36); `registerAssessmentSeams()` :561 (09-assessments/seams/index.ts:37 — `const store = deps.store ?? createInMemoryAssessmentReaderStore().store`); `registerOrderSeams()` :603; `registerDoseSpotSeams()` :608; `registerEmarSeams()` :614; `registerIdgSeams()` :620; `registerDisciplinePlanSeams()` :632; `registerBereavementSeams()` :653; `registerSchedulingSeams()` :826; `registerEvvSeams()` :834 (18-evv/seams/index.ts:68-76 — all six EVV seams over `createInMemoryEvvSeamStore()`); `registerDocumentSeams()` :841 (22-documents/seams/index.ts:108-111, including `createInMemoryObjectStore()` as the production document object store).
  - Partial: `registerPatientSeams(deps.db ? { db } : {})` index.ts:540 — 05-patient/seams/index.ts:60-73 uses `db` only for `PatientCoverageReader`; **`PatientReader` (:66-69) and `PatientMutator` (:70-73, a WRITE seam) bind in-memory stores even with a db**. Same shape M6 (06-admission/seams/index.ts:73 — all six admission readers in-memory; db only feeds `DeathDischargeReader` :81-84) and M10 (10-hope/seams/index.ts:75; db only feeds the org rollup).
  - Doctrine contradiction in the same file: M19/M20 deliberately register **nothing** without a real store so the deny-stub throws (index.ts:707-711, 722-725: "A DB-less boot must not manufacture a coverage gap"). The M18 comment at index.ts:829-832 claims the five non-bracket EVV seams "stand over their deny-stubs" — **false**: 18-evv/seams/index.ts:70-75 registers real impls over an empty store, replacing the stubs.
  - Live consumers reading fabricated-empty today: `getSeam("PatientReader")` in M31 portal session/identity resolution (31-portal/read-surfaces/resolve.ts:146, 31-portal/routes/session.routes.ts:51), M39 (39-consent/consumed-seams.ts:26), M20 (20-field-safety/consumers/seam-context.ts:216), M28 FHIR (28-fhir/seams/consumed.ts:48); `getSeam("ElectionPeriodReader")` in M28 (28-fhir/seams/consumed.ts:53); M15's `VolunteerComplianceProvider` consumed by M16's ABAC arm (index.ts:670-676) and M17's pre-schedule gate — over an empty Map.
  - Correct counter-pattern already exists: M8 (index.ts:557 `createDrizzleEncounterReaderStore`), M21 (:696), M38/M36-provider/M40/M39 (db-gated stores).
- Description / Root cause: Clinical-core modules shipped seams in the slice era ("Drizzle store lands with routes/repos (M9-T05+)"), routes later went Drizzle, but the seam registrations in `wireModuleSeams` were never upgraded to pass the Drizzle stores.
- Impact: Cross-module reads silently answer empty in production: portal patient identity never resolves; M28 FHIR projections empty; M7 CTI narrative / M14 packet see no assessments; volunteer-compliance and supervisory-cadence gates evaluate over nothing; M22's `DocumentRenderer`/`DocumentStorageProvider` keep rendered PDFs in process memory (lost on restart). Unlike a deny-stub, these are indistinguishable from true negatives — the platform's own fail-closed doctrine (index.ts:707-711) is violated by ~15 of its modules. `PatientMutator` writes vanish into a Map.
- Recommended remediation: Bind each module's existing Drizzle route store into its seam registration (M8/M21 pattern); where no Drizzle seam store exists, register nothing on a db boot (M19/M20 pattern) so consumers fail loudly. Add a boot assertion: with `deps.db` present, no registered seam impl may be backed by a `createInMemory*` store.
- Acceptance criteria: With DATABASE_URL set, `getSeam("PatientReader").findById` returns a row written through M5's routes; zero argument-less `register*Seams()` calls remain for modules with Drizzle backends; M18 comment matches behavior.

## ARCH-004 — Deny-stub seam census: the recorded M27/M30 blockers are FIXED; two consumed stubs remain (ClaimReader, DrugCostBillingReader)
- Severity: Medium
- Priority: P2
- Confidence: Confirmed
- Production blocker: No (fail-closed by design)
- Evidence:
  - **FIXED (live-bound when db present)** — the task brief's named suspects: `CapAccrualReader` + `CapProjectionProvider` (26-cap/wiring.ts:17-22, wired index.ts:574; consumed by M27 at 27-cost-report/routes/cap-context-wiring.ts:10); `PatientDaysProvider` + `ClaimLineReader` (23-billing-medicare/cost-report-seams.ts:72-77, index.ts:581); `ClaimSettlementProvider` (25-remittance/cost-report-seams.ts:61-64, index.ts:585); `CostReportFilingStatusReader` (27-cost-report/published-seams.ts:111-114, index.ts:598). M30's HCI adapters consume them via getSeam (30-quality/consumed-seam-adapters.ts:78,94,114). `hci_composite` is registered (packages/quality/src/measures/registrations.ts:108); its remaining gaps are upstream fact gaps (M38 opioid classification, M15/M16 facts), not seam stubs.
  - **Still deny-stub WITH live consumers**: `ClaimReader` (registry.ts:447, owner M23) — the only registrar is `packages/billing/src/seam-registration.ts:49`, never called (see ARCH-011) → M28's FHIR Claim/EOB projection (`getSeam("ClaimReader")`, 28-fhir/seams/consumed.ts:205) permanently fail-closed. `DrugCostBillingReader` (registry.ts:340, owner M12) — never registered anywhere; consumed by M27's validation context (index.ts:2111 `drugCost: () => getSeam("DrugCostBillingReader")`) → cost-report drug-cost validation always refuses.
  - **Deny-stub, zero consumers** (verified no getSeam call sites): M35's six (`SubscriptionStateProvider`, `BillingStatusProvider`, `PatientCounterProvider`, `PlanCatalogReader`, `RevenueMetricsProvider`, `UsageMeteringIngest`), `AITokenMeterProvider` (M32), `OnboardingStatusProvider` (M34).
  - **Deliberate documented stubs**: M32's ten inference seams (index.ts:946-951, `ai.full` OFF posture); `deviceAttestationValid` (packages/auth/src/abac/registry.ts:140-158).
- Impact: M28 cannot serve FHIR Claim/ExplanationOfBenefit; M27's drug-cost rule always answers "cannot answer". Both fail loudly (correct direction), but ClaimReader is a wiring omission, not a plan — M23 is merged and the registrar exists as dead code.
- Recommended remediation: Wire `packages/billing`'s registrar (or fold ClaimReader into 23-billing-medicare/cost-report-seams.ts); register a Drizzle `DrugCostBillingReader` in M12.
- Acceptance criteria: `getSeam("ClaimReader")` and `getSeam("DrugCostBillingReader")` resolve live impls on a db boot; M28 Claim projection integration test passes.

## ARCH-005 — M2 identity: core audit sink FIXED, but collaborator magic-links and auditor session minting are process-local Maps in production; step-up routes never mounted
- Severity: High
- Priority: P1
- Confidence: Confirmed
- Production blocker: Partially
- Evidence:
  - **FIXED**: identity route audit sink DB-bound — `audit: db` at 02-identity/index.ts:145 (mount index.ts:1463); header 02-identity/index.ts:107-122 documents the former Map-sink defect and migration 0119's INSERT policy. Memberships/sessions/invitations/users all Drizzle (:140-144). `SessionContextResolver` DB-backed (index.ts:1925-1927).
  - **CONFIRMED-PRESENT**: `collaborators: _collabStore().store` (02-identity/index.ts:143) → `createInMemoryCollaboratorLinkStore` (`const links = new Map<string, Link>()`, identity-ports.ts:418-427) — one-time external-collaborator magic links are per-replica, die on restart (documented as a schema gap, :125-131).
  - **CONFIRMED-PRESENT**: `AuditorSessionMinter` seam backed by `createInMemoryAuditorMagicLinkIssuer` (02-identity/seams.ts:51-53); the `auditorLinks` injection slot is never supplied by the composition root (index.ts:518).
  - **Not mounted at all**: `registerSessionStepUpRoutes` (02-identity/routes/session-step-up.ts:83, exported 02-identity/index.ts:48) has zero call sites in index.ts/bootstrap — `/session/step-up` initiate/verify does not exist on the production server, while `step_up_recent`-gated routes do.
- Impact: Multi-replica deploys break collaborator/auditor magic links; restarts void pending links. The absent step-up mount means step-up freshness can never be established via M2's HTTP surface (compounds ARCH-009's `stepUpRecent` finding).
- Recommended remediation: Token-hash table (+RLS/audit trigger) for both link stores; mount the step-up routes in the db branch.
- Acceptance criteria: A magic link minted on one process is redeemable after restart; `POST /session/step-up/initiate` appears in openapi.json.

## ARCH-006 — M3 and M4 route audit sinks are in-memory arrays in production (auth-plane audit events silently discarded)
- Severity: Critical
- Priority: P0
- Confidence: Confirmed
- Production blocker: Yes
- Evidence: `audit: createInMemoryAuditExecutor().executor` bound in the db-only mounts at 03-authorization/index.ts:109 and 04-audit/index.ts:78 (mounts at index.ts:1461/1464). The executor pushes to `const rows: NewAuditEvent[] = []` (02-identity/step-up-ports.ts:200-213). M3's mount also binds in-memory `engagements`/`auditorSessions`/`notifier` and a **hardcoded-empty** route-local `effectivePermissions: _fixedPerms([])` (03-authorization/index.ts:105-108); docstring (:88-94) admits these "land in follow-up M3 wiring". M4 docstring (:73-74): "The `audit.elevated_access` meta-event sink is in-memory for now."
- Description / Root cause: The audit-remediation wave fixed M2's sink but the identical `createInMemoryAuditExecutor` stayed bound on M3 (role grant/revoke, break-glass invocation, auditor-engagement lifecycle) and M4 (`audit.elevated_access` — the record of who searched the audit log). Asymmetry: break-glass **per-access** rows are durable (03-authorization/contract.ts:75-81); **invocation** rows via `deps.audit` are not.
- Impact: HIPAA-relevant authorization-plane audit events go to a process-local array that is never read and dies with the process, while the API reports success. An investigator's elevated audit-log access leaves no durable trace.
- Recommended remediation: Bind `audit: db` (the M2 fix, one line each) for the M3 and M4 mounts; wire M3's engagement/notifier stores to Drizzle or fail closed.
- Acceptance criteria: Live test proves a role-grant and an audit-search each produce a durable `audit_event` row; zero `createInMemoryAuditExecutor` bindings outside tests.

## ARCH-007 — 25 data-class erasers registered over empty in-memory stores in production: right-to-erasure returns success certificates having deleted nothing
- Severity: Critical
- Priority: P0
- Confidence: Confirmed
- Production blocker: Yes
- Evidence: `wireModuleErasers({ db: dbHandle?.db })` (index.ts:1930 → 1140-1237) calls 25 registrars **with no arguments**, so each `deps.store ?? createInMemory…EraseStore()` fallback fires despite the live DB. Sample: `registerIdentityErasers()` index.ts:1141 → 02-identity/erasers/identity-eraser.ts:113; `registerAdmissionErasers()` :1148 → 06-admission/erasers/admission-eraser.ts:112; `registerOrderErasers()` :1153 → 11-orders/erasers/orders-eraser.ts:156; … through `cap` :1181 → 26-cap/erasers/cap-eraser.ts:125. Affected classes (index.ts:1141-1181): identity, audit_event, terminology_tenant_extensions, messages, mdm_tenant_overlays, clinical_record, consent, admission_record, care_plan_record, encounter_record, clinical_assessment, hope_record, order_record, medication_order_record, emar_record, idg_record, documents, saas_tenant_platform_class, reporting_class, quality_class, cost_report_class, billing_record, remittance, medicaid_billing_record, cap. Correctly db-gated by contrast: M15 (:1160), M16 (:1168), M19 (:1198), M20 (:1205), M32 (:1215), M28 (:1222); db-only: M21 (:1191), M31 (:1230), M37 (:1236).
- Impact: A HIPAA/CCPA erasure request for any of the 25 classes runs against an empty Map, touches zero Postgres rows, and returns a successful destruction certificate — the exact "silent no-op" the wiring comment (index.ts:1136-1138) promises to prevent. Highest-severity cluster found: a compliance obligation converted into a false attestation.
- Recommended remediation: Pass `{ db }`-backed erase stores (M15/M16/M28 pattern) or refuse to register without a store when the boot has a db, so the eraser reports failure instead of fake success. A boot assertion mirroring ARCH-003's would catch both classes of defect.
- Acceptance criteria: Live test: erase request for a seeded patient deletes real rows with non-zero certificate counts; store-less erasers fail the erase loudly.

## ARCH-008 — `providerEntityIds` declared but never assembled; consumers split between permanently-dead endpoints and silent fail-open
- Severity: High
- Priority: P1
- Confidence: Confirmed
- Production blocker: Yes (for the affected surfaces)
- Evidence:
  - Assembly: `providerEntityIds: []` hardcoded at bootstrap/plugins/request-context.ts:38; zero assignment sites anywhere; `ResolvedActor`/`ActorEnrichment` (packages/types/src/seams.ts:482-495) have no field to carry it.
  - Dead endpoints (always deny): M24 `provider_entity_medicaid_billing_scope` (24-billing-medicaid/abac-predicates.ts:132-149) → `POST /api/v1/medicaid-claims` (claims.routes.ts:41-43) and `POST /api/v1/medicaid-eligibility-checks` (eligibility.routes.ts:25-27) 403 for everyone. M20 field-safety writes: 20-field-safety/routes/actor.ts:115-130 throws ForbiddenError on `length===0` → check-in, SOS, incident, policy writes all dead (write-service-drizzle.ts:532, 771, 1270, 1680, 1930); comment at actor.ts:106 claiming "M2 assembles providerEntityIds" is false. M32 hallucination report (32-ai-platform/routes/actor.ts:113-129, bound at hallucinations.routes.ts:95) — dead.
  - Degraded: M23 `provider_entity_billing_scope` (23-billing-medicare/abac-predicates.ts:225-229, roles :91-94) passes only for org_admin/compliance_officer; every billing-manager role 404s on claim assemble/submit/replace/void, NOE, NOTR, MAC credentials (guards.ts:80-84 notFoundOnDeny).
  - Fail-open: `GET /api/v1/claims` applies **no** provider narrowing (claims.routes.ts:153-161 `if (scope.length === 0) return undefined`, documented).
  - Dead intrinsic: M3's `provider_entity_scope` (packages/auth/src/abac/registry.ts:70-73, seeded :167) would always deny but **no route binds it**; the 17 permission-catalog rows naming it (packages/auth/src/permissions/contributed.ts, e.g. :1166) are unenforced metadata (`defaultAbac` is never read by an enforcement path).
  - Working counter-pattern: M27 falls back to `resolver.loadMembershipProviderScope(..., membershipId)` (27-cost-report/abac-predicates.ts:274-279).
- Impact: Two whole write surfaces (M20 field safety — a life-safety module — and M24 Medicaid claim submission) plus M32's hallucination filing are unusable in production; M23 restricted to two admin roles; provider-entity scoping claimed in the catalog is enforced nowhere.
- Recommended remediation: Add membership→provider-entity resolution to `ActorEnrichment` (populate in authenticate.ts beside membershipId), or adopt M27's resolver-fallback pattern in M20/M23/M24/M32.
- Acceptance criteria: A billing_manager submits a claim scoped to their PE; an M20 check-in succeeds for a field clinician; cross-PE attempts still deny.

## ARCH-009 — `actorKind` populated but constant `"user"`; `locationIds` and five other context attributes never assembled — dead gates in both fail directions
- Severity: High
- Priority: P1
- Confidence: Confirmed
- Production blocker: Yes (M14 surface; step-up-gated writes)
- Evidence:
  - `actorKind`: written unconditionally as `"user"` (bootstrap/plugins/authenticate.ts:48). `requireSystemPrincipal()` therefore always denies → M15 internal routes (15-discipline-care-plans/routes/internal.routes.ts:30) and M23 internal routes #39/#40 (23-billing-medicare/routes/internal.routes.ts:69, guards.ts:128) unreachable; `rejectAiActor()` (23-billing-medicare/routes/actor.ts:84-90; 24-billing-medicaid/routes/actor.ts:59-66) never fires — the D13/D12 AI-write blocks have never blocked anything; billing rows stamp `actor_kind="user"` as a constant (write-service-drizzle.ts:606). Stale comment at 23-billing-medicare/routes/internal.routes.ts:112-114 still claims nothing assembles the field.
  - `locationIds`: hardcoded `[]` (request-context.ts:39), no writer. M14's `idg_meeting_scope` (14-idg/abac-predicates.ts:95 `context.locationIds.includes(...)`) always false → **13 IDG meeting routes always 403** (14-idg/routes/idg-routes.ts:116-367). Latent fail-open: 06-admission/abac-predicates.ts:94-96 treats `length===0` as "org-wide → allow" (currently unreachable — no route binds `referral.scope` — but flips open the day one does). M3 intrinsic `location_scope` (registry.ts:80-83): always-deny, bound by no route.
  - Never-written attributes with live readers: `stepUpRecent` — always false → step-up-gated write actors deny in M15 (:66), M16 (:74), M23 (:71), M27, M32 (:90), M37 (:43) (M3's real `step_up_recent` predicate resolves via the session seam instead — two parallel representations of one fact, one always-false); `systemPrincipal` — always false → M25 internal seam routes 403 for everyone (25-remittance/routes/internal.routes.ts:19, abac-predicates.ts:143) and M23's service-to-service escape hatch never opens; `sessionClass` — defaults "staff" → M31/M39/M15/M16/M19 portal/collaborator-class predicates cannot identify a portal session (39-consent/abac-predicates.ts:36, 31-portal/abac-predicates.ts:235); `portalAccountId`, `externalActorId` — always null.
- Impact: An entire clinical surface (M14 IDG — a CoP requirement) is dead in production; step-up-gated mutations across six modules deny; AI-actor rejection controls are decorative; session-class differentiation silently collapses to "staff".
- Recommended remediation: Populate location/PE/session-class facts in the enrichment reader; give machine principals a credential path that sets `actorKind`; delete or wire the parallel `stepUpRecent` attribute (prefer the seam-backed predicate).
- Acceptance criteria: IDG meeting CRUD works for a scoped user live; a portal-minted session is distinguishable in ABAC; internal system routes reachable by a real system credential only.

## ARCH-010 — `membershipId`: VERIFIED FIXED, one residual inconsistency
- Severity: Low
- Priority: P3
- Confidence: Confirmed
- Production blocker: No
- Evidence: Populated end-to-end on the db boot: authenticate.ts:64 ← packages/auth/src/identity/session-seam.ts:52-60 ← db-session-store.ts:40 ← createDbActorEnrichmentReader (packages/auth/src/rbac/drizzle-store.ts:113-129) ← index.ts:1925-1926. ~15 consumers treat null as deny. Residual: 34-saas-tenant-platform/routes/platform/support-sessions.ts:51 still falls back `?? ctx.userId` for the *recorded* actor while the predicate denies on null — recorded id and checked id are different value spaces on a membership-less session.
- Remediation: Remove the userId fallback. Acceptance: recorded support-session actor is always a membership id.

## ARCH-011 — Duplicate `registerM23PublishedSeams`: the packages/billing registrar (ClaimReader + 4 more) is dead code shadowed by a same-named module function
- Severity: Medium
- Priority: P2
- Confidence: Confirmed
- Production blocker: No (but causes ARCH-004's ClaimReader stub)
- Evidence: `packages/billing/src/seam-registration.ts:45` exports `registerM23PublishedSeams(registrar, impls)` registering `ClaimReader`, `ClaimDayProjectionProvider`, `ClaimSubmissionReader`, `ClaimMetricsProvider`, `MacCredentialAdmin` (:49-53) — zero call sites outside tests. `apps/backend/src/modules/23-billing-medicare/cost-report-seams.ts:72` defines a *different* `registerM23PublishedSeams(db)` (PatientDaysProvider + ClaimLineReader only), which is what index.ts:581 imports. Two public functions, same name, different seam sets. Similarly `registerM24PublishedSeams` (24-billing-medicaid/wiring.ts:18-21) *builds* eight seam impls and registers none — documented as deferred, but the name says "register".
- Impact: Developer trap — grepping "who registers ClaimReader" finds a plausible, never-executed answer; direct cause of the M28 Claim projection stub.
- Remediation: Rename the package function (`buildM23SeamRegistrar`) or wire it from the composition root; rename the M24 function. Acceptance: one name = one behavior; ClaimReader live or explicitly deferred in the registry comment.

## ARCH-012 — `registerSeam` is last-wins `Map.set` with no owner check: any module can silently hijack another's seam
- Severity: Medium
- Priority: P2
- Confidence: Confirmed
- Production blocker: No (latent)
- Evidence: bootstrap/seams/registry.ts:1167-1169 (`registry.set(name, impl)` — no has-check, no ownerModule verification); `validateSeams` (:1184-1199) only backfills deny-stubs. `REQUIRED_SEAMS` carries `ownerModule` metadata that registration never consults. Mirror image of ARCH-002: ABAC is silent first-wins, seams are silent last-wins.
- Remediation: Warn/throw on overwrite of a non-deny-stub impl; verify registering module against `ownerModule` in dev builds. Acceptance: double registration of one seam key fails a test.

## ARCH-013 — Bootstrap system-status reader is a per-process Map in production (the promised Drizzle reader does not exist)
- Severity: Low
- Priority: P3
- Confidence: Confirmed
- Production blocker: No
- Evidence: `statusReader: deps.systemStatusReader ?? createInMemorySystemStatusReader()` (bootstrap/index.ts:225); the deps slot is never supplied by index.ts; docstring at bootstrap/routes/system.ts:91-94 promises "production injects the Drizzle reader" — no such reader exists in the tree. Org scoping is enforced in route code (system.ts:60-61), so no cross-tenant leak; durability/multi-replica consistency only.
- Remediation: Implement the Drizzle reader over `system_status` or correct the docstring.

## ARCH-014 — M36 AlertEmitter left on its in-memory default even on the db boot
- Severity: Medium
- Priority: P2
- Confidence: Confirmed
- Production blocker: No
- Evidence: `registerMessagingSeams(deps.db ? { provider: createDbMessagingProvider(deps.db) } : {})` (index.ts:531) upgrades only the `provider`; the `emitter` slot falls back to in-memory at 36-messaging/seams.ts:46. Alerts emitted through the seam by producer modules are process-local.
- Remediation: Bind a durable (outbox- or table-backed) emitter beside the provider.

---

## Verified-fixed (no longer an issue)

1. **M27←M23/M26 and M30←M27 seam deny-stubs** (task item 2's named suspects): `CapAccrualReader`, `CapProjectionProvider`, `PatientDaysProvider`, `ClaimLineReader`, `ClaimSettlementProvider`, `CostReportFilingStatusReader` all register live Drizzle impls on the db boot (26-cap/wiring.ts:17-22; 23-billing-medicare/cost-report-seams.ts:72-77; 25-remittance/cost-report-seams.ts:61-64; 27-cost-report/published-seams.ts:111-114; wired index.ts:574-598) and are consumed via getSeam by M27 (cap-context-wiring.ts:10) and M30's HCI adapters (consumed-seam-adapters.ts:78-114). Residual stubs: ClaimReader / DrugCostBillingReader (ARCH-004).
2. **M2 identity in-memory production stores** (task item 3, core claim): the identity route audit sink and the membership/session/invitation/user stores are Drizzle-bound (`audit: db`, 02-identity/index.ts:140-145; migration 0119 added the audit INSERT policy); `SessionContextResolver` DB-backed (index.ts:1925-1927). Residuals moved, not gone: collaborator links + auditor minter + unmounted step-up routes (ARCH-005); the same in-memory audit executor still bound in M3/M4 (ARCH-006).
3. **`membershipId` unpopulated** (task item 5, first field): fixed end-to-end (ARCH-010).
4. **Bootstrap idempotency store**: DB store wins in production (`idempotencyStore: createDbIdempotencyStore(dbHandle.db)`, index.ts:1455; bootstrap/plugins/idempotency-store-db.ts:39); in-memory only on db-less boots.
5. **Break-glass persistence**: Drizzle store bound (`createDbBreakGlassStore`, 03-authorization/index.ts:97-104); per-access critical audit rows durable via withOrgContext (contract.ts:75-81). The in-memory variant is export-only.
6. **Outbox**: no in-memory persistence — `buildTxOutboxPublisher` writes transactionally (bootstrap/outbox-persister.ts:80); the in-process `bootOutboxCatalog` is immutable reference data by design.

---

## ARCH-015 — M3 authorization routes bind a hardcoded-EMPTY effective-permission resolver in production: `/me/permissions` returns `[]` for everyone and every role-grant 403s
- Severity: Critical
- Priority: P0
- Confidence: Confirmed
- Production blocker: Yes
- Evidence: `effectivePermissions: _fixedPerms([]).resolver` at 03-authorization/index.ts:108 (mount is production, index.ts:1461). `createFixedPermissionResolver([])` returns `new Set<string>()` for every actor (authz-ports.ts:591-592). This is a SECOND, route-injected permission-resolver abstraction (`ActorPermissionResolver`, authz-ports.ts:252) parallel to the real one (`EffectivePermissionResolver`/`setEffectivePermissionResolver`, packages/auth/src/rbac/require-role.ts:83-92) that IS wired live via `registerDbEffectivePermissionResolver(deps.db)` at index.ts:521. The route surface uses the fake one. Consumers: `GET /api/v1/me/permissions` (routes/authz-routes.ts:293-297, "drives UI gating §4.3") returns `{permissions:[]}` for every user; `assertNoEscalation` (authz-routes.ts:106-112) reads the same empty set → every role-grant mutation 403s `cannot grant permission '<x>' you do not hold`.
- Description / Root cause: Two effective-permission resolver abstractions coexist (old route-port beside new contract-seam); the production mount was never migrated to the live seam and still injects the empty-seed stub the docstring (03-authorization/index.ts:88-94) admits "lands in follow-up M3 wiring."
- Impact: UI permission-gating reads empty for all users (over-restrictive client); no admin can grant/revoke a role in production (fail-closed but total). `requirePermission` route guards are unaffected (they use the live contract seam) — only M3's own management surface is broken, which is severe because it is the surface that administers everyone else's access.
- Recommended remediation: Inject the DB-backed resolver (a `createDbEffectivePermissionStore(deps.db)` adapter) into the M3 mount instead of `_fixedPerms([])`; delete the route-local `ActorPermissionResolver` abstraction in favor of the contract seam.
- Acceptance criteria: `GET /me/permissions` returns a non-empty set for a seeded admin; an org_admin can grant a role in a live test.

## ARCH-016 — M3 auditor-engagement magic-link tokens are minted but stored nowhere; engagement records are per-process
- Severity: High
- Priority: P1
- Confidence: Confirmed
- Production blocker: Yes
- Evidence: In the production M3 mount, `engagements: _engagements().store` (in-memory Map, authz-ports.ts:501), `auditorSessions: _auditorMinter().minter`, `notifier: _notifier().notifier` (03-authorization/index.ts:105-107). `POST /api/v1/engagements/:id/auditors` (authz-routes.ts:454-470) calls `mintAuditorSession`, which returns `magicLinkToken: crypto.randomUUID()` (authz-ports.ts:557) persisted nowhere — the endpoint hands out a credential that can never be redeemed. Engagement CRUD (authz-routes.ts:388/430/481) writes to a Map lost on restart / invisible across replicas.
- Impact: External-auditor access provisioning is non-functional in production (issued tokens are un-redeemable), and the compliance-engagement lifecycle has no durable record. Pairs with ARCH-005's M2 auditor minter stub — the whole auditor-access path is process-local end to end.
- Recommended remediation: Drizzle-backed engagement + token-hash stores (RLS + audit trigger); or fail closed until they exist.
- Acceptance criteria: An auditor token minted on one process is redeemable on another; engagement rows survive restart.

## ARCH-017 — `check-table-ownership` is blind to the `schema.<table>` barrel-import style: ~35 cross-module table accesses escape, including M18→M17 `visit` and M30→M3 `role`/`membership_role`
- Severity: High
- Priority: P1
- Confidence: Confirmed
- Production blocker: No (correctness/coupling risk; gate is false-green)
- Evidence: The used-table predicate requires a literal `from "…schema…"` import in the file text — scripts/check-table-ownership.ts:102-103: `new RegExp('\\b'+ref.constName+'\\b').test(src) && /from ['"].*schema/.test(src)`. Files using `import { schema } from "@wardenx/db"` then `schema.<table>` never match, so their cross-module reads are skipped. Two are not M1-foundation tables: (1) **M18 → M17's `visit`** — 18-evv/evv-route-service-db.ts:79 `const VISIT = schema.visit`, used in 8 queries (:175-183 six-column projection, :255-257, :268-270, :457, :738-740, :784); `visit` is M17-owned (manifest:600-607). The checker's own contract (check-table-ownership.ts:124-127) says a dependency's table is still a violation for direct schema use. (2) **M30 → M3's `role`+`membership_role`** — 30-quality/abac-predicates.ts:219-220 `schema.roles`/`schema.membershipRoles`, joined in `loadMemberRoleKeys` (:206-208). The other ~33 are M1-foundation tables (`membership`/`organization`/`user`/`session`/`audit_event`) reached by 14+ modules' Drizzle ABAC resolvers. Raw-SQL path is genuinely clean (scanEvasions works); only the `sql\`` case is covered, not `schema.X`. The manifest header (module-manifest.ts:39-42) asserts "Data access to another module's tables is still blocked by check-table-ownership.ts" — it is not.
- Impact: The architecture's headline boundary invariant is silently unenforced for the dominant access style. M18 is coupled to M17's `visit` column layout and M30's ABAC to M3's role-table semantics with zero gate signal; an owner-side schema change breaks the consumer at runtime only.
- Recommended remediation: Extend the checker to recognize `schema.<ident>` member access (map camelCase Drizzle const → snake_case table) regardless of import spelling; then triage the ~35 real hits (route the two non-foundation ones through the owner's repository/seam).
- Acceptance criteria: The checker flags a synthetic `schema.visit` read from M18; M18/M30 either go through a seam or carry an explicit, reviewed exemption.

## ARCH-018 — M31 resolves three seams that cannot exist in the typed registry via a `getSeam`-cast; one silently serves an empty PHI-adjacent route, and a private `M31_REQUIRED_SEAMS` self-satisfies the fitness gate
- Severity: High
- Priority: P1
- Confidence: Confirmed
- Production blocker: Yes (bereavement-resources route)
- Evidence: M31 casts the type-safe `getSeam` away — `const rawSeam = getSeam as unknown as (name:string)=>unknown` (31-portal/abac-predicates.ts:45); `arm = <T>(name)=>...` (routes/read.routes.ts:63, write.routes.ts:52). Three names resolved through the cast are in neither the `SeamName` union nor `REQUIRED_SEAMS`: `PatientCaregiverReader` (abac-predicates.ts:196 → `catch{return null}` → `portal_caregiver_is_primary_or_dpoa` always denies), `PatientAddressReader` (:206 → `state_two_party_recording_consent_present` never resolves), `ExternalGriefResourceReader` (read.routes.ts:349 → `GET /api/v1/portal/bereavement/resources` returns `{items:[]}` forever via the `layList` catch at :73-75). These names are unregisterable: `registerSeam` is also `<K extends SeamName>` (registry.ts:1167) and `validateSeams` iterates `REQUIRED_SEAMS` only (registry.ts:1184-1199), so no deny-stub is installed either. No gate catches it: 31-portal/seams/registration.ts:100 declares a private `M31_REQUIRED_SEAMS` (30 names, 8 nonexistent in M1), and check-fitness-gaps.ts:140-141 unions ANY file's `*REQUIRED_SEAMS = [...]` names into its "registered" set — so M31 self-certifies — while :142 only scans literal `getSeam("Name")`, missing the `rawSeam(...)`/`arm(...)` calls. The coverage is circular (comment at abac-predicates.ts:43-44 states the mistaken belief).
- Impact: Two portal ABAC predicates permanently deny (fail-closed, invisible); one patient/family-facing route silently returns an empty list instead of a 501/503 — a wired-but-fake production surface. The fitness gate reports these seams satisfied.
- Recommended remediation: Add the three names to `SeamName`/`REQUIRED_SEAMS` with real impls or deny-stubs, and delete the cast; tighten check-fitness-gaps to only trust the canonical `REQUIRED_SEAMS` and to scan cast/aliased getSeam call forms.
- Acceptance criteria: `getSeam("ExternalGriefResourceReader")` is a compile error or resolves a registered impl; the bereavement-resources route returns real data or a 501; the fitness gate flags an unregistered portal seam.

## ARCH-019 — AI capability catalog: three parallel registries, no gate joins any two, and the runtime inventory has zero consumers / no seed path
- Severity: Medium
- Priority: P2
- Confidence: Confirmed
- Production blocker: No
- Evidence: (1) governance YAML `docs/ai/capability-catalog.yaml` (18 ids), (2) the gate's own hardcoded `const REQUIRED=[...]` (scripts/check-ai-governance.ts:15-33, 18 ids), (3) runtime `AI_PHASE_1_CAPABILITIES` (packages/ai-platform/src/inventory/capabilities.ts:38, 17 rows). `check-ai-governance.ts` never reads the runtime inventory; the join key `governanceCatalogId` (packages/types/src/ai-platform.ts:515-518) is asserted only by a unit test with hardcoded strings (phase-1-inventory.test.ts:160-177) that never opens the YAML. Known live drift: `aggregate-cap-projection` is in the YAML + gate but has no registry row (recorded as a gap at phase-1-inventory.test.ts:181-185). `AI_PHASE_1_CAPABILITIES` has zero runtime consumers and no INSERT path into `ai_capability` (index.ts:7-8 claims "read by seeding" — no such path exists), so the governance docs describe capabilities the DB never receives.
- Impact: Governance catalog and runtime capability set can diverge in either direction with every gate green; the runtime table that is meant to be the source of truth is never populated.
- Recommended remediation: Make `check-ai-governance` join all three by `governanceCatalogId` and fail on asymmetry; add the seed/migration path for `AI_PHASE_1_CAPABILITIES`.
- Acceptance criteria: Adding a YAML entry with no registry row (or vice-versa) fails the gate; `ai_capability` is seeded at provision time.

## ARCH-020 — 13 `M*_AUDIT_DENYLIST` per-table PHI-redaction constants are dead; three parallel per-table denylist representations exist and the spec-declared one feeds neither enforcement path
- Severity: Medium
- Priority: P2
- Confidence: Confirmed
- Production blocker: No (hygiene now, PHI-leak risk on schema change)
- Evidence: `M6/M7/M8/M9/M11/M12/M13/M14/M15/M16/M17/M18/M29_AUDIT_DENYLIST` (packages/types/src/{admission,care-plan,encounter,assessment,orders,dosespot,emar,idg,discipline-plans,bereavement,scheduling,evv,external-interfaces}.ts) have zero importers repo-wide (M20/M28's are referenced only by tests). The redaction that actually runs is unrelated: runtime `AUDIT_FIELD_DENYLIST` is a flat key-name set (packages/audit/src/denylist.ts:10, applied by redactSnapshot audit.ts:16, no table notion); the per-table DDL scrub is hand-transcribed into migrations (e.g. packages/db/migrations/0033_assessment_m9_rls_audit_triggers.sql:21-23); the generator `AUDIT_DENYLIST_CATALOG` holds one entry (packages/audit/src/triggers/catalog.ts:44). The shared registry table `auditDenylistCatalog` (packages/db/src/schema/audit-denylist-catalog.ts:10) is itself a zero-importer export.
- Impact: A module adding a free-text column and updating only its `M*_AUDIT_DENYLIST` gets zero enforcement — the constant is decorative; current migrations happen to scrub the right columns, so no live leak, but the three representations can drift silently.
- Recommended remediation: Drive the migration trigger generator (and/or the runtime redactor) from the `M*_AUDIT_DENYLIST` constants so there is one source; or delete the constants and document the migration SQL as canonical.
- Acceptance criteria: A new denylisted column in a constant produces a failing gate until its trigger exists.

## ARCH-021 — Duplicated regulatory money kernels across billing / cost-report / cap-management
- Severity: Medium
- Priority: P2
- Confidence: Confirmed
- Production blocker: No
- Evidence: packages/billing/src/domain/money.ts (199 L) and packages/cost-report/src/domain/money.ts (125 L) copy `toDecimal`/`fromDecimal`/`sumCents`/`ratio`/`allocateProportional` verbatim (billing/money.ts:13-15 says "the M27 …/money.ts precedent, adapted"); packages/cap-management/src/money.ts:8 adds a third `roundCents`. Both headers warn the math is "REGULATORY … a cent off is a real Medicare-payment consequence."
- Impact: A rounding/allocation fix in one copy silently misses the others on money that drives CMS payments.
- Recommended remediation: Extract one `@wardenx/money` (or put it in `packages/shared`) and have all three depend on it.
- Acceptance criteria: One implementation of `allocateProportional`; the others re-export it.

## ARCH-022 — `ROLE_TEMPLATES` serves 13 of the ~66 spec roles, and nothing seeds roles into the DB on production tenant provisioning
- Severity: Medium
- Priority: P2
- Confidence: High confidence
- Production blocker: No (onboarding gap)
- Evidence: `ROLE_TEMPLATES` has 13 entries (packages/auth/src/roles/templates.ts) though its own comment (:203-206) says the catalog is "≈60 system_default templates … enumerated in Appendix A" beyond the six locked ones. The live role-template API (`ROLE_TEMPLATES.map(templateView)`, 03-authorization/authz-ports.ts:316) therefore exposes 13. No production path materializes templates into `role` rows — only `scripts/db/*` dev seeds create them (and `seed.ts:181-200` duplicates `seed-org-admin.ts:98-131`). `org_admin` itself is now properly defined+seeded (templates.ts:247; drizzle-store.ts:156; seed.ts:72 / seed-org-admin.ts) — the historical org_admin-missing issue is RESOLVED.
- Impact: A newly provisioned production tenant has no role catalog unless a dev seed is run; the template API is a partial surface.
- Recommended remediation: Add a provisioning step that upserts `ROLE_TEMPLATES` per new org; complete the catalog or correct the docstring; de-duplicate the two seed copies.
- Acceptance criteria: Creating an org materializes the role catalog; template count matches the documented set.

## ARCH-023 — Dead-code census: ~40 zero-importer Drizzle tables (incl. behaviorally-suspicious `encounter_signatures`, `consent_revocation`) and ~140 zero-importer `packages/types` exports
- Severity: Low
- Priority: P3
- Confidence: Confirmed
- Production blocker: No
- Evidence: `packages/auth/src` is clean (zero orphaned exports). `packages/db` has ~40 schema consts with no query path — notably `encounterSignatures` (schema/encounter/encounter-signatures.ts:25) and `consentRevocation` (schema/consent/*), which are behaviorally suspicious (signature + consent-revocation storage with no read/write path), plus `auditSeals`, `auditExports`, `destructionCertificates`, `patientMerges/Phones/Emails/MatchReviews`, ~12 M30 pgEnums, etc. `packages/types` has ~140 orphans concentrated in external-interfaces.ts (22, consistent with M29's 501-deferral), event/idempotency taxonomies (`M15/M16/M22/M31/M35_*_EVENT_NAMES`), and `ERROR_CODES` (errors.ts:37 — the "one auditable place" for status mapping, unused; 15+ modules define their own `M*_ERROR_STATUS`). Also `packages/db/src/organization-settings/boot.ts:12,36` (`bootOrganizationSettingsRegistry`) has no `apps/backend` caller — if the registry is empty at runtime, M3's break-glass `cosignPolicy` (03-authorization/index.ts:113) falls through to its `false` default.
- Impact: Mostly hygiene; the encounter-signature / consent-revocation / org-settings-boot cases are worth confirming are truly not-yet-live vs. silently unwired features.
- Recommended remediation: Confirm each behaviorally-suspicious table is intentionally pending; delete or wire the org-settings boot; consolidate `ERROR_CODES` vs per-module status maps.
- Acceptance criteria: Zero-importer schema tables are either referenced by a feature or removed; the org-settings registry is booted or the fallback is documented as intended.

---

## Additional verified-fixed / non-findings

7. **`org_admin` vs `administrator`**: RESOLVED — `org_admin` is defined (packages/auth/src/roles/templates.ts:247), consumed (drizzle-store.ts:156), and seeded (seed.ts:72, seed-org-admin.ts). Two distinct roles by design. Residual: incomplete catalog + no prod seed (ARCH-022).
8. **In-memory `routes/service.ts` beside `*-route-service-db.ts`** (14 clinical modules, ~9,500 lines): NOT mounted in production — the composition root mounts only the Drizzle services (index.ts:1461-1480; removal documented at index.ts:503-505). Survives as the behavioral reference for the pure route/acceptance suites. Hygiene only. (Exception: M3/M4/M2 mounts DO bind some in-memory ports — ARCH-006/015/016/005.)
9. **Dynamic cross-module imports**: clean — every `import(...)` outside tests is type-position; no runtime `await import()` crosses a module boundary.
10. **Raw-SQL cross-module table access**: clean — the `scanEvasions()` path covers `sql\`` literals; no cross-module raw-SQL table reference found (the gap is the `schema.X` style, ARCH-017).
11. **501 routes**: all 44 are honest, typed, documented deny-stubs (M28/M29/M36/M39/M40 Phase-1 deferrals); no fake surface hides behind a 501. The fake surfaces return 200 with empty/in-memory data instead (ARCH-003/018).
12. **Module-local `permission-keys.ts` (21 files)**: clean re-exports of the `@wardenx/auth` canonical maps — no drift possible.
