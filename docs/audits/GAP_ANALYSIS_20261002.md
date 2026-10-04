# WardenX Gap Analysis — 2026-10-02

Generated: 2026-10-03T00:12:31Z · Repository: WardenX (`/Users/fabrice/Apps/x2/wardenx4`, branch `main` at `4ba54589d`) · Brief: `docs/audits/GAP_ANALYSIS_AUDIT_PROMPT.md`

Synthesised from 13 audit workers (8 module batches, plus fitness, seams, UI, security, docs and discovered-gap workers). No worker failed. Every P0/P1 below passed an independent evidence-verification pass (a separate re-read and counter-evidence search). P2/P3 findings carry the verification flag the worker or verifier gave them. Near-duplicate findings were merged (merges are listed in Section 7). After deduplication the report holds **188 findings**.

## 1. Executive summary

| Severity | Count |
|---|---|
| P0 | 1 |
| P1 | 72 |
| P2 | 80 |
| P3 | 35 |
| **Total** | **188** |

### Top 5 risks (could break prod or block certification)

1. **Cross-tenant takeover via role-key spoofing (GAP-001, P0).** A tenant admin can create a custom role named `platform_ops`, assign it to themselves and suspend or close another tenant. Platform-operator status is decided by a role-key string, and tenants can mint any key.
2. **Production ships with no CI gate (GAP-072).** The deploy.yml `verify` job is commented out and ci.yml no longer runs on PRs to main. Every main push builds and deploys a PHI-bearing image without build, typecheck, arch:fitness or tests.
3. **Minimum-necessary PHI access is not enforced inside a tenant.** `caseload_or_scope` is declared but never composed on orders, prescribing, eMAR, IDG packets, visits, labs and consents (GAP-015, GAP-016, GAP-021, GAP-027, GAP-030, GAP-052, GAP-070). Several route headers wrongly claim the default ABAC binds it; this is the unremediated F-092 pattern. Related gaps: no server-side session timeouts (GAP-002), PHI search needles written to nginx access logs (GAP-073), and M29 lab reads with no read audit (GAP-051).
4. **Revenue and compliance pipelines are silently inert.** M23 NOE/NOTR window-watch and revalidation never run (GAP-042, GAP-043). The validation override and eligibility check always return 503 (GAP-044, GAP-045). M25 rejection consumers are never constructed, so rows stay pending forever and the gate reports a false green (GAP-047). M24 room-and-board days are never created (GAP-046). No EVV aggregator submission exists (GAP-035). The CAHPS sample silently reads nothing under RLS (GAP-055).
5. **Clinical-safety controls are bypassable or unbuilt.** The controlled-substance witness requirement is keyed on a client-supplied medClass (GAP-020). Late-entry tiers are never computed and author ABAC is missing (GAP-011, GAP-012). Emitted IDG decisions can be rewritten (GAP-023). There is no lone-worker overdue detector (GAP-039). M30 outbreak and sentinel alerts reach nobody (GAP-056). Post-death consent termination is hard-coded off (GAP-071).

**Overall health:** The structural fitness kit is fully green: build, typecheck, 38 gates, 10,668 tests and a clean `bun audit`. Behind that, the platform has one P0 tenancy break, a disabled deploy gate, and a broad layer of unenforced intra-tenant ABAC and unbuilt workers. Several core clinical, revenue and compliance flows are therefore not certification-ready.

## 2. Fitness kit results

| Command | Pass/Fail | Metric | Non-green output | Failure class (code/test-infra/unverified) |
|---|---|---|---|---|
| `bun install --frozen-lockfile` (exit 0) | Pass | Lockfile reproducibility / install | None ('Checked 523 installs across 650 packages (no changes)') | none |
| `bun run build` (exit 0) | Pass | tsc -b project-reference build | None (incremental; full type pass covered by typecheck) | none |
| `bun run arch:fitness` (exit 0) | Pass | 38 architecture-fitness gates | All 38 pass. Informational: 12 migration ordinal gaps + 21 frozen duplicate pairs; 1 deferred registrar (registerMessagingWebhookRoutes, M36); 2 declared-but-unbound outbox pairs (m22); 169 live bindings / 174 of 704 events; 89 subscription-list exceptions; 1 registered body disagreement (Stripe webhook); 86 unplaced openapi provenance pairs; frame-fidelity 3 green / 14 partial; E2E reaches 19/157 screens, axe 151/157 | none |
| `bun run status:matrix` (exit 0) | Pass | Implementation-status matrix | None (40 Implemented / 0 Partial / 0 Placeholder; report fresh) | none |
| `bun run openapi:coverage` (exit 0) | Pass | OpenAPI enrichment ratchet | 1338/1343 enriched; 5 unenriched bootstrap routes (/health, /ready, /version, /metrics, /api/v1/system/feature-flags); 8/550 GETs without response schema (5 bootstrap, HOPE package ZIP, volunteer-hour-ratio, msw-risk-factors); 1/760 unpublished body (Stripe webhook) | none |
| `bun run ui:parity` (exit 0) | Pass | Screen-spec corpus vs registered screens | 113 specs / 302 screens / 3 apps; report fresh (no per-spec join, see GAP-146) | none |
| `bun run frame:fidelity` (exit 0) | Pass | Mockup frame-fidelity ledger | 17 mapped of 120 frames: 3 matched / 14 partial / 0 pending (see GAP-148) | none |
| `bun run test` (exit 0) | Pass | Non-live vitest (2 projects) | 714 files passed, 255 skipped (live/RLS, DB-gated); 10,668 tests passed, 2,825 skipped, 12 todo; 88.4 s | none |
| `bun run arch:abac-predicates` (exit 0) | Pass | requireAbac names registered | None (173 declared, 135 used across 243 guards) | none |
| `bun audit` (exit 0) | Pass | npm advisory scan | 'No vulnerabilities found' (8 Trivy image suppressions in .trivyignore.yaml expire 2026-12-31) | none |
| `bun run typecheck` (exit 0) | Pass | tsc -b + test tsconfigs | None | none |
| `bun run check:boot:platform` (exit 1) | Fail | Production-config boot with platform credential | 'DATABASE_PLATFORM_URL is required — this check exists to exercise the platform-credential boot.' (unset locally; CI outbox-boot job sets it, .github/workflows/ci.yml:980-986) | test-infra |

## 3. Per-module gap table

Rows are ordered by severity, then module. The full evidence lists are in the Section 8 JSON appendix; the table shows up to three citations per row.

| ID | Module | Area | Gap | Evidence | Severity | Verified | Recommended fix |
|---|---|---|---|---|---|---|---|
| GAP-001 | M03 | RBAC / role catalog | Tenants can create custom roles whose keys match platform-ops keys (platform_ops, platform_admin, ...). Self-assigning one passes the platform-only gates, so a tenant admin can suspend or close ANOTHER tenant (close is terminal and deletes its sessions). Static trace; not run live. | apps/backend/src/modules/03-authorization/routes/authz-typebox.ts:150 (key pattern ^[a-z0-9_]+$, no reserved-key exclusion)<br>apps/backend/src/modules/03-authorization/routes/authz-routes.ts:114-128 (assertNoEscalation compares permission keys only); :148-176 POST /api/v1/roles; :258-292 role assign (no self-grant / role-key check)<br>apps/backend/src/modules/03-authorization/role-store.ts:184-210 (createCustom inserts key as given)<br>(+5 more) | P0 | true | Reject tenant role create/rename whose key is in PLATFORM_OPS_ROLE_KEYS, any template key or ORG_WIDE_SCOPE_ROLES (authz-routes.ts / role-store.ts) and add a DB CHECK/trigger on role (organization_id IS NOT NULL => key not reserved). Better: decide platform-operator status from a platform-owned fact (platform-org membership or org_id IS NULL template role ids), not a key string. Audit every hasRole()/requireRole() caller. |
| GAP-002 | M02 | Session policy | Binding SESSION_POLICY timeouts (staff 15-min idle / 8h absolute / 24h hard; auditor 10-min idle) are not enforced server-side. Better Auth sets no expiresIn/updateAge (library default lifetime applies); the authenticate hook has no idle/absolute check; only the client screen-lock overlay reads the policy, and POST /api/v1/auth/screen-unlock does not exist (HIPAA 164.312(a)(2)(iii)). | packages/types/src/policy/session-policy.ts:62-72<br>apps/web/src/modules/02-identity/screen-lock.tsx:1,19,25 (only runtime consumer of SESSION_POLICY)<br>packages/auth/src/identity/auth.ts:270-300 (session block has only additionalFields)<br>(+3 more) | P1 | true | Set Better Auth session.expiresIn/updateAge from SESSION_POLICY and enforce per-class idle/absolute limits in the authenticate hook (compare session.updatedAt/createdAt; revoke and 401 on breach). Implement POST /api/v1/auth/screen-unlock. |
| GAP-003 | M02 | Tenant onboarding routes | No API or production code creates provider_entity or location rows; only GET /api/v1/provider-entities and GET /api/v1/locations exist. A new tenant cannot register CCN/NPI/MAC or locations in-product; the provider-entity resolver fails closed (503) with zero entities. Only scripts/db/seed-org-structure.ts inserts them. | docs/modules/WARDENX_MODULE_02_IDENTITY_SPEC_v0_4.md:754-755<br>apps/backend/src/bootstrap/routes/provider-entities.ts:27-28; apps/backend/src/bootstrap/routes/locations.ts:46-47 (GET only)<br>apps/backend/src/bootstrap/provider-entity-resolver.ts:13-14 (zero entities -> 503)<br>(+1 more) | P1 | true | Add org_admin-gated POST/PATCH /api/v1/provider-entities and /api/v1/locations, or provision them in the M34 tenant-provision flow; enrich in scripts/openapi/enrichments.ts. |
| GAP-004 | M03 | Break-glass / engagements / boot gate | Break-glass Compliance notification, auditor engagements and auditor sessions are in-memory on the production mount; the spec's m3.breakglass.invoked/ended, m3.engagement.closed, m3.role.assigned/revoked outbox events do not exist (no events-by-m3.ts) and the reap/close crons are absent. The TASK-001 ledger makes a NODE_ENV=production boot throw unless WARDENX_INMEM_ASSERT=warn, which no tracked deploy config sets, so prod either refuses to boot or runs with that downgrade permanently set (silencing every in-memory binding). Critical audit row on break-glass still survives. | apps/backend/src/modules/03-authorization/index.ts:86-89,156-158 (createInMemory* engagements/auditorSessions/notifier)<br>apps/backend/src/modules/03-authorization/authz-ports.ts:621-634 (in-memory notifier pushes to array)<br>apps/backend/src/modules/03-authorization/routes/authz-routes.ts:360-366 (comment claims outbox path; calls in-memory notifier)<br>(+4 more) | P1 | true | Add apps/backend/src/modules/03-authorization/events-by-m3.ts (m36 as consumer) and publish inside break-glass/engagement/role transactions; replace in-memory engagement/auditor-session/notifier with Drizzle stores over auditor_engagement; add reap/close crons; remove the ledger note. Until then document the production WARDENX_INMEM_ASSERT decision in deploy/production/README.md. |
| GAP-005 | M04 | Exports / destruction / retention / integrity workers | M4 BullMQ workers are never constructed: audit exports stay 'pending' forever (no object-store adapter), approved destruction certificates never execute, the daily retention scan never opens certificates, partitions are never tiered and the quarterly integrity sample never runs. Documented deferral, fail-closed, but auditor exports and retention-driven destruction are not delivered. | apps/backend/src/modules/04-audit/routes/audit-exports.ts:5-15<br>apps/backend/src/modules/04-audit/routes/destruction-certificates.ts:5-17<br>apps/backend/src/index.ts:4117-4123 (registerAuditWorkers/scheduleAuditJobs 'stay deferred')<br>(+2 more) | P1 | true | Build Drizzle-backed AuditJobAdapters (BuildExportPorts.store over a shared S3/MinIO adapter, ExecuteDestructionPorts, archive, integrity sample) and call registerAuditWorkers/scheduleAuditJobs in the worker-runner block of apps/backend/src/index.ts. |
| GAP-006 | M05 | Routes / ABAC | POST /api/v1/patients/:id/payers checks patient.edit instead of patient.edit_payers and is the only per-chart route without a caseload_or_scope guard; any patient.edit holder can rewrite coverage (billing-relevant) on any chart in the tenant. Missing patient throws plain Error -> 500. | apps/backend/src/modules/05-patient/routes/patient-routes.ts:307-323 (preHandler [EDIT] only); :385-387 sibling uses [EDIT, SCOPE_EDIT]<br>docs/modules/WARDENX_MODULE_05_PATIENT_SPEC_v0_4.md:1243<br>packages/auth/src/permissions/contributed.ts:314-319 (patient.edit_payers unused)<br>(+1 more) | P1 | true | Use preHandler [requirePermission('patient.edit_payers'), chartScope('patient.edit_payers')] and throw NotFoundError on a missing patient. |
| GAP-007 | M05 | Outbox emit | Production M5 write routes publish no outbox events: admit, addAddress, addPayer, submitAmendment, decideAmendment write rows only (addAddress even returns a false cascadeEmitted literal). Bound live consumers (M12 DoseSpot sync, M24 revalidate, M33 census refresh, M22 statement of disagreement) never fire on route-driven changes. | apps/backend/src/modules/05-patient/patient-route-service-db.ts:8-10 (header lists outbox emission as follow-up); :686-723 (cascadeEmitted literal at :722)<br>apps/backend/src/modules/05-patient/index.ts:243-248 (outbox passed only to merge path)<br>repo grep for m5.patient.(created\|address_changed\|payer_changed\|amendment_decided) -> consumers + catalog + in-memory fake only<br>(+1 more) | P1 | true | Thread m5OutboxPublisher into createDbPatientRouteService and publish m5.patient.created / address_changed / payer_changed / amendment_request_received / amendment_decided inside the write's withOrgContext transaction. |
| GAP-008 | M05 | Care-team assignment | No production path creates patient_assignment rows (spec section 4.3 assignment write routes not implemented; inserts exist only in tests/seeds). The caseload source of truth is therefore empty: a non-org-wide clinician sees an empty census except via M17 shift data. Fails closed but care-team management is unusable. | docs/modules/WARDENX_MODULE_05_PATIENT_SPEC_v0_4.md:1246-1248<br>apps/backend/src/modules/05-patient/routes/patient-routes.ts:325-336 (only read-only GET /care-team)<br>apps/backend/src/modules/05-patient/seams/drizzle-stores.ts:413-442 (reads patient_assignment)<br>(+1 more) | P1 | true | Implement GET/POST /patients/:id/assignments and POST .../assignments/:assignmentId/end (patient.assign + caseload_or_scope, caseload-cache invalidation, emits) in patient-routes.ts / patient-route-service-db.ts; enrich in scripts/openapi/enrichments.ts. |
| GAP-009 | M05 | Routes / soft-match | 13 of 29 spec section 4.3 routes are not implemented (PATCH /patients/:id, status, deceased, identifiers POST, caregivers, assignments, patient-matches queue, unmerge, privacy resync, amendment list/statement). Demographics cannot be corrected after admit, and soft-match triage (0.75-0.92, spec D2) is skipped: admit returns matchReviewIds: [] and writes no patient_match_review. Status matrix shows 16/16 routes. (Death recording still works via the M6 discharge-death consumer.) | docs/modules/WARDENX_MODULE_05_PATIENT_SPEC_v0_4.md:1232-1260,311<br>apps/backend/src/modules/05-patient/routes/patient-routes.ts:215-456 (16 routes)<br>apps/backend/src/modules/05-patient/patient-route-service-db.ts:354-356 (soft_review -> [])<br>(+1 more) | P1 | true | Add the missing handlers with the spec permission/ABAC pairs; persist patient_match_review rows on soft_review; enrich in scripts/openapi/enrichments.ts; document extras (census-metrics, demographics, care-team) in the spec. |
| GAP-010 | M06 | UI | No UI for live discharge, revocation, transfer-out/in or for-cause cosign, although the backend routes are live and in the typed client. The 06-admission web module's 8 screens include none of these, so staff cannot end or move a hospice episode (drives election close, LOC end, NOTR, final claim) from the UI. | apps/backend/src/modules/06-admission/routes/admission-routes.ts:1022,1044,1065,1091,1113<br>apps/web/src/modules/06-admission/screens.ts:42-100<br>apps/web/src/modules/06-admission/admission-detail.tsx:139,1946<br>(+1 more) | P1 | true | Add a discharge/revocation/transfer stepper screen (e.g. admission.discharge at /admissions/:id/discharge) in apps/web/src/modules/06-admission, launched from admission-detail.tsx, calling the four POST routes plus cosign-for-cause via the typed client; register it and add a DOM test. |
| GAP-011 | M08 | Late-entry tiers | Late-entry tier is never computed and the override sign-gate never runs: finalize never sets encounter.late_entry_tier (stays 'normal'), sign never checks for an override, and computeLateEntryTier / override deciders run only in unit tests. Override routes overwrite the tier with no tier-mismatch check and emit daysLate: 0; billing receives 'normal' for every encounter. | apps/backend/src/modules/08-encounters/encounters-route-service-db.ts:1668-1736 (finalize UPDATE at 1702-1707 omits tier); :1774 (sign); :1953-2011 (overrides, daysLate: 0 at 1978/2008)<br>grep computeLateEntryTier\|checkLateEntryOverrideSatisfied -> apps/backend/__tests__/encounter-late-entry.test.ts + barrel only<br>apps/backend/src/modules/08-encounters/gate/checks.ts:78-86 (late_entry_ceiling marked 'elsewhere')<br>(+1 more) | P1 | true | In finalize() compute the tier with computeLateEntryTier and persist it; in sign()/signAddendum() call checkLateEntryOverrideSatisfied; in the override methods call decideSignificantLateOverride/decideAdministrativeLateOverride with the real tier, role and step-up and emit the real daysLate. |
| GAP-012 | M08 | ABAC / routes | Author-ownership ABAC (is_author, is_author_or_supervisor, is_addendum_author) is never registered or composed; finalize/enhance/decisions/sign, vitals/mileage/link-delete/evv-reconcile and addenda routes are permission-gated only and most lack encounter.scope. Any encounter.sign holder can sign another clinician's note anywhere in the tenant. | apps/backend/src/modules/08-encounters/routes/encounters-routes.ts:291,303,352,364,436,448,463,477,488,500,626,658,669<br>apps/backend/src/modules/08-encounters/abac-predicates.ts:44 (only m8.cosigner_role_match, encounter.scope)<br>packages/auth/src/permissions/contributed.ts:1003,1009,1033,1063,1069 (declaration only)<br>(+2 more) | P1 | true | Register encounter.is_author / is_author_or_supervisor / is_addendum_author in 08-encounters/abac-predicates.ts and compose them plus SCOPE_FOR on routes 4-7, 9-14, 23-25. |
| GAP-013 | M08 | Step-up | Late-entry override, administrative >14-day override and cosignature supervisor-release (spec rows 15, 16, 21) have no server-verified step-up; the TypeBox schemas still require a client stepUpAuthAt that nothing reads, and the route header wrongly claims route 21 carries step-up. | apps/backend/src/modules/08-encounters/routes/encounters-routes.ts:510-521,524-535,593-605 (permission only); :134 STEP_UP used only at 500/582/669; :12-14 header<br>apps/backend/src/modules/08-encounters/routes/encounters-typebox.ts:211-227<br>apps/backend/src/modules/08-encounters/cosignature/cosignature.ts:134-152<br>(+1 more) | P1 | true | Add STEP_UP('encounter.late_entry_override'), STEP_UP('encounter.administrative_override'), STEP_UP('encounter.cosign_supervisor_release') to those preHandlers and drop stepUpAuthAt from the schemas. |
| GAP-014 | M08 | EncounterCreator seam | EncounterCreator is registered over the Drizzle store, which spreads the in-memory fallback and does not override insertDraftEncounter. Production drafts go to a per-process array with counter-derived ids (00000000-0000-4000-8000-...), which M19 links to triage calls (and M17 visit seeding uses). Calls can never reach 'documented' and ids collide across orgs/restarts. | apps/backend/src/index.ts:1172<br>apps/backend/src/modules/08-encounters/seams/drizzle-store.ts:12-15,56-58<br>apps/backend/src/modules/08-encounters/seams/store.ts:98-101,135-147<br>(+2 more) | P1 | true | Implement insertDraftEncounter in seams/drizzle-store.ts as a real INSERT into encounter under withOrgContext via M8's draft path (audit + outbox); port or explicitly deny renderPayload and mileageForClinician so no in-memory method is reachable in production. |
| GAP-015 | M11 | ABAC / minimum-necessary | No M11 PHI route enforces caseload_or_scope (GET /orders, /orders/:id, discontinue, queues); the route header falsely claims it is bound by default ABAC, which requirePermission never reads (unremediated F-092). Any orders.read holder reads every patient's orders in the org. | apps/backend/src/modules/11-orders/routes/orders-routes.ts:10-11 (false header); :127-134 (only discipline/signer/cosigner ABAC); :140-156,272-283,394,547-562 ([READ]/[DISCONTINUE] only)<br>packages/auth/src/rbac/require-role.ts:126-135<br>docs/modules/WARDENX_MODULE_11_ORDERS_SPEC_v0_4.md:1187,1563,2421<br>(+1 more) | P1 | true | Compose requireAbac(<key>, 'caseload_or_scope', {notFoundOnDeny:true}) on per-order/per-patient routes and narrow list/queue SQL by M5 caseloadPatientIds unless hasOrgWideScope (F-096 pattern); correct the header. |
| GAP-016 | M12 | ABAC / minimum-necessary | M12 order list/detail/transmission and /patients/:id/medications/active\|history routes have no caseload_or_scope; only the refill inbox is narrowed. Any prescribing.read holder reads every patient's active medication list. Header falsely claims default-ABAC binding. | apps/backend/src/modules/12-dosespot/routes/dosespot-routes.ts:10-12,111-123,129-133,180-183,366-369,380-404<br>apps/backend/src/modules/12-dosespot/dosespot-route-service-db.ts:424-451,488-496 (no caseload predicate); :157-251,856-886 (refill-only narrowing)<br>docs/modules/WARDENX_MODULE_12_DOSESPOT_PRESCRIBING_SPEC_v0_2.md:1025-1048,1261-1273 | P1 | true | Add requireAbac('prescribing.read','caseload_or_scope',{notFoundOnDeny:true}) to per-order/per-patient routes; narrow GET /medication-orders in SQL via the existing caseloadPatientIds helper unless hasOrgWideScope. |
| GAP-017 | M12 | DoseSpot adapter | No live DoseSpot transport: packages/dosespot/src/client has no http.ts and no fetch; the worker defaults to the deny-stub client and index.ts passes none, so NewRx, patient sync, enrollment and med-history never reach DoseSpot in any environment. Documented Phase-1 deny-stub; status matrix shows M12 Adapter green. | packages/dosespot/src/client/unbound.ts:1-6<br>apps/backend/src/modules/12-dosespot/jobs/worker.ts:34-38,119<br>apps/backend/src/index.ts:5382-5389 (no doseSpotClient passed)<br>(+1 more) | P1 | true | Build packages/dosespot/src/client/http.ts (circuit-breaker-wrapped, per-tenant credentials), add DOSESPOT_* to apps/backend/src/bootstrap/env.ts and .env.example, bind it in the composition root when configured; tighten the status-matrix adapter heuristic. |
| GAP-018 | M12 | Rx-benefit route | POST /api/v1/rx-benefit/lookup returns a hardcoded {covered: true, copayCents: null} for every drug and patient instead of failing closed; no RxBenefit client method or cache exists. Fabricated coverage data on a live production API (no UI caller today). | apps/backend/src/modules/12-dosespot/dosespot-route-service-db.ts:994-996<br>apps/backend/src/modules/12-dosespot/routes/service.ts:366-370,1019-1021<br>apps/backend/src/modules/12-dosespot/routes/dosespot-routes.ts:489-494<br>(+1 more) | P1 | true | Add a lookupRxBenefit client method and route rxBenefitLookup through it; return 503 or formularyStatus:'unknown' while unbound, never covered:true. |
| GAP-019 | M12 | Admin policy / schema | refill_inbox_policy and controlled_substance_policy tables do not exist; GET returns hardcoded defaults, PATCH persists nothing yet emits m12.controlled_substance_policy_changed {before, after}, and tighten-only refusals return 404 NOT_FOUND. Enforcement sites read DEFAULT_CS_POLICY constants directly. Fail-safe but the audit trail records changes that never took effect. | apps/backend/src/modules/12-dosespot/dosespot-route-service-db.ts:1082-1122; :549,608,916 (DEFAULT_CS_POLICY reads)<br>packages/types/src/errors.ts:83-89<br>docs/modules/WARDENX_MODULE_12_DOSESPOT_PRESCRIBING_SPEC_v0_2.md:91,399,537-538,2105 | P1 | true | Add both tables via a new migration (RLS, FORCE, audit trigger) and to M12 ownedTables in architecture/module-manifest.ts and .cjs; persist put*, read stored values in refill approve and the EPCS gate, use 409/422 for tighten-only refusals. |
| GAP-020 | M13 | Medication safety | Controlled-substance witness requirement and administering-discipline ABAC are keyed on the client-supplied body medClass; the order port carries no controlled-substance flag although M12 exposes isControlledSubstance. Sending medClass:'standard' for a Schedule II order skips the witness. Offline-sync is [RECORD] only and checks no per-row eligibility despite its comment. Five-rights validation against the order is still open (documented). | apps/backend/src/modules/13-emar/emar-route-service-db.ts:714,836 (isControlled from body); :171-192 (port lacks class); :42-44 (five-rights open); :1318; :1336-1344 (offlineSync loop)<br>apps/backend/src/modules/13-emar/index.ts:38-53<br>apps/backend/src/modules/12-dosespot/seams/providers.ts:139<br>(+2 more) | P1 | true | Carry isControlledSubstance/medClass from M12 getAdministrationContext into the administrationIdentity port; derive isControlled from the order and 422 on body disagreement; evaluate eligibility per row in offlineSync; implement the five-rights comparison. |
| GAP-021 | M13 | ABAC / minimum-necessary | eMAR read and many write routes (administrations, scheduled/missed doses, reconciliation, comfort-kit deployments) have no caseload_or_scope check; the header claims a binding that does not exist (named in F-092, unresolved). Services take no caseload input. | apps/backend/src/modules/13-emar/routes/emar-routes.ts:11-13 (header); :100-122 (no caseload guard); :270-297,303,368,396,421,435,523,537<br>apps/backend/src/modules/13-emar/abac-predicates.ts:24-25<br>docs/modules/WARDENX_MODULE_13_EMAR_SPEC_v0_2.md:1275-1300,1490-1507<br>(+1 more) | P1 | true | Compose requireAbac(..., 'caseload_or_scope', {notFoundOnDeny:true}) per spec row in emar-routes.ts; narrow list routes in SQL via M5 caseloadPatientIds unless hasOrgWideScope. |
| GAP-022 | M13 | Step-up / void | Administration hard-void and the admin-policy PUT have no step-up (comments say 'enforced upstream'; no upstream gate exists) and no clinical_supervisor_or_above check; worksheet void and kit acknowledge-return lack supervisor predicates. voidAdministration has no status guard and bypasses the pure machine, so an already voided/superseded row can be voided again (second voided event). Diversion-relevant. | apps/backend/src/modules/13-emar/routes/emar-routes.ts:74,262-268,510,576-577<br>apps/backend/src/modules/13-emar/emar-route-service-db.ts:1273-1292,349-353<br>packages/emar/src/lifecycle/administration-record.ts:13,122-123,309<br>(+2 more) | P1 | true | Add requireStepUp('administration.void') plus a clinical_supervisor_or_above predicate to void; step-up on the admin-policy PUT; supervisor predicates on worksheet void and kit ack-return; refuse voided/superseded rows with 409. |
| GAP-023 | M14 | Decision integrity | PATCH /idg/decisions/:id rewrites emitted or superseded decisions: updateDecision has no status guard (unconditional UPDATE), no edit guard exists in packages/idg, no immutability trigger exists, and the route lacks idg_meeting_scope. Minutes already published to M7/M11/M12 can be silently rewritten; three code comments rely on the non-existent invariant. | apps/backend/src/modules/14-idg/routes/idg-routes.ts:602-608<br>apps/backend/src/modules/14-idg/idg-route-service-db.ts:1797-1820; :1319 (comment relying on invariant)<br>packages/idg/src/lifecycle/decision.ts:62,94,124<br>(+2 more) | P1 | true | Add planDecisionEdit (DECISION_NOT_OPEN 409 unless open) to packages/idg/src/lifecycle/decision.ts; call it in updateDecision with a conditional UPDATE ... WHERE status='open'; add idg_meeting_scope and If-Match. |
| GAP-024 | M14 | Supersession | Supersede writes the successor into the prior (already adjourned) meeting with the prior payload, hardcodes wasQuorate: true, ignores the request body and skips quorate_decision and idg_meeting_scope. The successor stays 'open' forever (emit only happens at adjournment), while the prior is marked superseded. | apps/backend/src/modules/14-idg/idg-route-service-db.ts:1822-1855; :1273-1281 (only emit path)<br>packages/idg/src/lifecycle/decision.ts:124-138<br>apps/backend/src/modules/14-idg/routes/idg-routes.ts:611-620 (vs record route :584-587)<br>(+2 more) | P1 | true | Require a target live meetingId and new payload in SupersedeDecisionRequest; gate with idg_meeting_scope + quorate_decision on the target; insert the successor into the target meeting with live quorum; mark the prior superseded in the same tx. |
| GAP-025 | M14 | Agenda routes | PATCH /idg/agenda/:id discards its body and returns the row unchanged (undocumented); DELETE /idg/agenda/:id returns {removed: true} without writing (documented compromise #2). Because a patient-scoped agenda item is the Phase-1 decision-inclusion signal, a 'removed' patient stays decision-eligible. Both routes lack idg_meeting_scope. | apps/backend/src/modules/14-idg/routes/idg-routes.ts:551-556,559-563<br>apps/backend/src/modules/14-idg/idg-route-service-db.ts:1528-1547; :22-27 (compromises); :253-265 (patientIncluded)<br>packages/db/migrations/0042_idg_m14_tables.sql:60-74<br>(+1 more) | P1 | true | Add a status/tombstone column (new migration, check arch:migration-numbering); implement real update and soft delete and exclude removed items from patientIncluded; return 501/409 until then; add idg_meeting_scope via meeting resolution. |
| GAP-026 | M14 | ABAC / concurrency | Child-resource mutations (attendance, agenda, decisions, supersede, action-items, recurring-policies) skip idg_meeting_scope, If-Match and Idempotency-Key (only discipline-notes PATCH implements the pattern); a location-A coordinator can edit location B's meetings. Attendance (418.56 quorum evidence) can be changed after adjournment and action-item updates do not check the assignee. | apps/backend/src/modules/14-idg/routes/idg-routes.ts:210,428,436,551,559,603,611-613,684,692; :868-889 (discipline-notes pattern)<br>apps/backend/src/modules/14-idg/abac-predicates.ts:6-10,71-73<br>apps/backend/src/modules/14-idg/idg-route-service-db.ts:1475-1502,1894-1922<br>(+1 more) | P1 | true | Generalise the discipline-notes pattern: resolve meetingId from the child id, apply requireAbac(<key>,'idg_meeting_scope'), add IF_MATCH and IDEMPOTENCY_KEY to every PATCH/DELETE; refuse attendance changes post-start/adjourn; require assignee===actor for idg.act-only callers. |
| GAP-027 | M14 | ABAC / minimum-necessary | IDG patient packet detail/list and GET /patients/:patientId/idg-history skip the per-patient caseload_or_scope check (only meeting-location scope + SUD filter; idg-history has only idg.read). The abac-predicates.ts header falsely claims caseload is carried. | apps/backend/src/modules/14-idg/routes/idg-routes.ts:118-119,459-475,478-516,518-533<br>apps/backend/src/modules/14-idg/abac-predicates.ts:38-39<br>docs/modules/WARDENX_MODULE_14_IDG_SPEC_v0_4.md:872-873,1362,1437-1438 | P1 | true | Add requireAbac('idg.read','caseload_or_scope',{notFoundOnDeny:true}) with a patientId target to packet detail and idg-history; filter the packet list per patient by caseload unless hasOrgWideScope. |
| GAP-028 | M16 | Workers | M16 has no BullMQ workers: plans never close at death+13 months (CoP 418.64(d)), outreach never becomes 'missed' (so /outreach/:id/late-attempt can never succeed), anniversary alerts never fire and the unreachable detector never proposes. No documented deferral. | apps/backend/src/modules/16-bereavement (no jobs/ directory)<br>apps/backend/src/modules/16-bereavement/lifecycle/plan.ts:108,145,148,373; lifecycle/outreach.ts:56,83-85,177-189 (no callers)<br>apps/backend/src/modules/16-bereavement/routes/outreach.routes.ts:143-148<br>(+2 more) | P1 | true | Add apps/backend/src/modules/16-bereavement/jobs/ with close-13mo, miss-deadline, anniversary-lookahead and unreachable-detector crons (active-org fan-out, withOrgContext, DB-state pre-check) wired in index.ts. |
| GAP-029 | M16 | Outbox consumers | M16 section 4.5 subscriptions to m8.encounter.signed (bereavement_contact -> contact_log + complete outreach), m22.document.rendered (rendered_document_id) and m4.legal_hold.* are unbuilt; producers do not declare m16, so arch:outbox-bindings is silent. The M8 bereavement_contact subscriber is part of the spec's binding done gate. | apps/backend/src/modules/16-bereavement/outbox-consumers/ (7 consumers, none for these events)<br>apps/backend/src/modules/08-encounters/events-by-m8.ts:142; apps/backend/src/modules/22-documents/events-by-m22.ts:72; apps/backend/src/modules/04-audit/events-by-m4.ts:37,47<br>docs/modules/WARDENX_MODULE_16_BEREAVEMENT_SPEC_v0_5.md:55,1456-1466 | P1 | true | Add M16 outbox consumers for m8.encounter.signed (encounter_type=bereavement_contact) and m22.document.rendered (bereavement templates); add m16 to the producers' declaredConsumers and bind both in apps/backend/src/index.ts. |
| GAP-030 | M17 | ABAC | M17 visit reads (list, get, day/week/map views, proposals) and visit.start/arrive are gated by requirePermission only; listVisits applies no caseload or own-membership filter and visit.read_team is never checked. Any field clinician lists every patient's visits and address ids in the org. | apps/backend/src/modules/17-scheduling/routes/scheduling-routes.ts:86-87,165-196,231-310,474-495<br>apps/backend/src/modules/17-scheduling/scheduling-route-service-db.ts:852-885,2061-2075<br>packages/db/migrations/0045_scheduling_m17_rls_audit_triggers.sql:182-186 (org-only RLS)<br>(+1 more) | P1 | true | Bind requireAbac(key,'caseload_or_scope',{getTarget: patientId from visit}) on per-visit routes; narrow listVisits/dayView/weekView to caseload or own membership unless visit.read_team or org-wide scope. |
| GAP-031 | M17 | Routes (own vs any) | Own-vs-any permission scoping is not enforced for availability and time-off: routes gate on *_own keys only and services ignore the caller, so any clinician can overwrite a colleague's availability, cancel their approved PTO or file PTO on their behalf (PTO feeds the not_on_pto scheduling gate). | apps/backend/src/modules/17-scheduling/routes/scheduling-routes.ts:102-106,412-472<br>apps/backend/src/modules/17-scheduling/scheduling-route-service-db.ts:1871-1905,1908-1955,2037-2058<br>docs/modules/WARDENX_MODULE_17_SCHEDULING_SPEC_v0_2.md:710-715,976-983,991-992 | P1 | true | Resolve own-vs-any: require edit_any/read_team/approve when the target membership is not the caller's; force requestTimeOff.membershipId to the caller unless approve; add an ownership check to cancelTimeOff. |
| GAP-032 | M17 | PTO reassignment scan | PTO approval never runs the reassignment scan or emits m17.reassignment_needed; affectedPublishedVisitCount and conflictingVisitCount are hardcoded 0 and no reassignment-scan worker exists (route comment falsely says it runs in-service). Visits assigned to a clinician on approved PTO stay published with no alert. | apps/backend/src/modules/17-scheduling/scheduling-route-service-db.ts:1963,1984,2000<br>apps/backend/src/modules/17-scheduling/jobs/index.ts (only recurringMaterialize, visitAttention)<br>packages/scheduling/src/lifecycle/effects.ts:64<br>(+2 more) | P1 | true | In approveTimeOff's tx select overlapping published visits, emit m17.reassignment_needed (reason 'pto') per visit and populate the real counts in both events. |
| GAP-033 | M17 | Audit attribution | M17 (36 call sites) and M18 (25) open withOrgContext with userId: "", so M4 write-audit triggers record a NULL actor_user_id on visit, time_off, availability, evv_event and missing-resolution writes. Same pattern in the M5-M11 and M39 route services (documented 'M8-M17 convention' compromise). | apps/backend/src/modules/18-evv/evv-route-service-db.ts:19-21 (compromise 1)<br>apps/backend/src/modules/17-scheduling/scheduling-route-service-db.ts:1070-1093 (cancelVisit drops userId)<br>packages/db/migrations/0045_scheduling_m17_rls_audit_triggers.sql:258 (NULLIF(app.user_id,''))<br>(+2 more) | P1 | true | Pass the acting user/membership id into withOrgContext in every route DB service (M5-M11, M17, M18, M39), as M16/M19/M20 do. |
| GAP-034 | M18 | EVV geofence | EVV capture decides 'pass' from GPS accuracy alone and never computes distance to the patient address, yet emits m18.evv.at_patient_address (and breach) with a fabricated computedDistanceM: 0 and then visit_verified (consumed by M30). Documented compromise #3, but on the Cures Act EVV verification path. | apps/backend/src/modules/18-evv/evv-route-service-db.ts:29-31,305-314,357,373-390,420-444,65<br>apps/backend/src/modules/18-evv/domain/geofence.ts:64,98 (haversineMeters unused)<br>apps/backend/src/modules/30-quality/outbox-consumers/upstream-events.ts | P1 | true | Resolve the patient-address baseline via the M5 PatientAddressReader, compute haversine distance, drive decisions through the domain capture machine (outside_geofence -> open missing-resolution, spoof detection) and persist computed_distance_m. |
| GAP-035 | M18 | Workers / aggregator | M18 has no BullMQ workers: no aggregator submission is ever created (Cures Act state-aggregator path cannot start), dispatchSubmission/pollSubmissionOnce have no caller, no late-check sweep creates missing-resolution rows, and 7 catalogued events (aggregator_submitted/accepted/rejected/timeout, gps_spoof_suspected, late_check_out_detected, verification_pdf_requested) are never emitted, leaving the M19 late-checkout and M20 gps-spoof consumers dead. | apps/backend/src/modules/18-evv (no jobs/ directory)<br>packages/db/migrations/0047_evv_m18_rls_audit_triggers.sql:184 (only grant; no insert into evv_aggregator_submission)<br>apps/backend/src/modules/18-evv/submission-flow.ts:38,77<br>(+3 more) | P1 | true | Add apps/backend/src/modules/18-evv/jobs/ with late-check-sweep, aggregator-submission-prep, submitter and poller workers (withOrgContext per org) registered in index.ts. |
| GAP-036 | M18 | Offline-sync ABAC | POST /evv/offline-sync gates only on evv.check_in and calls recordCapture with each event's client-supplied kind (check_out allowed) and visitId; assigned-clinician and visit-window ABAC run only on /check-in and /check-out. Any member with evv.check_in and an approved device can post EVV events for any visit at any time. | apps/backend/src/modules/18-evv/routes/evv-routes.ts:112-115,123,141,157-174<br>apps/backend/src/modules/18-evv/evv-route-service-db.ts:186-201,285-303,515-530<br>docs/modules/WARDENX_MODULE_18_EVV_SPEC_v0_2.md:778-780 | P1 | true | Run assigned-clinician, window and per-kind permission checks per event in the offline-sync handler or captureInTx; reject or quarantine failures. |
| GAP-037 | M18 | PHI / encryption | EVV GPS coordinates (PHI) are stored as base64('lat,lng') in coords_cipher / device_coords_cipher stamped coords_dek_version=1; that is not encryption and misleads erasure/audit reports. M20 deliberately refuses the same pattern. Documented deferral (compromise #2 / D10). | apps/backend/src/modules/18-evv/coords.ts:12-18,25-27<br>apps/backend/src/modules/18-evv/evv-route-service-db.ts:22-27,316,336,356<br>apps/backend/src/index.ts:3771-3781 (M20 refuses cleartext in _cipher) | P1 | true | Bind the per-tenant DEK envelope cipher (getTenantKeyProvider) in encodeStoredCoords; until then store NULL with a sentinel as M20 does. |
| GAP-038 | M19 | Workers | M19 Tier-1 crons are unbuilt: shift-open/close, the proactive 24h coverage-gap watchdog, callback-sla, awaiting-callback-timeout, close-documented and escalation-sla. No callback/escalation SLA alerts, calls never time out or auto-close. (A reactive coverage_gap emit exists for no-show/late-checkout triggers; manual shift activate/complete routes exist.) | apps/backend/src/modules/19-oncall/jobs/index.ts:19-22; jobs/worker.ts:151-160; apps/backend/src/index.ts:5414-5418<br>apps/backend/src/modules/19-oncall/alerts.ts:194 (no caller)<br>apps/backend/src/modules/19-oncall/roster/shift-machine.ts:212,217<br>(+2 more) | P1 | true | Add M19 cron workers for shift-open/close, coverage-gap-watchdog, callback-sla, awaiting-callback-timeout, close-documented and escalation-sla (active-org fan-out under withOrgContext, M19_PLATFORM_JOB_ID allowlist) registered in index.ts. |
| GAP-039 | M20 | Workers | The 30-second check-in overdue detector (core lone-worker safety control) does not exist; M20 registers only the SOS SLA watchdog and decideOverdueCheckIn has no production caller. A missed safety check-in raises no alert unless someone opens the dashboard. post-visit-window-closer, high-risk-area-evaluator, coverage-gap-watchdog, sos-location-stream, policy housekeeper and dek-rotation are also absent. | apps/backend/src/modules/20-field-safety/jobs/index.ts:11-16; jobs/cron-workers.ts:567,645-647,656<br>apps/backend/src/index.ts:5077,5083<br>apps/backend/src/modules/20-field-safety/lifecycle/check-in-overdue.ts:206 (no caller)<br>(+2 more) | P1 | true | Add the overdue-detector cron over safety_check_in_schedule applying decideOverdueCheckIn effects (state flip, outbox, M36 alert) per org under withOrgContext; add post-visit-window-closer and coverage-gap-watchdog. |
| GAP-040 | M20 | Incidents / encryption | The M20 DEK cipher port is deliberately unbound, so POST /safety/incidents (and patch, narrative resolve, action plan) always return 503 SAFETY_CIPHER_UNBOUND and SOS/check-in coordinates are discarded for a sentinel. Field-staff incident reporting (workers-comp/OSHA) is unusable in production. Documented fail-closed. | apps/backend/src/index.ts:3771-3792 (buildDrizzleM20WriteService without cipher)<br>apps/backend/src/modules/20-field-safety/routes/write-service-drizzle.ts:121-134,288-292,337-346,565-569 (seal callers 1119,1203,1262,1266,1361,1365,1429,1534,2014) | P1 | true | Provide the per-tenant DEK envelope cipher (shared M34 key ring via getTenantKeyProvider) and pass it as `cipher` to buildDrizzleM20WriteService in apps/backend/src/index.ts. |
| GAP-041 | M21 | Controlled-substance crons | None of the M21 section 4.6 crons exist: par_monitor, unreturned_kit_monitor (30-day overdue flip + compliance escalation), invoice_reconciliation. detectReturnEscalation and runParMonitor have no caller and markOverdue is never driven, so overdue comfort-kit (controlled substance) escalation and par alerts never fire. Only the manual declare-unreturnable route remains. | grep par_monitor\|unreturned_kit\|invoice_reconciliation -> doc comments only<br>apps/backend/src/modules/21-supplies/lifecycle/return.ts:196-208,409<br>apps/backend/src/modules/21-supplies/lifecycle/par-stock.ts:9-12,72<br>(+2 more) | P1 | true | Add apps/backend/src/modules/21-supplies/jobs/ with par-monitor and unreturned-kit-monitor crons (active-org fan-out, withOrgContext, detectReturnEscalation -> markOverdue effects, runParMonitor -> outbox/alerts) registered in index.ts. |
| GAP-042 | M23 | Cron workers | NOE/NOTR 5-day window-watch and eligibility stale-watch crons are scheduled but every tick throws: buildM23WorkerDeps receives no activeOrgs or noticeWindow port (M23 is the only cron module without activeOrgs). Spec 4.8 rows and acceptance 7.5 (day-3 warning, breach stamp, claim block) never run; late NOE makes days non-covered. Only an inline TODO records it. | apps/backend/src/index.ts:4619-4641 (no activeOrgs/noticeWindow); :4643-4650 (comment admits); :4661 scheduleM23Jobs<br>apps/backend/src/modules/23-billing-medicare/jobs/m23-jobs.ts:566-576 (unboundWorkerPort default); :1361,1432,1494; :1771-1797; :1889-1933<br>grep 'activeOrgs:' apps/backend/src/index.ts -> every cron module except M23 | P1 | true | Build an M23 enumerator with buildActiveOrgEnumerator (same as m24ActiveOrgs/m25ActiveOrgs) and pass activeOrgs; bind noticeWindow to the noe-notr-state-service breach stamp; register M23 cron jobIds in PLATFORM_CONTEXT_ALLOWLIST. |
| GAP-043 | M23 | Revalidation worker | The revalidate.consumer queue has a live producer (six F-153 outbox triggers + F-162) but no Worker: only the never-called registerM23Workers constructs it (plus validationRun and eligibilityRefresh). Jobs pile up in Valkey and READY/VALIDATING claims are never re-validated when CTI/F2F/LOC change. index.ts and the trigger file header wrongly claim the worker is registered; enqueue/validationRunner ports are also unbound. | apps/backend/src/index.ts:2404,6548 (producer; wrong comment 6545-6547); :4642-4651 (only Launch + Cron workers)<br>apps/backend/src/modules/23-billing-medicare/jobs/m23-jobs.ts:396-404,1175-1199,1650-1715,1718-1764,1773-1800<br>apps/backend/src/modules/23-billing-medicare/outbox-consumers/m23-revalidate-triggers.ts:7-9 | P1 | true | Register Workers for revalidateConsumer and validationRun in index.ts (call registerM23Workers with bound deps or add them to the launch set); bind enqueue and validationRunner; fix the header. |
| GAP-044 | M23 | Validation override | POST /api/v1/claims/:id/validation-runs/:runId/results/:resultId/override always returns 503 SEAM_UNBOUND: the override audit port defaults to denyAudit and index.ts passes none; no implementation of recordOverrideAudit exists. The compliance_officer escape hatch for evv_bracket_coherence (severity error) is dead, blocking claims. | apps/backend/src/modules/23-billing-medicare/routes/write-service-drizzle.ts:253-257,284,786-797<br>apps/backend/src/index.ts:3494-3498<br>apps/backend/src/modules/23-billing-medicare/routes/validation.routes.ts:86-95<br>(+1 more) | P1 | true | Implement an AuditEventPort over @wardenx/audit writing the audit_event in the caller tx and pass it as `audit` at apps/backend/src/index.ts:3494. |
| GAP-045 | M23 | Eligibility check | POST /api/v1/billing/eligibility/check always returns 503: the outbox-backed submission gate admits only claim/noe/notr queue names, the eligibility.refresh worker lives in never-called registerM23Workers, and the HETS port is unbound. No eligibility_check rows are produced (spec route 22, acceptance 7.14); freshness rule skips so claims are not blocked. | apps/backend/src/modules/23-billing-medicare/routes/write-service-drizzle.ts:1019-1033<br>apps/backend/src/modules/23-billing-medicare/outbox-consumers/submit-requests.ts:8-13,100-112<br>apps/backend/src/index.ts:3496,4645-4652<br>(+2 more) | P1 | true | Bind a HETS 270/271 port, add an eligibility.refresh producer or dedicated queue port and register the eligibilityRefresh worker; until then document the deferral and disable the UI action. |
| GAP-046 | M24 | R&B billing | rb_day rows are never created in production: the rb-day-daily-sweep worker body only lists active orgs, RbDaySweepStore has no implementation, and registerM24CronWorkers/scheduleM24Jobs are never called. Combined hospice + room-and-board claims never carry rev 0658 / Q5003 lines; the eligibility stale watchdog is the same no-op. | apps/backend/src/modules/24-billing-medicaid/routes/write-service-drizzle.ts:608-651<br>apps/backend/src/modules/24-billing-medicaid/jobs/index.ts:7-9,43-57<br>apps/backend/src/modules/24-billing-medicaid/jobs/m24-jobs.ts:3-5<br>(+3 more) | P1 | true | Implement RbDaySweepStore.sweepPendingDays over the M6 LOC snapshot + rb_arrangement (idempotent on (patient_id, service_date)) and a real eligibility watchdog store; wire registerM24CronWorkers with m24ActiveOrgs and call scheduleM24Jobs in index.ts. |
| GAP-047 | M25 | Denial-seed consumers | buildM23ClaimRejectedConsumer and buildM18EvvAggregatorRejectedConsumer are written and live-tested but never constructed in apps/backend/src/index.ts. m25 is the only declared consumer of both events, so the dispatcher defers them forever (rows stay pending, never dead-letter) and 277CA/999/aggregator rejections never seed denials. arch:outbox-bindings is falsely green (counts factories on disk); the deferral register says the group is 'GONE'. | apps/backend/src/modules/25-remittance/outbox-consumers/m23-claim-rejected.ts:98; m18-evv-aggregator-rejected.ts:125<br>apps/backend/src/modules/25-remittance/index.ts:134 (only buildM25EdiReceivedConsumer exported)<br>apps/backend/src/index.ts:688,6422 (only EDI-received consumer wired)<br>(+2 more) | P1 | true | Add both consumers to the org-scoped consumer array next to buildM25EdiReceivedConsumer in apps/backend/src/index.ts; harden scripts/check-outbox-bindings.ts so every discovered build*Consumer factory must be reachable from the composition root. |
| GAP-048 | M27 | Cost-report submit two-person control | Cost-report submit's two-person check compares the actor with an optional, caller-supplied approvedByMembershipId; approveForSubmit never persists the approver (no column). A user holding both approve_for_submit and submit can approve then submit with the field omitted, defeating W-CR-11 and the STRIDE elevation-of-privilege mitigation. | apps/backend/src/modules/27-cost-report/routes/write-service-drizzle.ts:1107-1134,1150-1157<br>apps/backend/src/modules/27-cost-report/routes/cost-report-typebox.ts:152,158<br>apps/backend/src/modules/27-cost-report/routes/cost-reports.routes.ts:180,197<br>(+2 more) | P1 | true | Add approved_by_membership_id to cost_report (migration + Drizzle schema), set it in approveForSubmit, compare actor.membershipId with the persisted value at submit; remove approvedByMembershipId from the submit body schemas. |
| GAP-049 | M28 | FHIR R4 coverage | The FHIR gateway serves only Patient, Encounter (search), MedicationRequest and MedicationAdministration; DiagnosticReport, Practitioner, Condition, CarePlan, Goal, Observation, DocumentReference, Coverage and the rest of the Phase-1 set are absent (W-FHIR-13..16 unmet). The DiagnosticReport projector exists and the M29 LabObservationReader is registered, but neither is used. Undermines the ONC/USCDI and information-blocking posture. | apps/backend/src/modules/28-fhir/routes/projection.ts:8-29,41-51,74-87<br>apps/backend/src/modules/28-fhir/seams/consumed.ts:225-233<br>apps/backend/src/index.ts:1760<br>(+1 more) | P1 | true | Add DiagnosticReport (read + ?patient) via projectDiagnosticReport with M11 OrderProvider + M29 LabObservationReader (after the contract fix) and Practitioner via M40 ExternalPhysicianReader to SERVED_RESOURCES; add remaining US Core types as producer seams land. |
| GAP-050 | M29 | Inbound MLLP listener | No inbound HL7 MLLP listener process is composed (startListenerProcess is defined nowhere; createTlsListenerRegistry is used only by tests) and no production MllpIngestSink exists; nothing inserts hl7_message_inbound. ADT proposals, lab auto-attach, the unmatched-lab queue and the M28/M22 lab back-refs have no live source. Credentials are stored as sha256 digests, so mTLS material is unrecoverable. Known residual (F-182). | apps/backend/src/modules/29-external-interfaces/listener/index.ts:7-11,56<br>apps/backend/src/modules/29-external-interfaces/listener/connection.ts:65<br>apps/backend/src/modules/29-external-interfaces/routes/store-drizzle.ts:9-12,119,350,512,1016<br>(+1 more) | P1 | true | Build the M29 listener entrypoint (separate process or worker.ts branch): load active feeds under withPlatformContext, apply the BAA gate, start createTlsListenerRegistry, bind a Drizzle MllpIngestSink writing hl7_message_inbound under withOrgContext with DEK-encrypted payload; store real credential ciphertext. |
| GAP-051 | M29 | Read audit | M29 lab-observation reads (list, unmatched, detail with values) have no config.auditRead and /api/clinical/labs and /api/admin/external-interfaces are outside DEFAULT_READ_AUDIT_PREFIXES, so the fail-closed boot gate never governs them and no read event is emitted (164.528 accounting gap). Spec requires auditRead() on every route surfacing lab values. | apps/backend/src/modules/29-external-interfaces/routes/labs.routes.ts:34-49,53-68,71-89,165-166<br>grep auditRead\|auditPhiRead apps/backend/src/modules/29-external-interfaces -> 0 matches<br>apps/backend/src/bootstrap/index.ts:120-250 (DEFAULT_READ_AUDIT_PREFIXES /api/v1/* only)<br>(+1 more) | P1 | true | Add auditListRead to list/unmatched and auditPhiRead (patientIdPayloadPath 'observation.patientId') to detail; add auditRead or a justified waiver to every /api/admin/external-interfaces GET; add both prefixes to DEFAULT_READ_AUDIT_PREFIXES. |
| GAP-052 | M29 | Lab ABAC | GET /api/clinical/labs/observations is gated only by inOrg; the caseload predicate applies only to :observationId routes and no caller passes caseloadPatientIds, so any lab.read holder lists every patient's labs in the org. Filters also run after LIMIT in JS (wrong pagination). | apps/backend/src/modules/29-external-interfaces/routes/labs.routes.ts:33-50<br>apps/backend/src/modules/29-external-interfaces/routes/guards.ts:43-44,97-101<br>apps/backend/src/modules/29-external-interfaces/routes/store-drizzle.ts:853-869<br>(+2 more) | P1 | true | Resolve the actor's caseload (or wide-scope bypass) and pass caseloadPatientIds to listObservations; push patient/loinc/caseload filters into SQL before LIMIT. |
| GAP-053 | M30 | SRA / PIP two-person control | SRA cycle close and QAPI PIP close take both cosigner ids from the request body; nothing checks the actor is a cosigner, that either holds the required role, or that the second person authenticated. qapiCloseAuthority/sraCloseAuthority predicates exist but are never attached; PIP close has no step-up and SRA hardcodes recentStepUp: true. One user can close a HIPAA 164.308 SRA cycle or a CMS QAPI PIP alone. | apps/backend/src/modules/30-quality/routes/quality-typebox.ts:112-119<br>apps/backend/src/modules/30-quality/routes/qapi.routes.ts:243-249<br>apps/backend/src/modules/30-quality/routes/sra.routes.ts:13-19,68,191-200<br>(+2 more) | P1 | true | In closeSraCycle/closeQapiPip require actor.membershipId to be a cosigner, load both memberships and check roles (reuse the predicate logic), add requireStepUp('qapi.close') to R-31; ideally use a pending-cosign record confirmed in the second signer's own step-up session. |
| GAP-054 | M30 | Mortality review + CAHPS consumers | m6.discharge.death is not consumed, so mortality reviews are never auto-created (no create route exists, R-70..R-73 unusable) and CAHPS decedent sampling/export ports are unbound end to end (index.ts passes no cahpsAdapters). Documented deferral (F-150) with a stale exception reason: the deferral register no longer holds those events. | apps/backend/src/modules/30-quality/outbox-consumers/upstream-consumer-ports.ts:8-21,109-118<br>apps/backend/src/modules/30-quality/routes/mortality.routes.ts:1-11<br>apps/backend/src/index.ts:5817-5847,4469-4488<br>(+3 more) | P1 | true | Split handleDischargeDeath so the mortality-review draft binds now; bind buildM30DischargeDeathConsumer in index.ts (idempotent on createdViaEventIdempotencyKey); then bind CAHPS ports to getTenantKeyProvider().dekForOrg and an adapter registry; update the exception reason. |
| GAP-055 | M30 | CAHPS workers / RLS | The monthly CAHPS sample cron builds CahpsRepository on the base pool and calls findActiveBinding with no withOrgContext; under the org-keyed RLS policy it reads zero rows and silently records every org as 'no_active_vendor'. The cahps_export worker runs unscoped with unbound decrypt/bindingConfig/outbox ports and nothing enqueues it. No CAHPS Hospice sample is ever produced or sent to the vendor (HQRP obligation), and nothing reports the failure. | apps/backend/src/modules/30-quality/jobs/m30-jobs.ts:2006,2080-2105,2214-2216,2309-2313,2484-2487<br>packages/quality/src/workers/crons.ts:159-163<br>packages/db/migrations/0067_quality_m30_rls.sql:28-31<br>(+2 more) | P1 | true | Run activeVendorBinding and the sample insert inside withOrgContext; bind listPriorMonthDecedents to DeathDischargeReader, insertSampled/decrypt/bindingConfig to the tenant DEK helper, emits to deps.outboxPublisher; wrap cahps_export per job in withOrgContext; pass a CahpsAdapterRegistry; fail loudly until bound. |
| GAP-056 | M30 | Alerts to M36 | None of M30's twelve section 4.9 alerts reach M36: all trigger events are record-only (declaredConsumers []), no M30 code calls AlertEmitter, M36's clinical-alert consumer has no m30 events, the scheduled SRA-reminders cron's cycles/alerts ports are unbound (fails daily), and m30.incident.cap_overdue has no producer. Outbreaks and sentinel/abuse incidents are recorded but nobody is notified. | docs/modules/WARDENX_MODULE_30_HQRP_QUALITY_SPEC_v0_5.md:2155-2162<br>apps/backend/src/modules/30-quality/events-by-m30.ts:47,60-61,66,83-84,105,116-117,122,132-133,335,348-349<br>apps/backend/src/modules/36-messaging/outbox-consumers/clinical-alerts.ts:4-21<br>(+2 more) | P1 | true | Add an M36 outbox consumer for M30 alert-trigger events (validate M30_ALERT_PAYLOADS, dispatch via getSeam('AlertEmitter')) and declare m36 on those events; bind the SRA-reminders cycles and alerts.dispatch ports; add a CAP-overdue sweep emitting m30.incident.cap_overdue. |
| GAP-057 | M31 | Portal provisioning | Portal invitation routes are silent no-ops: issue returns 202 with invented ids and persists nothing, list returns [], revoke/invite-bereaved return ok. No production path creates portal_account or portal_access_grant, so caregivers cannot be onboarded and every downstream portal surface is unreachable. Header falsely claims M2 binding. Acknowledged in F-222 but open. | apps/backend/src/modules/31-portal/routes/admin.routes.ts:6-11,66-76,87,101,115-117<br>grep insert portal_account (non-test) -> none; apps/backend/src/modules/31-portal/outbox-consumers/m16-bereavement-plan-opened.ts:275 (only replaces existing grant)<br>apps/backend/src/modules/31-portal/lifecycle/invitation.ts:64,101 (no callers)<br>(+2 more) | P1 | true | Wire issuance to issueInvitation + M2 collaborator-invite + M36 delivery outbox; persist invitation state (decide owner table); implement accept -> portal_account + portal_access_grant under withOrgContext; real list/revoke/invite-bereaved. |
| GAP-058 | M31 | Portal session | Portal logout and step-up are no-ops: logout returns ok without revoking the server session (the SPA just navigates to '/'), and step-up returns ok for any TOTP without validating or stamping freshness, while the UI says 'Verified'. A PHI portal session stays valid after logout until expiry; STEP_UP-guarded writes still deny (fail closed). | apps/backend/src/modules/31-portal/routes/session.routes.ts:5-6,118-122,124-133<br>apps/portal/src/screens/account.tsx:65-80<br>apps/backend/src/modules/02-identity/routes/session-step-up.ts:128,161<br>(+1 more) | P1 | true | Delegate logout to Better Auth session revocation for the caller's session id and step-up to the M2 step-up verifier; return 401/422 on a bad TOTP. |
| GAP-059 | M31 | Bereavement opt-out / preferences | POST /api/v1/portal/bereavement/opt-out returns ok without calling M16 (which has a working opt-out path), so bereaved families who opt out keep receiving outreach. PATCH /notification-preferences/:id is also a no-op and GET returns a static stub list. | apps/backend/src/modules/31-portal/routes/write.routes.ts:253-264,266-280<br>apps/backend/src/modules/31-portal/routes/read.routes.ts:370-389<br>apps/backend/src/modules/16-bereavement/permission-keys.ts:27 (M16 opt-out exists)<br>(+1 more) | P1 | true | Forward opt-out to M16 via its seam or an m31.* outbox event M16 consumes, returning 202 only once enqueued; bind preferences to an M36 seam or return 501 until one exists. |
| GAP-060 | M33 | Drilldown | Report drilldown emit and bulk_export always fail closed: drilldownEncryption is never passed, so the stub throws DrilldownDekUnavailable, and the drilldown audit-flush worker is unbound. The justification ('the M1 envelope-DEK provider does not exist') is stale: a DB boot registers the real key-ring TenantKeyProvider used by M31/M39. | apps/backend/src/modules/33-reporting/routes/export-drilldown-service.ts:482-487<br>apps/backend/src/modules/33-reporting/wiring.ts:466-468,568-578<br>apps/backend/src/index.ts:3341-3346,1799-1805,3181,3215,3254<br>(+2 more) | P1 | true | Implement a DrilldownFilterEncryptionPort over getTenantKeyProvider() (portal-crypto pattern, AAD m33:report_drilldown_audit:filter_context:<org>), pass it into createDrizzleM33ExportDrilldownBackend and the audit-flush ports; fix the comment. |
| GAP-061 | M34 | ABAC resolver | M34 ABAC predicates are always bound to SLICE_M34_ABAC_RESOLVER (all loaders null/false) even on a DB boot, so feature_flag_write_authority, support_session_actor_distinct_from_grantor and tenant_consented_support_active always deny: feature-flag writes, the kill switch and support-session start/elevate always 403. The boot comment wrongly says only role-only predicates are used. | apps/backend/src/index.ts:1665-1670,1899-1910<br>apps/backend/src/modules/34-saas-tenant-platform/abac-predicates.ts:136-143,162-169,194-198<br>apps/backend/src/modules/34-saas-tenant-platform/routes/platform/feature-flags-admin.ts:60-65,95,116<br>(+2 more) | P1 | true | Add a Drizzle TenantPlatformAbacResolver (support_consent_grant, support_session, onboarding_task, FeatureFlagAdmin seam) and bind it in index.ts when deps.db is present; fix the comment. |
| GAP-062 | M35 | Stripe loop | No live Stripe loop: mountM35Routes gets no webhook ingest (POST /api/v1/webhooks/stripe always 503 STRIPE_WEBHOOK_UNCONFIGURED), the outbound stripe-dispatcher worker is never wired, and createSetupIntent returns {clientSecret:null}. Subscriptions, payment methods and invoices are local rows only; dunning transitions never arrive. Documented deferral. | apps/backend/src/index.ts:934,3390-3418<br>apps/backend/src/modules/35-subscription/routes/mount.ts:38<br>apps/backend/src/modules/35-subscription/routes/webhooks.routes.ts:44-51<br>(+2 more) | P1 | true | Build the section 4.14 ingest (verifier + Drizzle stripe_webhook_event + DEK + STRIPE_WEBHOOK_SECRET in env.ts) and pass mountM35Routes({webhook:{ingest}}); register a stripe-dispatcher worker with a LiveStripeClient gated on STRIPE_SECRET_KEY. |
| GAP-063 | M35 | Published seams / usage metering | None of M35's six published seams (SubscriptionStateProvider, BillingStatusProvider, UsageMeteringIngest, PatientCounterProvider, RevenueMetricsProvider, PlanCatalogReader) is registered (spec D20 'boot refuses on missing registration' is not enforced; deny-stubs apply), and no producer (M28, M32) calls UsageMeteringIngest.ingest. AI-token and FHIR-egress usage never reaches usage_event. (M32 AITokenMeterProvider / M34 OnboardingStatusProvider deny-stubs are documented Phase-1 interims; M34 entitlement reader is never set.) | apps/backend/src/bootstrap/seams/registry.ts:591-630,632-655<br>apps/backend/src/bootstrap/seams/providers.ts:1711-1717<br>docs/modules/WARDENX_MODULE_35_SUBSCRIPTION_BILLING_SPEC_v0_3.md:1421-1423,2945<br>(+2 more) | P1 | true | Add apps/backend/src/modules/35-subscription/wiring.ts with registerM35PublishedSeams(db) for the six Drizzle impls (PHI denylist + idempotency), call it from wireModuleSeams; call ingest from M32's token ledger and M28's FHIR read audit; bind the M34 entitlement reader. |
| GAP-064 | M36 | Alert delivery / realtime | M36 out-of-band delivery (push/SMS/voice/email), Socket.IO realtime and delivery-reconcile webhooks are unbuilt: the 12-queue catalog is data only, no vendor send call exists, planned notification_delivery rows are never dispatched, the webhook registrar is deliberately unmounted, and m36.notification.delivery_failed has no producer (M19/M20 escalation consumers never fire). Tier-1 SOS voice path (7.7) and critical lab 4-channel alerts (7.10) are unmet. Known, documented; in-app inbox works. | packages/messaging/src/jobs/queues.ts:35,54,171<br>apps/backend/src/modules/36-messaging/messaging-route-service-db.ts:786<br>scripts/check-route-reachability.ts:53-67<br>(+3 more) | P1 | true | Build the dispatch tier in apps/backend/src/modules/36-messaging/jobs/ (send_* workers over notification_delivery, delivery_reconcile with a concrete MessagingWebhookService), register @fastify/formbody, mount registerMessagingWebhookRoutes, emit delivery_failed; remove the DEFERRED entry. |
| GAP-065 | M37 | Cron tier | Only 1 of 12 section 4.8 IPU crons exists (rn-coverage-watchdog). ipu_census_snapshot has no writer, so GET /api/v1/ipu-census/:date and IpuCensusProvider (M26 cap accrual, M27 S-3) always return 0; irc_episode.consecutive_day_count is never incremented, so the 5-day IRC cap never reaches approaching_cap/breached. Restraint, IV bedside, cleaning-SLA, transfer, settlement, staleness, reservation, equipment and nursing-note crons are also absent. Header cites #174, which is closed. | docs/modules/WARDENX_MODULE_37_IPU_SPEC_v0_2.md:1646-1659<br>apps/backend/src/modules/37-ipu/jobs/index.ts:21-41; jobs/cron-workers.ts:266-275<br>apps/backend/src/index.ts:5452,5458<br>(+2 more) | P1 | true | Add Workers/schedules in apps/backend/src/modules/37-ipu/jobs/ for census-snapshot-builder, irc-cap-watchdog (calling planIrcDailyTick), restraint-reassessment, iv-bedside-check, bed-cleaning-SLA, transfer-completion, postclose-settlement and the rest; reopen tracking. |
| GAP-066 | M37 | GIP attestation | GIP criteria attestation does not enforce hospice-MD / active M40 ExternalPhysician eligibility: attestGip persists a client-supplied attestingPhysicianId unchecked, the route has no requireAbac, the attester_eligible predicate is a target-boolean stub nothing feeds, and stepUpAssertionId is written as the membership id. Any m37.gip_criteria.attest holder can attest GIP, driving GIP per-diem billing (CoP 418.108). | apps/backend/src/modules/37-ipu/routes/service-drizzle.ts:1206-1227<br>apps/backend/src/modules/37-ipu/routes/ipu.routes.ts:322-333<br>apps/backend/src/modules/37-ipu/abac/predicates.ts:48<br>(+2 more) | P1 | true | In attestGip resolve the actor's M2 discipline and the attesting physician via M40 (active ExternalPhysician bound to the actor) and reject with 403 GIP_ATTESTER_INELIGIBLE; persist the real step-up assertion id. |
| GAP-067 | M37 | M6 LCP handshake | POST /ipu-admissions/:id/confirm (spec: system-internal) is a normal session route gated by m37.ipu_admission.create; it ignores its body (including forceFlag) and always passes lcpConfirmed: true, so the ADMISSION_LCP_NOT_CONFIRMED guard is dead. No M37 consumer exists for m6.level_of_care.activated/requires_ipu_bed, and M6 never emits them. IPU/GIP admissions can go active (billing-relevant) with no M6 LCP. | apps/backend/src/modules/37-ipu/routes/ipu.routes.ts:289-298<br>apps/backend/src/modules/37-ipu/routes/service-drizzle.ts:1117-1133<br>apps/backend/src/modules/37-ipu/routes/ipu-typebox.ts:169-172<br>(+2 more) | P1 | true | Implement the M6<->M37 LCP handshake (M6 emits requires_ipu_bed/activated; M37 consumers drive open/confirm) and restrict the user route, or require an explicit force-flag + coordinator-only permission + seam check for an M6 LCP before lcpConfirmed. |
| GAP-068 | M37 | Outbox consumers | 11 of 13 section 4.5 M37 consumers are absent (only the two M6 discharge consumers exist). No code path inserts ipu_iv_safety_overlay, so the D7 IV-continuous safety overlay is never operative (the registered seam reads an empty table), and outbreak-driven visitor restrictions (D8) have no producer. Producers do not declare m37, so the gate passes. | apps/backend/src/modules/37-ipu/consumers/ (two files)<br>docs/modules/WARDENX_MODULE_37_IPU_SPEC_v0_2.md:1545-1563<br>apps/backend/src/modules/11-orders/events-by-m11.ts:179-183; apps/backend/src/modules/30-quality/events-by-m30.ts:348-349<br>(+2 more) | P1 | true | Add consumers (m11-order-signed/discontinued, m13-administration-recorded, m8-encounter-signed, m30-outbreak-*) under apps/backend/src/modules/37-ipu/consumers/, declare m37 on producers and bind them in index.ts. |
| GAP-069 | M38 | Terminology loader | No production terminology loader or worker: packages/terminology-loader does not exist, the processors in packages/terminology/src/jobs have no backend caller, and POST /api/v1/admin/terminology/:system/load only registers a version row (ingestion 'pending_loader_worker'). Concept tables are empty unless loaded out-of-band (only a dev seed writes concepts). ICD-10 validation and RxNorm search depend on this. Self-documented. | apps/backend/src/modules/38-terminology/routes/admin-terminology-routes.ts:16-21,117<br>packages/terminology/src/jobs/processors.ts:48,85; jobs/queues.ts:12 (no apps/ callers)<br>apps/backend/src/index.ts:990-996,1094,1628,1960,3250 (no worker)<br>(+2 more) | P1 | true | Build packages/terminology-loader (fetch/stage/diff/write, deprecation mapping, activate/supersede) and a BullMQ worker in apps/backend/src/modules/38-terminology/jobs consuming load_version / tenant_deprecation_scan / refresh_embeddings, wired from index.ts. |
| GAP-070 | M39 | ABAC | Patient-scoped consent read routes (3, 4, 11, 14, 17, 21, 28) are gated by requirePermission only; no requireAbac exists in the module and services receive no actor. Any consent.read holder reads any patient's consents, including 42 CFR Part 2 recipients and DPOA agents. Route 3's comment claims a caseload check that does not exist. | apps/backend/src/modules/39-consent/routes/consent-routes.ts:75-92,150-162,164-188<br>apps/backend/src/modules/39-consent/consent-store-db.ts:412-438<br>docs/modules/WARDENX_MODULE_39_CONSENT_SPEC_v0_3.md:1050,1064,1065,1068,1075<br>(+1 more) | P1 | true | Add requireAbac guards (caseload_or_scope with a patientId target adapter, consent_owner_or_compliance, is_consent_drafter, bereavement_window, compliance_officer) to consent-routes.ts; load patient_id for consentId routes (IDOR); log denies to consent_eval_audit. |
| GAP-071 | M39 | ConsentEvaluator D13 | The production ConsentEvaluator never applies D13 post-death termination: the Drizzle store backing the seam returns isPatientDeceased = false unconditionally and no m39 consumer for m5.patient.deceased exists. After death, non-survives-death consents keep authorizing disclosure for every PHI-egress module consulting the seam. A working deceased query already exists in the same file. | apps/backend/src/modules/39-consent/consent-store-db.ts:168-174,342-354<br>apps/backend/src/index.ts:1544<br>packages/consent/src/seams/consent-evaluator.ts:326-336<br>(+2 more) | P1 | true | Implement isPatientDeceased in createDbConsentStore with the existing withOrgContext patient.status read; optionally bind an m39 consumer for m5.patient.deceased using decideDeceasedConsentExpiry and add m39 to the catalog. |
| GAP-072 | global | CI / deploy | Production deploys run with zero CI: deploy.yml `verify` job is commented out (release needs only debounce) and ci.yml's pull_request trigger only matches `fix/admission`, so neither PRs to main nor main pushes run build/typecheck/arch:fitness/tests before a PHI-bearing image ships. Undocumented; CLAUDE.md:78 still describes `verify` as active. | .github/workflows/deploy.yml:91-95 (`# verify:` job commented out); :97-101 (`release: needs: debounce`, `# needs: verify`)<br>.github/workflows/ci.yml:4-12 (push trigger commented; pull_request branches only `fix/admission`)<br>git log: 8468d5530 'Skipped the CI'; 27b1ee094 'CI/CD'<br>(+2 more) | P1 | true | Uncomment `verify` in .github/workflows/deploy.yml (needs: debounce, uses ./.github/workflows/ci.yml) and set release.needs: [debounce, verify] gated on verify success; restore ci.yml `pull_request: branches: [main]`. If Actions minutes are the reason, reduce cost with path filters / a smaller PR job set instead of removing the gate. Record the decision in docs/history and fix CLAUDE.md/AGENTS.md. |
| GAP-073 | global | Logging / deploy | Production nginx vhosts proxy /api with no access_log/log_format override, so nginx's default combined format persists $request including ?q=<patient name\|MRN> from patient search, the exact PHI that logger.ts strips from Pino and names as a downstream risk. Host-level nginx.conf is not in the repo. | apps/backend/src/bootstrap/plugins/logger.ts:3-5,27-30<br>deploy/production/nginx/wardenx-frontend.conf:6-13; deploy/production/nginx/wardenx-backend.conf:8-15<br>apps/web/src/modules/05-patient/global-search.tsx:150<br>(+1 more) | P1 | true | Define a path-only log_format ($uri) for /api/ locations in both vhosts (or access_log off for /api/); better, move search needles into a POST body. |
| GAP-074 | M02 | Routes | Several M2 spec routes have no handler (GET/DELETE /api/v1/auth/sessions, POST /api/v1/auth/screen-unlock, GET /api/v1/me/session, POST /api/v1/funeral/invite, orgs CRUD, step-up overrides); several implemented routes (device attestation, auth/context, invitations resend, elevated approvals) are absent from the spec inventory. | docs/modules/WARDENX_MODULE_02_IDENTITY_SPEC_v0_4.md:736-756<br>grep me/session\|auth/sessions\|screen-unlock\|funeral/invite\|step-up-overrides apps/backend/src apps/web/src scripts/openapi -> none | P2 | false | Implement the missing handlers in apps/backend/src/modules/02-identity/routes or record explicit deferrals and update the spec inventory, including extras. |
| GAP-075 | M02 | Sign-up | Email/password sign-up is open instead of invite-gated: Better Auth has no disableSignUp or hooks, the mount bridge forwards every /api/auth/* path, the credential throttle covers sign-in only, and the web accept-invitation page calls signUp.email without a token. Tenant data stays membership/RLS-gated; magicLink also lacks disableSignUp. | packages/auth/src/identity/auth.ts:197-201<br>packages/auth/src/identity/mount.ts:59-75<br>packages/auth/src/identity/credential-throttle.ts:56<br>(+2 more) | P2 | true | Set disableSignUp (also for magicLink) and create the account server-side inside POST /api/v1/invitations/accept after token validation, or gate /api/auth/sign-up/* on a valid invitation in the mount bridge. |
| GAP-076 | M03 | Break-glass live coverage | No live suite exercises the break-glass branch end to end (requireAbac deny -> durable grant -> critical audit row under wardenx_app); the audit insert is covered only in memory, and a regression would 500 every emergency access. | apps/backend/__tests__/ac-01-break-glass-cosign.live.test.ts:33,105,134 (store only)<br>apps/backend/src/modules/03-authorization/contract.ts:57-84<br>packages/auth/src/abac/require-abac.ts:200-205 | P2 | false | Extend ac-01 (or add a suite + package.json script + ci.yml row) to invoke break-glass, run a denying guard and assert access allowed + m3.breakglass.access critical audit row as wardenx_app. |
| GAP-077 | M05 | Amendments (164.526) | Amendment decide only flips status: no pending guard (can be re-decided), requested_changes always {} (documented interim), accepted changes not applied, unknown id -> 500; GET /patients/:id/amendments and POST /amendments/:id/statement are absent. | apps/backend/src/modules/05-patient/patient-route-service-db.ts:725-757,759-790,777<br>apps/backend/src/modules/05-patient/routes/patient-routes.ts:425-456<br>docs/modules/WARDENX_MODULE_05_PATIENT_SPEC_v0_4.md:1256-1260,2422 | P2 | true | Guard status='pending' (409), use NotFoundError, carry requested_changes in the submit body and apply via PatientMutator on accept; add the list and statement routes. |
| GAP-078 | M05 | Merge resolution | Census list does not exclude merged patients and GET /patients/:id does not follow merged_into_id; clinicians can open and document on a merged-away chart. | apps/backend/src/modules/05-patient/patient-route-service-db.ts:120-136,169-173<br>docs/modules/WARDENX_MODULE_05_PATIENT_SPEC_v0_4.md:1232-1233 | P2 | false | Default the list filter to status <> 'merged'; return the canonical row or a redirect body from getPatient. |
| GAP-079 | M05 | ABAC | POST /api/v1/patients has no location_scope guard and no module registers a location_scope predicate (catalog declares it; declaration only). | apps/backend/src/modules/05-patient/routes/patient-routes.ts:352<br>packages/auth/src/permissions/contributed.ts:290-295<br>docs/modules/WARDENX_MODULE_05_PATIENT_SPEC_v0_4.md:1234 | P2 | false | Register a location_scope predicate (or change the declaration) and compose requireAbac('patient.create','location_scope'). |
| GAP-080 | M05 | Admit | Admit persists only the patient row + MRN/MBI; SSN (encrypted), aliases, address, phone, email are follow-ups, so deterministic matcher keys (SSN+DOB+name, DOB+name+address) are never available. | apps/backend/src/modules/05-patient/patient-route-service-db.ts:284-300<br>docs/modules/WARDENX_MODULE_05_PATIENT_SPEC_v0_4.md:56 | P2 | false | Persist satellite rows in the admit tx (SSN via the KEK/DEK envelope into patient_identifier.value_encrypted). |
| GAP-081 | M05 | PatientCaregiverReader | PatientCaregiverReader has only the M1 deny-stub (no caregiver->user schema link exists), so the portal family_caregiver attestation path always denies; only DPOA/patient_self can attest. M31's registration header wrongly claims every producer is live. | apps/backend/src/bootstrap/seams/providers.ts:228-238<br>packages/types/src/patient.ts:403-417<br>packages/db/src/schema/patient/caregivers.ts:8-27<br>(+2 more) | P2 | true | Add a caregiver.user_id (or portal_account.caregiver_id) link via migration, then implement and register PatientCaregiverReader in apps/backend/src/modules/05-patient/seams/index.ts; fix the M31 header. |
| GAP-082 | M06 | Live RLS tests | 3 of 15 M06 owned tables (referral_activity, referral_note, admission_evidence) have no live cross-tenant RLS test; they once shipped ENABLE without FORCE (fixed in 0233). | audit/implementation-status/IMPLEMENTATION_STATUS.md:18<br>packages/db/migrations/0233_rls_force_and_hope_result_event_rls.sql:8-16,34-36<br>packages/db/migrations/__tests__/rls-isolation.live.test.ts:2280,2334 (structural only) | P2 | false | Add cross-tenant cases for the three tables to an M6 live suite using _live-app-role.ts. |
| GAP-083 | M06 | CTI signing ABAC | cti.is_attending / is_hospice_md compare context.userId with M40 physician ids, which can never match, so the role escape (md/hospice_physician) is the live path and any such user can sign any CTI's attending certification (42 CFR 418.22(c)). Documented compromise. | apps/backend/src/modules/06-admission/abac-predicates.ts:168-175,189-199<br>docs/modules/WARDENX_MODULE_06_ADMISSION_ELECTION_CERTIFICATION_SPEC_v0_4.md section 4.1 rows 24-25 | P2 | false | Add a membership-to-M40-physician link and compare against it; narrow the role escape to the attending of record. |
| GAP-084 | M07 | Spec route inventory | Three implemented, gated read routes (GET /care-plans/:planId/readiness, /versions/:versionId/proposed-changes, /review-status) are not in the M07 spec section 4.1 inventory (19 rows vs 22 registrations). | apps/backend/src/modules/07-care-plan/routes/care-plan-routes.ts:431-441,443-454,456-466<br>docs/modules/WARDENX_MODULE_07_CARE_PLAN_SPEC_v0_3.md:774-794 | P2 | true | Add the three GETs to M07 spec section 4.1. |
| GAP-085 | M08 | Self-cosign predicate | m8.cosigner_role_match and the M9 cosigner predicate compare a membership-id fact with context.userId (Better Auth id), so 'cosigner must not be the author' never denies. In M8 neither cosign service checks the author, so an RN author can cosign their own encounter; M9's service layer still blocks self-cosign (dead defense-in-depth). M10 already fixed the same bug. | apps/backend/src/modules/08-encounters/abac-predicates.ts:110<br>apps/backend/src/modules/08-encounters/encounters-route-service-db.ts:344,2052,2064-2100,2363<br>apps/backend/src/bootstrap/plugins/authenticate.ts:81,115<br>(+2 more) | P2 | true | Compare against context.attributes.membershipId in both predicates (M10 membershipIdOf pattern), failing closed when null. |
| GAP-086 | M08 | Audit attribution | Supervisor release stores the routed cosigner, not the releasing supervisor, as supervisor_released_by, and emits no outbox event for the release. | apps/backend/src/modules/08-encounters/encounters-route-service-db.ts:2117-2139,2132<br>apps/backend/src/modules/08-encounters/routes/encounters-routes.ts:596-607 | P2 | false | Pass the actor's membershipId into supervisorRelease and store it; emit the catalogued release event. |
| GAP-087 | M08 | Compliance gate | Layer-3 sign-gate checks for required HOPE items (check 4) and Layer-2 decisions (check 7) are documented deferrals; a HOPE-timepoint visit note can be signed without the HOPE items. | apps/backend/src/modules/08-encounters/gate/checks.ts:68-77,92-101<br>apps/backend/src/modules/08-encounters/routes/encounters-routes.ts:466-484 | P2 | false | Add an encounter->HOPE-timepoint link and evaluate check 4 in gate/gate.ts; track Layer 2 under #123. |
| GAP-088 | M10 | Live RLS tests | hope_submission_result_event (CMS iQIES results for named patients) has no live RLS test of cross-tenant isolation or its append-only grant. | audit/implementation-status/IMPLEMENTATION_STATUS.md:22<br>packages/db/migrations/0226_hope_phase_7_manual_iqies_submission.sql:45-62<br>packages/db/migrations/0233_rls_force_and_hope_result_event_rls.sql:21-27,43-52 | P2 | false | Add a live case: org-B session cannot read org-A result event; UPDATE/DELETE refused. |
| GAP-089 | M10 | iQIES pipeline | Spec mandates automated iQIES submit/reconcile workers; implementation ships a manual package/upload/import flow (9 extra routes) with the workers unscheduled. Reasoned in code but recorded in no spec or ADR. | docs/modules/WARDENX_MODULE_10_HOPE_ENGINE_SPEC_v0_2.md:149,943-972<br>apps/backend/src/modules/10-hope/jobs/cron-workers.ts:8-16,451-452<br>packages/db/migrations/0226_hope_phase_7_manual_iqies_submission.sql:15 | P2 | false | Write an ADR for the manual iQIES transport and update M10 spec sections 1, 4.1 (9 routes), 4.2/4.8. |
| GAP-090 | M10 | Submission retry | POST /hope/submissions/:id/retry only flips rejected -> queued and emits submission_queued; no worker processes 'queued' batches in the manual flow, so the retried batch is orphaned (operators can recover by re-running assemble). Spec still says retry re-validates and re-assembles. | apps/backend/src/modules/10-hope/hope-route-service-db.ts:1764-1786,1796-1903,1821<br>apps/backend/src/modules/10-hope/routes/hope-routes.ts:511-517<br>apps/backend/src/modules/10-hope/jobs/cron-workers.ts:451-452<br>(+1 more) | P2 | true | Make retrySubmission re-validate and re-package into a new packaged batch, or remove the route and document that assemble supersedes it. |
| GAP-091 | M11 | Authorization | PATCH /orders/:id lets any orders.draft holder edit another clinician's draft (no author/supervisor check); indicationText is accepted by the schema but silently dropped. | apps/backend/src/modules/11-orders/routes/orders-routes.ts:83,284-296<br>apps/backend/src/modules/11-orders/orders-route-service-db.ts:1002-1018<br>apps/backend/src/modules/11-orders/routes/orders-typebox.ts:87-91<br>(+1 more) | P2 | true | Refuse in editDraft unless actor.membershipId === drafter_membership_id or the actor is a supervisor; persist indicationText or remove it from the schema. |
| GAP-092 | M11 | Outbox consumer | The M11 HOPE J2051 trigger consumer exists only as an unbound decider (documented handler-unbound exception); spec D7 order suggestion from m10.hope.j2051_trigger_fired is not fed. | scripts/outbox-subscription-exceptions.ts:159-165<br>apps/backend/src/modules/11-orders/consumers/hope-trigger.ts | P2 | false | Bind decideHopeTrigger in consumers/bindings.ts, declare m11 on the M10 event, remove the exception and confirm index.ts reaches the factory. |
| GAP-093 | M12 | Step-up | Prescriber enrollment and both policy PATCH routes lack step-up although the spec and permission catalog require it; enrollment sets deaAuthorizedSchedules used by dea_schedule_authorized. | apps/backend/src/modules/12-dosespot/routes/dosespot-routes.ts:511-525,556,583-585<br>packages/auth/src/permissions/contributed.ts:1484<br>docs/modules/WARDENX_MODULE_12_DOSESPOT_PRESCRIBING_SPEC_v0_2.md:1049-1055 | P2 | false | Add requireStepUp('dosespot_prescriber.enroll') and requireStepUp('prescribing_policy.update') to the three routes. |
| GAP-094 | M12 | EPCS | EPCS controlled signing is a stub: deaScheduleAuthorized/prescriberIal2Verified hardcoded true, nonce is the order id, no TOTP verified, epcs_signing_attempt never written. Unreachable today (certification constant 'not_certified'), but a config flip would enable controlled signing without 2FA. | apps/backend/src/modules/12-dosespot/dosespot-route-service-db.ts:148-152,597-622<br>docs/modules/WARDENX_MODULE_12_DOSESPOT_PRESCRIBING_SPEC_v0_2.md:28 | P2 | false | Implement epcs_signing_attempt rows, TOTP verification and DEA/IAL2 reads from dosespot_prescriber; add a hard throw independent of the certification constant until then. |
| GAP-095 | M12 | Schema | Spec ERD tables medication_order_discontinuation and rx_benefit_cache are absent from migrations and the manifest; discontinuation is only a status on medication_order. | packages/db/migrations/0038_dosespot_m12_tables.sql:10<br>docs/modules/WARDENX_MODULE_12_DOSESPOT_PRESCRIBING_SPEC_v0_2.md:248,524-536<br>architecture/module-manifest.ts:516-530 | P2 | false | Add the tables (migration, schema, manifest, RLS suite) or amend the spec to record the simpler model/deferral. |
| GAP-096 | M13 | Outbox consumer | M13 subscribes to m9.prn_reassessment_overdue, which M9 never catalogues or emits (documented no-such-event exception); PRN follow-up never fires. | apps/backend/src/modules/13-emar/consumers/index.ts:67<br>scripts/outbox-subscription-exceptions.ts:166-171 | P2 | false | Catalogue and emit the M9 event (or run an M13 overdue sweep over prn_administration), then bind the consumer. |
| GAP-097 | M13 | UI copy | The patient eMAR empty state and header still say the scheduled-dose materializer 'is not yet wired', but F-166 bound it; clinicians get wrong guidance on a medication-safety path. | apps/web/src/modules/13-emar/patient-emar.tsx:31-36,213,322<br>apps/backend/src/index.ts:6304-6310 | P2 | false | Update the empty-state copy and comments; reassess whether the Administer panel should still be order-driven. |
| GAP-098 | M15 | Pagination | The discipline-plan list fetches limit+1 rows then post-filters by caseload and computes has_more from the filtered set, so pagination ends early and off-caseload rows hide reachable plans (F-096 anti-pattern). | apps/backend/src/modules/15-discipline-care-plans/routes/read-service-drizzle.ts:288-307<br>apps/backend/src/modules/15-discipline-care-plans/routes/concurrency.ts:123-136<br>docs/history/gates-authz-and-routes.md:50-55 | P2 | false | Compute has_more/cursor from raw rows, or narrow in SQL with patient_id = ANY(caseloadPatientIds) unless hasOrgWideScope. |
| GAP-099 | M17 | Metrics | GET /api/v1/metrics/visits ignores its window and returns onTimeRate: 1; route-efficiency returns zeros for every membership. M30/M33 dashlets built on them show fabricated values. Caregiver-reminder cron has no producer (F-161). | apps/backend/src/modules/17-scheduling/scheduling-route-service-db.ts:2096-2106<br>apps/backend/src/modules/17-scheduling/jobs/index.ts<br>docs/modules/WARDENX_MODULE_17_SCHEDULING_SPEC_v0_2.md:722-723,1052-1068 | P2 | false | Compute onTimeRate from actual vs scheduled start within [from,to]; compute route efficiency from route_segment or return 501/null with an 'unavailable' flag. |
| GAP-100 | M17 | Portal routes | Portal upcoming-visit (M17) and EVV arrival (M18) routes take patient/visit ids from the request and check only an RBAC key, with no M39 family_caregiver_access consent scope; M18 staff reads bind only evv.read with no caseload. | apps/backend/src/modules/17-scheduling/routes/scheduling-routes.ts:525-533<br>apps/backend/src/modules/17-scheduling/scheduling-route-service-db.ts:2082-2094<br>apps/backend/src/modules/18-evv/routes/evv-routes.ts:481-491<br>(+2 more) | P2 | false | Bind requireAbac with the portal consent predicate (M19 portal_session_consent_active pattern) using the session patient; resolve visitId->patientId for arrival. |
| GAP-101 | M19 | ABAC | GET /triage-calls binds caseload_or_scope but the predicate allows collection reads and listTriageCalls applies no narrowing, so every triage.read holder sees all org triage calls. | apps/backend/src/modules/19-oncall/routes/triage-calls.routes.ts:76-79<br>apps/backend/src/modules/19-oncall/routes/read-service-drizzle.ts:220-270<br>apps/backend/src/modules/07-care-plan/abac-predicates.ts:300-315<br>(+1 more) | P2 | false | Narrow for callers without org-wide scope (own/escalated calls or caseload/on-call PE), or amend the spec to make triage.read org-wide. |
| GAP-102 | M21 | Spec routes | Four implemented M21 routes (perpetual-log, assign-retriever, declare-unreturnable, caregiver-signature) are absent from spec section 4.1 (the /api/v1/supplies prefix is already documented at line 2079). | apps/backend/src/modules/21-supplies/routes/comfort-kits.routes.ts:117,173,216<br>apps/backend/src/modules/21-supplies/routes/supply-requests.routes.ts:173<br>docs/modules/WARDENX_MODULE_21_SUPPLIES_DME_COMFORT_KITS_SPEC_v0_2.md:2079,2083-2120 | P2 | true | Add the four routes to spec section 4.1. |
| GAP-103 | M22 | Routes | Spec routes POST /api/v1/documents and POST /documents/:id/versions are permanent 503 DegradedError stubs; the working /api/v1/document-uploads flow and other extra routes are not in spec section 4.1; header comment contradicts itself. | apps/backend/src/modules/22-documents/documents-route-service-db.ts:2,488-499,882<br>apps/backend/src/modules/22-documents/index.ts:83-94<br>docs/modules/WARDENX_MODULE_22_DOCUMENTS_SPEC_v0_5.md:1489 | P2 | false | Remove or 410/308-redirect the legacy routes or document the verified-upload flow and extras in spec section 4.1; fix the header. |
| GAP-104 | M23 | Routes | Four spec'd M23 routes are missing: GET /api/v1/billing/validation-overrides, POST /billing/mac-credentials/:id:test, POST /admin/billing/platform-rules, POST /admin/billing/wage-index:load (partly superseded by F-211, spec not updated). | docs/modules/WARDENX_MODULE_23_BILLING_MEDICARE_SPEC_v0_2.md:1474,1493,1498,1499<br>apps/backend/src/modules/24-billing-medicaid/routes/claims.routes.ts:355 (M24 equivalent only) | P2 | false | Implement the override list and MAC credential test routes; implement or amend the platform admin routes in spec section 4.1. |
| GAP-105 | M23 | MAC credentials | POST /api/v1/billing/mac-credentials always returns 503 because secretCipher defaults to denyCipher and production passes none; per-tenant submitter credentials can never be stored (launch gateway uses env tokens). | apps/backend/src/modules/23-billing-medicare/routes/write-service-drizzle.ts:248-252,283,1046-1053<br>apps/backend/src/index.ts:3494-3498<br>docs/modules/WARDENX_MODULE_23_BILLING_MEDICARE_SPEC_v0_2.md:1492 | P2 | false | Bind a tenant-DEK SecretCipherPort (M24 credential-crypto pattern) into the write-service construction. |
| GAP-106 | M23 | Internal seam routes | Internal routes /api/v1/internal/billing/claim-day-projection and /submissions are permanent 503 deny-stubs (no internalSeam passed) yet advertised in the typed client; consumers use the in-process seam. | apps/backend/src/modules/23-billing-medicare/routes/internal.routes.ts:52-63,72<br>apps/backend/src/modules/23-billing-medicare/routes/mount.ts:94<br>packages/ui/src/core/api/schema.ts:9857,9874 | P2 | false | Bind a Drizzle M23InternalSeamProvider or remove the routes and amend spec section 4.1 #39/#40. |
| GAP-107 | M23 | Outbox consumers | M23 still treats m26.cap.projection_updated (and m8.encounter.signed) as deny-stub/handler-unbound 'until M26 lands' although M26 emits it; M26's catalog lists no m23 consumer. freeze_new_claims for m5.patient.deceased has no schema or implementation. Documented exception with stale comments. | apps/backend/src/modules/23-billing-medicare/consumers/subscription-map.ts:67,296,302,314-321<br>apps/backend/src/modules/23-billing-medicare/consumers/index.ts:139<br>scripts/outbox-subscription-exceptions.ts:185-191<br>(+2 more) | P2 | true | Decide whether M23 consumes these events, then bind live consumers (or seam pull), update catalogs and remove the exceptions/stale comments. |
| GAP-108 | M24 | Workers | medicaid-ack-pull cron and medicaid-claim.submit.retry queue are declared names only; batch-file state channels cannot ingest acks and portal failures have no retry queue (Oregon uses sync/poll). | apps/backend/src/modules/24-billing-medicaid/jobs/queues.ts:7,13,21<br>apps/backend/src/modules/24-billing-medicaid/jobs/submission-jobs.ts:597-626<br>docs/modules/WARDENX_MODULE_24_BILLING_MEDICAID_SPEC_v0_2_1.md:1775-1782 | P2 | false | Implement the ack-pull cron and submit.retry worker or amend spec section 4.9. |
| GAP-109 | M24 | Env switches | M24_LAUNCH_GATEWAY_ENABLED is opt-in (default off, workers silently not constructed) contrary to env.ts's opt-out integration-switch policy, and it and M25_X12_WORKER_URL/TOKEN plus ~14 other code-read vars are undocumented in any template or doc. | packages/medicaid-adapters/src/oregon/launch-gateway.ts:336<br>apps/backend/src/index.ts:4697-4699,3588-3591<br>apps/backend/src/bootstrap/env.ts:29-49<br>(+1 more) | P2 | false | Add M24_LAUNCH_GATEWAY_ENABLED to env.ts INTEGRATION_SWITCHES (opt-out, requiring M24_CREDENTIAL_ENCRYPTION_KEY) or document it as opt-in; document it, M25_X12_WORKER_* and other knobs in .env.example and the production template. |
| GAP-110 | M25 | Appeal deadlines | Appeal-deadline cron only alerts at T-30/14/7/1: no T-0 alert and no T-7 next-tier auto-spawn per spec 4.8 (spec itself is inconsistent). | apps/backend/src/modules/25-remittance/jobs/m25-jobs.ts:94-111<br>apps/backend/src/modules/25-remittance/domain/deadline.ts:25,68-78<br>docs/modules/WARDENX_MODULE_25_REMITTANCE_SPEC_v0_2.md:132,535,1424 | P2 | false | Decide the rule; implement T-0 + T-7 auto-spawn or amend spec line 1424. |
| GAP-111 | M26 | CCN resolution | Every cap period is created with sentinel CCN '000000'; no M40 CCN resolution and no PS&R CCN validation, so multi-CCN tenants cannot hold per-CCN periods. | apps/backend/src/modules/26-cap/routes/write-service-drizzle.ts:110-111<br>apps/backend/src/modules/26-cap/consumers/drizzle-store.ts:24<br>docs/modules/WARDENX_MODULE_26_CAP_MANAGEMENT_SPEC_v0_3.md:1486 | P2 | false | Resolve CCN via the M40 provider-entity seam at period open and validate the PS&R file's CCN, rejecting on mismatch/unbound. |
| GAP-112 | M26 | Cap seams | CapSettlementProvider (and Inpatient/Metrics/AlertSubscriber providers) are built but never registered; M33 Cap Watch's consumer bundle is never bound; aggregateForCostReport takes .limit(1) per cap year (multi-CCN under-aggregation); listSubscribers returns []. | apps/backend/src/modules/26-cap/wiring.ts:8-9,16-21<br>apps/backend/src/modules/26-cap/seam-impls.ts:132-133,202-230<br>docs/modules/WARDENX_MODULE_26_CAP_MANAGEMENT_SPEC_v0_3.md:18<br>(+1 more) | P2 | false | Register CapSettlementProvider and consume it from M27's per-beneficiary attachment; sum all cap_period rows per cap year; wire or delete the dead M33 Cap Watch bundle. |
| GAP-113 | M27 | Imports / statistics workers | Xero trial-balance pull, Gusto wage pull and statistics refresh workers are unbound (no OAuth storage), so jobs fail with M27WorkerPortUnbound; only manual imports work. The comment saying LevelOfCarePeriodReader is unavailable is stale. | apps/backend/src/modules/27-cost-report/jobs/m27-jobs.ts:1192-1215<br>apps/backend/src/index.ts:4528-4567,4456 | P2 | false | Bind statisticsSeams.serviceMonthlyBreakdown to LevelOfCarePeriodReader now; bind Xero/Gusto when tenant OAuth storage lands. |
| GAP-114 | M27 | Submit past deadline | submit and submit-past-deadline behave identically: submit delegates with reason '', the required reason is discarded, no deadline check runs in the service and no warn-severity audit is produced (only the validation rule gates deadlines). | apps/backend/src/modules/27-cost-report/routes/write-service-drizzle.ts:1137-1140,1142-1235,1199<br>apps/backend/src/modules/27-cost-report/routes/cost-reports.routes.ts:186-201<br>apps/backend/src/modules/27-cost-report/jobs/validation-context-builder.ts:150-151<br>(+1 more) | P2 | true | In submit refuse with 409 past current_effective_deadline_date; in submitPastDeadline persist the reason and emit the warn-severity audit. |
| GAP-115 | M27 | Outbox consumers | W-CR-12 (close open cost reports on provider-entity offboarding) cannot bind because M40 emits no such event; the m25.denial.opened denial-accrual handler is unbound (documented exceptions). | scripts/outbox-subscription-exceptions.ts:227-240<br>docs/modules/WARDENX_MODULE_27_COST_REPORT_SPEC_v0_2.md:1556-1558 | P2 | false | Have M40 emit an offboarded/deactivated event and bind a closing consumer; bind or remove the denial-accrual handler. |
| GAP-116 | M28 | LabObservationReader contract | M28's LabObservationReader view expects loadById(org, id) but M29 publishes getById/listByPatient/getByObservationId with a different DTO; an `as unknown as` cast hides it, so wiring DiagnosticReport would throw 'loadById is not a function'. Latent (no caller yet); consumed.ts comment is stale. | packages/fhir/src/r4/mappers/deps.ts:55-65<br>packages/fhir/src/r4/mappers/diagnostic-report/projector.ts:60<br>apps/backend/src/modules/29-external-interfaces/seams/published.ts:47-58,94-116<br>(+1 more) | P2 | true | Retype the @wardenx/fhir reader to M29's contract or add an adapter in consumed.ts; remove the cast and stale comment; add the per-value SUD flag if missing. |
| GAP-117 | M28 | Rate limiting | Per-client tier rate limits (100/10/1 RPS, 429 + Retry-After) and the one-concurrent-export cap are not enforced; fhirRateLimitDecision exists but is unused. | packages/fhir/src/rate-limit/sliding-window.ts:25,53<br>grep fhirRateLimitDecision\|isFhirBulkExportActive\|429 in apps/backend/src/modules/28-fhir -> none | P2 | false | Add a preHandler on /fhir/r4/* evaluating fhirRateLimitDecision against a Valkey counter; refuse a second $export per client with 429. |
| GAP-118 | M28 | Client onboarding approval | FHIR client co-approval only requires a different fhir.client.admin holder; two org admins can activate a PHI egress client without a Compliance Officer. | apps/backend/src/modules/28-fhir/routes/admin-clients.routes.ts:104-114<br>apps/backend/src/modules/28-fhir/routes/store-drizzle.ts:372-381 | P2 | false | Require compliance_officer (or a fhir.client.approve key granted only to it) on R25 or check the approver's role in approveClient. |
| GAP-119 | M28 | UI | None of the 11 M28 admin screens (client registry, onboarding wizard, bulk export, inbound proposal queues, disclosure accounting, etc.) exist; inbound FHIR proposals are API-only. | audit/implementation-status/IMPLEMENTATION_STATUS.md:40<br>architecture/module-manifest.ts:937<br>docs/modules/WARDENX_MODULE_28_FHIR_GATEWAY_SPEC_v0_4.md:1743-1757 | P2 | false | Add an apps/web 28-fhir module with screens.ts for the section 5.1 screens; add codePaths to both manifests. |
| GAP-120 | M29 | UI | No M29 operator/clinician screens (feeds, create-feed wizard, proposal detail, unmatched lab queue, NPPES history); ADT review and unmatched-lab review are API-only. | audit/implementation-status/IMPLEMENTATION_STATUS.md:41<br>architecture/module-manifest.ts:957<br>docs/modules/WARDENX_MODULE_29_EXTERNAL_INTERFACES_SPEC_v0_4.md:2019-2175 | P2 | false | Add apps/web/src/modules/29-external-interfaces with screens.ts, update both manifests and main.tsx. |
| GAP-121 | M29 | Compliance decrypt route | POST /messages/inbound/:messageId/decrypt is a permanent 501 citing an unbound per-tenant DEK, which is stale (dekForOrg resolves and M29 outbound already decrypts per org). Fails closed; moot until inbound ingest exists. | apps/backend/src/modules/29-external-interfaces/routes/message.routes.ts:64-85<br>apps/backend/src/modules/29-external-interfaces/routes/store.ts:455-460<br>apps/backend/src/modules/27-cost-report/jobs/m27-jobs.ts:1195-1200<br>(+1 more) | P2 | true | Implement decrypt with getTenantKeyProvider().dekForOrg once raw payloads are envelope-encrypted and emit the M4 disclosure event. |
| GAP-122 | M30 | Routes | R-48 GET /v1/quality/sra/cycles/:cycle_id/export (NIST 800-66r2 export) is intentionally not registered; no m30 render_requested event exists. | apps/backend/src/modules/30-quality/routes/sra.routes.ts:27-30,71<br>docs/modules/WARDENX_MODULE_30_HQRP_QUALITY_SPEC_v0_5.md:1458 | P2 | false | Add the export route service emitting a catalogued m30.sra.render_requested to M22. |
| GAP-123 | M30 | HCI composite | HCI indicators 5-7 are declared structurally unavailable, so the HCI composite is permanently withheld (documented, F-042). | packages/quality/src/measures/hci/availability.ts:39-61<br>packages/quality/src/measures/hci/index.ts:35-36 | P2 | false | Ingest CMS-published values or a claims feed for 5-7, and update the spec on externally sourced indicators. |
| GAP-124 | M30 | M30 -> M33 | MetricsProvider is registered by M33 but nothing consumes it; M33 has no quality/HQRP MV, its HQRP consumer is a dead deny-stub bundle and MV refresh subscriptions are deferred (nightly only). Documented GAP-066. | apps/backend/src/modules/33-reporting/wiring.ts:295-298<br>packages/reporting/src/refresh/outbox-subscriber.ts:101<br>apps/backend/src/index.ts:1205-1218 | P2 | false | Add an M33 quality base/MV over quality_measure_value with a live m30.measure.value_emitted binding, or embed MetricsProvider in M30's measure screen; remove the dead bundle. |
| GAP-125 | M30 | Measure inputs | comfort_kit_deployment_to_admin_minutes is active from FY2025 but has no input resolver, so the nightly recompute enqueues a job per provider entity that always throws M30WorkerPortUnbound into the DLQ. | packages/quality/src/measures/registry.ts:302-305<br>apps/backend/src/modules/30-quality/jobs/m30-jobs.ts:412-416,648-663,1660-1732,2043-2049 | P2 | false | Bind the measure to M13 + M21 data or declare it unavailable (HCI_UNAVAILABLE pattern) so it writes a suppressed row. |
| GAP-126 | M30 | UI | M30 compliance backends (SRA, CAHPS, risk register, infection/outbreaks, mortality) have no UI; web registers only quality.hub and quality.qapi-incidents. | apps/backend/src/modules/30-quality/routes/sra.routes.ts:77; cahps.routes.ts:92; risk-register.routes.ts:39<br>audit/ui-parity/UI_PARITY.md (30-quality rows) | P2 | false | Add M30 screens in apps/web/src/modules/30-quality/screens.ts for SRA, CAHPS, risk register, infection log and mortality review. |
| GAP-127 | M31 | Disclosure accounting | GET /api/v1/admin/portal-accounts/:id/audit-views (164.528 disclosure accounting) always returns {items: []}, which reads as 'no disclosures' rather than unavailable. | apps/backend/src/modules/31-portal/routes/admin.routes.ts:10-11,218-231<br>docs/modules/WARDENX_MODULE_31_PORTAL_TELEHEALTH_SPEC_v0_2.md:824 | P2 | true | Bind the M4 disclosure-trail read seam, or return 501/503 until bound. |
| GAP-128 | M31 | Schema | Spec defines 15 portal/telehealth tables; implementation owns 3 (no invitation, recording, consent-capture or webhook-event persistence) and the spec was never amended. | docs/modules/WARDENX_MODULE_31_PORTAL_TELEHEALTH_SPEC_v0_2.md:533-551<br>architecture/module-manifest.ts:1013<br>apps/backend/src/modules/31-portal/lifecycle/invitation.ts:8-9 | P2 | false | Amend the spec via ADR to the three-table model naming owners, or add the tables (manifest .ts/.cjs, migrations, RLS, audit triggers). |
| GAP-129 | M31 | Staff UI | The staff-facing portal admin pane (spec 5.3: accounts, invitations, telehealth visits, audit views, disclosure accounting) is not implemented in any app. | docs/modules/WARDENX_MODULE_31_PORTAL_TELEHEALTH_SPEC_v0_2.md:1437-1452<br>audit/implementation-status/IMPLEMENTATION_STATUS.md:43 | P2 | false | Add an apps/web/src/modules/31-portal staff slice registering the 5.3 screens; add the codePath to both manifests. |
| GAP-130 | M31 | CI security gates | M31 spec mandates `lint:portal-dto`, `lint:telehealth-phi-boundary` and a gated `test:security` CI job (and lists them in its sign-off checklist); none exists and no deferral is recorded. Runtime DTO validation and HMAC'd room names mitigate. | docs/modules/WARDENX_MODULE_31_PORTAL_TELEHEALTH_SPEC_v0_2.md:1863,1877,1980-1983,2238-2239<br>package.json (no such scripts); git grep 'lint:portal-dto\|phi-boundary' -> spec only<br>apps/backend/src/modules/31-portal/routes/portal-typebox.ts:1-8 | P2 | true | Add scripts/check-portal-dto.ts and scripts/check-telehealth-phi-boundary.ts and register them in scripts/run-fitness-gates.ts, or amend the spec to name existing enforcement and record a reasoned deferral. |
| GAP-131 | M32 | Inference seams | All ten section 4.2 AI inference seams remain deny-stubs because no pipeline is passed; the stated blocker (no per-tenant DEK cipher) is stale since the key-ring TenantKeyProvider binds on a DB boot. Documented 'ai.full OFF' posture. | apps/backend/src/index.ts:1686-1705,1799-1802<br>apps/backend/src/modules/32-ai-platform/seams/index.ts:104-110 | P2 | false | Build the AiInvocationPipeline with a cipher over getTenantKeyProvider() behind the ai.full flag/kill switch/opt-in, or update the comment to the real blocker. |
| GAP-132 | M33 | Report catalog | Only 3 of 36 platform report MVs exist (33 'registered' placeholders since migration 0061; no later migration creates or activates more), so the spec's day-one HQRP/HOPE/cap/bereavement dashboards are absent. Documented scope. | packages/db/migrations/0061_reporting_seed.sql:4-9,15-17,28,30<br>grep -l 'CREATE MATERIALIZED VIEW' packages/db/migrations -> only 0060_reporting_mv.sql<br>apps/backend/src/modules/33-reporting/system-dashboard-seeder.ts:17-23<br>(+1 more) | P2 | true | Add migrations for the remaining MVs whose upstream tables exist (HOPE window compliance, care-plan review overdue, cap, billing first), flip them active and run scripts/backfill-system-dashboards.ts. |
| GAP-133 | M33 | ABAC scope | Reporting team/location scope always collapses to 'self' because M2 publishes no SupervisorReader; supervisors cannot see team data (fail-closed, documented). | apps/backend/src/modules/33-reporting/abac-resolver-db.ts:12-16,54 | P2 | false | Publish an M2 SupervisorReader (or reuse M5 CaseloadProvider) and call it from buildDrizzleReportingAbacResolver. |
| GAP-134 | M34 | Routes | Six spec'd M34 routes are not implemented (platform DSAR list, platform onboarding view/skip, tenant account read, tenant feature-flag read/write); two TypeBox schemas are orphaned. The DSAR list may be an unrecorded M34-F09 decision. | docs/modules/WARDENX_MODULE_34_SAAS_TENANT_PLATFORM_SPEC_v0_3.md:1645,1646,1656,1670,1689,1690<br>apps/backend/src/modules/34-saas-tenant-platform/routes/typebox.ts:160-163,263-266<br>audit/AUDIT_M34.md:32 | P2 | false | Implement the routes (step-up on onboarding skip) and enrich them, or amend spec 4.1 via ADR and delete the orphan schemas. |
| GAP-135 | M34 | Routes | Four M34 routes (support-session events, POST/PATCH baa-register, signup-intents reject) are not in spec 4.1; the BAA-register writes are gated by the same READ guard as the GET with no step-up, unlike every other platform-ops write. | docs/modules/WARDENX_MODULE_34_SAAS_TENANT_PLATFORM_SPEC_v0_3.md:1629-1665<br>apps/backend/src/modules/34-saas-tenant-platform/routes/platform/support-sessions.ts:135-136<br>apps/backend/src/modules/34-saas-tenant-platform/routes/platform/baa-register.ts:65-67,86-88<br>(+1 more) | P2 | true | Document the four routes in spec 4.1 with permission/ABAC/step-up and decide the BAA-register write guard. |
| GAP-136 | M36 | ABAC | messaging.manage_members routes carry only requirePermission; addMember/removeMember check neither location nor channel kind, so a holder can add themselves to another pair's DM and then read it. Header claims channel_visibility ABAC. | apps/backend/src/modules/36-messaging/routes/messaging-routes.ts:10-12,89,98-99,199-225<br>apps/backend/src/modules/36-messaging/messaging-route-service-db.ts:506-550<br>packages/auth/src/permissions/contributed.ts:220-225<br>(+1 more) | P2 | true | Add requireAbac('messaging.manage_members','location_membership') (or a channel_member_admin predicate) and refuse manual edits on 'dm' channels. |
| GAP-137 | M36 | ABAC channel_visibility | channel_visibility implements only the membership branch, not caseload_membership (care_team) or bereavement_membership; with channel_sync unbuilt, care_team access can outlive caseload removal. | apps/backend/src/modules/36-messaging/messaging-route-service-db.ts:337-363<br>docs/modules/WARDENX_MODULE_36_MESSAGING_SPEC_v0_4.md section 4.5 (~1715) | P2 | false | Branch canViewChannel on channel_kind: care_team -> CaseloadProvider seam, bereavement -> M16 seam. |
| GAP-138 | M36 | Routes | Spec'd platform-ops route GET /api/v1/admin/messaging/alert-deliveries is not implemented (permission key exists). | docs/modules/WARDENX_MODULE_36_MESSAGING_SPEC_v0_4.md:1554<br>packages/auth/src/permissions/contributed.ts:259 | P2 | false | Add the route with messaging.admin.read plus a platform-ops ABAC conjunct, audited as elevated access, and enrich it. |
| GAP-139 | M36 | Live RLS tests | alert_receipt has no live RLS test although it shipped once with no RLS or grants (0243 -> 0247 production 42501). | audit/implementation-status/IMPLEMENTATION_STATUS.md:48<br>packages/db/migrations/0247_alert_receipt_rls_and_grants.sql:1-4 | P2 | false | Add a wardenx_app live suite asserting cross-tenant invisibility and insert refusal; add the package.json script and ci.yml job. |
| GAP-140 | M37 | IRC resumption | The IRC 30-day resumption rule is not applied at episode open (resumedStartingDayCount unused), so IRC can be split into fresh episodes; combined with the missing watchdog the IRC cap is unenforced. | apps/backend/src/modules/37-ipu/routes/service-drizzle.ts:536-543<br>packages/inpatient/src/machines/irc-episode.ts:95-118<br>docs/modules/WARDENX_MODULE_37_IPU_SPEC_v0_2.md:248 | P2 | false | Select episodes closed within the look-back in open_irc_episode and set consecutiveDayCount via resumedStartingDayCount. |
| GAP-141 | M37 | ABAC predicates | None of the five section 4.7 M37 predicates is consulted by any route (target-boolean stubs); ipu.staff_member unit scoping is unenforced (getAdmission is a plain RLS read) and RN-coverage is checked only in four service methods, not 'every mutation' (e.g. equipment assign). Removal documented in guards.ts. | apps/backend/src/modules/37-ipu/abac/predicates.ts:42-50<br>apps/backend/src/modules/37-ipu/routes/guards.ts:5-18<br>apps/backend/src/modules/37-ipu/routes/service-drizzle.ts:303,933-938,947,1002,1155,1794,2240-2256<br>(+1 more) | P2 | true | Enforce staff_member (unit assignment or IPU director) in the service on IPU admission reads/writes and extend RN coverage to the section 2.3 list, or amend spec 4.1/4.7. |
| GAP-142 | M39 | Outbox consumers | M39 section 4.6 consumers (m5.patient.merged re-point, m4.legal_hold.*, m22.document.rendered back-ref) have deciders but no bindings; after a merge the survivor has no consents (fail-closed denials) and the duplicate's consents are orphaned. | apps/backend/src/modules/39-consent/consumers.ts:60,69<br>apps/backend/src/modules/05-patient/events-by-m5.ts:166-167<br>docs/modules/WARDENX_MODULE_39_CONSENT_SPEC_v0_3.md:1628-1639 | P2 | false | Bind M39 consumers for those events, add m39 to the producers' declaredConsumers and wire them in index.ts. |
| GAP-143 | M39 | Jobs | 4 of 6 M39 crons are unbuilt (revocation-cascade-retry, renewal-cycle-close, draft-auto-expire, eval-audit-partition); stuck cascades are not retried automatically and consent_eval_audit lands in the DEFAULT partition. Self-documented. | apps/backend/src/modules/39-consent/jobs/index.ts:11-12<br>apps/backend/src/modules/39-consent/jobs/cron-workers.ts:61-72<br>packages/db/migrations/0023_consent_m39_rls_audit_triggers.sql:454 | P2 | false | Add the four workers and schedules in cron-workers.ts using withOrgContext per org. |
| GAP-144 | M40 | ExternalGriefResourceReader | ExternalGriefResourceReader is never registered (no external_grief_resource table), so GET /api/v1/portal/bereavement/resources returns 501 by design; the M22 tenant-catalog half is not composed either. M31 header claims every producer is live. | apps/backend/src/modules/31-portal/routes/read.routes.ts:422-437<br>apps/backend/src/bootstrap/seams/registry.ts:253-259<br>apps/backend/src/bootstrap/seams/providers.ts:285-287<br>(+2 more) | P2 | true | Build the M40 grief-resource catalog seam (or compose the M22 tenant catalog alone) and register it; correct the M31_REQUIRED_SEAMS header. |
| GAP-145 | M40 | Jobs | The M40 job tier is unbuilt: BAA 90/30/0-day and license expiration alerts, fuzzy dedup, execute_merge/repoint, NPPES fallback and provisional aging never run (queues defined as data only). mdm-routes.ts claims repoint jobs run in the background. | packages/mdm/src/jobs/queues.ts:10,40<br>grep MDM_QUEUES\|MDM_JOB apps/backend/src -> 0 hits<br>apps/backend/src/modules/40-mdm/routes/mdm-routes.ts:19-22<br>(+1 more) | P2 | false | Add apps/backend/src/modules/40-mdm/jobs/ with at least baa_expiration_scan, license_expiration_scan and execute_merge/repoint wired from index.ts; correct the header. |
| GAP-146 | global | UI parity | About 40 documented screen specs have no registered screen (keyword join; ui:parity does no per-screen join): e.g. CLINICAL_COPILOT, DEATH_PRONOUNCEMENT, WOUND_CARE, ALLERGY_MANAGEMENT, BREACH_SECURITY_INCIDENTS, OIG_COMPLIANCE_PROGRAM, PATIENT_RIGHTS_GRIEVANCES, PRIOR_AUTHORIZATION, TIMESHEETS_PAYROLL, FHIR_GATEWAY_CLIENTS, HL7_INTERFACE_LOGS and the six non-patient portals. Some are partly covered by other screens. | audit/ui-parity/UI_PARITY.md:9,13<br>docs/design/screens/ (cited spec files, e.g. clinical/WARDENX_UI_WOUND_CARE.md, revenue/WARDENX_UI_PRIOR_AUTHORIZATION.md)<br>apps/backend/src/modules/28-fhir/routes/admin-clients.routes.ts:37 (backend exists, no UI caller) | P2 | true | Add a spec-to-screen key (e.g. a `spec:` field on ScreenDef) so scripts/report-ui-parity.ts lists unbuilt specs; prioritise clinical/compliance specs whose backends exist. |
| GAP-147 | global | Frame-fidelity registry | Frame-fidelity notes for eMAR, Encounter and Patient Chart are stale (claim unbuilt writes/unbound selections/placeholder cards that now exist); the gate checks only report freshness, not note accuracy. | scripts/frame-fidelity/registry.ts:108,143,188-189<br>apps/web/src/modules/13-emar/emar-api.ts:278,301,312<br>apps/web/src/modules/08-encounters/encounter-read.tsx:461<br>(+1 more) | P2 | false | Edit the three entries in scripts/frame-fidelity/registry.ts and regenerate with bun run frame:fidelity. |
| GAP-148 | global | Frame-fidelity coverage | Frame-fidelity maps 17 of 120 ledger frames (3 matched, 14 partial); the other 103 are not even 'pending', so '0 pending' reads as complete. No revenue (M23-M27) screen is mapped. | audit/frame-fidelity/FRAME_FIDELITY.md:8-9<br>bun run scripts/report-frame-fidelity.ts --check -> 17 mapped, 3/14/0 | P2 | false | Seed scripts/frame-fidelity/registry.ts with a 'pending' row for every ledger frame that has a built screen, starting with M23/M25/M26/M27. |
| GAP-149 | global | Security headers | The SPA document is served without CSP, frame-ancestors, X-Frame-Options, HSTS, nosniff or Referrer-Policy (headers are set only on Fastify API responses), contrary to SECURITY_HARDENING 9.6.1; backend CSP also lacks report-uri. | deploy/production/web-nginx.conf:1-21<br>deploy/production/nginx/wardenx-frontend.conf:24-30<br>apps/backend/src/bootstrap/plugins/security.ts:46-56,66-69<br>(+1 more) | P2 | true | Add the security.ts header set with `always` at server level (and in add_header location blocks) in web-nginx.conf; verify CSP against the Vite build; optionally add report-uri. |
| GAP-150 | global | Fitness gate (PHI guards) | check-fitness-gaps phi-guards regexes are vacuous: a table passes RLS if 'enable row level security' appears anywhere earlier in the corpus, and the audit-trigger check passes on any 'trigger' + 'on <table>' + 'audit'; not net-effect aware. Live dev DB is currently clean. | scripts/check-fitness-gaps.ts:199-201,205-207<br>scratch replica: fake table passes both checks<br>psql dev DB (through 0306): 0 org tables lacking RLS/FORCE/policy; 0 patient tables lacking audit trigger | P2 | false | Replace the regexes with a per-table net-effect replay (ENABLE/DISABLE RLS, CREATE/DROP TRIGGER) or a pg_catalog live assertion. |
| GAP-151 | global | Architecture docs | Ops runbook and security hardening cite unannotated infra/ artifacts (secret inventory, MinIO policies, Grafana dashboards, firewall rules) that do not exist; arch:architecture-docs cannot see them because PATH_PREFIXES omits infra/ and deploy/. | docs/architecture/WARDENX_OPS_RUNBOOK_v0.1.md:816,985,1333<br>docs/architecture/WARDENX_SECURITY_HARDENING_v0_2.md:793<br>scripts/check-architecture-docs.ts:37 | P2 | false | Add infra\|deploy to PATH_PREFIXES, then create the artifacts or annotate the four citations as not yet created. |
| GAP-152 | global | Deploy bootstrap | bootstrap-vps.sh reads deploy/production/.env.production.example, which has never been committed (gitignored by `.env.*`); a first-time bootstrap / DR rebuild fails under set -eu. Ten production-required keys appear in no committed template (TRUSTED_ORIGINS, TWO_FACTOR_ENCRYPTION_KEY, M24_CREDENTIAL_ENCRYPTION_KEY, M13_WITNESS_SIGNING_KEY, MESSAGING_ENCRYPTION_KEY, CURSOR_SIGNING_KEY, PASSKEY_RP_ID, WEBAUTHN_RP_ID, TRUSTED_PROXY_CIDRS, INTERNAL_SERVICE_TOKEN). | deploy/production/bootstrap-vps.sh:9,39-50<br>git check-ignore -v deploy/production/.env.production.example -> .gitignore:25:.env.*<br>git log --all -- 'deploy/production/.env.production*' -> empty<br>(+2 more) | P2 | true | Add deploy/production/.env.production.example with every env.ts REQUIREMENTS key using the REPLACE_WITH_* placeholders the bootstrap's sed expects; add `!deploy/production/.env.production.example` to .gitignore; optionally gate key coverage. |
| GAP-153 | global | Error envelope | 29+ error responses in M02, M12, M29, M33 and M37 bypass the M1 section 4.3 envelope with flat {code,message} or string {error:'...'} bodies, without correlationId. | docs/modules/WARDENX_MODULE_01_FOUNDATION_SPEC_v0_4.md:2278-2300<br>apps/backend/src/bootstrap/plugins/error-handler.ts:39-66<br>apps/backend/src/modules/37-ipu/routes/ipu.routes.ts:236<br>(+3 more) | P2 | false | Replace direct error sends with thrown WardenXError subclasses (extra fields via details); add a fitness grep with an allowlist for vendor-mandated webhook replies. |
| GAP-154 | M01 | Events / realtime | m1.system_status.changed and m1.feature_flag.updated are catalogued but never emitted; Socket.IO realtime events are an ADR-0036 deferral, but catalog entries without producers remain drift. | packages/shared/src/outbox-events/events-by-m1.ts:12-43<br>apps/backend/src/bootstrap/routes/system.ts:88-94<br>docs/adr/ADR-0036-no-realtime-backbone.md | P3 | false | Publish m1.system_status.changed from the admin upsert, or drop the catalog entries and record it in ADR-0036. |
| GAP-155 | M01 | OpenAPI | 5 bootstrap routes are unenriched (health/ready/version/metrics probes plus the client-consumed GET /api/v1/system/feature-flags, which has no response schema, so the UI uses a hand-written FeatureFlags type); the baseline allows a deficit of 5. | apps/backend/src/bootstrap/routes/system.ts:82-86; apps/backend/src/bootstrap/routes/health.ts:30-46<br>scripts/openapi/enrichments.ts:10731-10745<br>docs/api/openapi.json paths['/api/v1/system/feature-flags'].get.responses['200'] = {description:'OK'}<br>(+2 more) | P3 | true | Add ROUTE_ENRICHMENTS for GET /api/v1/system/feature-flags ({flags: Record<string,boolean>}) and the probes; run openapi:emit, client:gen, openapi:coverage --update. |
| GAP-156 | M03 | Status matrix | The implementation-status matrix shows M03 Tests and M01 Routes/Screens as absent although authz tests and bootstrap routes exist (heuristic misses them). | audit/implementation-status/IMPLEMENTATION_STATUS.md:13,15<br>apps/backend/__tests__/authz-routes.test.ts, authz-idor.test.ts | P3 | false | Teach the status:matrix heuristic the authz-*/break-glass-* slugs and count apps/backend/src/bootstrap/routes as M1 routes. |
| GAP-157 | M03 | ABAC fitness gate | No boot-level check that every requireAbac predicate name is registered at runtime; check-abac-predicates is static and per-module tests are scoped. Production is currently correct, but a dropped registrar call would 403 every caller with all gates green. | scripts/check-abac-predicates.ts:31-33<br>apps/backend/src/modules/11-orders/index.ts:94; apps/backend/src/modules/22-documents/index.ts:61<br>scripts/check-boot-with-platform-credential.ts (no ABAC check) | P3 | true | Add a DB-booted test (extend check:boot:platform or a live boot suite) asserting every requireAbac literal resolves in abacRegistry.names(). |
| GAP-158 | M05 | UI | Census KPIs (Admissions, Discharges, GIP, Recerts due) are hardcoded '—' placeholders; M6 list endpoints exist but are paginated lists, not counts. | apps/web/src/modules/05-patient/patient-list-census.tsx:83-86,104-105<br>packages/ui/src/core/api/schema.ts:1859-1867,5180-5187<br>audit/frame-fidelity/FRAME_FIDELITY.md:29 | P3 | true | Add a count/metrics read (or census-metrics extension) and bind the KPIs; update the frame-fidelity note. |
| GAP-159 | M06 | Spec route inventory | 22 implemented M06 routes (referral phase-1 workflow, readiness, patient admissions, evidence uploads, confirm-bed) are not in the spec section 4.1 inventory (68 vs 46). | apps/backend/src/modules/06-admission/routes/admission-routes.ts<br>docs/modules/WARDENX_MODULE_06_ADMISSION_ELECTION_CERTIFICATION_SPEC_v0_4.md:1787-1846 | P3 | false | Add the 22 routes with permission/ABAC to spec section 4.1. |
| GAP-160 | M08 | Spec route inventory | 6 M08 read routes are missing from the spec's '31 routes' inventory (37 registered); route header says 34. | apps/backend/src/modules/08-encounters/routes/encounters-routes.ts:1-2,245,320<br>docs/modules/WARDENX_MODULE_08_ENCOUNTERS_SPEC_v0_2.md:1152 | P3 | false | Add the six GETs to spec 4.1 and fix the header count. |
| GAP-161 | M09 | Spec route inventory | Two implemented M09 routes (summary/document POST, GET /scales) are not in spec 4.1. | apps/backend/src/modules/09-assessments/routes/assessments-routes.ts:219,417<br>docs/modules/WARDENX_MODULE_09_CLINICAL_ASSESSMENTS_SPEC_v0_3.md:757-776 | P3 | false | Add both routes to spec 4.1. |
| GAP-162 | M10 | OpenAPI | GET /hope/submissions/{id}/package (ZIP download) declares no response content type, so the generated client cannot type it. | audit/openapi-coverage/OPENAPI_COVERAGE.md:22<br>docs/api/openapi.json paths['/api/v1/hope/submissions/{id}/package'] | P3 | false | Add a 200 application/zip binary response to the M10 enrichment. |
| GAP-163 | M10 | ABAC | HOPE draft update and answer/HUV PATCH routes omit the discipline ABAC (authorDisciplineAllowed) the spec requires; GET /hope/sfv deliberately skips caseload scope and returns an org-wide PHI worklist. | apps/backend/src/modules/10-hope/routes/hope-routes.ts:270-271,376-377,393,432-447<br>docs/modules/WARDENX_MODULE_10_HOPE_ENGINE_SPEC_v0_2.md:952,957 | P3 | false | Add ABAC_AUTHOR to PUT/PATCH routes; filter listSfv by caseload for non-org-wide roles. |
| GAP-164 | M11 | Spec route inventory | Six M11 routes (verbal-orders, held-transmissions, resend/recover-transmission and its cosign/cancel) are absent from spec 4.1 (only in docs/history and openapi.json). | apps/backend/src/modules/11-orders/routes/orders-routes.ts:253,462,486,511,530<br>apps/backend/src/modules/11-orders/routes/held-transmissions-routes.ts:38 | P3 | false | Add the routes with permissions/step-up to M11 spec 4.1. |
| GAP-165 | M12 | Spec / status matrix | POST /medication-orders/:id/report-error (F-205) and its permission are absent from the M12 spec route inventory (the event is documented), and the status matrix's 'Adapter' green overstates readiness while the only DoseSpot client is the deny-stub. | apps/backend/src/modules/12-dosespot/routes/dosespot-routes.ts:294-299<br>docs/modules/WARDENX_MODULE_12_DOSESPOT_PRESCRIBING_SPEC_v0_2.md:1021-1059,1234<br>audit/implementation-status/IMPLEMENTATION_STATUS.md:9,24<br>(+1 more) | P3 | true | Add the route to spec 4.1; refine the status-matrix adapter heuristic to exclude deny-stub-only clients. |
| GAP-166 | M14 | Spec route inventory | M14 implements routes absent from spec 4.1 (ad-hoc meeting create, agenda/attendance/decisions/recert-windows GETs, idg-history) while the spec's internal /api/v1/internal/idg/* routes are served via in-process seams instead; DECISION_PAYLOAD_INVALID is never emitted. | apps/backend/src/modules/14-idg/routes/idg-routes.ts:219,522<br>docs/modules/WARDENX_MODULE_14_IDG_SPEC_v0_4.md:884-886 | P3 | false | Update spec 4.1/4.3 to the implemented routes and seams; drop or implement DECISION_PAYLOAD_INVALID. |
| GAP-167 | M17 | Live RLS tests | membership_credential (M17) and bereavement_cop_opt_out_credit (M16) have no direct cross-tenant RLS assertion on the app role (only setup inserts / admin reads). | packages/db/migrations/__tests__/m17-rls-isolation.live.test.ts<br>apps/backend/__tests__/m16-opt-out-changed.live.test.ts:153,299,355-371 | P3 | false | Add both tables to the m16/m17 rls-isolation live suites. |
| GAP-168 | M17 | Spec route inventory | Implemented routes absent from spec 4.1: M17 /visits/:id/arrive and membership credentials; M19 paper-reentry (+worklist) and vendor-sessions/bind; M20 GET /safety/incidents list. | apps/backend/src/modules/17-scheduling/routes/scheduling-routes.ts:253,575,592,610<br>apps/backend/src/modules/19-oncall/routes/triage-calls.routes.ts:307,325; vendor-sessions.routes.ts:71<br>apps/backend/src/modules/20-field-safety/routes/incidents.routes.ts:87-88<br>(+1 more) | P3 | true | Add these rows (permission/ABAC) to the M17, M19 and M20 spec 4.1 tables. |
| GAP-169 | M22 | Seam M22 -> M32 | M22's DocLens resolver is hard-wired to the deny-stub; rewiring alone would change nothing because M32 registers DocLens seams only when a pipeline is passed (none is). Latent, documented (F-231). | apps/backend/src/modules/22-documents/extraction/doclens-capability.ts:12-16,23-31<br>apps/backend/src/modules/22-documents/index.ts:125<br>apps/backend/src/modules/32-ai-platform/seams/index.ts:111-112,122-125<br>(+2 more) | P3 | true | Project getSeam('DocLensClassifier'/'DocLensExtractor') into DocLensCapabilityPort with a fail-closed fallback once the M32 pipeline binds. |
| GAP-170 | M22 | Tenancy spec text | M22, M25 and M31 specs prescribe tenant_id / app.tenant_id RLS, which ADR-0010 D2 bans (architecture wins); shipped migrations correctly use app.org_id. Spec-text drift only. | docs/adr/ADR-0010-tenancy-rls-invariants.md:31-35<br>docs/modules/WARDENX_MODULE_22_DOCUMENTS_SPEC_v0_5.md:2806-2807<br>docs/modules/WARDENX_MODULE_25_REMITTANCE_SPEC_v0_2.md:1802<br>(+1 more) | P3 | false | Rewrite M22 8.2, M25 8.1 and M31 task A4 to organization_id / app.org_id with revision rows (M17-F10 precedent). |
| GAP-171 | M23 | Spec route paths | M23 route paths drift from spec 4.1 (NOE/NOTR/validation not under /billing, duplicate validate route, rule-configs path). | Route extraction: POST /api/v1/billing/claims/:id/validate and /api/v1/claims/:id/validate<br>docs/modules/WARDENX_MODULE_23_BILLING_MEDICARE_SPEC_v0_2.md:1471-1488 | P3 | false | Update spec 4.1 to implemented paths and drop one duplicate validate route. |
| GAP-172 | M25 | Spec note | M25 spec WX-PR-012 note says the M23 claim-match seam 'remains unbound', but it is now bound. | docs/modules/WARDENX_MODULE_25_REMITTANCE_SPEC_v0_2.md:1010<br>apps/backend/src/modules/23-billing-medicare/cost-report-seams.ts:114<br>apps/backend/src/index.ts:3603-3604 | P3 | false | Amend the M25 spec note. |
| GAP-173 | M26 | Routes | PS&R import is registered as POST /api/v1/cap/periods/:periodId/psr-imports while the spec declares POST /v1/cap/psr-imports. | apps/backend/src/modules/26-cap/routes/psr.routes.ts:35<br>docs/modules/WARDENX_MODULE_26_CAP_MANAGEMENT_SPEC_v0_3.md:1095 | P3 | false | Update spec 4.1 to the period-scoped path (or alias). |
| GAP-174 | M30 | Outbox consumer | The m6.election.signed HCI-denominator recompute handler is implemented but unbound (nightly recompute covers it with <=24h staleness); exception reason is stale. | packages/quality/src/consumers/handlers.ts:150-157<br>scripts/outbox-subscription-exceptions.ts:241-247 | P3 | false | Bind a buildM30ElectionSignedConsumer using the existing enqueueRecompute port. |
| GAP-175 | M31 | Routes | GET /api/v1/admin/telehealth/visits/:id returns 200 with lifecycleState 'not_found' instead of 404. | apps/backend/src/modules/31-portal/routes/admin.routes.ts:257<br>apps/backend/src/modules/31-portal/routes/telehealth.routes.ts:101 | P3 | false | Throw NotFoundError when telehealthById returns null. |
| GAP-176 | M31 | UI auth guard | The portal SPA has no chromed-route auth guard (web/admin have RequireChrome); framed routes render for anonymous visitors (server still enforces auth). Portal not deployed today. | apps/portal/src/app.tsx:73-81<br>apps/web/src/shell/app.tsx:68-75; apps/admin/src/shell/require-chrome.tsx:14-22 | P3 | false | Add a portal session provider + RequireChrome equivalent around PortalFrame before deployment. |
| GAP-177 | M35 | Spec route inventory | Four M35 admin GETs (dunning, plans/:id, promos/:id, refunds/:id) are registered but absent from spec 4.2. | docs/modules/WARDENX_MODULE_35_SUBSCRIPTION_BILLING_SPEC_v0_3.md:1281-1314<br>apps/backend/src/modules/35-subscription/routes/admin.routes.ts | P3 | false | Add the four rows to M35 spec 4.2. |
| GAP-178 | M36 | Comments / spec | Stale 'writes defer to FB-T05 (501)' comments although M36 writes are live; POST /api/v1/alerts/:id/read is missing from spec 4.1. | apps/backend/src/modules/36-messaging/index.ts:136<br>apps/backend/src/index.ts:3257<br>apps/backend/src/modules/36-messaging/routes/messaging-routes.ts:307 | P3 | false | Update both comments and add the route to spec 4.1. |
| GAP-179 | M37 | Spec route inventory | M37 spec says 38 routes (lines 554, 1368, 2337) versus 52 implemented; seven read/confirm routes are absent from 4.1 and row 31 lists only visitor_restriction.apply although the spec's own catalog defines .lift for DELETE. | apps/backend/src/modules/37-ipu/routes/ipu.routes.ts:203-204,372-406,505-507,582-585,610-612<br>docs/modules/WARDENX_MODULE_37_IPU_SPEC_v0_2.md:554,1368,1402,1600,2337<br>audit/openapi-coverage/OPENAPI_COVERAGE.md:49 | P3 | true | Update spec 4.1 with the added routes and the lift key. |
| GAP-180 | M39 | Portal routes | Portal consent routes #25-27 (/api/v1/portal/consents/*) are not implemented; the spec marks them Phase 2 (recorded deferral). | grep 'portal/consents' apps/backend/src -> 0 hits<br>docs/modules/WARDENX_MODULE_39_CONSENT_SPEC_v0_3.md:1804 | P3 | false | Build when M31 Phase 2 lands; track only. |
| GAP-181 | global | Seam status comments | Stale composition-root/M30 comments describe live seams as unbound or in-memory (provider-entity resolver, SignedEncountersReader, emitThresholdBreached), and several outbox-subscription-exception reasons say events are 'already deferred' though the register holds only m22 pairs. | apps/backend/src/index.ts:3355 vs :3366; :4448-4449 vs :1172; :1201-1203<br>apps/backend/src/modules/30-quality/jobs/m30-jobs.ts:2461-2463 vs :1780-1792<br>bun run arch:outbox-bindings -> 'Declared-but-unbound: 2 (module, event) pair(s)' | P3 | false | Update the comments and refresh the reason strings in scripts/outbox-subscription-exceptions.ts for m30/m23/m27/m11. |
| GAP-182 | global | Auth / CSRF docs | SameSite policy contradicts itself: SECURITY_HARDENING 5.1 says Lax (matching csrf.ts:127) while 9.6.4, SYSTEM_DESIGN 5.1 and M31 9.3 say Strict. | docs/architecture/WARDENX_SECURITY_HARDENING_v0_2.md:189,576,1173<br>docs/architecture/WARDENX_SYSTEM_DESIGN_v0.3.md:942<br>docs/modules/WARDENX_MODULE_31_PORTAL_TELEHEALTH_SPEC_v0_2.md:1985<br>(+1 more) | P3 | false | Change the Strict references to Lax + double-submit token. |
| GAP-183 | global | CLAUDE.md / AGENTS.md | CLAUDE.md:66 (and AGENTS.md) says audit-fitness has a --check mode inside arch:fitness; it has neither and is not a package.json script. | CLAUDE.md:66<br>scripts/run-fitness-gates.ts:56-59<br>docs/architecture/ARCHITECTURE_25_15_FITNESS.md:162 | P3 | false | Move audit-fitness out of the --check list in CLAUDE.md and copy CLAUDE.md to AGENTS.md verbatim. |
| GAP-184 | global | Doc links | Four broken relative links: docs/history/status-overview.md:77,78,81 (./docs/... resolves under docs/history) and docs/REMEDIATION_SUMMARY.md:41 (../ARCHITECTURE_25_15_FITNESS.md). | docs/history/status-overview.md:77,78,81<br>docs/REMEDIATION_SUMMARY.md:41 | P3 | true | Change to ../DEVELOPMENT.md, ../PHASE_0_SCAFFOLD_PLAN.md, ../adr/ADR-0027-... and ./architecture/ARCHITECTURE_25_15_FITNESS.md. |
| GAP-185 | global | Spec script references | Specs/plans cite non-existent `bun run` scripts (check:manifest, check:cruiser, check:table-ownership, test:rls-isolation, lint:deps, db:migrate:up/down, gen:proto, db:seed:admissions). | docs/modules/WARDENX_MODULE_29_EXTERNAL_INTERFACES_SPEC_v0_4.md:2964-2966<br>docs/modules/WARDENX_MODULE_31_PORTAL_TELEHEALTH_SPEC_v0_2.md:2034,2212<br>docs/modules/WARDENX_MODULE_32_AI_PLATFORM_SPEC_v0_2.md:2661<br>(+2 more) | P3 | false | Update to current names (arch:manifest-mirror, arch:boundaries, arch:tables, test:rls:live:m31, ...) or mark historical. |
| GAP-186 | global | Code TODOs | Stale TODOs: M23/M27/M30 erasers still say step (1) is adding their DataClass to REQUIRED_ERASERS (done), and the M34 alert-rules TODO step (2) is done by wireM34AlertRuleSeed. 38 TODO(CMS-fixture) placeholders (e.g. ECR byte layout) are the main live placeholder set. | apps/backend/src/modules/23-billing-medicare/erasers/billing-eraser.ts:564<br>apps/backend/src/modules/27-cost-report/erasers/cost-report-eraser.ts:204<br>apps/backend/src/modules/30-quality/erasers/quality-eraser.ts:192<br>(+3 more) | P3 | false | Trim the eraser and M34 TODOs to the remaining steps; track CMS-fixture placeholders as one issue. |
| GAP-187 | global | Audit brief / plans | The audit brief cites /Users/fabrice/Apps/WardenX and apps/backend/src/db/migrations/ (actual: repo root and packages/db/migrations/) and omits typecheck and check:boot:platform from its command list; PHASE_4_PLAN claims a non-existent @wardenx/mobile-offline package. | docs/audits/GAP_ANALYSIS_AUDIT_PROMPT.md:5,96-105,115<br>docs/PHASE_4_PLAN.md:35<br>CLAUDE.md (typecheck + check:boot:platform are required central steps) | P3 | false | Fix the brief path, migrations directory and command list; correct the PHASE_4_PLAN claim. |
| GAP-188 | global | Schema indexes | 516 of 1085 foreign keys have no index whose leading columns cover the FK (134 location_id, 132 provider_entity_id); 16 unindexed FKs are ON DELETE CASCADE and 29 SET NULL, each forcing a child seq-scan on parent delete. No gate covers non-org FK indexing. | dev DB pg_catalog query -> 516 unindexed of 1085<br>by confdeltype: a\|93 c\|16 n\|29 r\|378<br>bun run arch:org-indexes -> passes (422 tables) | P3 | false | Add indexes for the 16 CASCADE / 29 SET NULL FKs and admission_id FKs in a new migration (check arch:migration-numbering); decide policy for location_id/provider_entity_id; optionally extend scripts/check-org-index-coverage.ts. |

## 4. Cross-module seams table

Status values: live, partial, stubbed, missing. Verified = true only where an admitted seam finding was independently verified. The brief lists 'M23 → M26' for the cap seam; it is traced here in its actual provider → consumer direction (M26 provides, M23 consumes).

| Source | Target | Seam | Status | Evidence | Verified | Risk |
|---|---|---|---|---|---|---|
| M26 | M23 | CapProjectionProvider (pre-submission cap rules) | live | apps/backend/src/modules/26-cap/wiring.ts:20<br>apps/backend/src/index.ts:1194<br>apps/backend/src/modules/23-billing-medicare/services/cap-projection-adapter.ts:61<br>cap-projection-adapter.test.ts passed | false | Low; warn-only (D8). M23 consumer of m26.cap.projection_updated is a documented unbound exception (GAP-107). |
| M26 | M27 | CapAccrualReader / CapSettlementProvider → CMS-1984-14 Worksheet E | partial | apps/backend/src/modules/26-cap/wiring.ts:16-21 (only CapAccrualReader)<br>apps/backend/src/modules/27-cost-report/routes/cap-context-wiring.ts:8-10<br>apps/backend/src/index.ts:4554-4566<br>apps/backend/src/modules/26-cap/seam-impls.ts:132-133,202 | false | Cap calc is live. CapSettlementProvider is unregistered and limit(1) under-aggregates multi-CCN orgs (GAP-112). |
| M27 | M30 | CostReportFilingStatusReader → cost_report_filing_compliance | live | apps/backend/src/index.ts:1229<br>apps/backend/src/modules/30-quality/consumed-seam-adapters.ts:108-122<br>apps/backend/src/modules/30-quality/jobs/m30-jobs.ts:2420,1712-1713<br>m30-forward-seam-binds.test.ts passed | false | Low; degrades to suppressed when unbound. |
| M5–M18 | M30 | HCI + operational measure data binding (resolveInput) | partial | apps/backend/src/modules/30-quality/jobs/m30-jobs.ts:1660-1732,648-663,412-416<br>packages/quality/src/measures/registry.ts:302 | false | comfort_kit measure throws nightly into the DLQ (GAP-125); HCI 5–7 unavailable by design (GAP-123). |
| M1 | M30 | Transactional outbox emit for quality events (m30 publisher) | partial | apps/backend/src/index.ts:2673,2924,4486<br>apps/backend/src/modules/30-quality/jobs/m30-jobs.ts:1764-1792,1909-1921 (bound)<br>m30-jobs.ts:1844-1855,2101-2107 (CAHPS emits unbound); cap_overdue has no emit site | true | CAHPS lifecycle events never emit; all m30 events are record-only, so emits are audit-only (GAP-056, GAP-055). |
| M33 | M30 | MetricsProvider registration + m30.* consumption | partial | apps/backend/src/modules/33-reporting/wiring.ts:295-298<br>apps/backend/src/index.ts:1190<br>packages/reporting/src/refresh/outbox-subscriber.ts:101<br>packages/reporting/src/seam-registration.ts:171 | false | Registered but nothing consumes it; no HQRP dataset (GAP-066, GAP-124). |
| M6 | M30 | DeathDischargeReader (HVLDL / HCI 10) | live | apps/backend/src/modules/06-admission/seams/index.ts:168-173<br>apps/backend/src/index.ts:1157,4452,4474<br>death-discharge-reader.test.ts, m30-hvldl-resolveinput.test.ts passed | false | Low. |
| M8 | M30 | SignedEncountersReader (HVLDL numerator, HCI 2/8/9) | live | apps/backend/src/modules/08-encounters/seams/index.ts:70<br>apps/backend/src/index.ts:1172,4453<br>apps/backend/src/modules/08-encounters/seams/drizzle-store.ts:194 | false | Low for M30. The same store still inherits in-memory insertDraftEncounter (GAP-014); comment at index.ts:4448 is stale. |
| M1 (provider_entity) | M30 | M40-free provider-entity resolver / org lister | live | apps/backend/src/bootstrap/provider-entity-resolver.ts:30-50,63-76<br>apps/backend/src/index.ts:3366,1220,4485<br>provider-entity-resolver.test.ts passed | false | Low; primary PE stamped for multi-PE orgs (by design); comment at index.ts:3355 is stale (GAP-181). |
| M30 workers | RLS | Per-job withOrgContext (recompute/outbreak/risk/CAHPS) | partial | apps/backend/src/modules/30-quality/jobs/m30-jobs.ts:2218-2305 (scoped)<br>m30-jobs.ts:2309-2313,2006 (CAHPS unscoped)<br>packages/db/migrations/0067_quality_m30_rls.sql:28-31 | true | CAHPS cron reads zero rows and reports no_active_vendor (GAP-055); other M30 workers are scoped. |
| M30 | M36 | §4.9 alert delivery (AlertEmitter / alert consumers) | missing | no AlertEmitter use in apps/backend/src/modules/30-quality or packages/quality/src<br>apps/backend/src/modules/36-messaging/outbox-consumers/clinical-alerts.ts:4-21<br>apps/backend/src/modules/30-quality/jobs/m30-jobs.ts:2134-2155 | true | Outbreak, sentinel/abuse, threshold, CAP-overdue and SRA alerts are never delivered (GAP-056). |
| M23 / M18 | M25 | m23.claim.rejected / m18.evv.aggregator_rejected → denial seed | missing | apps/backend/src/modules/25-remittance/outbox-consumers/m23-claim-rejected.ts:98; m18-evv-aggregator-rejected.ts:125<br>not referenced in apps/backend/src/index.ts<br>events-by-m23.ts:208 / events-by-m18.ts:312 | true | Rejections never seed denials; rows pending forever; gate false-green (GAP-047). |
| M8 | M19 | EncounterCreator.createDraftEncounter | stubbed | apps/backend/src/modules/08-encounters/seams/drizzle-store.ts:13-15,56-59<br>apps/backend/src/modules/08-encounters/seams/store.ts:98-101,135-147<br>apps/backend/src/modules/19-oncall/clinical/encounter-link.ts:218 | true | Phantom non-persisted encounter ids linked to triage calls (GAP-014). |
| M5 | M31 | PatientCaregiverReader | missing | apps/backend/src/bootstrap/seams/providers.ts:234-236<br>apps/backend/src/modules/31-portal/abac-predicates.ts:193-198 | true | Fails closed; primary caregivers cannot attest (GAP-081). |
| M28 / M32 | M35 | UsageMeteringIngest (+ 5 other M35 seams) | missing | apps/backend/src/bootstrap/seams/registry.ts:601-651<br>apps/backend/src/modules/32-ai-platform/events-by-m32.ts:140 | true | Usage-based billing never metered (GAP-063). |
| M40 | M31 | ExternalGriefResourceReader | stubbed | apps/backend/src/modules/31-portal/routes/read.routes.ts:427-436 | true | Documented 501 on bereavement resources (GAP-144). |
| M4 jobs | Composition root | registerAuditWorkers / scheduleAuditJobs | stubbed | apps/backend/src/index.ts:4122-4123<br>apps/backend/src/modules/04-audit/routes/destruction-certificates.ts:5-18 | true | Retention/destruction/integrity never run (GAP-005). |
| Various | M22 | Outbox deferred-consumer register | partial | bun run arch:outbox-bindings -> 2 declared-but-unbound pairs<br>scripts/outbox-deferred-consumers.ts:502-505 | false | Low and reasoned. The two extraction events are re-claimed every 30 min until M22 binds them. |

## 5. Global / systemic findings

### 5.1 Build/test failures (code)

**No gaps found.** Checks run: `bun install --frozen-lockfile` (exit 0), `bun run build` (exit 0), `bun run typecheck` (exit 0), and `bun run test` (exit 0: 714 files and 10,668 tests passed, 0 failures, 255 DB-gated live files skipped). Batch workers also ran targeted package and module suites, all green: M02–M05 105/105, M06–M10 encounter-late-entry 14/14, M11–M15 packages 510, M16–M20 1,139, M31–M35 589, M36–M40 packages 476, and the seam suites 35/35. One related CI-process gap is listed under 5.6 (GAP-072).

### 5.2 Test infrastructure failures

- `bun run check:boot:platform` exits 1 because `DATABASE_PLATFORM_URL` is not set in the local `.env`. This is an environment problem, not a code defect; CI's outbox-boot job sets it at `.github/workflows/ci.yml:980-986`. **Remediation:** run it against a throwaway Docker database after `bun run db:provision-roles`, exporting `DATABASE_PLATFORM_URL=postgresql://wardenx_platform_login:<pw>@localhost:5432/<db>`, or rely on the CI outbox-boot result. Optionally document the variable in `.env.example`.
- The 255 live/RLS suites were skipped locally because they need a database. Their results are unverified in this audit (see Section 7).

### 5.3 Architecture-fitness failures

No gate failed: all 38 `arch:fitness` gates passed, as did `arch:abac-predicates`, `arch:tenancy`, `arch:manifest-mirror`, `arch:outbox-bindings`, `arch:openapi-coverage`, `arch:route-reachability` and `arch:org-indexes`. Several gates are green while hiding real gaps:
- **GAP-029** (P1, M16): M16 section 4.5 subscriptions to m8.encounter.signed (bereavement_contact -> contact_log + complete outreach), m22.document.rendered (rendered_document_id) and m4.legal_hold.* are unbuilt; producers do not declare m16, so arch:outbox-bindings is silent. The M8 bereavement_contact subscriber is part of the spec's binding done gate.
- **GAP-047** (P1, M25): buildM23ClaimRejectedConsumer and buildM18EvvAggregatorRejectedConsumer are written and live-tested but never constructed in apps/backend/src/index.ts. m25 is the only declared consumer of both events, so the dispatcher defers them forever (rows stay pending, never dead-letter) and 277CA/999/aggregator rejections never seed denials. arch:outbox-bindings is falsely green (counts factories on disk); the deferral register says the group is 'GONE'.
- **GAP-068** (P1, M37): 11 of 13 section 4.5 M37 consumers are absent (only the two M6 discharge consumers exist). No code path inserts ipu_iv_safety_overlay, so the D7 IV-continuous safety overlay is never operative (the registered seam reads an empty table), and outbreak-driven visitor restrictions (D8) have no producer. Producers do not declare m37, so the gate passes.
- **GAP-147** (P2, global): Frame-fidelity notes for eMAR, Encounter and Patient Chart are stale (claim unbuilt writes/unbound selections/placeholder cards that now exist); the gate checks only report freshness, not note accuracy.
- **GAP-148** (P2, global): Frame-fidelity maps 17 of 120 ledger frames (3 matched, 14 partial); the other 103 are not even 'pending', so '0 pending' reads as complete. No revenue (M23-M27) screen is mapped.
- **GAP-150** (P2, global): check-fitness-gaps phi-guards regexes are vacuous: a table passes RLS if 'enable row level security' appears anywhere earlier in the corpus, and the audit-trigger check passes on any 'trigger' + 'on <table>' + 'audit'; not net-effect aware. Live dev DB is currently clean.
- **GAP-151** (P2, global): Ops runbook and security hardening cite unannotated infra/ artifacts (secret inventory, MinIO policies, Grafana dashboards, firewall rules) that do not exist; arch:architecture-docs cannot see them because PATH_PREFIXES omits infra/ and deploy/.
- **GAP-156** (P3, M03): The implementation-status matrix shows M03 Tests and M01 Routes/Screens as absent although authz tests and bootstrap routes exist (heuristic misses them).
- **GAP-157** (P3, M03): No boot-level check that every requireAbac predicate name is registered at runtime; check-abac-predicates is static and per-module tests are scoped. Production is currently correct, but a dropped registrar call would 403 every caller with all gates green.

### 5.4 Security/compliance gaps

The 2026-06-27 remediation is intact:
- The production ABAC registry is fail-closed and installed at `apps/backend/src/index.ts:1841`, with `step_up_recent` registered at `:1088` from the server session.
- Logging is PHI-safe (`apps/backend/src/bootstrap/plugins/logger.ts`), and no PHI is held in browser storage.
- RequireChrome fail-closed guards are in place in web and admin.
- The read-audit boot gate is present.
- `assertProductionEnv` runs at `index.ts:2302`.
- The M34 `platform.bypass_invoked` auditor uses SECURITY DEFINER and fails closed.
- The durable break-glass store and contract are wired.
- Boot refuses a BYPASSRLS runtime role.
- No real secrets are tracked, and `bun audit` is clean.
- The live dev database has RLS + FORCE + a policy on every org table, and an audit trigger on every patient table.

Security and compliance gaps found:
- **GAP-001** (P0, M03): Tenants can create custom roles whose keys match platform-ops keys (platform_ops, platform_admin, ...). Self-assigning one passes the platform-only gates, so a tenant admin can suspend or close ANOTHER tenant (close is terminal and deletes its sessions). Static trace; not run live.
- **GAP-002** (P1, M02): Binding SESSION_POLICY timeouts (staff 15-min idle / 8h absolute / 24h hard; auditor 10-min idle) are not enforced server-side. Better Auth sets no expiresIn/updateAge (library default lifetime applies); the authenticate hook has no idle/absolute check; only the client screen-lock overlay reads the policy, and POST /api/v1/auth/screen-unlock does not exist (HIPAA 164.312(a)(2)(iii)).
- **GAP-006** (P1, M05): POST /api/v1/patients/:id/payers checks patient.edit instead of patient.edit_payers and is the only per-chart route without a caseload_or_scope guard; any patient.edit holder can rewrite coverage (billing-relevant) on any chart in the tenant. Missing patient throws plain Error -> 500.
- **GAP-012** (P1, M08): Author-ownership ABAC (is_author, is_author_or_supervisor, is_addendum_author) is never registered or composed; finalize/enhance/decisions/sign, vitals/mileage/link-delete/evv-reconcile and addenda routes are permission-gated only and most lack encounter.scope. Any encounter.sign holder can sign another clinician's note anywhere in the tenant.
- **GAP-013** (P1, M08): Late-entry override, administrative >14-day override and cosignature supervisor-release (spec rows 15, 16, 21) have no server-verified step-up; the TypeBox schemas still require a client stepUpAuthAt that nothing reads, and the route header wrongly claims route 21 carries step-up.
- **GAP-015** (P1, M11): No M11 PHI route enforces caseload_or_scope (GET /orders, /orders/:id, discontinue, queues); the route header falsely claims it is bound by default ABAC, which requirePermission never reads (unremediated F-092). Any orders.read holder reads every patient's orders in the org.
- **GAP-016** (P1, M12): M12 order list/detail/transmission and /patients/:id/medications/active|history routes have no caseload_or_scope; only the refill inbox is narrowed. Any prescribing.read holder reads every patient's active medication list. Header falsely claims default-ABAC binding.
- **GAP-020** (P1, M13): Controlled-substance witness requirement and administering-discipline ABAC are keyed on the client-supplied body medClass; the order port carries no controlled-substance flag although M12 exposes isControlledSubstance. Sending medClass:'standard' for a Schedule II order skips the witness. Offline-sync is [RECORD] only and checks no per-row eligibility despite its comment. Five-rights validation against the order is still open (documented).
- **GAP-021** (P1, M13): eMAR read and many write routes (administrations, scheduled/missed doses, reconciliation, comfort-kit deployments) have no caseload_or_scope check; the header claims a binding that does not exist (named in F-092, unresolved). Services take no caseload input.
- **GAP-027** (P1, M14): IDG patient packet detail/list and GET /patients/:patientId/idg-history skip the per-patient caseload_or_scope check (only meeting-location scope + SUD filter; idg-history has only idg.read). The abac-predicates.ts header falsely claims caseload is carried.
- **GAP-030** (P1, M17): M17 visit reads (list, get, day/week/map views, proposals) and visit.start/arrive are gated by requirePermission only; listVisits applies no caseload or own-membership filter and visit.read_team is never checked. Any field clinician lists every patient's visits and address ids in the org.
- **GAP-031** (P1, M17): Own-vs-any permission scoping is not enforced for availability and time-off: routes gate on *_own keys only and services ignore the caller, so any clinician can overwrite a colleague's availability, cancel their approved PTO or file PTO on their behalf (PTO feeds the not_on_pto scheduling gate).
- **GAP-033** (P1, M17): M17 (36 call sites) and M18 (25) open withOrgContext with userId: "", so M4 write-audit triggers record a NULL actor_user_id on visit, time_off, availability, evv_event and missing-resolution writes. Same pattern in the M5-M11 and M39 route services (documented 'M8-M17 convention' compromise).
- **GAP-034** (P1, M18): EVV capture decides 'pass' from GPS accuracy alone and never computes distance to the patient address, yet emits m18.evv.at_patient_address (and breach) with a fabricated computedDistanceM: 0 and then visit_verified (consumed by M30). Documented compromise #3, but on the Cures Act EVV verification path.
- **GAP-036** (P1, M18): POST /evv/offline-sync gates only on evv.check_in and calls recordCapture with each event's client-supplied kind (check_out allowed) and visitId; assigned-clinician and visit-window ABAC run only on /check-in and /check-out. Any member with evv.check_in and an approved device can post EVV events for any visit at any time.
- **GAP-037** (P1, M18): EVV GPS coordinates (PHI) are stored as base64('lat,lng') in coords_cipher / device_coords_cipher stamped coords_dek_version=1; that is not encryption and misleads erasure/audit reports. M20 deliberately refuses the same pattern. Documented deferral (compromise #2 / D10).
- **GAP-048** (P1, M27): Cost-report submit's two-person check compares the actor with an optional, caller-supplied approvedByMembershipId; approveForSubmit never persists the approver (no column). A user holding both approve_for_submit and submit can approve then submit with the field omitted, defeating W-CR-11 and the STRIDE elevation-of-privilege mitigation.
- **GAP-051** (P1, M29): M29 lab-observation reads (list, unmatched, detail with values) have no config.auditRead and /api/clinical/labs and /api/admin/external-interfaces are outside DEFAULT_READ_AUDIT_PREFIXES, so the fail-closed boot gate never governs them and no read event is emitted (164.528 accounting gap). Spec requires auditRead() on every route surfacing lab values.
- **GAP-052** (P1, M29): GET /api/clinical/labs/observations is gated only by inOrg; the caseload predicate applies only to :observationId routes and no caller passes caseloadPatientIds, so any lab.read holder lists every patient's labs in the org. Filters also run after LIMIT in JS (wrong pagination).
- **GAP-053** (P1, M30): SRA cycle close and QAPI PIP close take both cosigner ids from the request body; nothing checks the actor is a cosigner, that either holds the required role, or that the second person authenticated. qapiCloseAuthority/sraCloseAuthority predicates exist but are never attached; PIP close has no step-up and SRA hardcodes recentStepUp: true. One user can close a HIPAA 164.308 SRA cycle or a CMS QAPI PIP alone.
- **GAP-058** (P1, M31): Portal logout and step-up are no-ops: logout returns ok without revoking the server session (the SPA just navigates to '/'), and step-up returns ok for any TOTP without validating or stamping freshness, while the UI says 'Verified'. A PHI portal session stays valid after logout until expiry; STEP_UP-guarded writes still deny (fail closed).
- **GAP-070** (P1, M39): Patient-scoped consent read routes (3, 4, 11, 14, 17, 21, 28) are gated by requirePermission only; no requireAbac exists in the module and services receive no actor. Any consent.read holder reads any patient's consents, including 42 CFR Part 2 recipients and DPOA agents. Route 3's comment claims a caseload check that does not exist.
- **GAP-071** (P1, M39): The production ConsentEvaluator never applies D13 post-death termination: the Drizzle store backing the seam returns isPatientDeceased = false unconditionally and no m39 consumer for m5.patient.deceased exists. After death, non-survives-death consents keep authorizing disclosure for every PHI-egress module consulting the seam. A working deceased query already exists in the same file.
- **GAP-073** (P1, global): Production nginx vhosts proxy /api with no access_log/log_format override, so nginx's default combined format persists $request including ?q=<patient name|MRN> from patient search, the exact PHI that logger.ts strips from Pino and names as a downstream risk. Host-level nginx.conf is not in the repo.
- **GAP-075** (P2, M02): Email/password sign-up is open instead of invite-gated: Better Auth has no disableSignUp or hooks, the mount bridge forwards every /api/auth/* path, the credential throttle covers sign-in only, and the web accept-invitation page calls signUp.email without a token. Tenant data stays membership/RLS-gated; magicLink also lacks disableSignUp.
- **GAP-083** (P2, M06): cti.is_attending / is_hospice_md compare context.userId with M40 physician ids, which can never match, so the role escape (md/hospice_physician) is the live path and any such user can sign any CTI's attending certification (42 CFR 418.22(c)). Documented compromise.
- **GAP-085** (P2, M08): m8.cosigner_role_match and the M9 cosigner predicate compare a membership-id fact with context.userId (Better Auth id), so 'cosigner must not be the author' never denies. In M8 neither cosign service checks the author, so an RN author can cosign their own encounter; M9's service layer still blocks self-cosign (dead defense-in-depth). M10 already fixed the same bug.
- **GAP-093** (P2, M12): Prescriber enrollment and both policy PATCH routes lack step-up although the spec and permission catalog require it; enrollment sets deaAuthorizedSchedules used by dea_schedule_authorized.
- **GAP-100** (P2, M17): Portal upcoming-visit (M17) and EVV arrival (M18) routes take patient/visit ids from the request and check only an RBAC key, with no M39 family_caregiver_access consent scope; M18 staff reads bind only evv.read with no caseload.
- **GAP-118** (P2, M28): FHIR client co-approval only requires a different fhir.client.admin holder; two org admins can activate a PHI egress client without a Compliance Officer.
- **GAP-136** (P2, M36): messaging.manage_members routes carry only requirePermission; addMember/removeMember check neither location nor channel kind, so a holder can add themselves to another pair's DM and then read it. Header claims channel_visibility ABAC.
- **GAP-149** (P2, global): The SPA document is served without CSP, frame-ancestors, X-Frame-Options, HSTS, nosniff or Referrer-Policy (headers are set only on Fastify API responses), contrary to SECURITY_HARDENING 9.6.1; backend CSP also lacks report-uri.
- **GAP-176** (P3, M31): The portal SPA has no chromed-route auth guard (web/admin have RequireChrome); framed routes render for anonymous visitors (server still enforces auth). Portal not deployed today.

### 5.5 Documentation drift

- **GAP-084** (P2, M07): Three implemented, gated read routes (GET /care-plans/:planId/readiness, /versions/:versionId/proposed-changes, /review-status) are not in the M07 spec section 4.1 inventory (19 rows vs 22 registrations).
- **GAP-097** (P2, M13): The patient eMAR empty state and header still say the scheduled-dose materializer 'is not yet wired', but F-166 bound it; clinicians get wrong guidance on a medication-safety path.
- **GAP-102** (P2, M21): Four implemented M21 routes (perpetual-log, assign-retriever, declare-unreturnable, caregiver-signature) are absent from spec section 4.1 (the /api/v1/supplies prefix is already documented at line 2079).
- **GAP-130** (P2, M31): M31 spec mandates `lint:portal-dto`, `lint:telehealth-phi-boundary` and a gated `test:security` CI job (and lists them in its sign-off checklist); none exists and no deferral is recorded. Runtime DTO validation and HMAC'd room names mitigate.
- **GAP-147** (P2, global): Frame-fidelity notes for eMAR, Encounter and Patient Chart are stale (claim unbuilt writes/unbound selections/placeholder cards that now exist); the gate checks only report freshness, not note accuracy.
- **GAP-151** (P2, global): Ops runbook and security hardening cite unannotated infra/ artifacts (secret inventory, MinIO policies, Grafana dashboards, firewall rules) that do not exist; arch:architecture-docs cannot see them because PATH_PREFIXES omits infra/ and deploy/.
- **GAP-156** (P3, M03): The implementation-status matrix shows M03 Tests and M01 Routes/Screens as absent although authz tests and bootstrap routes exist (heuristic misses them).
- **GAP-159** (P3, M06): 22 implemented M06 routes (referral phase-1 workflow, readiness, patient admissions, evidence uploads, confirm-bed) are not in the spec section 4.1 inventory (68 vs 46).
- **GAP-160** (P3, M08): 6 M08 read routes are missing from the spec's '31 routes' inventory (37 registered); route header says 34.
- **GAP-161** (P3, M09): Two implemented M09 routes (summary/document POST, GET /scales) are not in spec 4.1.
- **GAP-163** (P3, M10): HOPE draft update and answer/HUV PATCH routes omit the discipline ABAC (authorDisciplineAllowed) the spec requires; GET /hope/sfv deliberately skips caseload scope and returns an org-wide PHI worklist.
- **GAP-164** (P3, M11): Six M11 routes (verbal-orders, held-transmissions, resend/recover-transmission and its cosign/cancel) are absent from spec 4.1 (only in docs/history and openapi.json).
- **GAP-165** (P3, M12): POST /medication-orders/:id/report-error (F-205) and its permission are absent from the M12 spec route inventory (the event is documented), and the status matrix's 'Adapter' green overstates readiness while the only DoseSpot client is the deny-stub.
- **GAP-166** (P3, M14): M14 implements routes absent from spec 4.1 (ad-hoc meeting create, agenda/attendance/decisions/recert-windows GETs, idg-history) while the spec's internal /api/v1/internal/idg/* routes are served via in-process seams instead; DECISION_PAYLOAD_INVALID is never emitted.
- **GAP-168** (P3, M17): Implemented routes absent from spec 4.1: M17 /visits/:id/arrive and membership credentials; M19 paper-reentry (+worklist) and vendor-sessions/bind; M20 GET /safety/incidents list.
- **GAP-170** (P3, M22): M22, M25 and M31 specs prescribe tenant_id / app.tenant_id RLS, which ADR-0010 D2 bans (architecture wins); shipped migrations correctly use app.org_id. Spec-text drift only.
- **GAP-171** (P3, M23): M23 route paths drift from spec 4.1 (NOE/NOTR/validation not under /billing, duplicate validate route, rule-configs path).
- **GAP-172** (P3, M25): M25 spec WX-PR-012 note says the M23 claim-match seam 'remains unbound', but it is now bound.
- **GAP-173** (P3, M26): PS&R import is registered as POST /api/v1/cap/periods/:periodId/psr-imports while the spec declares POST /v1/cap/psr-imports.
- **GAP-174** (P3, M30): The m6.election.signed HCI-denominator recompute handler is implemented but unbound (nightly recompute covers it with <=24h staleness); exception reason is stale.
- **GAP-175** (P3, M31): GET /api/v1/admin/telehealth/visits/:id returns 200 with lifecycleState 'not_found' instead of 404.
- **GAP-177** (P3, M35): Four M35 admin GETs (dunning, plans/:id, promos/:id, refunds/:id) are registered but absent from spec 4.2.
- **GAP-178** (P3, M36): Stale 'writes defer to FB-T05 (501)' comments although M36 writes are live; POST /api/v1/alerts/:id/read is missing from spec 4.1.
- **GAP-179** (P3, M37): M37 spec says 38 routes (lines 554, 1368, 2337) versus 52 implemented; seven read/confirm routes are absent from 4.1 and row 31 lists only visitor_restriction.apply although the spec's own catalog defines .lift for DELETE.
- **GAP-180** (P3, M39): Portal consent routes #25-27 (/api/v1/portal/consents/*) are not implemented; the spec marks them Phase 2 (recorded deferral).
- **GAP-181** (P3, global): Stale composition-root/M30 comments describe live seams as unbound or in-memory (provider-entity resolver, SignedEncountersReader, emitThresholdBreached), and several outbox-subscription-exception reasons say events are 'already deferred' though the register holds only m22 pairs.
- **GAP-182** (P3, global): SameSite policy contradicts itself: SECURITY_HARDENING 5.1 says Lax (matching csrf.ts:127) while 9.6.4, SYSTEM_DESIGN 5.1 and M31 9.3 say Strict.
- **GAP-183** (P3, global): CLAUDE.md:66 (and AGENTS.md) says audit-fitness has a --check mode inside arch:fitness; it has neither and is not a package.json script.
- **GAP-184** (P3, global): Four broken relative links: docs/history/status-overview.md:77,78,81 (./docs/... resolves under docs/history) and docs/REMEDIATION_SUMMARY.md:41 (../ARCHITECTURE_25_15_FITNESS.md).
- **GAP-185** (P3, global): Specs/plans cite non-existent `bun run` scripts (check:manifest, check:cruiser, check:table-ownership, test:rls-isolation, lint:deps, db:migrate:up/down, gen:proto, db:seed:admissions).
- **GAP-186** (P3, global): Stale TODOs: M23/M27/M30 erasers still say step (1) is adding their DataClass to REQUIRED_ERASERS (done), and the M34 alert-rules TODO step (2) is done by wireM34AlertRuleSeed. 38 TODO(CMS-fixture) placeholders (e.g. ECR byte layout) are the main live placeholder set.
- **GAP-187** (P3, global): The audit brief cites /Users/fabrice/Apps/WardenX and apps/backend/src/db/migrations/ (actual: repo root and packages/db/migrations/) and omits typecheck and check:boot:platform from its command list; PHASE_4_PLAN claims a non-existent @wardenx/mobile-offline package.

### 5.6 Discovered gaps

- **GAP-072** (P1, global): Production deploys run with zero CI: deploy.yml `verify` job is commented out (release needs only debounce) and ci.yml's pull_request trigger only matches `fix/admission`, so neither PRs to main nor main pushes run build/typecheck/arch:fitness/tests before a PHI-bearing image ships. Undocumented; CLAUDE.md:78 still describes `verify` as active.
- **GAP-109** (P2, M24): M24_LAUNCH_GATEWAY_ENABLED is opt-in (default off, workers silently not constructed) contrary to env.ts's opt-out integration-switch policy, and it and M25_X12_WORKER_URL/TOKEN plus ~14 other code-read vars are undocumented in any template or doc.
- **GAP-152** (P2, global): bootstrap-vps.sh reads deploy/production/.env.production.example, which has never been committed (gitignored by `.env.*`); a first-time bootstrap / DR rebuild fails under set -eu. Ten production-required keys appear in no committed template (TRUSTED_ORIGINS, TWO_FACTOR_ENCRYPTION_KEY, M24_CREDENTIAL_ENCRYPTION_KEY, M13_WITNESS_SIGNING_KEY, MESSAGING_ENCRYPTION_KEY, CURSOR_SIGNING_KEY, PASSKEY_RP_ID, WEBAUTHN_RP_ID, TRUSTED_PROXY_CIDRS, INTERNAL_SERVICE_TOKEN).
- **GAP-153** (P2, global): 29+ error responses in M02, M12, M29, M33 and M37 bypass the M1 section 4.3 envelope with flat {code,message} or string {error:'...'} bodies, without correlationId.
- **GAP-187** (P3, global): The audit brief cites /Users/fabrice/Apps/WardenX and apps/backend/src/db/migrations/ (actual: repo root and packages/db/migrations/) and omits typecheck and check:boot:platform from its command list; PHASE_4_PLAN claims a non-existent @wardenx/mobile-offline package.
- **GAP-188** (P3, global): 516 of 1085 foreign keys have no index whose leading columns cover the FK (134 location_id, 132 provider_entity_id); 16 unindexed FKs are ON DELETE CASCADE and 29 SET NULL, each forcing a child seq-scan on parent delete. No gate covers non-org FK indexing.

Discovered-gap checks that found nothing:
- Every `bun run` script that CI calls exists.
- Every `arch:*` script except `arch:graph` is inside `run-fitness-gates`.
- Debounce routing is intact: release needs debounce.
- The no-circular rule is active and `arch:boundaries` is clean.
- Migration numbering passes (21 frozen historical duplicates are documented).
- The only enum name mismatches are the intentional M23 ones, documented in migration 0198.
- No unimported route files exist beyond the documented M36 webhook deferral.
- Org-index coverage passes on 422 tables.

## 6. Remediation backlog

Ordered P0 → P3, then by module. Each item lists the files to change (taken from the cited evidence), what done looks like, and how to verify it.

### P0

**GAP-001 — M03 — Tenants can create custom roles whose keys match platform-ops keys (platform_ops, platform_admin, ...).**
- Files: `apps/backend/src/modules/03-authorization/routes/authz-typebox.ts`, `apps/backend/src/modules/03-authorization/routes/authz-routes.ts`, `apps/backend/src/modules/03-authorization/role-store.ts`, `packages/db/migrations/0008_authorization_m3_tables.sql`, `packages/auth/src/rbac/drizzle-store.ts`, `packages/auth/src/roles/templates.ts`, `apps/backend/src/modules/02-identity/abac-predicates.ts`, `apps/backend/src/modules/02-identity/organization-lifecycle.ts`, `apps/backend/src/bootstrap/routes/system.ts`
- Done when: Reject tenant role create/rename whose key is in PLATFORM_OPS_ROLE_KEYS, any template key or ORG_WIDE_SCOPE_ROLES (authz-routes.ts / role-store.ts) and add a DB CHECK/trigger on role (organization_id IS NOT NULL => key not reserved). Better: decide platform-operator status from a platform-owned fact (platform-org membership or org_id IS NULL template role ids), not a key string. Audit every hasRole()/requireRole() caller.
- Verify: New live test: as tenant admin, POST /api/v1/roles {key:'platform_ops'} -> 422/409; POST /api/v1/platform/organizations/<otherOrg>/status -> 403. bun run arch:abac-predicates.

### P1

**GAP-002 — M02 — Binding SESSION_POLICY timeouts (staff 15-min idle / 8h absolute / 24h hard; auditor 10-min idle) are not enforced server-side.**
- Files: `packages/types/src/policy/session-policy.ts`, `apps/web/src/modules/02-identity/screen-lock.tsx`, `packages/auth/src/identity/auth.ts`, `packages/auth/src/identity/session-snapshot.ts`, `apps/backend/src/bootstrap/plugins/authenticate.ts`, `packages/auth/src/identity/session-classes.ts`, `docs/modules/WARDENX_MODULE_02_IDENTITY_SPEC_v0_4.md`
- Done when: Set Better Auth session.expiresIn/updateAge from SESSION_POLICY and enforce per-class idle/absolute limits in the authenticate hook (compare session.updatedAt/createdAt; revoke and 401 on breach). Implement POST /api/v1/auth/screen-unlock.
- Verify: Live test: a staff session idle >15 min gets 401 on any /api/v1 route; a session older than 8h gets 401.

**GAP-003 — M02 — No API or production code creates provider_entity or location rows; only GET /api/v1/provider-entities and GET /api/v1/locations exist.**
- Files: `docs/modules/WARDENX_MODULE_02_IDENTITY_SPEC_v0_4.md`, `apps/backend/src/bootstrap/routes/provider-entities.ts`, `apps/backend/src/bootstrap/routes/locations.ts`, `apps/backend/src/bootstrap/provider-entity-resolver.ts`, `apps/backend/src/modules/02-identity/tenant-org-creation-provider.ts`
- Done when: Add org_admin-gated POST/PATCH /api/v1/provider-entities and /api/v1/locations, or provision them in the M34 tenant-provision flow; enrich in scripts/openapi/enrichments.ts.
- Verify: Live: org_admin creates a provider entity, resolver returns it; cross-tenant PATCH -> 404.

**GAP-004 — M03 — Break-glass Compliance notification, auditor engagements and auditor sessions are in-memory on the production mount; the spec's m3.breakglass.invoked/ended, m3.engagement.closed, m3.role.assigned/revoked outbox events do not exist (no events-by-m3.ts) and the reap/close crons are absent.**
- Files: `apps/backend/src/modules/03-authorization/index.ts`, `apps/backend/src/modules/03-authorization/authz-ports.ts`, `apps/backend/src/modules/03-authorization/routes/authz-routes.ts`, `docs/modules/WARDENX_MODULE_03_AUTHORIZATION_SPEC_v0_3.md`, `apps/backend/src/index.ts`, `apps/backend/src/bootstrap/in-memory-ledger.ts`, `Dockerfile`
- Done when: Add apps/backend/src/modules/03-authorization/events-by-m3.ts (m36 as consumer) and publish inside break-glass/engagement/role transactions; replace in-memory engagement/auditor-session/notifier with Drizzle stores over auditor_engagement; add reap/close crons; remove the ledger note. Until then document the production WARDENX_INMEM_ASSERT decision in deploy/production/README.md.
- Verify: Live test with real publisher: POST /api/v1/breakglass leaves an m3.breakglass.invoked outbox row; boot with NODE_ENV=production and WARDENX_INMEM_ASSERT unset succeeds with empty inMemoryBindingNotes(); bun run arch:outbox-bindings.

**GAP-005 — M04 — M4 BullMQ workers are never constructed: audit exports stay 'pending' forever (no object-store adapter), approved destruction certificates never execute, the daily retention scan never opens certificates, partitions are never tiered and the quarterly integrity sample never runs.**
- Files: `apps/backend/src/modules/04-audit/routes/audit-exports.ts`, `apps/backend/src/modules/04-audit/routes/destruction-certificates.ts`, `apps/backend/src/index.ts`, `apps/backend/src/modules/04-audit/routes/audit-typebox.ts`
- Done when: Build Drizzle-backed AuditJobAdapters (BuildExportPorts.store over a shared S3/MinIO adapter, ExecuteDestructionPorts, archive, integrity sample) and call registerAuditWorkers/scheduleAuditJobs in the worker-runner block of apps/backend/src/index.ts.
- Verify: Live: POST export, run worker, GET /audit/exports/:id is ready with downloadUrl; approve a certificate, run worker, status executed and held rows refused; grep -n 'registerAuditWorkers(' apps/backend/src/index.ts.

**GAP-006 — M05 — POST /api/v1/patients/:id/payers checks patient.edit instead of patient.edit_payers and is the only per-chart route without a caseload_or_scope guard; any patient.edit holder can rewrite coverage (billing-relevant) on any chart in the tenant.**
- Files: `apps/backend/src/modules/05-patient/routes/patient-routes.ts`, `docs/modules/WARDENX_MODULE_05_PATIENT_SPEC_v0_4.md`, `packages/auth/src/permissions/contributed.ts`, `apps/backend/src/modules/05-patient/patient-route-service-db.ts`
- Done when: Use preHandler [requirePermission('patient.edit_payers'), chartScope('patient.edit_payers')] and throw NotFoundError on a missing patient.
- Verify: patient-routes.test.ts: patient.edit-only actor -> 403; edit_payers without caseload -> 404.

**GAP-007 — M05 — Production M5 write routes publish no outbox events: admit, addAddress, addPayer, submitAmendment, decideAmendment write rows only (addAddress even returns a false cascadeEmitted literal).**
- Files: `apps/backend/src/modules/05-patient/patient-route-service-db.ts`, `apps/backend/src/modules/05-patient/index.ts`, `apps/backend/src/modules/12-dosespot/consumers/index.ts`, `apps/backend/src/modules/24-billing-medicaid/outbox-consumers/m24-revalidate-triggers.ts`
- Done when: Thread m5OutboxPublisher into createDbPatientRouteService and publish m5.patient.created / address_changed / payer_changed / amendment_request_received / amendment_decided inside the write's withOrgContext transaction.
- Verify: New live suite with the real catalog-validating publisher: POST /patients, /:id/addresses, /:id/payers each leave a matching outbox_event row in the same tx; bun run arch:outbox-bindings.

**GAP-008 — M05 — No production path creates patient_assignment rows (spec section 4.3 assignment write routes not implemented; inserts exist only in tests/seeds).**
- Files: `docs/modules/WARDENX_MODULE_05_PATIENT_SPEC_v0_4.md`, `apps/backend/src/modules/05-patient/routes/patient-routes.ts`, `apps/backend/src/modules/05-patient/seams/drizzle-stores.ts`, `apps/backend/src/modules/05-patient/events-by-m5.ts`
- Done when: Implement GET/POST /patients/:id/assignments and POST .../assignments/:assignmentId/end (patient.assign + caseload_or_scope, caseload-cache invalidation, emits) in patient-routes.ts / patient-route-service-db.ts; enrich in scripts/openapi/enrichments.ts.
- Verify: Live: POST an assignment, then GET /api/v1/patients as that non-org-wide clinician returns the patient; bun run openapi:coverage --check.

**GAP-009 — M05 — 13 of 29 spec section 4.3 routes are not implemented (PATCH /patients/:id, status, deceased, identifiers POST, caregivers, assignments, patient-matches queue, unmerge, privacy resync, amendment list/statement).**
- Files: `docs/modules/WARDENX_MODULE_05_PATIENT_SPEC_v0_4.md`, `apps/backend/src/modules/05-patient/routes/patient-routes.ts`, `apps/backend/src/modules/05-patient/patient-route-service-db.ts`, `audit/implementation-status/IMPLEMENTATION_STATUS.md`
- Done when: Add the missing handlers with the spec permission/ABAC pairs; persist patient_match_review rows on soft_review; enrich in scripts/openapi/enrichments.ts; document extras (census-metrics, demographics, care-team) in the spec.
- Verify: patient-routes.test.ts per route; live test that a soft-match admit yields a non-empty matchReviewIds and a patient_match_review row; bun run openapi:coverage --check.

**GAP-010 — M06 — No UI for live discharge, revocation, transfer-out/in or for-cause cosign, although the backend routes are live and in the typed client.**
- Files: `apps/backend/src/modules/06-admission/routes/admission-routes.ts`, `apps/web/src/modules/06-admission/screens.ts`, `apps/web/src/modules/06-admission/admission-detail.tsx`, `docs/design/screens/clinical/WARDENX_UI_DISCHARGE_REVOCATION_TRANSFER.md`, `docs/design/SCREENS.md`
- Done when: Add a discharge/revocation/transfer stepper screen (e.g. admission.discharge at /admissions/:id/discharge) in apps/web/src/modules/06-admission, launched from admission-detail.tsx, calling the four POST routes plus cosign-for-cause via the typed client; register it and add a DOM test.
- Verify: grep -rn 'admissions/{id}/discharge' apps/web/src returns a caller; bun run ui:parity lists the screen; DOM test drives the stepper.

**GAP-011 — M08 — Late-entry tier is never computed and the override sign-gate never runs: finalize never sets encounter.late_entry_tier (stays 'normal'), sign never checks for an override, and computeLateEntryTier / override deciders run only in unit tests.**
- Files: `apps/backend/src/modules/08-encounters/encounters-route-service-db.ts`, `apps/backend/__tests__/encounter-late-entry.test.ts`, `apps/backend/src/modules/08-encounters/gate/checks.ts`, `packages/db/migrations/0030_encounters_m8_tables.sql`
- Done when: In finalize() compute the tier with computeLateEntryTier and persist it; in sign()/signAddendum() call checkLateEntryOverrideSatisfied; in the override methods call decideSignificantLateOverride/decideAdministrativeLateOverride with the real tier, role and step-up and emit the real daysLate.
- Verify: M8 live suite: serviceDate 5 days ago -> finalize gives significant_late_entry; sign returns SIGNIFICANT_LATE_ENTRY_OVERRIDE_REQUIRED until route 15; route 15 on 'normal' -> LATE_ENTRY_TIER_MISMATCH.

**GAP-012 — M08 — Author-ownership ABAC (is_author, is_author_or_supervisor, is_addendum_author) is never registered or composed; finalize/enhance/decisions/sign, vitals/mileage/link-delete/evv-reconcile and addenda routes are permission-gated only and most lack encounter.scope.**
- Files: `apps/backend/src/modules/08-encounters/routes/encounters-routes.ts`, `apps/backend/src/modules/08-encounters/abac-predicates.ts`, `packages/auth/src/permissions/contributed.ts`, `docs/modules/WARDENX_MODULE_08_ENCOUNTERS_SPEC_v0_2.md`, `apps/backend/src/modules/08-encounters/encounters-route-service-db.ts`
- Done when: Register encounter.is_author / is_author_or_supervisor / is_addendum_author in 08-encounters/abac-predicates.ts and compose them plus SCOPE_FOR on routes 4-7, 9-14, 23-25.
- Verify: Route test with real DB resolver: non-author with encounter.sign -> 403/404 on POST /encounters/:id/sign; author succeeds; bun run arch:abac-predicates.

**GAP-013 — M08 — Late-entry override, administrative >14-day override and cosignature supervisor-release (spec rows 15, 16, 21) have no server-verified step-up; the TypeBox schemas still require a client stepUpAuthAt that nothing reads, and the route header wrongly claims route 21 carries step-up.**
- Files: `apps/backend/src/modules/08-encounters/routes/encounters-routes.ts`, `apps/backend/src/modules/08-encounters/routes/encounters-typebox.ts`, `apps/backend/src/modules/08-encounters/cosignature/cosignature.ts`, `docs/modules/WARDENX_MODULE_08_ENCOUNTERS_SPEC_v0_2.md`
- Done when: Add STEP_UP('encounter.late_entry_override'), STEP_UP('encounter.administrative_override'), STEP_UP('encounter.cosign_supervisor_release') to those preHandlers and drop stepUpAuthAt from the schemas.
- Verify: Route test: each route returns 412 STEP_UP_AUTH_REQUIRED with stale step-up and succeeds when fresh.

**GAP-014 — M08 — EncounterCreator is registered over the Drizzle store, which spreads the in-memory fallback and does not override insertDraftEncounter.**
- Files: `apps/backend/src/index.ts`, `apps/backend/src/modules/08-encounters/seams/drizzle-store.ts`, `apps/backend/src/modules/08-encounters/seams/store.ts`, `apps/backend/src/modules/19-oncall/clinical/encounter-link.ts`, `apps/backend/src/modules/19-oncall/routes/write-service-drizzle.ts`
- Done when: Implement insertDraftEncounter in seams/drizzle-store.ts as a real INSERT into encounter under withOrgContext via M8's draft path (audit + outbox); port or explicitly deny renderPayload and mileageForClinician so no in-memory method is reachable in production.
- Verify: Live: getSeam('EncounterCreator').createDraftEncounter as wardenx_app persists an encounter row; the M19 disposition flow links a real encounter.

**GAP-015 — M11 — No M11 PHI route enforces caseload_or_scope (GET /orders, /orders/:id, discontinue, queues); the route header falsely claims it is bound by default ABAC, which requirePermission never reads (unremediated F-092).**
- Files: `apps/backend/src/modules/11-orders/routes/orders-routes.ts`, `packages/auth/src/rbac/require-role.ts`, `docs/modules/WARDENX_MODULE_11_ORDERS_SPEC_v0_4.md`, `docs/history/gates-authz-and-routes.md`
- Done when: Compose requireAbac(<key>, 'caseload_or_scope', {notFoundOnDeny:true}) on per-order/per-patient routes and narrow list/queue SQL by M5 caseloadPatientIds unless hasOrgWideScope (F-096 pattern); correct the header.
- Verify: Live suite (wardenx_app): RN with a two-patient caseload sees only those orders; 404 on a third patient's order; medical_director sees all.

**GAP-016 — M12 — M12 order list/detail/transmission and /patients/:id/medications/active|history routes have no caseload_or_scope; only the refill inbox is narrowed.**
- Files: `apps/backend/src/modules/12-dosespot/routes/dosespot-routes.ts`, `apps/backend/src/modules/12-dosespot/dosespot-route-service-db.ts`, `docs/modules/WARDENX_MODULE_12_DOSESPOT_PRESCRIBING_SPEC_v0_2.md`
- Done when: Add requireAbac('prescribing.read','caseload_or_scope',{notFoundOnDeny:true}) to per-order/per-patient routes; narrow GET /medication-orders in SQL via the existing caseloadPatientIds helper unless hasOrgWideScope.
- Verify: Live (wardenx_app): off-caseload RN gets 404 on /patients/:id/medications/active and an empty /medication-orders list.

**GAP-017 — M12 — No live DoseSpot transport: packages/dosespot/src/client has no http.ts and no fetch; the worker defaults to the deny-stub client and index.ts passes none, so NewRx, patient sync, enrollment and med-history never reach DoseSpot in any environment.**
- Files: `packages/dosespot/src/client/unbound.ts`, `apps/backend/src/modules/12-dosespot/jobs/worker.ts`, `apps/backend/src/index.ts`, `audit/implementation-status/IMPLEMENTATION_STATUS.md`
- Done when: Build packages/dosespot/src/client/http.ts (circuit-breaker-wrapped, per-tenant credentials), add DOSESPOT_* to apps/backend/src/bootstrap/env.ts and .env.example, bind it in the composition root when configured; tighten the status-matrix adapter heuristic.
- Verify: Contract test against a DoseSpot sandbox mock; m12-vendor-boundary.live shows a queued row reaching 'transmitted'; bun run status:matrix.

**GAP-018 — M12 — POST /api/v1/rx-benefit/lookup returns a hardcoded {covered: true, copayCents: null} for every drug and patient instead of failing closed; no RxBenefit client method or cache exists.**
- Files: `apps/backend/src/modules/12-dosespot/dosespot-route-service-db.ts`, `apps/backend/src/modules/12-dosespot/routes/service.ts`, `apps/backend/src/modules/12-dosespot/routes/dosespot-routes.ts`, `docs/modules/WARDENX_MODULE_12_DOSESPOT_PRESCRIBING_SPEC_v0_2.md`
- Done when: Add a lookupRxBenefit client method and route rxBenefitLookup through it; return 503 or formularyStatus:'unknown' while unbound, never covered:true.
- Verify: Unit test: with the unbound client, POST /rx-benefit/lookup returns unavailable/unknown.

**GAP-019 — M12 — refill_inbox_policy and controlled_substance_policy tables do not exist; GET returns hardcoded defaults, PATCH persists nothing yet emits m12.controlled_substance_policy_changed {before, after}, and tighten-only refusals return 404 NOT_FOUND.**
- Files: `apps/backend/src/modules/12-dosespot/dosespot-route-service-db.ts`, `packages/types/src/errors.ts`, `docs/modules/WARDENX_MODULE_12_DOSESPOT_PRESCRIBING_SPEC_v0_2.md`
- Done when: Add both tables via a new migration (RLS, FORCE, audit trigger) and to M12 ownedTables in architecture/module-manifest.ts and .cjs; persist put*, read stored values in refill approve and the EPCS gate, use 409/422 for tighten-only refusals.
- Verify: Live: PATCH controlled-substance-policy {scheduleIiiToVMaxRefills:2}, GET returns 2, approve with 3 refills -> 422; bun run arch:tables && bun run arch:tenancy.

**GAP-020 — M13 — Controlled-substance witness requirement and administering-discipline ABAC are keyed on the client-supplied body medClass; the order port carries no controlled-substance flag although M12 exposes isControlledSubstance.**
- Files: `apps/backend/src/modules/13-emar/emar-route-service-db.ts`, `apps/backend/src/modules/13-emar/index.ts`, `apps/backend/src/modules/12-dosespot/seams/providers.ts`, `apps/backend/src/modules/13-emar/routes/emar-routes.ts`, `docs/modules/WARDENX_MODULE_13_EMAR_SPEC_v0_2.md`
- Done when: Carry isControlledSubstance/medClass from M12 getAdministrationContext into the administrationIdentity port; derive isControlled from the order and 422 on body disagreement; evaluate eligibility per row in offlineSync; implement the five-rights comparison.
- Verify: apps/backend/__tests__/m13-emar-write.live.test.ts: controlled order with body medClass 'standard' and no witness -> 422; LPN offline-sync of a compounded order -> 403/422.

**GAP-021 — M13 — eMAR read and many write routes (administrations, scheduled/missed doses, reconciliation, comfort-kit deployments) have no caseload_or_scope check; the header claims a binding that does not exist (named in F-092, unresolved).**
- Files: `apps/backend/src/modules/13-emar/routes/emar-routes.ts`, `apps/backend/src/modules/13-emar/abac-predicates.ts`, `docs/modules/WARDENX_MODULE_13_EMAR_SPEC_v0_2.md`, `docs/history/gates-authz-and-routes.md`
- Done when: Compose requireAbac(..., 'caseload_or_scope', {notFoundOnDeny:true}) per spec row in emar-routes.ts; narrow list routes in SQL via M5 caseloadPatientIds unless hasOrgWideScope.
- Verify: Live: off-caseload RN gets 404 on GET /administrations/:id and an empty GET /administrations?patient=<other>.

**GAP-022 — M13 — Administration hard-void and the admin-policy PUT have no step-up (comments say 'enforced upstream'; no upstream gate exists) and no clinical_supervisor_or_above check; worksheet void and kit acknowledge-return lack supervisor predicates.**
- Files: `apps/backend/src/modules/13-emar/routes/emar-routes.ts`, `apps/backend/src/modules/13-emar/emar-route-service-db.ts`, `packages/emar/src/lifecycle/administration-record.ts`, `packages/auth/src/permissions/contributed.ts`, `docs/modules/WARDENX_MODULE_13_EMAR_SPEC_v0_2.md`
- Done when: Add requireStepUp('administration.void') plus a clinical_supervisor_or_above predicate to void; step-up on the admin-policy PUT; supervisor predicates on worksheet void and kit ack-return; refuse voided/superseded rows with 409.
- Verify: Route tests: void without step-up -> 403/412; non-supervisor RN -> 403; m13-emar-write live: double void -> 409.

**GAP-023 — M14 — PATCH /idg/decisions/:id rewrites emitted or superseded decisions: updateDecision has no status guard (unconditional UPDATE), no edit guard exists in packages/idg, no immutability trigger exists, and the route lacks idg_meeting_scope.**
- Files: `apps/backend/src/modules/14-idg/routes/idg-routes.ts`, `apps/backend/src/modules/14-idg/idg-route-service-db.ts`, `packages/idg/src/lifecycle/decision.ts`, `packages/db/migrations/0043_idg_m14_rls_audit_triggers.sql`, `docs/modules/WARDENX_MODULE_14_IDG_SPEC_v0_4.md`
- Done when: Add planDecisionEdit (DECISION_NOT_OPEN 409 unless open) to packages/idg/src/lifecycle/decision.ts; call it in updateDecision with a conditional UPDATE ... WHERE status='open'; add idg_meeting_scope and If-Match.
- Verify: packages/idg/__tests__/decision.test.ts; m14-idg-write live: PATCH an emitted decision -> 409 DECISION_NOT_OPEN.

**GAP-024 — M14 — Supersede writes the successor into the prior (already adjourned) meeting with the prior payload, hardcodes wasQuorate: true, ignores the request body and skips quorate_decision and idg_meeting_scope.**
- Files: `apps/backend/src/modules/14-idg/idg-route-service-db.ts`, `packages/idg/src/lifecycle/decision.ts`, `apps/backend/src/modules/14-idg/routes/idg-routes.ts`, `apps/backend/src/modules/14-idg/routes/idg-typebox.ts`, `docs/modules/WARDENX_MODULE_14_IDG_SPEC_v0_4.md`
- Done when: Require a target live meetingId and new payload in SupersedeDecisionRequest; gate with idg_meeting_scope + quorate_decision on the target; insert the successor into the target meeting with live quorum; mark the prior superseded in the same tx.
- Verify: m14-idg-write live: supersede into a live quorate meeting emits on its adjournment; into the adjourned origin or without quorum -> 422.

**GAP-025 — M14 — PATCH /idg/agenda/:id discards its body and returns the row unchanged (undocumented); DELETE /idg/agenda/:id returns {removed: true} without writing (documented compromise #2).**
- Files: `apps/backend/src/modules/14-idg/routes/idg-routes.ts`, `apps/backend/src/modules/14-idg/idg-route-service-db.ts`, `packages/db/migrations/0042_idg_m14_tables.sql`, `docs/modules/WARDENX_MODULE_14_IDG_SPEC_v0_4.md`
- Done when: Add a status/tombstone column (new migration, check arch:migration-numbering); implement real update and soft delete and exclude removed items from patientIncluded; return 501/409 until then; add idg_meeting_scope via meeting resolution.
- Verify: Live: DELETE an agenda item, then POST a decision for that patient -> 422 INCLUSION_CRITERIA_FAILED; PATCH reflects in GET /meetings/:id/agenda.

**GAP-026 — M14 — Child-resource mutations (attendance, agenda, decisions, supersede, action-items, recurring-policies) skip idg_meeting_scope, If-Match and Idempotency-Key (only discipline-notes PATCH implements the pattern); a location-A coordinator can edit location B's meetings.**
- Files: `apps/backend/src/modules/14-idg/routes/idg-routes.ts`, `apps/backend/src/modules/14-idg/abac-predicates.ts`, `apps/backend/src/modules/14-idg/idg-route-service-db.ts`, `docs/modules/WARDENX_MODULE_14_IDG_SPEC_v0_4.md`
- Done when: Generalise the discipline-notes pattern: resolve meetingId from the child id, apply requireAbac(<key>,'idg_meeting_scope'), add IF_MATCH and IDEMPOTENCY_KEY to every PATCH/DELETE; refuse attendance changes post-start/adjourn; require assignee===actor for idg.act-only callers.
- Verify: 14-idg route tests: cross-location PATCH -> 404; missing If-Match -> 400; attendance PATCH after adjourn -> 422 MINUTES_FINAL; m14-idg-write live.

**GAP-027 — M14 — IDG patient packet detail/list and GET /patients/:patientId/idg-history skip the per-patient caseload_or_scope check (only meeting-location scope + SUD filter; idg-history has only idg.read).**
- Files: `apps/backend/src/modules/14-idg/routes/idg-routes.ts`, `apps/backend/src/modules/14-idg/abac-predicates.ts`, `docs/modules/WARDENX_MODULE_14_IDG_SPEC_v0_4.md`
- Done when: Add requireAbac('idg.read','caseload_or_scope',{notFoundOnDeny:true}) with a patientId target to packet detail and idg-history; filter the packet list per patient by caseload unless hasOrgWideScope.
- Verify: Route + live test: an attendee outside the patient's caseload gets 403/404 on /packets/:patientId and /patients/:id/idg-history.

**GAP-028 — M16 — M16 has no BullMQ workers: plans never close at death+13 months (CoP 418.64(d)), outreach never becomes 'missed' (so /outreach/:id/late-attempt can never succeed), anniversary alerts never fire and the unreachable detector never proposes.**
- Files: `apps/backend/src/modules/16-bereavement/lifecycle/plan.ts`, `apps/backend/src/modules/16-bereavement/routes/outreach.routes.ts`, `apps/backend/src/index.ts`, `docs/modules/WARDENX_MODULE_16_BEREAVEMENT_SPEC_v0_5.md`
- Done when: Add apps/backend/src/modules/16-bereavement/jobs/ with close-13mo, miss-deadline, anniversary-lookahead and unreachable-detector crons (active-org fan-out, withOrgContext, DB-state pre-check) wired in index.ts.
- Verify: Live: plan with death_date 14 months ago -> closed_completed after one tick; scheduled outreach past late_grace_until -> missed + m16.bereavement.outreach_missed.

**GAP-029 — M16 — M16 section 4.5 subscriptions to m8.encounter.signed (bereavement_contact -> contact_log + complete outreach), m22.document.rendered (rendered_document_id) and m4.legal_hold.* are unbuilt; producers do not declare m16, so arch:outbox-bindings is silent.**
- Files: `apps/backend/src/modules/08-encounters/events-by-m8.ts`, `apps/backend/src/modules/22-documents/events-by-m22.ts`, `apps/backend/src/modules/04-audit/events-by-m4.ts`, `docs/modules/WARDENX_MODULE_16_BEREAVEMENT_SPEC_v0_5.md`
- Done when: Add M16 outbox consumers for m8.encounter.signed (encounter_type=bereavement_contact) and m22.document.rendered (bereavement templates); add m16 to the producers' declaredConsumers and bind both in apps/backend/src/index.ts.
- Verify: Live: signing a bereavement_contact encounter completes the linked outreach and appends contact_log; a rendered sympathy_letter sets rendered_document_id; bun run arch:outbox-bindings.

**GAP-030 — M17 — M17 visit reads (list, get, day/week/map views, proposals) and visit.start/arrive are gated by requirePermission only; listVisits applies no caseload or own-membership filter and visit.read_team is never checked.**
- Files: `apps/backend/src/modules/17-scheduling/routes/scheduling-routes.ts`, `apps/backend/src/modules/17-scheduling/scheduling-route-service-db.ts`, `packages/db/migrations/0045_scheduling_m17_rls_audit_triggers.sql`, `docs/modules/WARDENX_MODULE_17_SCHEDULING_SPEC_v0_2.md`
- Done when: Bind requireAbac(key,'caseload_or_scope',{getTarget: patientId from visit}) on per-visit routes; narrow listVisits/dayView/weekView to caseload or own membership unless visit.read_team or org-wide scope.
- Verify: Live (wardenx_app): RN without a caseload link sees zero rows for an unrelated patient and gets 404/403 on GET /visits/:id; scheduler with visit.read_team sees all.

**GAP-031 — M17 — Own-vs-any permission scoping is not enforced for availability and time-off: routes gate on *_own keys only and services ignore the caller, so any clinician can overwrite a colleague's availability, cancel their approved PTO or file PTO on their behalf (PTO feeds the not_on_pto scheduling gate).**
- Files: `apps/backend/src/modules/17-scheduling/routes/scheduling-routes.ts`, `apps/backend/src/modules/17-scheduling/scheduling-route-service-db.ts`, `docs/modules/WARDENX_MODULE_17_SCHEDULING_SPEC_v0_2.md`
- Done when: Resolve own-vs-any: require edit_any/read_team/approve when the target membership is not the caller's; force requestTimeOff.membershipId to the caller unless approve; add an ownership check to cancelTimeOff.
- Verify: Inject tests: *_own-only RN gets 403 on PUT /availability/<other>, POST /time-off for another membership, cancel of another's PTO, and sees only own rows on GET /time-off.

**GAP-032 — M17 — PTO approval never runs the reassignment scan or emits m17.reassignment_needed; affectedPublishedVisitCount and conflictingVisitCount are hardcoded 0 and no reassignment-scan worker exists (route comment falsely says it runs in-service).**
- Files: `apps/backend/src/modules/17-scheduling/scheduling-route-service-db.ts`, `apps/backend/src/modules/17-scheduling/jobs/index.ts`, `packages/scheduling/src/lifecycle/effects.ts`, `apps/backend/src/modules/17-scheduling/routes/scheduling-routes.ts`, `docs/modules/WARDENX_MODULE_17_SCHEDULING_SPEC_v0_2.md`
- Done when: In approveTimeOff's tx select overlapping published visits, emit m17.reassignment_needed (reason 'pto') per visit and populate the real counts in both events.
- Verify: Live: seed a published visit inside a PTO window, approve PTO, assert one m17.reassignment_needed outbox row and affectedPublishedVisitCount=1.

**GAP-033 — M17 — M17 (36 call sites) and M18 (25) open withOrgContext with userId: "", so M4 write-audit triggers record a NULL actor_user_id on visit, time_off, availability, evv_event and missing-resolution writes.**
- Files: `apps/backend/src/modules/18-evv/evv-route-service-db.ts`, `apps/backend/src/modules/17-scheduling/scheduling-route-service-db.ts`, `packages/db/migrations/0045_scheduling_m17_rls_audit_triggers.sql`, `packages/tenancy/src/context.ts`
- Done when: Pass the acting user/membership id into withOrgContext in every route DB service (M5-M11, M17, M18, M39), as M16/M19/M20 do.
- Verify: Live: POST /api/v1/visits/:id/cancel, assert audit_event.actor_user_id equals the caller.

**GAP-034 — M18 — EVV capture decides 'pass' from GPS accuracy alone and never computes distance to the patient address, yet emits m18.evv.at_patient_address (and breach) with a fabricated computedDistanceM: 0 and then visit_verified (consumed by M30).**
- Files: `apps/backend/src/modules/18-evv/evv-route-service-db.ts`, `apps/backend/src/modules/18-evv/domain/geofence.ts`, `apps/backend/src/modules/30-quality/outbox-consumers/upstream-events.ts`
- Done when: Resolve the patient-address baseline via the M5 PatientAddressReader, compute haversine distance, drive decisions through the domain capture machine (outside_geofence -> open missing-resolution, spoof detection) and persist computed_distance_m.
- Verify: Live: check-in 5 km away with 10 m accuracy -> outside_geofence + open evv_missing_resolution, no at_patient_address/visit_verified.

**GAP-035 — M18 — M18 has no BullMQ workers: no aggregator submission is ever created (Cures Act state-aggregator path cannot start), dispatchSubmission/pollSubmissionOnce have no caller, no late-check sweep creates missing-resolution rows, and 7 catalogued events (aggregator_submitted/accepted/rejected/timeout, gps_spoof_suspected, late_check_out_detected, verification_pdf_requested) are never emitted, leaving the M19 late-checkout and M20 gps-spoof consumers dead.**
- Files: `packages/db/migrations/0047_evv_m18_rls_audit_triggers.sql`, `apps/backend/src/modules/18-evv/submission-flow.ts`, `apps/backend/src/modules/18-evv/evv-route-service-db.ts`, `apps/backend/src/modules/19-oncall/consumers/m18-late-checkout.ts`, `apps/backend/src/modules/20-field-safety/consumers/bindings.ts`, `docs/modules/WARDENX_MODULE_18_EVV_SPEC_v0_2.md`
- Done when: Add apps/backend/src/modules/18-evv/jobs/ with late-check-sweep, aggregator-submission-prep, submitter and poller workers (withOrgContext per org) registered in index.ts.
- Verify: Live: check-out on an aggregation-state visit produces a queued evv_aggregator_submission; an in_visit visit past grace produces an open missing_resolution and an m18.evv.late_check_out_detected row consumed by M19.

**GAP-036 — M18 — POST /evv/offline-sync gates only on evv.check_in and calls recordCapture with each event's client-supplied kind (check_out allowed) and visitId; assigned-clinician and visit-window ABAC run only on /check-in and /check-out.**
- Files: `apps/backend/src/modules/18-evv/routes/evv-routes.ts`, `apps/backend/src/modules/18-evv/evv-route-service-db.ts`, `docs/modules/WARDENX_MODULE_18_EVV_SPEC_v0_2.md`
- Done when: Run assigned-clinician, window and per-kind permission checks per event in the offline-sync handler or captureInTx; reject or quarantine failures.
- Verify: Inject test: unassigned clinician offline-sync -> 403/per-event rejection; a check_out in the batch requires evv.check_out.

**GAP-037 — M18 — EVV GPS coordinates (PHI) are stored as base64('lat,lng') in coords_cipher / device_coords_cipher stamped coords_dek_version=1; that is not encryption and misleads erasure/audit reports.**
- Files: `apps/backend/src/modules/18-evv/coords.ts`, `apps/backend/src/modules/18-evv/evv-route-service-db.ts`, `apps/backend/src/index.ts`
- Done when: Bind the per-tenant DEK envelope cipher (getTenantKeyProvider) in encodeStoredCoords; until then store NULL with a sentinel as M20 does.
- Verify: Unit: encodeStoredCoords output not decodable without the DEK; live: coords_cipher does not base64-decode to 'lat,lng'.

**GAP-038 — M19 — M19 Tier-1 crons are unbuilt: shift-open/close, the proactive 24h coverage-gap watchdog, callback-sla, awaiting-callback-timeout, close-documented and escalation-sla.**
- Files: `apps/backend/src/modules/19-oncall/jobs/index.ts`, `apps/backend/src/index.ts`, `apps/backend/src/modules/19-oncall/alerts.ts`, `apps/backend/src/modules/19-oncall/roster/shift-machine.ts`, `apps/backend/src/modules/19-oncall/consumers/bindings.ts`, `docs/modules/WARDENX_MODULE_19_ONCALL_TRIAGE_SPEC_v0_3.md`
- Done when: Add M19 cron workers for shift-open/close, coverage-gap-watchdog, callback-sla, awaiting-callback-timeout, close-documented and escalation-sla (active-org fan-out under withOrgContext, M19_PLATFORM_JOB_ID allowlist) registered in index.ts.
- Verify: Live: no clinical_rn shift in next 24h -> one m19.oncall_shift.coverage_gap + critical alert; awaiting_callback past SLA emits callback_sla_breached.

**GAP-039 — M20 — The 30-second check-in overdue detector (core lone-worker safety control) does not exist; M20 registers only the SOS SLA watchdog and decideOverdueCheckIn has no production caller.**
- Files: `apps/backend/src/modules/20-field-safety/jobs/index.ts`, `apps/backend/src/index.ts`, `apps/backend/src/modules/20-field-safety/lifecycle/check-in-overdue.ts`, `apps/backend/src/modules/20-field-safety/seams/providers.ts`, `docs/modules/WARDENX_MODULE_20_FIELD_SAFETY_SPEC_v0_3.md`
- Done when: Add the overdue-detector cron over safety_check_in_schedule applying decideOverdueCheckIn effects (state flip, outbox, M36 alert) per org under withOrgContext; add post-visit-window-closer and coverage-gap-watchdog.
- Verify: Live: schedule row past expected_at+window becomes overdue after one tick and emits m20.safety.check_in_overdue.

**GAP-040 — M20 — The M20 DEK cipher port is deliberately unbound, so POST /safety/incidents (and patch, narrative resolve, action plan) always return 503 SAFETY_CIPHER_UNBOUND and SOS/check-in coordinates are discarded for a sentinel.**
- Files: `apps/backend/src/index.ts`, `apps/backend/src/modules/20-field-safety/routes/write-service-drizzle.ts`
- Done when: Provide the per-tenant DEK envelope cipher (shared M34 key ring via getTenantKeyProvider) and pass it as `cipher` to buildDrizzleM20WriteService in apps/backend/src/index.ts.
- Verify: Docker stack: POST /api/v1/safety/incidents -> 201 and narrative_cipher is not plaintext; SOS persists postedCoordinatesCipher.

**GAP-041 — M21 — None of the M21 section 4.6 crons exist: par_monitor, unreturned_kit_monitor (30-day overdue flip + compliance escalation), invoice_reconciliation.**
- Files: `apps/backend/src/modules/21-supplies/lifecycle/return.ts`, `apps/backend/src/modules/21-supplies/lifecycle/par-stock.ts`, `packages/emar/src/cascade/discharge-cascade.ts`, `docs/modules/WARDENX_MODULE_21_SUPPLIES_DME_COMFORT_KITS_SPEC_v0_2.md`
- Done when: Add apps/backend/src/modules/21-supplies/jobs/ with par-monitor and unreturned-kit-monitor crons (active-org fan-out, withOrgContext, detectReturnEscalation -> markOverdue effects, runParMonitor -> outbox/alerts) registered in index.ts.
- Verify: Integration tests unreturned-kit-cron-30d/90d: dispatch with patient deceased 31/91 days ago -> state flip + outbox events.

**GAP-042 — M23 — NOE/NOTR 5-day window-watch and eligibility stale-watch crons are scheduled but every tick throws: buildM23WorkerDeps receives no activeOrgs or noticeWindow port (M23 is the only cron module without activeOrgs).**
- Files: `apps/backend/src/index.ts`, `apps/backend/src/modules/23-billing-medicare/jobs/m23-jobs.ts`
- Done when: Build an M23 enumerator with buildActiveOrgEnumerator (same as m24ActiveOrgs/m25ActiveOrgs) and pass activeOrgs; bind noticeWindow to the noe-notr-state-service breach stamp; register M23 cron jobIds in PLATFORM_CONTEXT_ALLOWLIST.
- Verify: Live: NOE with windowTargetAt in the past + runNoeWindowWatch with index.ts-built deps sets window_breached_at and emits m23.noe.window_breached.

**GAP-043 — M23 — The revalidate.consumer queue has a live producer (six F-153 outbox triggers + F-162) but no Worker: only the never-called registerM23Workers constructs it (plus validationRun and eligibilityRefresh).**
- Files: `apps/backend/src/index.ts`, `apps/backend/src/modules/23-billing-medicare/jobs/m23-jobs.ts`, `apps/backend/src/modules/23-billing-medicare/outbox-consumers/m23-revalidate-triggers.ts`
- Done when: Register Workers for revalidateConsumer and validationRun in index.ts (call registerM23Workers with bound deps or add them to the launch set); bind enqueue and validationRunner; fix the header.
- Verify: Live: publish m6.cti.signed for a patient with a READY claim, drain with index.ts-built workers, assert a new validation_run row.

**GAP-044 — M23 — POST /api/v1/claims/:id/validation-runs/:runId/results/:resultId/override always returns 503 SEAM_UNBOUND: the override audit port defaults to denyAudit and index.ts passes none; no implementation of recordOverrideAudit exists.**
- Files: `apps/backend/src/modules/23-billing-medicare/routes/write-service-drizzle.ts`, `apps/backend/src/index.ts`, `apps/backend/src/modules/23-billing-medicare/routes/validation.routes.ts`, `packages/billing/src/rules/evv-coherence.ts`
- Done when: Implement an AuditEventPort over @wardenx/audit writing the audit_event in the caller tx and pass it as `audit` at apps/backend/src/index.ts:3494.
- Verify: Docker stack / Drizzle service as built by index.ts: override returns 200 and writes validation_override with non-null audit_event_id.

**GAP-045 — M23 — POST /api/v1/billing/eligibility/check always returns 503: the outbox-backed submission gate admits only claim/noe/notr queue names, the eligibility.refresh worker lives in never-called registerM23Workers, and the HETS port is unbound.**
- Files: `apps/backend/src/modules/23-billing-medicare/routes/write-service-drizzle.ts`, `apps/backend/src/modules/23-billing-medicare/outbox-consumers/submit-requests.ts`, `apps/backend/src/index.ts`, `apps/backend/src/modules/23-billing-medicare/jobs/m23-jobs.ts`, `packages/billing/src/rules/eligibility-freshness.ts`
- Done when: Bind a HETS 270/271 port, add an eligibility.refresh producer or dedicated queue port and register the eligibilityRefresh worker; until then document the deferral and disable the UI action.
- Verify: Docker stack: POST /api/v1/billing/eligibility/check -> 202 and the worker appends an eligibility_check row.

**GAP-046 — M24 — rb_day rows are never created in production: the rb-day-daily-sweep worker body only lists active orgs, RbDaySweepStore has no implementation, and registerM24CronWorkers/scheduleM24Jobs are never called.**
- Files: `apps/backend/src/modules/24-billing-medicaid/routes/write-service-drizzle.ts`, `apps/backend/src/modules/24-billing-medicaid/jobs/index.ts`, `apps/backend/src/modules/24-billing-medicaid/jobs/m24-jobs.ts`, `apps/backend/src/index.ts`, `docs/modules/WARDENX_MODULE_24_BILLING_MEDICAID_SPEC_v0_2_1.md`, `docs/history/outbox-248-builds.md`
- Done when: Implement RbDaySweepStore.sweepPendingDays over the M6 LOC snapshot + rb_arrangement (idempotent on (patient_id, service_date)) and a real eligibility watchdog store; wire registerM24CronWorkers with m24ActiveOrgs and call scheduleM24Jobs in index.ts.
- Verify: Live: activate an rb_arrangement, run the sweep, assert rb_day rows; assemble a combined claim with revenue code 0658 lines.

**GAP-047 — M25 — buildM23ClaimRejectedConsumer and buildM18EvvAggregatorRejectedConsumer are written and live-tested but never constructed in apps/backend/src/index.ts.**
- Files: `apps/backend/src/modules/25-remittance/outbox-consumers/m23-claim-rejected.ts`, `apps/backend/src/modules/25-remittance/index.ts`, `apps/backend/src/index.ts`, `apps/backend/src/bootstrap/outbox-dispatcher.ts`, `scripts/check-outbox-bindings.ts`, `scripts/outbox-deferred-consumers.ts`
- Done when: Add both consumers to the org-scoped consumer array next to buildM25EdiReceivedConsumer in apps/backend/src/index.ts; harden scripts/check-outbox-bindings.ts so every discovered build*Consumer factory must be reachable from the composition root.
- Verify: grep -n 'buildM23ClaimRejectedConsumer\|buildM18EvvAggregatorRejectedConsumer' apps/backend/src/index.ts; bun run test:m25:denial-seed-consumers:live; boot test asserting neither event is in buildOutboxRoutingPlan(...).deferred.

**GAP-048 — M27 — Cost-report submit's two-person check compares the actor with an optional, caller-supplied approvedByMembershipId; approveForSubmit never persists the approver (no column).**
- Files: `apps/backend/src/modules/27-cost-report/routes/write-service-drizzle.ts`, `apps/backend/src/modules/27-cost-report/routes/cost-report-typebox.ts`, `apps/backend/src/modules/27-cost-report/routes/cost-reports.routes.ts`, `packages/db/src/schema/cost-report/cost-report.ts`
- Done when: Add approved_by_membership_id to cost_report (migration + Drizzle schema), set it in approveForSubmit, compare actor.membershipId with the persisted value at submit; remove approvedByMembershipId from the submit body schemas.
- Verify: Live: same membership approves then submits with no approvedByMembershipId -> 403 TWO_PERSON_CONTROL_VIOLATION; run m27-cost-report-workflow-slice.live.test.ts.

**GAP-049 — M28 — The FHIR gateway serves only Patient, Encounter (search), MedicationRequest and MedicationAdministration; DiagnosticReport, Practitioner, Condition, CarePlan, Goal, Observation, DocumentReference, Coverage and the rest of the Phase-1 set are absent (W-FHIR-13..16 unmet).**
- Files: `apps/backend/src/modules/28-fhir/routes/projection.ts`, `apps/backend/src/modules/28-fhir/seams/consumed.ts`, `apps/backend/src/index.ts`, `docs/modules/WARDENX_MODULE_28_FHIR_GATEWAY_SPEC_v0_4.md`
- Done when: Add DiagnosticReport (read + ?patient) via projectDiagnosticReport with M11 OrderProvider + M29 LabObservationReader (after the contract fix) and Practitioner via M40 ExternalPhysicianReader to SERVED_RESOURCES; add remaining US Core types as producer seams land.
- Verify: Extend m28-fhir-gateway.live.test.ts with W-FHIR-13..16; GET /fhir/r4/metadata lists the new types.

**GAP-050 — M29 — No inbound HL7 MLLP listener process is composed (startListenerProcess is defined nowhere; createTlsListenerRegistry is used only by tests) and no production MllpIngestSink exists; nothing inserts hl7_message_inbound.**
- Files: `apps/backend/src/modules/29-external-interfaces/listener/index.ts`, `apps/backend/src/modules/29-external-interfaces/listener/connection.ts`, `apps/backend/src/modules/29-external-interfaces/routes/store-drizzle.ts`, `docs/history/outbox-248-builds.md`
- Done when: Build the M29 listener entrypoint (separate process or worker.ts branch): load active feeds under withPlatformContext, apply the BAA gate, start createTlsListenerRegistry, bind a Drizzle MllpIngestSink writing hl7_message_inbound under withOrgContext with DEK-encrypted payload; store real credential ciphertext.
- Verify: Live: TLS MLLP socket sends ADT^A08 and ORU^R01 -> hl7_message_inbound + proposal/lab_observation rows + ACK; add a ci.yml job row.

**GAP-051 — M29 — M29 lab-observation reads (list, unmatched, detail with values) have no config.auditRead and /api/clinical/labs and /api/admin/external-interfaces are outside DEFAULT_READ_AUDIT_PREFIXES, so the fail-closed boot gate never governs them and no read event is emitted (164.528 accounting gap).**
- Files: `apps/backend/src/modules/29-external-interfaces/routes/labs.routes.ts`, `apps/backend/src/bootstrap/index.ts`, `docs/modules/WARDENX_MODULE_29_EXTERNAL_INTERFACES_SPEC_v0_4.md`
- Done when: Add auditListRead to list/unmatched and auditPhiRead (patientIdPayloadPath 'observation.patientId') to detail; add auditRead or a justified waiver to every /api/admin/external-interfaces GET; add both prefixes to DEFAULT_READ_AUDIT_PREFIXES.
- Verify: bunx vitest run apps/backend/__tests__/read-audit-coverage.test.ts plus a boot-fail case; extend gap-079-read-audit-emission.live.test.ts with a lab read -> audit_event row.

**GAP-052 — M29 — GET /api/clinical/labs/observations is gated only by inOrg; the caseload predicate applies only to :observationId routes and no caller passes caseloadPatientIds, so any lab.read holder lists every patient's labs in the org.**
- Files: `apps/backend/src/modules/29-external-interfaces/routes/labs.routes.ts`, `apps/backend/src/modules/29-external-interfaces/routes/guards.ts`, `apps/backend/src/modules/29-external-interfaces/routes/store-drizzle.ts`, `packages/db/migrations/0148_external_interfaces_m29_rls_audit_triggers.sql`, `docs/modules/WARDENX_MODULE_29_EXTERNAL_INTERFACES_SPEC_v0_4.md`
- Done when: Resolve the actor's caseload (or wide-scope bypass) and pass caseloadPatientIds to listObservations; push patient/loinc/caseload filters into SQL before LIMIT.
- Verify: Live (wardenx_app): clinician with caseload {P1} receives no P2 observations; wide-scope role receives both.

**GAP-053 — M30 — SRA cycle close and QAPI PIP close take both cosigner ids from the request body; nothing checks the actor is a cosigner, that either holds the required role, or that the second person authenticated.**
- Files: `apps/backend/src/modules/30-quality/routes/quality-typebox.ts`, `apps/backend/src/modules/30-quality/routes/qapi.routes.ts`, `apps/backend/src/modules/30-quality/routes/sra.routes.ts`, `apps/backend/src/modules/30-quality/routes/write-service-drizzle.ts`, `apps/backend/src/modules/30-quality/abac-predicates.ts`
- Done when: In closeSraCycle/closeQapiPip require actor.membershipId to be a cosigner, load both memberships and check roles (reuse the predicate logic), add requireStepUp('qapi.close') to R-31; ideally use a pending-cosign record confirmed in the second signer's own step-up session.
- Verify: Route/live test: single actor with qapi.close (or sra.close + step-up) closing with two arbitrary distinct membership ids -> 403; bunx vitest run on the M30 route tests.

**GAP-054 — M30 — m6.discharge.death is not consumed, so mortality reviews are never auto-created (no create route exists, R-70..R-73 unusable) and CAHPS decedent sampling/export ports are unbound end to end (index.ts passes no cahpsAdapters).**
- Files: `apps/backend/src/modules/30-quality/outbox-consumers/upstream-consumer-ports.ts`, `apps/backend/src/modules/30-quality/routes/mortality.routes.ts`, `apps/backend/src/index.ts`, `apps/backend/src/modules/30-quality/jobs/m30-jobs.ts`, `scripts/outbox-subscription-exceptions.ts`, `scripts/outbox-deferred-consumers.ts`, `docs/modules/WARDENX_MODULE_30_HQRP_QUALITY_SPEC_v0_5.md`
- Done when: Split handleDischargeDeath so the mortality-review draft binds now; bind buildM30DischargeDeathConsumer in index.ts (idempotent on createdViaEventIdempotencyKey); then bind CAHPS ports to getTenantKeyProvider().dekForOrg and an adapter registry; update the exception reason.
- Verify: Live: publish m6.discharge.death through the real publisher -> one mortality_review row as wardenx_app; redelivery no-op; bun run arch:outbox-bindings.

**GAP-055 — M30 — The monthly CAHPS sample cron builds CahpsRepository on the base pool and calls findActiveBinding with no withOrgContext; under the org-keyed RLS policy it reads zero rows and silently records every org as 'no_active_vendor'.**
- Files: `apps/backend/src/modules/30-quality/jobs/m30-jobs.ts`, `packages/quality/src/workers/crons.ts`, `packages/db/migrations/0067_quality_m30_rls.sql`, `apps/backend/src/index.ts`, `packages/quality/src/workers/params.ts`
- Done when: Run activeVendorBinding and the sample insert inside withOrgContext; bind listPriorMonthDecedents to DeathDischargeReader, insertSampled/decrypt/bindingConfig to the tenant DEK helper, emits to deps.outboxPublisher; wrap cahps_export per job in withOrgContext; pass a CahpsAdapterRegistry; fail loudly until bound.
- Verify: Live (wardenx_app): active cahps_vendor_binding + decedent -> runCahpsMonthlySample outcome 'sampled' with a cahps_decedent_sample row and an m30.cahps.sample_ready outbox row.

**GAP-056 — M30 — None of M30's twelve section 4.9 alerts reach M36: all trigger events are record-only (declaredConsumers []), no M30 code calls AlertEmitter, M36's clinical-alert consumer has no m30 events, the scheduled SRA-reminders cron's cycles/alerts ports are unbound (fails daily), and m30.incident.cap_overdue has no producer.**
- Files: `docs/modules/WARDENX_MODULE_30_HQRP_QUALITY_SPEC_v0_5.md`, `apps/backend/src/modules/30-quality/events-by-m30.ts`, `apps/backend/src/modules/36-messaging/outbox-consumers/clinical-alerts.ts`, `apps/backend/src/modules/30-quality/jobs/m30-jobs.ts`, `apps/backend/src/index.ts`
- Done when: Add an M36 outbox consumer for M30 alert-trigger events (validate M30_ALERT_PAYLOADS, dispatch via getSeam('AlertEmitter')) and declare m36 on those events; bind the SRA-reminders cycles and alerts.dispatch ports; add a CAP-overdue sweep emitting m30.incident.cap_overdue.
- Verify: Live: run the outbreak detector on 3 matching events -> M36 alert row eventType outbreak_detected; runSraReminders on a cycle due in 30 days dispatches an alert; bun run arch:outbox-bindings.

**GAP-057 — M31 — Portal invitation routes are silent no-ops: issue returns 202 with invented ids and persists nothing, list returns [], revoke/invite-bereaved return ok.**
- Files: `apps/backend/src/modules/31-portal/routes/admin.routes.ts`, `apps/backend/src/modules/31-portal/outbox-consumers/m16-bereavement-plan-opened.ts`, `apps/backend/src/modules/31-portal/lifecycle/invitation.ts`, `docs/modules/WARDENX_MODULE_31_PORTAL_TELEHEALTH_SPEC_v0_2.md`, `docs/history/m31-portal-deferrals.md`
- Done when: Wire issuance to issueInvitation + M2 collaborator-invite + M36 delivery outbox; persist invitation state (decide owner table); implement accept -> portal_account + portal_access_grant under withOrgContext; real list/revoke/invite-bereaved.
- Verify: Live: POST /api/v1/admin/portal-invitations -> accept -> GET /api/v1/portal/sessions/current shows an active grant.

**GAP-058 — M31 — Portal logout and step-up are no-ops: logout returns ok without revoking the server session (the SPA just navigates to '/'), and step-up returns ok for any TOTP without validating or stamping freshness, while the UI says 'Verified'.**
- Files: `apps/backend/src/modules/31-portal/routes/session.routes.ts`, `apps/portal/src/screens/account.tsx`, `apps/backend/src/modules/02-identity/routes/session-step-up.ts`, `docs/modules/WARDENX_MODULE_31_PORTAL_TELEHEALTH_SPEC_v0_2.md`
- Done when: Delegate logout to Better Auth session revocation for the caller's session id and step-up to the M2 step-up verifier; return 401/422 on a bad TOTP.
- Verify: Live: portal sign-in -> logout -> same cookie on GET /portal/sessions/current -> 401; bad TOTP -> 4xx.

**GAP-059 — M31 — POST /api/v1/portal/bereavement/opt-out returns ok without calling M16 (which has a working opt-out path), so bereaved families who opt out keep receiving outreach.**
- Files: `apps/backend/src/modules/31-portal/routes/write.routes.ts`, `apps/backend/src/modules/31-portal/routes/read.routes.ts`, `apps/backend/src/modules/16-bereavement/permission-keys.ts`, `docs/modules/WARDENX_MODULE_31_PORTAL_TELEHEALTH_SPEC_v0_2.md`
- Done when: Forward opt-out to M16 via its seam or an m31.* outbox event M16 consumes, returning 202 only once enqueued; bind preferences to an M36 seam or return 501 until one exists.
- Verify: Live: POST /api/v1/portal/bereavement/opt-out -> M16 contact shows opted-out; bun run arch:outbox-bindings.

**GAP-060 — M33 — Report drilldown emit and bulk_export always fail closed: drilldownEncryption is never passed, so the stub throws DrilldownDekUnavailable, and the drilldown audit-flush worker is unbound.**
- Files: `apps/backend/src/modules/33-reporting/routes/export-drilldown-service.ts`, `apps/backend/src/modules/33-reporting/wiring.ts`, `apps/backend/src/index.ts`, `apps/backend/src/modules/33-reporting/jobs/m33-jobs.ts`, `apps/backend/src/modules/31-portal/portal-crypto.ts`
- Done when: Implement a DrilldownFilterEncryptionPort over getTenantKeyProvider() (portal-crypto pattern, AAD m33:report_drilldown_audit:filter_context:<org>), pass it into createDrizzleM33ExportDrilldownBackend and the audit-flush ports; fix the comment.
- Verify: Live (wardenx_app): POST /api/v1/reporting/drilldown/emit -> 200 + ciphertext report_drilldown_audit row; listed by GET /api/v1/reporting/admin/audit/drilldowns.

**GAP-061 — M34 — M34 ABAC predicates are always bound to SLICE_M34_ABAC_RESOLVER (all loaders null/false) even on a DB boot, so feature_flag_write_authority, support_session_actor_distinct_from_grantor and tenant_consented_support_active always deny: feature-flag writes, the kill switch and support-session start/elevate always 403.**
- Files: `apps/backend/src/index.ts`, `apps/backend/src/modules/34-saas-tenant-platform/abac-predicates.ts`, `apps/backend/src/modules/34-saas-tenant-platform/routes/platform/feature-flags-admin.ts`, `apps/backend/src/modules/34-saas-tenant-platform/routes/platform/support-sessions.ts`
- Done when: Add a Drizzle TenantPlatformAbacResolver (support_consent_grant, support_session, onboarding_task, FeatureFlagAdmin seam) and bind it in index.ts when deps.db is present; fix the comment.
- Verify: Route test over the real resolver: platform_ops kill-switch -> 200; support-session start with a valid grant from another grantor -> 2xx.

**GAP-062 — M35 — No live Stripe loop: mountM35Routes gets no webhook ingest (POST /api/v1/webhooks/stripe always 503 STRIPE_WEBHOOK_UNCONFIGURED), the outbound stripe-dispatcher worker is never wired, and createSetupIntent returns {clientSecret:null}.**
- Files: `apps/backend/src/index.ts`, `apps/backend/src/modules/35-subscription/routes/mount.ts`, `apps/backend/src/modules/35-subscription/routes/webhooks.routes.ts`, `apps/backend/src/modules/35-subscription/routes/service-drizzle.ts`, `packages/subscription-billing/src/stripe/dispatcher.ts`
- Done when: Build the section 4.14 ingest (verifier + Drizzle stripe_webhook_event + DEK + STRIPE_WEBHOOK_SECRET in env.ts) and pass mountM35Routes({webhook:{ingest}}); register a stripe-dispatcher worker with a LiveStripeClient gated on STRIPE_SECRET_KEY.
- Verify: Live: Stripe test-signature fixture POST /api/v1/webhooks/stripe -> 200 + stripe_webhook_event; invalid signature -> 401; dispatcher drains an outbox op into stripe_api_call_audit.

**GAP-063 — M35 — None of M35's six published seams (SubscriptionStateProvider, BillingStatusProvider, UsageMeteringIngest, PatientCounterProvider, RevenueMetricsProvider, PlanCatalogReader) is registered (spec D20 'boot refuses on missing registration' is not enforced; deny-stubs apply), and no producer (M28, M32) calls UsageMeteringIngest.ingest.**
- Files: `apps/backend/src/bootstrap/seams/registry.ts`, `apps/backend/src/bootstrap/seams/providers.ts`, `docs/modules/WARDENX_MODULE_35_SUBSCRIPTION_BILLING_SPEC_v0_3.md`, `apps/backend/src/modules/32-ai-platform/events-by-m32.ts`, `packages/subscription-billing/src/service/usage-metering-service.ts`
- Done when: Add apps/backend/src/modules/35-subscription/wiring.ts with registerM35PublishedSeams(db) for the six Drizzle impls (PHI denylist + idempotency), call it from wireModuleSeams; call ingest from M32's token ledger and M28's FHIR read audit; bind the M34 entitlement reader.
- Verify: Boot test: getSeam('UsageMeteringIngest') is not the deny-stub on a DB boot; live: one M32 invocation -> one usage_event row, replay no-op.

**GAP-064 — M36 — M36 out-of-band delivery (push/SMS/voice/email), Socket.IO realtime and delivery-reconcile webhooks are unbuilt: the 12-queue catalog is data only, no vendor send call exists, planned notification_delivery rows are never dispatched, the webhook registrar is deliberately unmounted, and m36.notification.delivery_failed has no producer (M19/M20 escalation consumers never fire).**
- Files: `packages/messaging/src/jobs/queues.ts`, `apps/backend/src/modules/36-messaging/messaging-route-service-db.ts`, `scripts/check-route-reachability.ts`, `apps/backend/src/modules/19-oncall/consumers/bindings.ts`, `docs/history/gates-outbox-bindings.md`, `docs/modules/WARDENX_MODULE_36_MESSAGING_SPEC_v0_4.md`
- Done when: Build the dispatch tier in apps/backend/src/modules/36-messaging/jobs/ (send_* workers over notification_delivery, delivery_reconcile with a concrete MessagingWebhookService), register @fastify/formbody, mount registerMessagingWebhookRoutes, emit delivery_failed; remove the DEFERRED entry.
- Verify: bun run arch:route-reachability with the entry removed; live suite: alert leaves notification_delivery 'pending' and vendor failure publishes m36.notification.delivery_failed.

**GAP-065 — M37 — Only 1 of 12 section 4.8 IPU crons exists (rn-coverage-watchdog).**
- Files: `docs/modules/WARDENX_MODULE_37_IPU_SPEC_v0_2.md`, `apps/backend/src/modules/37-ipu/jobs/index.ts`, `apps/backend/src/index.ts`, `packages/inpatient/src/machines/irc-episode.ts`, `apps/backend/src/modules/37-ipu/routes/service-drizzle.ts`, `apps/backend/src/modules/37-ipu/seams.ts`
- Done when: Add Workers/schedules in apps/backend/src/modules/37-ipu/jobs/ for census-snapshot-builder, irc-cap-watchdog (calling planIrcDailyTick), restraint-reassessment, iv-bedside-check, bed-cleaning-SLA, transfer-completion, postclose-settlement and the rest; reopen tracking.
- Verify: Live suites: census row written for an active admission; IRC episode moves active -> approaching_cap -> breached over ticks; GET /api/v1/ipu-census/:date non-zero.

**GAP-066 — M37 — GIP criteria attestation does not enforce hospice-MD / active M40 ExternalPhysician eligibility: attestGip persists a client-supplied attestingPhysicianId unchecked, the route has no requireAbac, the attester_eligible predicate is a target-boolean stub nothing feeds, and stepUpAssertionId is written as the membership id.**
- Files: `apps/backend/src/modules/37-ipu/routes/service-drizzle.ts`, `apps/backend/src/modules/37-ipu/routes/ipu.routes.ts`, `apps/backend/src/modules/37-ipu/abac/predicates.ts`, `packages/auth/src/permissions/contributed.ts`, `docs/modules/WARDENX_MODULE_37_IPU_SPEC_v0_2.md`
- Done when: In attestGip resolve the actor's M2 discipline and the attesting physician via M40 (active ExternalPhysician bound to the actor) and reject with 403 GIP_ATTESTER_INELIGIBLE; persist the real step-up assertion id.
- Verify: Live: RN with attest + step-up -> 403; hospice MD bound to an active external_physician -> 201.

**GAP-067 — M37 — POST /ipu-admissions/:id/confirm (spec: system-internal) is a normal session route gated by m37.ipu_admission.create; it ignores its body (including forceFlag) and always passes lcpConfirmed: true, so the ADMISSION_LCP_NOT_CONFIRMED guard is dead.**
- Files: `apps/backend/src/modules/37-ipu/routes/ipu.routes.ts`, `apps/backend/src/modules/37-ipu/routes/service-drizzle.ts`, `apps/backend/src/modules/37-ipu/routes/ipu-typebox.ts`, `apps/backend/src/modules/06-admission/events-by-m6.ts`, `docs/modules/WARDENX_MODULE_37_IPU_SPEC_v0_2.md`
- Done when: Implement the M6<->M37 LCP handshake (M6 emits requires_ipu_bed/activated; M37 consumers drive open/confirm) and restrict the user route, or require an explicit force-flag + coordinator-only permission + seam check for an M6 LCP before lcpConfirmed.
- Verify: Live: confirm without an M6 LCP -> 412; m6.level_of_care.activated consumer transitions to active exactly once.

**GAP-068 — M37 — 11 of 13 section 4.5 M37 consumers are absent (only the two M6 discharge consumers exist).**
- Files: `docs/modules/WARDENX_MODULE_37_IPU_SPEC_v0_2.md`, `apps/backend/src/modules/11-orders/events-by-m11.ts`, `apps/backend/src/modules/30-quality/events-by-m30.ts`, `apps/backend/src/modules/37-ipu/seams.ts`, `packages/inpatient/src/domain/iv-safety/overlay-builder.ts`
- Done when: Add consumers (m11-order-signed/discontinued, m13-administration-recorded, m8-encounter-signed, m30-outbreak-*) under apps/backend/src/modules/37-ipu/consumers/, declare m37 on producers and bind them in index.ts.
- Verify: bun run arch:outbox-bindings; live: m11.order.signed (medication_iv_continuous) for an IPU patient creates an overlay row; grep the factory in index.ts.

**GAP-069 — M38 — No production terminology loader or worker: packages/terminology-loader does not exist, the processors in packages/terminology/src/jobs have no backend caller, and POST /api/v1/admin/terminology/:system/load only registers a version row (ingestion 'pending_loader_worker').**
- Files: `apps/backend/src/modules/38-terminology/routes/admin-terminology-routes.ts`, `packages/terminology/src/jobs/processors.ts`, `apps/backend/src/index.ts`, `scripts/db/seed-terminology.ts`, `docs/modules/WARDENX_MODULE_38_TERMINOLOGY_SPEC_v0_2.md`
- Done when: Build packages/terminology-loader (fetch/stage/diff/write, deprecation mapping, activate/supersede) and a BullMQ worker in apps/backend/src/modules/38-terminology/jobs consuming load_version / tenant_deprecation_scan / refresh_embeddings, wired from index.ts.
- Verify: Live: POST /api/v1/admin/terminology/icd10cm/load with a fixture, run the worker, GET /api/v1/terminology/icd10cm/validate?code=... valid; version 'active'.

**GAP-070 — M39 — Patient-scoped consent read routes (3, 4, 11, 14, 17, 21, 28) are gated by requirePermission only; no requireAbac exists in the module and services receive no actor.**
- Files: `apps/backend/src/modules/39-consent/routes/consent-routes.ts`, `apps/backend/src/modules/39-consent/consent-store-db.ts`, `docs/modules/WARDENX_MODULE_39_CONSENT_SPEC_v0_3.md`, `apps/backend/src/modules/07-care-plan/abac-predicates.ts`
- Done when: Add requireAbac guards (caseload_or_scope with a patientId target adapter, consent_owner_or_compliance, is_consent_drafter, bereavement_window, compliance_officer) to consent-routes.ts; load patient_id for consentId routes (IDOR); log denies to consent_eval_audit.
- Verify: bun run arch:abac-predicates; live: consent.read holder off-caseload gets 403 on GET /api/v1/patients/:id/consents and /api/v1/consents/:id.

**GAP-071 — M39 — The production ConsentEvaluator never applies D13 post-death termination: the Drizzle store backing the seam returns isPatientDeceased = false unconditionally and no m39 consumer for m5.patient.deceased exists.**
- Files: `apps/backend/src/modules/39-consent/consent-store-db.ts`, `apps/backend/src/index.ts`, `packages/consent/src/seams/consent-evaluator.ts`, `apps/backend/src/modules/05-patient/events-by-m5.ts`, `packages/consent/src/lifecycle/death.ts`
- Done when: Implement isPatientDeceased in createDbConsentStore with the existing withOrgContext patient.status read; optionally bind an m39 consumer for m5.patient.deceased using decideDeceasedConsentExpiry and add m39 to the catalog.
- Verify: Live: sign portal_access consent, mark patient deceased, ConsentEvaluator.evaluate -> allowed=false, denyReason 'patient_deceased_consent_terminated'.

**GAP-072 — global — Production deploys run with zero CI: deploy.yml `verify` job is commented out (release needs only debounce) and ci.yml's pull_request trigger only matches `fix/admission`, so neither PRs to main nor main pushes run build/typecheck/arch:fitness/tests before a PHI-bearing image ships.**
- Files: `.github/workflows/deploy.yml`, `.github/workflows/ci.yml`, `CLAUDE.md`
- Done when: Uncomment `verify` in .github/workflows/deploy.yml (needs: debounce, uses ./.github/workflows/ci.yml) and set release.needs: [debounce, verify] gated on verify success; restore ci.yml `pull_request: branches: [main]`. If Actions minutes are the reason, reduce cost with path filters / a smaller PR job set instead of removing the gate. Record the decision in docs/history and fix CLAUDE.md/AGENTS.md.
- Verify: gh run view <next deploy run> --json jobs lists CI matrix jobs before 'Build and publish immutable images'; grep -n 'needs: verify' .github/workflows/deploy.yml matches an uncommented line; a test PR to main triggers ci.yml.

**GAP-073 — global — Production nginx vhosts proxy /api with no access_log/log_format override, so nginx's default combined format persists $request including ?q=<patient name|MRN> from patient search, the exact PHI that logger.ts strips from Pino and names as a downstream risk.**
- Files: `apps/backend/src/bootstrap/plugins/logger.ts`, `deploy/production/nginx/wardenx-frontend.conf`, `deploy/production/nginx/wardenx-backend.conf`, `apps/web/src/modules/05-patient/global-search.tsx`
- Done when: Define a path-only log_format ($uri) for /api/ locations in both vhosts (or access_log off for /api/); better, move search needles into a POST body.
- Verify: On the VPS: curl 'https://<api>/api/v1/patients?q=TESTNEEDLE' then grep TESTNEEDLE /var/log/nginx/*.log returns nothing; nginx -T | grep log_format.

### P2

**GAP-074 — M02 — Several M2 spec routes have no handler (GET/DELETE /api/v1/auth/sessions, POST /api/v1/auth/screen-unlock, GET /api/v1/me/session, POST /api/v1/funeral/invite, orgs CRUD, step-up overrides); several implemented routes (device attestation, auth/context, invitations resend, elevated approvals) are absent from the spec inventory.**
- Files: `docs/modules/WARDENX_MODULE_02_IDENTITY_SPEC_v0_4.md`
- Done when: Implement the missing handlers in apps/backend/src/modules/02-identity/routes or record explicit deferrals and update the spec inventory, including extras.
- Verify: identity-routes.test.ts per route; bun run openapi:coverage --check.

**GAP-075 — M02 — Email/password sign-up is open instead of invite-gated: Better Auth has no disableSignUp or hooks, the mount bridge forwards every /api/auth/* path, the credential throttle covers sign-in only, and the web accept-invitation page calls signUp.email without a token.**
- Files: `packages/auth/src/identity/auth.ts`, `packages/auth/src/identity/mount.ts`, `packages/auth/src/identity/credential-throttle.ts`, `apps/web/src/modules/02-identity/accept-invitation.tsx`, `docs/modules/WARDENX_MODULE_02_IDENTITY_SPEC_v0_4.md`
- Done when: Set disableSignUp (also for magicLink) and create the account server-side inside POST /api/v1/invitations/accept after token validation, or gate /api/auth/sign-up/* on a valid invitation in the mount bridge.
- Verify: Live: POST /api/auth/sign-up/email without an invitation token -> 403/404.

**GAP-076 — M03 — No live suite exercises the break-glass branch end to end (requireAbac deny -> durable grant -> critical audit row under wardenx_app); the audit insert is covered only in memory, and a regression would 500 every emergency access.**
- Files: `apps/backend/__tests__/ac-01-break-glass-cosign.live.test.ts`, `apps/backend/src/modules/03-authorization/contract.ts`, `packages/auth/src/abac/require-abac.ts`
- Done when: Extend ac-01 (or add a suite + package.json script + ci.yml row) to invoke break-glass, run a denying guard and assert access allowed + m3.breakglass.access critical audit row as wardenx_app.
- Verify: bun run test:m3:break-glass:live; bun run arch:live-suites.

**GAP-077 — M05 — Amendment decide only flips status: no pending guard (can be re-decided), requested_changes always {} (documented interim), accepted changes not applied, unknown id -> 500; GET /patients/:id/amendments and POST /amendments/:id/statement are absent.**
- Files: `apps/backend/src/modules/05-patient/patient-route-service-db.ts`, `apps/backend/src/modules/05-patient/routes/patient-routes.ts`, `docs/modules/WARDENX_MODULE_05_PATIENT_SPEC_v0_4.md`
- Done when: Guard status='pending' (409), use NotFoundError, carry requested_changes in the submit body and apply via PatientMutator on accept; add the list and statement routes.
- Verify: patient-routes.test.ts: second decide -> 409; unknown id -> 404.

**GAP-078 — M05 — Census list does not exclude merged patients and GET /patients/:id does not follow merged_into_id; clinicians can open and document on a merged-away chart.**
- Files: `apps/backend/src/modules/05-patient/patient-route-service-db.ts`, `docs/modules/WARDENX_MODULE_05_PATIENT_SPEC_v0_4.md`
- Done when: Default the list filter to status <> 'merged'; return the canonical row or a redirect body from getPatient.
- Verify: Extend m5-patient-merge.live.test.ts: source absent from GET /patients; GET /patients/:source returns target/redirect.

**GAP-079 — M05 — POST /api/v1/patients has no location_scope guard and no module registers a location_scope predicate (catalog declares it; declaration only).**
- Files: `apps/backend/src/modules/05-patient/routes/patient-routes.ts`, `packages/auth/src/permissions/contributed.ts`, `docs/modules/WARDENX_MODULE_05_PATIENT_SPEC_v0_4.md`
- Done when: Register a location_scope predicate (or change the declaration) and compose requireAbac('patient.create','location_scope').
- Verify: bun run arch:abac-predicates; unit test: creator outside the target location -> 403.

**GAP-080 — M05 — Admit persists only the patient row + MRN/MBI; SSN (encrypted), aliases, address, phone, email are follow-ups, so deterministic matcher keys (SSN+DOB+name, DOB+name+address) are never available.**
- Files: `apps/backend/src/modules/05-patient/patient-route-service-db.ts`, `docs/modules/WARDENX_MODULE_05_PATIENT_SPEC_v0_4.md`
- Done when: Persist satellite rows in the admit tx (SSN via the KEK/DEK envelope into patient_identifier.value_encrypted).
- Verify: Live: admit with SSN + address creates encrypted patient_identifier(kind=ssn) and patient_address rows.

**GAP-081 — M05 — PatientCaregiverReader has only the M1 deny-stub (no caregiver->user schema link exists), so the portal family_caregiver attestation path always denies; only DPOA/patient_self can attest.**
- Files: `apps/backend/src/bootstrap/seams/providers.ts`, `packages/types/src/patient.ts`, `packages/db/src/schema/patient/caregivers.ts`, `apps/backend/src/modules/31-portal/abac-predicates.ts`, `apps/backend/src/modules/31-portal/seams/registration.ts`
- Done when: Add a caregiver.user_id (or portal_account.caregiver_id) link via migration, then implement and register PatientCaregiverReader in apps/backend/src/modules/05-patient/seams/index.ts; fix the M31 header.
- Verify: Unit + live: primary family_caregiver grant passes portal_caregiver_is_primary_or_dpoa; non-primary denied.

**GAP-082 — M06 — 3 of 15 M06 owned tables (referral_activity, referral_note, admission_evidence) have no live cross-tenant RLS test; they once shipped ENABLE without FORCE (fixed in 0233).**
- Files: `audit/implementation-status/IMPLEMENTATION_STATUS.md`, `packages/db/migrations/0233_rls_force_and_hope_result_event_rls.sql`, `packages/db/migrations/__tests__/rls-isolation.live.test.ts`
- Done when: Add cross-tenant cases for the three tables to an M6 live suite using _live-app-role.ts.
- Verify: bun run status:matrix shows M06 Live 15/15; new suite passes in CI.

**GAP-083 — M06 — cti.is_attending / is_hospice_md compare context.userId with M40 physician ids, which can never match, so the role escape (md/hospice_physician) is the live path and any such user can sign any CTI's attending certification (42 CFR 418.22(c)).**
- Files: `apps/backend/src/modules/06-admission/abac-predicates.ts`, `docs/modules/WARDENX_MODULE_06_ADMISSION_ELECTION_CERTIFICATION_SPEC_v0_4.md`
- Done when: Add a membership-to-M40-physician link and compare against it; narrow the role escape to the attending of record.
- Verify: Unit/live: md user who is not the CTI attending gets 403 on POST /cti/:id/sign-attending.

**GAP-084 — M07 — Three implemented, gated read routes (GET /care-plans/:planId/readiness, /versions/:versionId/proposed-changes, /review-status) are not in the M07 spec section 4.1 inventory (19 rows vs 22 registrations).**
- Files: `apps/backend/src/modules/07-care-plan/routes/care-plan-routes.ts`, `docs/modules/WARDENX_MODULE_07_CARE_PLAN_SPEC_v0_3.md`
- Done when: Add the three GETs to M07 spec section 4.1.
- Verify: Spec section 4.1 row count equals 22 registrations.

**GAP-085 — M08 — m8.cosigner_role_match and the M9 cosigner predicate compare a membership-id fact with context.userId (Better Auth id), so 'cosigner must not be the author' never denies.**
- Files: `apps/backend/src/modules/08-encounters/abac-predicates.ts`, `apps/backend/src/modules/08-encounters/encounters-route-service-db.ts`, `apps/backend/src/bootstrap/plugins/authenticate.ts`, `apps/backend/src/modules/09-assessments/abac-predicates.ts`, `apps/backend/src/modules/09-assessments/assessments-route-service-db.ts`, `apps/backend/src/modules/10-hope/abac-predicates.ts`
- Done when: Compare against context.attributes.membershipId in both predicates (M10 membershipIdOf pattern), failing closed when null.
- Verify: Unit test with distinct user/membership ids: author RN denied on /cosignature/acknowledge, /cosignature/sign and POST /assessments/:id/cosignatures.

**GAP-086 — M08 — Supervisor release stores the routed cosigner, not the releasing supervisor, as supervisor_released_by, and emits no outbox event for the release.**
- Files: `apps/backend/src/modules/08-encounters/encounters-route-service-db.ts`, `apps/backend/src/modules/08-encounters/routes/encounters-routes.ts`
- Done when: Pass the actor's membershipId into supervisorRelease and store it; emit the catalogued release event.
- Verify: Live: supervisor_released_by equals the releasing supervisor's membership id.

**GAP-087 — M08 — Layer-3 sign-gate checks for required HOPE items (check 4) and Layer-2 decisions (check 7) are documented deferrals; a HOPE-timepoint visit note can be signed without the HOPE items.**
- Files: `apps/backend/src/modules/08-encounters/gate/checks.ts`, `apps/backend/src/modules/08-encounters/routes/encounters-routes.ts`
- Done when: Add an encounter->HOPE-timepoint link and evaluate check 4 in gate/gate.ts; track Layer 2 under #123.
- Verify: Gate unit test: HOPE-timepoint encounter missing items fails sign with COMPLIANCE_GATE_FAILED.

**GAP-088 — M10 — hope_submission_result_event (CMS iQIES results for named patients) has no live RLS test of cross-tenant isolation or its append-only grant.**
- Files: `audit/implementation-status/IMPLEMENTATION_STATUS.md`, `packages/db/migrations/0226_hope_phase_7_manual_iqies_submission.sql`, `packages/db/migrations/0233_rls_force_and_hope_result_event_rls.sql`
- Done when: Add a live case: org-B session cannot read org-A result event; UPDATE/DELETE refused.
- Verify: bun run status:matrix shows M10 Live 12/12.

**GAP-089 — M10 — Spec mandates automated iQIES submit/reconcile workers; implementation ships a manual package/upload/import flow (9 extra routes) with the workers unscheduled.**
- Files: `docs/modules/WARDENX_MODULE_10_HOPE_ENGINE_SPEC_v0_2.md`, `apps/backend/src/modules/10-hope/jobs/cron-workers.ts`, `packages/db/migrations/0226_hope_phase_7_manual_iqies_submission.sql`
- Done when: Write an ADR for the manual iQIES transport and update M10 spec sections 1, 4.1 (9 routes), 4.2/4.8.
- Verify: bun run arch:module-docs; every hope-routes.ts route appears in spec 4.1.

**GAP-090 — M10 — POST /hope/submissions/:id/retry only flips rejected -> queued and emits submission_queued; no worker processes 'queued' batches in the manual flow, so the retried batch is orphaned (operators can recover by re-running assemble).**
- Files: `apps/backend/src/modules/10-hope/hope-route-service-db.ts`, `apps/backend/src/modules/10-hope/routes/hope-routes.ts`, `apps/backend/src/modules/10-hope/jobs/cron-workers.ts`, `docs/modules/WARDENX_MODULE_10_HOPE_ENGINE_SPEC_v0_2.md`
- Done when: Make retrySubmission re-validate and re-package into a new packaged batch, or remove the route and document that assemble supersedes it.
- Verify: Route test: retry on a rejected submission yields a packaged batch with the rejected items, or a documented 4xx.

**GAP-091 — M11 — PATCH /orders/:id lets any orders.draft holder edit another clinician's draft (no author/supervisor check); indicationText is accepted by the schema but silently dropped.**
- Files: `apps/backend/src/modules/11-orders/routes/orders-routes.ts`, `apps/backend/src/modules/11-orders/orders-route-service-db.ts`, `apps/backend/src/modules/11-orders/routes/orders-typebox.ts`, `docs/modules/WARDENX_MODULE_11_ORDERS_SPEC_v0_4.md`
- Done when: Refuse in editDraft unless actor.membershipId === drafter_membership_id or the actor is a supervisor; persist indicationText or remove it from the schema.
- Verify: m11-orders-write live: RN B PATCHes RN A's draft -> 403.

**GAP-092 — M11 — The M11 HOPE J2051 trigger consumer exists only as an unbound decider (documented handler-unbound exception); spec D7 order suggestion from m10.hope.j2051_trigger_fired is not fed.**
- Files: `scripts/outbox-subscription-exceptions.ts`, `apps/backend/src/modules/11-orders/consumers/hope-trigger.ts`
- Done when: Bind decideHopeTrigger in consumers/bindings.ts, declare m11 on the M10 event, remove the exception and confirm index.ts reaches the factory.
- Verify: bun run arch:outbox-bindings; live publish of m10.hope.j2051_trigger_fired shows the M11 suggestion.

**GAP-093 — M12 — Prescriber enrollment and both policy PATCH routes lack step-up although the spec and permission catalog require it; enrollment sets deaAuthorizedSchedules used by dea_schedule_authorized.**
- Files: `apps/backend/src/modules/12-dosespot/routes/dosespot-routes.ts`, `packages/auth/src/permissions/contributed.ts`, `docs/modules/WARDENX_MODULE_12_DOSESPOT_PRESCRIBING_SPEC_v0_2.md`
- Done when: Add requireStepUp('dosespot_prescriber.enroll') and requireStepUp('prescribing_policy.update') to the three routes.
- Verify: Route test: without fresh step-up the three routes return 403/412.

**GAP-094 — M12 — EPCS controlled signing is a stub: deaScheduleAuthorized/prescriberIal2Verified hardcoded true, nonce is the order id, no TOTP verified, epcs_signing_attempt never written.**
- Files: `apps/backend/src/modules/12-dosespot/dosespot-route-service-db.ts`, `docs/modules/WARDENX_MODULE_12_DOSESPOT_PRESCRIBING_SPEC_v0_2.md`
- Done when: Implement epcs_signing_attempt rows, TOTP verification and DEA/IAL2 reads from dosespot_prescriber; add a hard throw independent of the certification constant until then.
- Verify: Unit/live with certification forced on: complete without valid TOTP -> 401/422 and an epcs_signing_attempt row.

**GAP-095 — M12 — Spec ERD tables medication_order_discontinuation and rx_benefit_cache are absent from migrations and the manifest; discontinuation is only a status on medication_order.**
- Files: `packages/db/migrations/0038_dosespot_m12_tables.sql`, `docs/modules/WARDENX_MODULE_12_DOSESPOT_PRESCRIBING_SPEC_v0_2.md`, `architecture/module-manifest.ts`
- Done when: Add the tables (migration, schema, manifest, RLS suite) or amend the spec to record the simpler model/deferral.
- Verify: bun run arch:tables; bun run arch:module-docs.

**GAP-096 — M13 — M13 subscribes to m9.prn_reassessment_overdue, which M9 never catalogues or emits (documented no-such-event exception); PRN follow-up never fires.**
- Files: `apps/backend/src/modules/13-emar/consumers/index.ts`, `scripts/outbox-subscription-exceptions.ts`
- Done when: Catalogue and emit the M9 event (or run an M13 overdue sweep over prn_administration), then bind the consumer.
- Verify: bun run arch:outbox-bindings; live: overdue PRN produces the M13 follow-up.

**GAP-097 — M13 — The patient eMAR empty state and header still say the scheduled-dose materializer 'is not yet wired', but F-166 bound it; clinicians get wrong guidance on a medication-safety path.**
- Files: `apps/web/src/modules/13-emar/patient-emar.tsx`, `apps/backend/src/index.ts`
- Done when: Update the empty-state copy and comments; reassess whether the Administer panel should still be order-driven.
- Verify: grep -n 'not yet wired' apps/web/src/modules/13-emar returns nothing; DOM test asserts new text.

**GAP-098 — M15 — The discipline-plan list fetches limit+1 rows then post-filters by caseload and computes has_more from the filtered set, so pagination ends early and off-caseload rows hide reachable plans (F-096 anti-pattern).**
- Files: `apps/backend/src/modules/15-discipline-care-plans/routes/read-service-drizzle.ts`, `apps/backend/src/modules/15-discipline-care-plans/routes/concurrency.ts`, `docs/history/gates-authz-and-routes.md`
- Done when: Compute has_more/cursor from raw rows, or narrow in SQL with patient_id = ANY(caseloadPatientIds) unless hasOrgWideScope.
- Verify: Live: 3 visible plans after 10 off-caseload, limit=5, paging returns all 3.

**GAP-099 — M17 — GET /api/v1/metrics/visits ignores its window and returns onTimeRate: 1; route-efficiency returns zeros for every membership.**
- Files: `apps/backend/src/modules/17-scheduling/scheduling-route-service-db.ts`, `apps/backend/src/modules/17-scheduling/jobs/index.ts`, `docs/modules/WARDENX_MODULE_17_SCHEDULING_SPEC_v0_2.md`
- Done when: Compute onTimeRate from actual vs scheduled start within [from,to]; compute route efficiency from route_segment or return 501/null with an 'unavailable' flag.
- Verify: Unit/live: seeded late visits give onTimeRate < 1; window changes counts.

**GAP-100 — M17 — Portal upcoming-visit (M17) and EVV arrival (M18) routes take patient/visit ids from the request and check only an RBAC key, with no M39 family_caregiver_access consent scope; M18 staff reads bind only evv.read with no caseload.**
- Files: `apps/backend/src/modules/17-scheduling/routes/scheduling-routes.ts`, `apps/backend/src/modules/17-scheduling/scheduling-route-service-db.ts`, `apps/backend/src/modules/18-evv/routes/evv-routes.ts`, `apps/backend/src/modules/18-evv/evv-route-service-db.ts`, `docs/modules/WARDENX_MODULE_17_SCHEDULING_SPEC_v0_2.md`, `docs/modules/WARDENX_MODULE_18_EVV_SPEC_v0_2.md`
- Done when: Bind requireAbac with the portal consent predicate (M19 portal_session_consent_active pattern) using the session patient; resolve visitId->patientId for arrival.
- Verify: Inject test: portal session for patient A requesting B's visits/arrival -> 403/404.

**GAP-101 — M19 — GET /triage-calls binds caseload_or_scope but the predicate allows collection reads and listTriageCalls applies no narrowing, so every triage.read holder sees all org triage calls.**
- Files: `apps/backend/src/modules/19-oncall/routes/triage-calls.routes.ts`, `apps/backend/src/modules/19-oncall/routes/read-service-drizzle.ts`, `apps/backend/src/modules/07-care-plan/abac-predicates.ts`, `docs/modules/WARDENX_MODULE_19_ONCALL_TRIAGE_SPEC_v0_3.md`
- Done when: Narrow for callers without org-wide scope (own/escalated calls or caseload/on-call PE), or amend the spec to make triage.read org-wide.
- Verify: Inject/live: non-on-call RN without org scope sees only their own calls.

**GAP-102 — M21 — Four implemented M21 routes (perpetual-log, assign-retriever, declare-unreturnable, caregiver-signature) are absent from spec section 4.1 (the /api/v1/supplies prefix is already documented at line 2079).**
- Files: `apps/backend/src/modules/21-supplies/routes/comfort-kits.routes.ts`, `apps/backend/src/modules/21-supplies/routes/supply-requests.routes.ts`, `docs/modules/WARDENX_MODULE_21_SUPPLIES_DME_COMFORT_KITS_SPEC_v0_2.md`
- Done when: Add the four routes to spec section 4.1.
- Verify: Diff spec table vs route extraction.

**GAP-103 — M22 — Spec routes POST /api/v1/documents and POST /documents/:id/versions are permanent 503 DegradedError stubs; the working /api/v1/document-uploads flow and other extra routes are not in spec section 4.1; header comment contradicts itself.**
- Files: `apps/backend/src/modules/22-documents/documents-route-service-db.ts`, `apps/backend/src/modules/22-documents/index.ts`, `docs/modules/WARDENX_MODULE_22_DOCUMENTS_SPEC_v0_5.md`
- Done when: Remove or 410/308-redirect the legacy routes or document the verified-upload flow and extras in spec section 4.1; fix the header.
- Verify: Diff spec 4.1 against route extraction; curl POST /api/v1/documents on Docker returns the documented behaviour.

**GAP-104 — M23 — Four spec'd M23 routes are missing: GET /api/v1/billing/validation-overrides, POST /billing/mac-credentials/:id:test, POST /admin/billing/platform-rules, POST /admin/billing/wage-index:load (partly superseded by F-211, spec not updated).**
- Files: `docs/modules/WARDENX_MODULE_23_BILLING_MEDICARE_SPEC_v0_2.md`, `apps/backend/src/modules/24-billing-medicaid/routes/claims.routes.ts`
- Done when: Implement the override list and MAC credential test routes; implement or amend the platform admin routes in spec section 4.1.
- Verify: Re-run route extraction vs spec 4.1; bun run arch:openapi-coverage.

**GAP-105 — M23 — POST /api/v1/billing/mac-credentials always returns 503 because secretCipher defaults to denyCipher and production passes none; per-tenant submitter credentials can never be stored (launch gateway uses env tokens).**
- Files: `apps/backend/src/modules/23-billing-medicare/routes/write-service-drizzle.ts`, `apps/backend/src/index.ts`, `docs/modules/WARDENX_MODULE_23_BILLING_MEDICARE_SPEC_v0_2.md`
- Done when: Bind a tenant-DEK SecretCipherPort (M24 credential-crypto pattern) into the write-service construction.
- Verify: Docker: POST /api/v1/billing/mac-credentials with step-up -> 200 and an encrypted row.

**GAP-106 — M23 — Internal routes /api/v1/internal/billing/claim-day-projection and /submissions are permanent 503 deny-stubs (no internalSeam passed) yet advertised in the typed client; consumers use the in-process seam.**
- Files: `apps/backend/src/modules/23-billing-medicare/routes/internal.routes.ts`, `apps/backend/src/modules/23-billing-medicare/routes/mount.ts`, `packages/ui/src/core/api/schema.ts`
- Done when: Bind a Drizzle M23InternalSeamProvider or remove the routes and amend spec section 4.1 #39/#40.
- Verify: GET /api/v1/internal/billing/submissions with a system principal -> 200.

**GAP-107 — M23 — M23 still treats m26.cap.projection_updated (and m8.encounter.signed) as deny-stub/handler-unbound 'until M26 lands' although M26 emits it; M26's catalog lists no m23 consumer.**
- Files: `apps/backend/src/modules/23-billing-medicare/consumers/subscription-map.ts`, `apps/backend/src/modules/23-billing-medicare/consumers/index.ts`, `scripts/outbox-subscription-exceptions.ts`, `apps/backend/src/modules/26-cap/events-by-m26.ts`, `apps/backend/src/modules/23-billing-medicare/outbox-consumers/m23-revalidate-triggers.ts`
- Done when: Decide whether M23 consumes these events, then bind live consumers (or seam pull), update catalogs and remove the exceptions/stale comments.
- Verify: bun run arch:outbox-bindings with exceptions removed + a live real-publisher test.

**GAP-108 — M24 — medicaid-ack-pull cron and medicaid-claim.submit.retry queue are declared names only; batch-file state channels cannot ingest acks and portal failures have no retry queue (Oregon uses sync/poll).**
- Files: `apps/backend/src/modules/24-billing-medicaid/jobs/queues.ts`, `apps/backend/src/modules/24-billing-medicaid/jobs/submission-jobs.ts`, `docs/modules/WARDENX_MODULE_24_BILLING_MEDICAID_SPEC_v0_2_1.md`
- Done when: Implement the ack-pull cron and submit.retry worker or amend spec section 4.9.
- Verify: Unit test of the ack-pull processor; grep index.ts for the registration.

**GAP-109 — M24 — M24_LAUNCH_GATEWAY_ENABLED is opt-in (default off, workers silently not constructed) contrary to env.ts's opt-out integration-switch policy, and it and M25_X12_WORKER_URL/TOKEN plus ~14 other code-read vars are undocumented in any template or doc.**
- Files: `packages/medicaid-adapters/src/oregon/launch-gateway.ts`, `apps/backend/src/index.ts`, `apps/backend/src/bootstrap/env.ts`, `apps/backend/src/modules/25-remittance/ingest/x12-worker-transport.ts`
- Done when: Add M24_LAUNCH_GATEWAY_ENABLED to env.ts INTEGRATION_SWITCHES (opt-out, requiring M24_CREDENTIAL_ENCRYPTION_KEY) or document it as opt-in; document it, M25_X12_WORKER_* and other knobs in .env.example and the production template.
- Verify: grep -n M24_LAUNCH_GATEWAY_ENABLED .env.example apps/backend/src/bootstrap/env.ts; env test for production without the switch.

**GAP-110 — M25 — Appeal-deadline cron only alerts at T-30/14/7/1: no T-0 alert and no T-7 next-tier auto-spawn per spec 4.8 (spec itself is inconsistent).**
- Files: `apps/backend/src/modules/25-remittance/jobs/m25-jobs.ts`, `apps/backend/src/modules/25-remittance/domain/deadline.ts`, `docs/modules/WARDENX_MODULE_25_REMITTANCE_SPEC_v0_2.md`
- Done when: Decide the rule; implement T-0 + T-7 auto-spawn or amend spec line 1424.
- Verify: Unit test runAppealDeadlineWatch at remaining=0 and 7.

**GAP-111 — M26 — Every cap period is created with sentinel CCN '000000'; no M40 CCN resolution and no PS&R CCN validation, so multi-CCN tenants cannot hold per-CCN periods.**
- Files: `apps/backend/src/modules/26-cap/routes/write-service-drizzle.ts`, `apps/backend/src/modules/26-cap/consumers/drizzle-store.ts`, `docs/modules/WARDENX_MODULE_26_CAP_MANAGEMENT_SPEC_v0_3.md`
- Done when: Resolve CCN via the M40 provider-entity seam at period open and validate the PS&R file's CCN, rejecting on mismatch/unbound.
- Verify: Live: two CCNs open two periods for one cap year; wrong-CCN PS&R import -> 4xx.

**GAP-112 — M26 — CapSettlementProvider (and Inpatient/Metrics/AlertSubscriber providers) are built but never registered; M33 Cap Watch's consumer bundle is never bound; aggregateForCostReport takes .limit(1) per cap year (multi-CCN under-aggregation); listSubscribers returns [].**
- Files: `apps/backend/src/modules/26-cap/wiring.ts`, `apps/backend/src/modules/26-cap/seam-impls.ts`, `docs/modules/WARDENX_MODULE_26_CAP_MANAGEMENT_SPEC_v0_3.md`, `packages/reporting/src/seam-registration.ts`
- Done when: Register CapSettlementProvider and consume it from M27's per-beneficiary attachment; sum all cap_period rows per cap year; wire or delete the dead M33 Cap Watch bundle.
- Verify: bun run test:m26 live asserting getSeam('CapSettlementProvider') is live; multi-period fixture in m26-cost-report-cap-seam.live.test.ts.

**GAP-113 — M27 — Xero trial-balance pull, Gusto wage pull and statistics refresh workers are unbound (no OAuth storage), so jobs fail with M27WorkerPortUnbound; only manual imports work.**
- Files: `apps/backend/src/modules/27-cost-report/jobs/m27-jobs.ts`, `apps/backend/src/index.ts`
- Done when: Bind statisticsSeams.serviceMonthlyBreakdown to LevelOfCarePeriodReader now; bind Xero/Gusto when tenant OAuth storage lands.
- Verify: m27-cost-report-workflow-slice.live.test.ts with statistics-refresh populating statistic_data.

**GAP-114 — M27 — submit and submit-past-deadline behave identically: submit delegates with reason '', the required reason is discarded, no deadline check runs in the service and no warn-severity audit is produced (only the validation rule gates deadlines).**
- Files: `apps/backend/src/modules/27-cost-report/routes/write-service-drizzle.ts`, `apps/backend/src/modules/27-cost-report/routes/cost-reports.routes.ts`, `apps/backend/src/modules/27-cost-report/jobs/validation-context-builder.ts`, `packages/cost-report/src/validation/default-rules.ts`
- Done when: In submit refuse with 409 past current_effective_deadline_date; in submitPastDeadline persist the reason and emit the warn-severity audit.
- Verify: Live: plain submit past deadline -> 409; submit-past-deadline succeeds with reason in audit.

**GAP-115 — M27 — W-CR-12 (close open cost reports on provider-entity offboarding) cannot bind because M40 emits no such event; the m25.denial.opened denial-accrual handler is unbound (documented exceptions).**
- Files: `scripts/outbox-subscription-exceptions.ts`, `docs/modules/WARDENX_MODULE_27_COST_REPORT_SPEC_v0_2.md`
- Done when: Have M40 emit an offboarded/deactivated event and bind a closing consumer; bind or remove the denial-accrual handler.
- Verify: bun run arch:outbox-bindings; live offboarding closes cost_report.

**GAP-116 — M28 — M28's LabObservationReader view expects loadById(org, id) but M29 publishes getById/listByPatient/getByObservationId with a different DTO; an `as unknown as` cast hides it, so wiring DiagnosticReport would throw 'loadById is not a function'.**
- Files: `packages/fhir/src/r4/mappers/deps.ts`, `packages/fhir/src/r4/mappers/diagnostic-report/projector.ts`, `apps/backend/src/modules/29-external-interfaces/seams/published.ts`, `apps/backend/src/modules/28-fhir/seams/consumed.ts`
- Done when: Retype the @wardenx/fhir reader to M29's contract or add an adapter in consumed.ts; remove the cast and stale comment; add the per-value SUD flag if missing.
- Verify: Unit test registering the real reader and calling getFhirLabObservationReader().loadById; bun run typecheck.

**GAP-117 — M28 — Per-client tier rate limits (100/10/1 RPS, 429 + Retry-After) and the one-concurrent-export cap are not enforced; fhirRateLimitDecision exists but is unused.**
- Files: `packages/fhir/src/rate-limit/sliding-window.ts`
- Done when: Add a preHandler on /fhir/r4/* evaluating fhirRateLimitDecision against a Valkey counter; refuse a second $export per client with 429.
- Verify: Route test: tier-3 client above 1 RPS -> 429 Retry-After; concurrent $export -> 429.

**GAP-118 — M28 — FHIR client co-approval only requires a different fhir.client.admin holder; two org admins can activate a PHI egress client without a Compliance Officer.**
- Files: `apps/backend/src/modules/28-fhir/routes/admin-clients.routes.ts`, `apps/backend/src/modules/28-fhir/routes/store-drizzle.ts`
- Done when: Require compliance_officer (or a fhir.client.approve key granted only to it) on R25 or check the approver's role in approveClient.
- Verify: Live: second org_admin (not compliance) approves -> 403.

**GAP-119 — M28 — None of the 11 M28 admin screens (client registry, onboarding wizard, bulk export, inbound proposal queues, disclosure accounting, etc.) exist; inbound FHIR proposals are API-only.**
- Files: `audit/implementation-status/IMPLEMENTATION_STATUS.md`, `architecture/module-manifest.ts`, `docs/modules/WARDENX_MODULE_28_FHIR_GATEWAY_SPEC_v0_4.md`
- Done when: Add an apps/web 28-fhir module with screens.ts for the section 5.1 screens; add codePaths to both manifests.
- Verify: bun run ui:parity; status matrix Screens column turns green.

**GAP-120 — M29 — No M29 operator/clinician screens (feeds, create-feed wizard, proposal detail, unmatched lab queue, NPPES history); ADT review and unmatched-lab review are API-only.**
- Files: `audit/implementation-status/IMPLEMENTATION_STATUS.md`, `architecture/module-manifest.ts`, `docs/modules/WARDENX_MODULE_29_EXTERNAL_INTERFACES_SPEC_v0_4.md`
- Done when: Add apps/web/src/modules/29-external-interfaces with screens.ts, update both manifests and main.tsx.
- Verify: bun run ui:parity && bun run status:matrix --check.

**GAP-121 — M29 — POST /messages/inbound/:messageId/decrypt is a permanent 501 citing an unbound per-tenant DEK, which is stale (dekForOrg resolves and M29 outbound already decrypts per org).**
- Files: `apps/backend/src/modules/29-external-interfaces/routes/message.routes.ts`, `apps/backend/src/modules/29-external-interfaces/routes/store.ts`, `apps/backend/src/modules/27-cost-report/jobs/m27-jobs.ts`, `apps/backend/src/modules/29-external-interfaces/outbound/dispatch-worker.ts`
- Done when: Implement decrypt with getTenantKeyProvider().dekForOrg once raw payloads are envelope-encrypted and emit the M4 disclosure event.
- Verify: Route/live: decrypt a seeded inbound message -> plaintext + disclosure audit row.

**GAP-122 — M30 — R-48 GET /v1/quality/sra/cycles/:cycle_id/export (NIST 800-66r2 export) is intentionally not registered; no m30 render_requested event exists.**
- Files: `apps/backend/src/modules/30-quality/routes/sra.routes.ts`, `docs/modules/WARDENX_MODULE_30_HQRP_QUALITY_SPEC_v0_5.md`
- Done when: Add the export route service emitting a catalogued m30.sra.render_requested to M22.
- Verify: Route test returns 202/document ref; bun run arch:outbox-bindings.

**GAP-123 — M30 — HCI indicators 5-7 are declared structurally unavailable, so the HCI composite is permanently withheld (documented, F-042).**
- Files: `packages/quality/src/measures/hci/availability.ts`, `packages/quality/src/measures/hci/index.ts`
- Done when: Ingest CMS-published values or a claims feed for 5-7, and update the spec on externally sourced indicators.
- Verify: Unit test resolveHciCompositeInput computes once 5-7 have sourced values.

**GAP-124 — M30 — MetricsProvider is registered by M33 but nothing consumes it; M33 has no quality/HQRP MV, its HQRP consumer is a dead deny-stub bundle and MV refresh subscriptions are deferred (nightly only).**
- Files: `apps/backend/src/modules/33-reporting/wiring.ts`, `packages/reporting/src/refresh/outbox-subscriber.ts`, `apps/backend/src/index.ts`
- Done when: Add an M33 quality base/MV over quality_measure_value with a live m30.measure.value_emitted binding, or embed MetricsProvider in M30's measure screen; remove the dead bundle.
- Verify: Live: recompute writes quality_measure_value, then the HQRP tile returns isForwardSeamDenyStub:false.

**GAP-125 — M30 — comfort_kit_deployment_to_admin_minutes is active from FY2025 but has no input resolver, so the nightly recompute enqueues a job per provider entity that always throws M30WorkerPortUnbound into the DLQ.**
- Files: `packages/quality/src/measures/registry.ts`, `apps/backend/src/modules/30-quality/jobs/m30-jobs.ts`
- Done when: Bind the measure to M13 + M21 data or declare it unavailable (HCI_UNAVAILABLE pattern) so it writes a suppressed row.
- Verify: Unit test: resolveInput returns an input or declared-unavailable result.

**GAP-126 — M30 — M30 compliance backends (SRA, CAHPS, risk register, infection/outbreaks, mortality) have no UI; web registers only quality.hub and quality.qapi-incidents.**
- Files: `apps/backend/src/modules/30-quality/routes/sra.routes.ts`, `audit/ui-parity/UI_PARITY.md`
- Done when: Add M30 screens in apps/web/src/modules/30-quality/screens.ts for SRA, CAHPS, risk register, infection log and mortality review.
- Verify: grep the five quality sub-paths in apps/web/src; ui:parity lists the new screens.

**GAP-127 — M31 — GET /api/v1/admin/portal-accounts/:id/audit-views (164.528 disclosure accounting) always returns {items: []}, which reads as 'no disclosures' rather than unavailable.**
- Files: `apps/backend/src/modules/31-portal/routes/admin.routes.ts`, `docs/modules/WARDENX_MODULE_31_PORTAL_TELEHEALTH_SPEC_v0_2.md`
- Done when: Bind the M4 disclosure-trail read seam, or return 501/503 until bound.
- Verify: Route test: after a portal PHI read, audit-views returns >= 1 item.

**GAP-128 — M31 — Spec defines 15 portal/telehealth tables; implementation owns 3 (no invitation, recording, consent-capture or webhook-event persistence) and the spec was never amended.**
- Files: `docs/modules/WARDENX_MODULE_31_PORTAL_TELEHEALTH_SPEC_v0_2.md`, `architecture/module-manifest.ts`, `apps/backend/src/modules/31-portal/lifecycle/invitation.ts`
- Done when: Amend the spec via ADR to the three-table model naming owners, or add the tables (manifest .ts/.cjs, migrations, RLS, audit triggers).
- Verify: bun run arch:manifest-mirror && bun run arch:module-docs.

**GAP-129 — M31 — The staff-facing portal admin pane (spec 5.3: accounts, invitations, telehealth visits, audit views, disclosure accounting) is not implemented in any app.**
- Files: `docs/modules/WARDENX_MODULE_31_PORTAL_TELEHEALTH_SPEC_v0_2.md`, `audit/implementation-status/IMPLEMENTATION_STATUS.md`
- Done when: Add an apps/web/src/modules/31-portal staff slice registering the 5.3 screens; add the codePath to both manifests.
- Verify: bun run ui:parity && bun run status:matrix --check.

**GAP-130 — M31 — M31 spec mandates `lint:portal-dto`, `lint:telehealth-phi-boundary` and a gated `test:security` CI job (and lists them in its sign-off checklist); none exists and no deferral is recorded.**
- Files: `docs/modules/WARDENX_MODULE_31_PORTAL_TELEHEALTH_SPEC_v0_2.md`, `package.json`, `apps/backend/src/modules/31-portal/routes/portal-typebox.ts`
- Done when: Add scripts/check-portal-dto.ts and scripts/check-telehealth-phi-boundary.ts and register them in scripts/run-fitness-gates.ts, or amend the spec to name existing enforcement and record a reasoned deferral.
- Verify: bun run lint:portal-dto && bun run lint:telehealth-phi-boundary, or grep shows the deferral note.

**GAP-131 — M32 — All ten section 4.2 AI inference seams remain deny-stubs because no pipeline is passed; the stated blocker (no per-tenant DEK cipher) is stale since the key-ring TenantKeyProvider binds on a DB boot.**
- Files: `apps/backend/src/index.ts`, `apps/backend/src/modules/32-ai-platform/seams/index.ts`
- Done when: Build the AiInvocationPipeline with a cipher over getTenantKeyProvider() behind the ai.full flag/kill switch/opt-in, or update the comment to the real blocker.
- Verify: Test: with ai.full enabled and opt-in, NarrativeEnhancementProvider writes an ai_invocation row with ciphertext.

**GAP-132 — M33 — Only 3 of 36 platform report MVs exist (33 'registered' placeholders since migration 0061; no later migration creates or activates more), so the spec's day-one HQRP/HOPE/cap/bereavement dashboards are absent.**
- Files: `packages/db/migrations/0061_reporting_seed.sql`, `apps/backend/src/modules/33-reporting/system-dashboard-seeder.ts`, `docs/modules/WARDENX_MODULE_33_REPORTING_SPEC_v0_2.md`
- Done when: Add migrations for the remaining MVs whose upstream tables exist (HOPE window compliance, care-plan review overdue, cap, billing first), flip them active and run scripts/backfill-system-dashboards.ts.
- Verify: SELECT count(*) FROM materialized_view_metadata WHERE status='active' rises; GET /api/v1/reporting/dashboards lists them.

**GAP-133 — M33 — Reporting team/location scope always collapses to 'self' because M2 publishes no SupervisorReader; supervisors cannot see team data (fail-closed, documented).**
- Files: `apps/backend/src/modules/33-reporting/abac-resolver-db.ts`
- Done when: Publish an M2 SupervisorReader (or reuse M5 CaseloadProvider) and call it from buildDrizzleReportingAbacResolver.
- Verify: Route test: supervisor of member X sees X's rows on GET /api/v1/reporting/tiles/:tileKey.

**GAP-134 — M34 — Six spec'd M34 routes are not implemented (platform DSAR list, platform onboarding view/skip, tenant account read, tenant feature-flag read/write); two TypeBox schemas are orphaned.**
- Files: `docs/modules/WARDENX_MODULE_34_SAAS_TENANT_PLATFORM_SPEC_v0_3.md`, `apps/backend/src/modules/34-saas-tenant-platform/routes/typebox.ts`, `audit/AUDIT_M34.md`
- Done when: Implement the routes (step-up on onboarding skip) and enrich them, or amend spec 4.1 via ADR and delete the orphan schemas.
- Verify: Spec-vs-route comparison has 0 spec-only rows; bun run openapi:coverage.

**GAP-135 — M34 — Four M34 routes (support-session events, POST/PATCH baa-register, signup-intents reject) are not in spec 4.1; the BAA-register writes are gated by the same READ guard as the GET with no step-up, unlike every other platform-ops write.**
- Files: `docs/modules/WARDENX_MODULE_34_SAAS_TENANT_PLATFORM_SPEC_v0_3.md`, `apps/backend/src/modules/34-saas-tenant-platform/routes/platform/support-sessions.ts`, `apps/backend/src/modules/34-saas-tenant-platform/routes/platform/baa-register.ts`, `apps/backend/src/modules/34-saas-tenant-platform/routes/platform/signup-intents.ts`
- Done when: Document the four routes in spec 4.1 with permission/ABAC/step-up and decide the BAA-register write guard.
- Verify: Spec-vs-route comparison has 0 impl-only rows.

**GAP-136 — M36 — messaging.manage_members routes carry only requirePermission; addMember/removeMember check neither location nor channel kind, so a holder can add themselves to another pair's DM and then read it.**
- Files: `apps/backend/src/modules/36-messaging/routes/messaging-routes.ts`, `apps/backend/src/modules/36-messaging/messaging-route-service-db.ts`, `packages/auth/src/permissions/contributed.ts`, `docs/modules/WARDENX_MODULE_36_MESSAGING_SPEC_v0_4.md`
- Done when: Add requireAbac('messaging.manage_members','location_membership') (or a channel_member_admin predicate) and refuse manual edits on 'dm' channels.
- Verify: bun run arch:abac-predicates; route test: clinical_lead adding to a DM or other-location channel -> 403.

**GAP-137 — M36 — channel_visibility implements only the membership branch, not caseload_membership (care_team) or bereavement_membership; with channel_sync unbuilt, care_team access can outlive caseload removal.**
- Files: `apps/backend/src/modules/36-messaging/messaging-route-service-db.ts`, `docs/modules/WARDENX_MODULE_36_MESSAGING_SPEC_v0_4.md`
- Done when: Branch canViewChannel on channel_kind: care_team -> CaseloadProvider seam, bereavement -> M16 seam.
- Verify: Live: user removed from a care team with a stale channel_member row is denied the channel.

**GAP-138 — M36 — Spec'd platform-ops route GET /api/v1/admin/messaging/alert-deliveries is not implemented (permission key exists).**
- Files: `docs/modules/WARDENX_MODULE_36_MESSAGING_SPEC_v0_4.md`, `packages/auth/src/permissions/contributed.ts`
- Done when: Add the route with messaging.admin.read plus a platform-ops ABAC conjunct, audited as elevated access, and enrich it.
- Verify: bun run arch:openapi-coverage; platform_ops 200 / tenant org_admin 403.

**GAP-139 — M36 — alert_receipt has no live RLS test although it shipped once with no RLS or grants (0243 -> 0247 production 42501).**
- Files: `audit/implementation-status/IMPLEMENTATION_STATUS.md`, `packages/db/migrations/0247_alert_receipt_rls_and_grants.sql`
- Done when: Add a wardenx_app live suite asserting cross-tenant invisibility and insert refusal; add the package.json script and ci.yml job.
- Verify: bun run status:matrix shows M36 Live 16/16; bun run arch:live-suites.

**GAP-140 — M37 — The IRC 30-day resumption rule is not applied at episode open (resumedStartingDayCount unused), so IRC can be split into fresh episodes; combined with the missing watchdog the IRC cap is unenforced.**
- Files: `apps/backend/src/modules/37-ipu/routes/service-drizzle.ts`, `packages/inpatient/src/machines/irc-episode.ts`, `docs/modules/WARDENX_MODULE_37_IPU_SPEC_v0_2.md`
- Done when: Select episodes closed within the look-back in open_irc_episode and set consecutiveDayCount via resumedStartingDayCount.
- Verify: Live: close a 3-day episode, reopen within 30 days -> starts at day 4.

**GAP-141 — M37 — None of the five section 4.7 M37 predicates is consulted by any route (target-boolean stubs); ipu.staff_member unit scoping is unenforced (getAdmission is a plain RLS read) and RN-coverage is checked only in four service methods, not 'every mutation' (e.g.**
- Files: `apps/backend/src/modules/37-ipu/abac/predicates.ts`, `apps/backend/src/modules/37-ipu/routes/guards.ts`, `apps/backend/src/modules/37-ipu/routes/service-drizzle.ts`, `docs/modules/WARDENX_MODULE_37_IPU_SPEC_v0_2.md`
- Done when: Enforce staff_member (unit assignment or IPU director) in the service on IPU admission reads/writes and extend RN coverage to the section 2.3 list, or amend spec 4.1/4.7.
- Verify: Route tests: non-IPU staff denied GET /api/v1/ipu-admissions/:id; equipment assign during uncovered hour -> 412.

**GAP-142 — M39 — M39 section 4.6 consumers (m5.patient.merged re-point, m4.legal_hold.*, m22.document.rendered back-ref) have deciders but no bindings; after a merge the survivor has no consents (fail-closed denials) and the duplicate's consents are orphaned.**
- Files: `apps/backend/src/modules/39-consent/consumers.ts`, `apps/backend/src/modules/05-patient/events-by-m5.ts`, `docs/modules/WARDENX_MODULE_39_CONSENT_SPEC_v0_3.md`
- Done when: Bind M39 consumers for those events, add m39 to the producers' declaredConsumers and wire them in index.ts.
- Verify: bun run arch:outbox-bindings; live merge re-points consent_record.patient_id and publishes m39.consent.repointed.

**GAP-143 — M39 — 4 of 6 M39 crons are unbuilt (revocation-cascade-retry, renewal-cycle-close, draft-auto-expire, eval-audit-partition); stuck cascades are not retried automatically and consent_eval_audit lands in the DEFAULT partition.**
- Files: `apps/backend/src/modules/39-consent/jobs/index.ts`, `apps/backend/src/modules/39-consent/jobs/cron-workers.ts`, `packages/db/migrations/0023_consent_m39_rls_audit_triggers.sql`
- Done when: Add the four workers and schedules in cron-workers.ts using withOrgContext per org.
- Verify: Live suite per job (e.g. a cascade stuck >5 min is re-fired).

**GAP-144 — M40 — ExternalGriefResourceReader is never registered (no external_grief_resource table), so GET /api/v1/portal/bereavement/resources returns 501 by design; the M22 tenant-catalog half is not composed either.**
- Files: `apps/backend/src/modules/31-portal/routes/read.routes.ts`, `apps/backend/src/bootstrap/seams/registry.ts`, `apps/backend/src/bootstrap/seams/providers.ts`, `apps/backend/src/modules/31-portal/seams/registration.ts`, `docs/modules/WARDENX_MODULE_31_PORTAL_TELEHEALTH_SPEC_v0_2.md`
- Done when: Build the M40 grief-resource catalog seam (or compose the M22 tenant catalog alone) and register it; correct the M31_REQUIRED_SEAMS header.
- Verify: Docker: portal bereavement resources -> 200 with items.

**GAP-145 — M40 — The M40 job tier is unbuilt: BAA 90/30/0-day and license expiration alerts, fuzzy dedup, execute_merge/repoint, NPPES fallback and provisional aging never run (queues defined as data only).**
- Files: `packages/mdm/src/jobs/queues.ts`, `apps/backend/src/modules/40-mdm/routes/mdm-routes.ts`, `docs/modules/WARDENX_MODULE_40_MDM_SPEC_v0_4.md`
- Done when: Add apps/backend/src/modules/40-mdm/jobs/ with at least baa_expiration_scan, license_expiration_scan and execute_merge/repoint wired from index.ts; correct the header.
- Verify: Live: BAA expiring in 30 days produces an M36 alert after the scan.

**GAP-146 — global — About 40 documented screen specs have no registered screen (keyword join; ui:parity does no per-screen join): e.g.**
- Files: `audit/ui-parity/UI_PARITY.md`, `apps/backend/src/modules/28-fhir/routes/admin-clients.routes.ts`
- Done when: Add a spec-to-screen key (e.g. a `spec:` field on ScreenDef) so scripts/report-ui-parity.ts lists unbuilt specs; prioritise clinical/compliance specs whose backends exist.
- Verify: bun run ui:parity prints a per-spec 'unbuilt' list that shrinks as screens land.

**GAP-147 — global — Frame-fidelity notes for eMAR, Encounter and Patient Chart are stale (claim unbuilt writes/unbound selections/placeholder cards that now exist); the gate checks only report freshness, not note accuracy.**
- Files: `scripts/frame-fidelity/registry.ts`, `apps/web/src/modules/13-emar/emar-api.ts`, `apps/web/src/modules/08-encounters/encounter-read.tsx`, `apps/web/src/modules/05-patient/patient-overview.tsx`
- Done when: Edit the three entries in scripts/frame-fidelity/registry.ts and regenerate with bun run frame:fidelity.
- Verify: bun run frame:fidelity:check green; the stale phrases no longer appear in the registry.

**GAP-148 — global — Frame-fidelity maps 17 of 120 ledger frames (3 matched, 14 partial); the other 103 are not even 'pending', so '0 pending' reads as complete.**
- Files: `audit/frame-fidelity/FRAME_FIDELITY.md`, `scripts/report-frame-fidelity.ts`
- Done when: Seed scripts/frame-fidelity/registry.ts with a 'pending' row for every ledger frame that has a built screen, starting with M23/M25/M26/M27.
- Verify: bun run frame:fidelity reports pending > 0.

**GAP-149 — global — The SPA document is served without CSP, frame-ancestors, X-Frame-Options, HSTS, nosniff or Referrer-Policy (headers are set only on Fastify API responses), contrary to SECURITY_HARDENING 9.6.1; backend CSP also lacks report-uri.**
- Files: `deploy/production/web-nginx.conf`, `deploy/production/nginx/wardenx-frontend.conf`, `apps/backend/src/bootstrap/plugins/security.ts`, `docs/architecture/WARDENX_SECURITY_HARDENING_v0_2.md`
- Done when: Add the security.ts header set with `always` at server level (and in add_header location blocks) in web-nginx.conf; verify CSP against the Vite build; optionally add report-uri.
- Verify: curl -sI https://wardenx.chartwarden.cloud/ | grep -i 'content-security-policy\|x-frame-options\|strict-transport'.

**GAP-150 — global — check-fitness-gaps phi-guards regexes are vacuous: a table passes RLS if 'enable row level security' appears anywhere earlier in the corpus, and the audit-trigger check passes on any 'trigger' + 'on <table>' + 'audit'; not net-effect aware.**
- Files: `scripts/check-fitness-gaps.ts`
- Done when: Replace the regexes with a per-table net-effect replay (ENABLE/DISABLE RLS, CREATE/DROP TRIGGER) or a pg_catalog live assertion.
- Verify: Add a fixture migration with an untriggered org table and confirm bun run arch:gaps exits 1.

**GAP-151 — global — Ops runbook and security hardening cite unannotated infra/ artifacts (secret inventory, MinIO policies, Grafana dashboards, firewall rules) that do not exist; arch:architecture-docs cannot see them because PATH_PREFIXES omits infra/ and deploy/.**
- Files: `docs/architecture/WARDENX_OPS_RUNBOOK_v0.1.md`, `docs/architecture/WARDENX_SECURITY_HARDENING_v0_2.md`, `scripts/check-architecture-docs.ts`
- Done when: Add infra|deploy to PATH_PREFIXES, then create the artifacts or annotate the four citations as not yet created.
- Verify: bun run arch:architecture-docs fails before annotation, passes after.

**GAP-152 — global — bootstrap-vps.sh reads deploy/production/.env.production.example, which has never been committed (gitignored by `.env.*`); a first-time bootstrap / DR rebuild fails under set -eu.**
- Files: `deploy/production/bootstrap-vps.sh`, `deploy/production/README.md`, `apps/backend/src/bootstrap/env.ts`
- Done when: Add deploy/production/.env.production.example with every env.ts REQUIREMENTS key using the REPLACE_WITH_* placeholders the bootstrap's sed expects; add `!deploy/production/.env.production.example` to .gitignore; optionally gate key coverage.
- Verify: git ls-files deploy/production/.env.production.example; run bootstrap-vps.sh with DEPLOY_DIR=/tmp/x in a container and confirm .env.production is produced.

**GAP-153 — global — 29+ error responses in M02, M12, M29, M33 and M37 bypass the M1 section 4.3 envelope with flat {code,message} or string {error:'...'} bodies, without correlationId.**
- Files: `docs/modules/WARDENX_MODULE_01_FOUNDATION_SPEC_v0_4.md`, `apps/backend/src/bootstrap/plugins/error-handler.ts`, `apps/backend/src/modules/37-ipu/routes/ipu.routes.ts`, `apps/backend/src/modules/29-external-interfaces/routes/feed.routes.ts`, `apps/backend/src/modules/02-identity/routes/session-step-up.ts`, `apps/backend/src/modules/33-reporting/routes/exports.routes.ts`, `apps/backend/src/modules/12-dosespot/webhooks/webhook-route.ts`
- Done when: Replace direct error sends with thrown WardenXError subclasses (extra fields via details); add a fitness grep with an allowlist for vendor-mandated webhook replies.
- Verify: grep -rnE 'code\([45][0-9]{2}\)\.send\(\{ *(code:|error: *")' apps/backend/src --include='*.ts' --exclude-dir=__tests__ returns only allowlisted lines; route tests assert body.error.correlationId.

### P3

**GAP-154 — M01 — m1.system_status.changed and m1.feature_flag.updated are catalogued but never emitted; Socket.IO realtime events are an ADR-0036 deferral, but catalog entries without producers remain drift.**
- Files: `packages/shared/src/outbox-events/events-by-m1.ts`, `apps/backend/src/bootstrap/routes/system.ts`, `docs/adr/ADR-0036-no-realtime-backbone.md`
- Done when: Publish m1.system_status.changed from the admin upsert, or drop the catalog entries and record it in ADR-0036.
- Verify: Unit test: POST /admin/system/status leaves an outbox_event row; bun run arch:gaps.

**GAP-155 — M01 — 5 bootstrap routes are unenriched (health/ready/version/metrics probes plus the client-consumed GET /api/v1/system/feature-flags, which has no response schema, so the UI uses a hand-written FeatureFlags type); the baseline allows a deficit of 5.**
- Files: `apps/backend/src/bootstrap/routes/system.ts`, `apps/backend/src/bootstrap/routes/health.ts`, `scripts/openapi/enrichments.ts`, `docs/api/openapi.json`, `packages/ui/src/core/types.ts`, `audit/openapi-coverage/OPENAPI_COVERAGE.md`, `audit/openapi-coverage/baseline.json`
- Done when: Add ROUTE_ENRICHMENTS for GET /api/v1/system/feature-flags ({flags: Record<string,boolean>}) and the probes; run openapi:emit, client:gen, openapi:coverage --update.
- Verify: bun run openapi:coverage && bun run arch:openapi-coverage && bun run client:check; bootstrap deficit drops.

**GAP-156 — M03 — The implementation-status matrix shows M03 Tests and M01 Routes/Screens as absent although authz tests and bootstrap routes exist (heuristic misses them).**
- Files: `audit/implementation-status/IMPLEMENTATION_STATUS.md`, `apps/backend/__tests__/authz-routes.test.ts`
- Done when: Teach the status:matrix heuristic the authz-*/break-glass-* slugs and count apps/backend/src/bootstrap/routes as M1 routes.
- Verify: bun run status:matrix --check shows M03 Tests and M01 Routes green.

**GAP-157 — M03 — No boot-level check that every requireAbac predicate name is registered at runtime; check-abac-predicates is static and per-module tests are scoped.**
- Files: `scripts/check-abac-predicates.ts`, `apps/backend/src/modules/11-orders/index.ts`, `apps/backend/src/modules/22-documents/index.ts`, `scripts/check-boot-with-platform-credential.ts`
- Done when: Add a DB-booted test (extend check:boot:platform or a live boot suite) asserting every requireAbac literal resolves in abacRegistry.names().
- Verify: Remove a registrar call on a scratch branch and confirm the new check fails.

**GAP-158 — M05 — Census KPIs (Admissions, Discharges, GIP, Recerts due) are hardcoded '—' placeholders; M6 list endpoints exist but are paginated lists, not counts.**
- Files: `apps/web/src/modules/05-patient/patient-list-census.tsx`, `packages/ui/src/core/api/schema.ts`, `audit/frame-fidelity/FRAME_FIDELITY.md`
- Done when: Add a count/metrics read (or census-metrics extension) and bind the KPIs; update the frame-fidelity note.
- Verify: Census DOM test asserts numeric KPI values from mocked responses.

**GAP-159 — M06 — 22 implemented M06 routes (referral phase-1 workflow, readiness, patient admissions, evidence uploads, confirm-bed) are not in the spec section 4.1 inventory (68 vs 46).**
- Files: `apps/backend/src/modules/06-admission/routes/admission-routes.ts`, `docs/modules/WARDENX_MODULE_06_ADMISSION_ELECTION_CERTIFICATION_SPEC_v0_4.md`
- Done when: Add the 22 routes with permission/ABAC to spec section 4.1.
- Verify: Route-vs-spec diff reports no unmatched routes.

**GAP-160 — M08 — 6 M08 read routes are missing from the spec's '31 routes' inventory (37 registered); route header says 34.**
- Files: `apps/backend/src/modules/08-encounters/routes/encounters-routes.ts`, `docs/modules/WARDENX_MODULE_08_ENCOUNTERS_SPEC_v0_2.md`
- Done when: Add the six GETs to spec 4.1 and fix the header count.
- Verify: Spec total equals 37.

**GAP-161 — M09 — Two implemented M09 routes (summary/document POST, GET /scales) are not in spec 4.1.**
- Files: `apps/backend/src/modules/09-assessments/routes/assessments-routes.ts`, `docs/modules/WARDENX_MODULE_09_CLINICAL_ASSESSMENTS_SPEC_v0_3.md`
- Done when: Add both routes to spec 4.1.
- Verify: Spec 4.1 matches 20 registrations.

**GAP-162 — M10 — GET /hope/submissions/{id}/package (ZIP download) declares no response content type, so the generated client cannot type it.**
- Files: `audit/openapi-coverage/OPENAPI_COVERAGE.md`, `docs/api/openapi.json`
- Done when: Add a 200 application/zip binary response to the M10 enrichment.
- Verify: bun run openapi:coverage shows 10-hope GET-no-resp 0; bun run client:check.

**GAP-163 — M10 — HOPE draft update and answer/HUV PATCH routes omit the discipline ABAC (authorDisciplineAllowed) the spec requires; GET /hope/sfv deliberately skips caseload scope and returns an org-wide PHI worklist.**
- Files: `apps/backend/src/modules/10-hope/routes/hope-routes.ts`, `docs/modules/WARDENX_MODULE_10_HOPE_ENGINE_SPEC_v0_2.md`
- Done when: Add ABAC_AUTHOR to PUT/PATCH routes; filter listSfv by caseload for non-org-wide roles.
- Verify: Route test: non-RN/NP/MD with write -> 403; SFV list excludes off-caseload patients.

**GAP-164 — M11 — Six M11 routes (verbal-orders, held-transmissions, resend/recover-transmission and its cosign/cancel) are absent from spec 4.1 (only in docs/history and openapi.json).**
- Files: `apps/backend/src/modules/11-orders/routes/orders-routes.ts`, `apps/backend/src/modules/11-orders/routes/held-transmissions-routes.ts`
- Done when: Add the routes with permissions/step-up to M11 spec 4.1.
- Verify: bun run arch:module-docs and a manual diff.

**GAP-165 — M12 — POST /medication-orders/:id/report-error (F-205) and its permission are absent from the M12 spec route inventory (the event is documented), and the status matrix's 'Adapter' green overstates readiness while the only DoseSpot client is the deny-stub.**
- Files: `apps/backend/src/modules/12-dosespot/routes/dosespot-routes.ts`, `docs/modules/WARDENX_MODULE_12_DOSESPOT_PRESCRIBING_SPEC_v0_2.md`, `audit/implementation-status/IMPLEMENTATION_STATUS.md`, `packages/dosespot/src/client/unbound.ts`
- Done when: Add the route to spec 4.1; refine the status-matrix adapter heuristic to exclude deny-stub-only clients.
- Verify: bun run status:matrix --check; bun run arch:module-docs.

**GAP-166 — M14 — M14 implements routes absent from spec 4.1 (ad-hoc meeting create, agenda/attendance/decisions/recert-windows GETs, idg-history) while the spec's internal /api/v1/internal/idg/* routes are served via in-process seams instead; DECISION_PAYLOAD_INVALID is never emitted.**
- Files: `apps/backend/src/modules/14-idg/routes/idg-routes.ts`, `docs/modules/WARDENX_MODULE_14_IDG_SPEC_v0_4.md`
- Done when: Update spec 4.1/4.3 to the implemented routes and seams; drop or implement DECISION_PAYLOAD_INVALID.
- Verify: bun run arch:module-docs.

**GAP-167 — M17 — membership_credential (M17) and bereavement_cop_opt_out_credit (M16) have no direct cross-tenant RLS assertion on the app role (only setup inserts / admin reads).**
- Files: `packages/db/migrations/__tests__/m17-rls-isolation.live.test.ts`, `apps/backend/__tests__/m16-opt-out-changed.live.test.ts`
- Done when: Add both tables to the m16/m17 rls-isolation live suites.
- Verify: Run the m16/m17 rls-isolation live suites against Docker Postgres.

**GAP-168 — M17 — Implemented routes absent from spec 4.1: M17 /visits/:id/arrive and membership credentials; M19 paper-reentry (+worklist) and vendor-sessions/bind; M20 GET /safety/incidents list.**
- Files: `apps/backend/src/modules/17-scheduling/routes/scheduling-routes.ts`, `apps/backend/src/modules/19-oncall/routes/triage-calls.routes.ts`, `apps/backend/src/modules/20-field-safety/routes/incidents.routes.ts`, `docs/modules/WARDENX_MODULE_20_FIELD_SAFETY_SPEC_v0_3.md`
- Done when: Add these rows (permission/ABAC) to the M17, M19 and M20 spec 4.1 tables.
- Verify: bun run arch:module-docs or a manual route-table diff.

**GAP-169 — M22 — M22's DocLens resolver is hard-wired to the deny-stub; rewiring alone would change nothing because M32 registers DocLens seams only when a pipeline is passed (none is).**
- Files: `apps/backend/src/modules/22-documents/extraction/doclens-capability.ts`, `apps/backend/src/modules/22-documents/index.ts`, `apps/backend/src/modules/32-ai-platform/seams/index.ts`, `apps/backend/src/index.ts`, `docs/history/outbox-248-builds.md`
- Done when: Project getSeam('DocLensClassifier'/'DocLensExtractor') into DocLensCapabilityPort with a fail-closed fallback once the M32 pipeline binds.
- Verify: With M32 seams registered and the flag on, POST /api/v1/intake/uploads/:id/extraction/run is not capability_unavailable.

**GAP-170 — M22 — M22, M25 and M31 specs prescribe tenant_id / app.tenant_id RLS, which ADR-0010 D2 bans (architecture wins); shipped migrations correctly use app.org_id.**
- Files: `docs/adr/ADR-0010-tenancy-rls-invariants.md`, `docs/modules/WARDENX_MODULE_22_DOCUMENTS_SPEC_v0_5.md`, `docs/modules/WARDENX_MODULE_25_REMITTANCE_SPEC_v0_2.md`, `docs/modules/WARDENX_MODULE_31_PORTAL_TELEHEALTH_SPEC_v0_2.md`
- Done when: Rewrite M22 8.2, M25 8.1 and M31 task A4 to organization_id / app.org_id with revision rows (M17-F10 precedent).
- Verify: grep -n 'app.tenant_id' docs/modules/*.md returns only lines citing it as banned.

**GAP-171 — M23 — M23 route paths drift from spec 4.1 (NOE/NOTR/validation not under /billing, duplicate validate route, rule-configs path).**
- Files: `docs/modules/WARDENX_MODULE_23_BILLING_MEDICARE_SPEC_v0_2.md`
- Done when: Update spec 4.1 to implemented paths and drop one duplicate validate route.
- Verify: Diff spec table vs route extraction.

**GAP-172 — M25 — M25 spec WX-PR-012 note says the M23 claim-match seam 'remains unbound', but it is now bound.**
- Files: `docs/modules/WARDENX_MODULE_25_REMITTANCE_SPEC_v0_2.md`, `apps/backend/src/modules/23-billing-medicare/cost-report-seams.ts`, `apps/backend/src/index.ts`
- Done when: Amend the M25 spec note.
- Verify: bun run arch:module-docs.

**GAP-173 — M26 — PS&R import is registered as POST /api/v1/cap/periods/:periodId/psr-imports while the spec declares POST /v1/cap/psr-imports.**
- Files: `apps/backend/src/modules/26-cap/routes/psr.routes.ts`, `docs/modules/WARDENX_MODULE_26_CAP_MANAGEMENT_SPEC_v0_3.md`
- Done when: Update spec 4.1 to the period-scoped path (or alias).
- Verify: bun run arch:module-docs.

**GAP-174 — M30 — The m6.election.signed HCI-denominator recompute handler is implemented but unbound (nightly recompute covers it with <=24h staleness); exception reason is stale.**
- Files: `packages/quality/src/consumers/handlers.ts`, `scripts/outbox-subscription-exceptions.ts`
- Done when: Bind a buildM30ElectionSignedConsumer using the existing enqueueRecompute port.
- Verify: bun run arch:outbox-bindings + m30-upstream-consumers.live.test.ts.

**GAP-175 — M31 — GET /api/v1/admin/telehealth/visits/:id returns 200 with lifecycleState 'not_found' instead of 404.**
- Files: `apps/backend/src/modules/31-portal/routes/admin.routes.ts`, `apps/backend/src/modules/31-portal/routes/telehealth.routes.ts`
- Done when: Throw NotFoundError when telehealthById returns null.
- Verify: Route test: unknown id -> 404.

**GAP-176 — M31 — The portal SPA has no chromed-route auth guard (web/admin have RequireChrome); framed routes render for anonymous visitors (server still enforces auth).**
- Files: `apps/portal/src/app.tsx`, `apps/web/src/shell/app.tsx`, `apps/admin/src/shell/require-chrome.tsx`
- Done when: Add a portal session provider + RequireChrome equivalent around PortalFrame before deployment.
- Verify: DOM test: anonymous PortalApp at /patient-picker redirects to '/'.

**GAP-177 — M35 — Four M35 admin GETs (dunning, plans/:id, promos/:id, refunds/:id) are registered but absent from spec 4.2.**
- Files: `docs/modules/WARDENX_MODULE_35_SUBSCRIPTION_BILLING_SPEC_v0_3.md`, `apps/backend/src/modules/35-subscription/routes/admin.routes.ts`
- Done when: Add the four rows to M35 spec 4.2.
- Verify: Spec-vs-route comparison has 0 impl-only rows.

**GAP-178 — M36 — Stale 'writes defer to FB-T05 (501)' comments although M36 writes are live; POST /api/v1/alerts/:id/read is missing from spec 4.1.**
- Files: `apps/backend/src/modules/36-messaging/index.ts`, `apps/backend/src/index.ts`, `apps/backend/src/modules/36-messaging/routes/messaging-routes.ts`
- Done when: Update both comments and add the route to spec 4.1.
- Verify: Manual grep; bun run arch:module-docs.

**GAP-179 — M37 — M37 spec says 38 routes (lines 554, 1368, 2337) versus 52 implemented; seven read/confirm routes are absent from 4.1 and row 31 lists only visitor_restriction.apply although the spec's own catalog defines .lift for DELETE.**
- Files: `apps/backend/src/modules/37-ipu/routes/ipu.routes.ts`, `docs/modules/WARDENX_MODULE_37_IPU_SPEC_v0_2.md`, `audit/openapi-coverage/OPENAPI_COVERAGE.md`
- Done when: Update spec 4.1 with the added routes and the lift key.
- Verify: bun run arch:module-docs.

**GAP-180 — M39 — Portal consent routes #25-27 (/api/v1/portal/consents/*) are not implemented; the spec marks them Phase 2 (recorded deferral).**
- Files: `docs/modules/WARDENX_MODULE_39_CONSENT_SPEC_v0_3.md`
- Done when: Build when M31 Phase 2 lands; track only.
- Verify: bun run arch:openapi-coverage shows 30 M39 routes.

**GAP-181 — global — Stale composition-root/M30 comments describe live seams as unbound or in-memory (provider-entity resolver, SignedEncountersReader, emitThresholdBreached), and several outbox-subscription-exception reasons say events are 'already deferred' though the register holds only m22 pairs.**
- Files: `apps/backend/src/index.ts`, `apps/backend/src/modules/30-quality/jobs/m30-jobs.ts`
- Done when: Update the comments and refresh the reason strings in scripts/outbox-subscription-exceptions.ts for m30/m23/m27/m11.
- Verify: Re-read cited lines; bun run arch:outbox-bindings stays green.

**GAP-182 — global — SameSite policy contradicts itself: SECURITY_HARDENING 5.1 says Lax (matching csrf.ts:127) while 9.6.4, SYSTEM_DESIGN 5.1 and M31 9.3 say Strict.**
- Files: `docs/architecture/WARDENX_SECURITY_HARDENING_v0_2.md`, `docs/architecture/WARDENX_SYSTEM_DESIGN_v0.3.md`, `docs/modules/WARDENX_MODULE_31_PORTAL_TELEHEALTH_SPEC_v0_2.md`, `apps/backend/src/bootstrap/plugins/csrf.ts`
- Done when: Change the Strict references to Lax + double-submit token.
- Verify: grep -rn 'SameSite=Strict' docs/architecture docs/modules returns nothing current.

**GAP-183 — global — CLAUDE.md:66 (and AGENTS.md) says audit-fitness has a --check mode inside arch:fitness; it has neither and is not a package.json script.**
- Files: `CLAUDE.md`, `scripts/run-fitness-gates.ts`, `docs/architecture/ARCHITECTURE_25_15_FITNESS.md`
- Done when: Move audit-fitness out of the --check list in CLAUDE.md and copy CLAUDE.md to AGENTS.md verbatim.
- Verify: diff CLAUDE.md AGENTS.md empty; line 66 updated.

**GAP-184 — global — Four broken relative links: docs/history/status-overview.md:77,78,81 (./docs/.**
- Files: `docs/history/status-overview.md`, `docs/REMEDIATION_SUMMARY.md`
- Done when: Change to ../DEVELOPMENT.md, ../PHASE_0_SCAFFOLD_PLAN.md, ../adr/ADR-0027-... and ./architecture/ARCHITECTURE_25_15_FITNESS.md.
- Verify: Markdown link check over docs/ reports 0 broken.

**GAP-185 — global — Specs/plans cite non-existent `bun run` scripts (check:manifest, check:cruiser, check:table-ownership, test:rls-isolation, lint:deps, db:migrate:up/down, gen:proto, db:seed:admissions).**
- Files: `docs/modules/WARDENX_MODULE_29_EXTERNAL_INTERFACES_SPEC_v0_4.md`, `docs/modules/WARDENX_MODULE_31_PORTAL_TELEHEALTH_SPEC_v0_2.md`, `docs/modules/WARDENX_MODULE_32_AI_PLATFORM_SPEC_v0_2.md`, `docs/modules/module-29-tasks/WARDENX_T-29.02_SCHEMA_PACKAGE.md`, `docs/plans/WAVE_M6_LIVE_WIRE_PLAN.md`
- Done when: Update to current names (arch:manifest-mirror, arch:boundaries, arch:tables, test:rls:live:m31, ...) or mark historical.
- Verify: Re-run the script-name diff; only intentional names remain.

**GAP-186 — global — Stale TODOs: M23/M27/M30 erasers still say step (1) is adding their DataClass to REQUIRED_ERASERS (done), and the M34 alert-rules TODO step (2) is done by wireM34AlertRuleSeed.**
- Files: `apps/backend/src/modules/23-billing-medicare/erasers/billing-eraser.ts`, `apps/backend/src/modules/27-cost-report/erasers/cost-report-eraser.ts`, `apps/backend/src/modules/30-quality/erasers/quality-eraser.ts`, `apps/backend/src/bootstrap/erasers/registry.ts`, `apps/backend/src/modules/34-saas-tenant-platform/alert-rules.ts`, `apps/backend/src/index.ts`, `packages/cost-report/src/ecr/records.ts`
- Done when: Trim the eraser and M34 TODOs to the remaining steps; track CMS-fixture placeholders as one issue.
- Verify: grep for the stale 'add "billing_record"'-style TODO text returns nothing.

**GAP-187 — global — The audit brief cites /Users/fabrice/Apps/WardenX and apps/backend/src/db/migrations/ (actual: repo root and packages/db/migrations/) and omits typecheck and check:boot:platform from its command list; PHASE_4_PLAN claims a non-existent @wardenx/mobile-offline package.**
- Files: `docs/audits/GAP_ANALYSIS_AUDIT_PROMPT.md`, `docs/PHASE_4_PLAN.md`, `CLAUDE.md`
- Done when: Fix the brief path, migrations directory and command list; correct the PHASE_4_PLAN claim.
- Verify: grep -n 'Apps/WardenX\|apps/backend/src/db/migrations\|mobile-offline' docs/audits/GAP_ANALYSIS_AUDIT_PROMPT.md docs/PHASE_4_PLAN.md returns nothing.

**GAP-188 — global — 516 of 1085 foreign keys have no index whose leading columns cover the FK (134 location_id, 132 provider_entity_id); 16 unindexed FKs are ON DELETE CASCADE and 29 SET NULL, each forcing a child seq-scan on parent delete.**
- Files: (see evidence; runtime/query-level)
- Done when: Add indexes for the 16 CASCADE / 29 SET NULL FKs and admission_id FKs in a new migration (check arch:migration-numbering); decide policy for location_id/provider_entity_id; optionally extend scripts/check-org-index-coverage.ts.
- Verify: Re-run the FK-index query on a fresh DB; CASCADE/SET NULL rows drop to 0.

## 7. Unverified assumptions

**Evidence-verification pass outcomes.** No finding was demoted (0 failed verification), none was refuted (0 dropped after disproof), and no worker failed. Every P0/P1 above is `verified: true`. Verifiers corrected some details: line ranges, a few overstated sub-claims (e.g. M8 override routes do have RBAC role guards; M9 self-cosign is blocked at the service layer; the M19 coverage_gap event does have a reactive emitter; M18 emits 7 rather than 8 unemitted events), and two severity changes (M14 child-resource ABAC raised P2→P1; M22 DocLens lowered P2→P3; CI gate lowered P0→P1). The corrected values are what this report uses.

**P2/P3 findings that did not receive an independent verification pass (85):** GAP-074, GAP-076, GAP-078, GAP-079, GAP-080, GAP-082, GAP-083, GAP-086, GAP-087, GAP-088, GAP-089, GAP-092, GAP-093, GAP-094, GAP-095, GAP-096, GAP-097, GAP-098, GAP-099, GAP-100, GAP-101, GAP-103, GAP-104, GAP-105, GAP-106, GAP-108, GAP-109, GAP-110, GAP-111, GAP-112, GAP-113, GAP-115, GAP-117, GAP-118, GAP-119, GAP-120, GAP-122, GAP-123, GAP-124, GAP-125, GAP-126, GAP-128, GAP-129, GAP-131, GAP-133, GAP-134, GAP-137, GAP-138, GAP-139, GAP-140, GAP-142, GAP-143, GAP-145, GAP-147, GAP-148, GAP-150, GAP-151, GAP-153, GAP-154, GAP-156, GAP-159, GAP-160, GAP-161, GAP-162, GAP-163, GAP-164, GAP-166, GAP-167, GAP-170, GAP-171, GAP-172, GAP-173, GAP-174, GAP-175, GAP-176, GAP-177, GAP-178, GAP-180, GAP-181, GAP-182, GAP-183, GAP-185, GAP-186, GAP-187, GAP-188. They are reported with `verified: false` and should be re-checked before work is scheduled.

**Assumptions and checks the workers could not complete:**

- **batch-1 (M01–M05)**
  - Whether WARDENX_INMEM_ASSERT=warn is set in the production environment. It is absent from the repo, and without it a NODE_ENV=production boot throws, so the real prod boot posture is unknown.
  - The M03 P0 chain was traced statically and not executed live. Next step: create role 'platform_ops' as a tenant admin, self-assign it, step up, then POST /api/v1/platform/organizations/<other>/status.
  - Whether Better Auth sign-up responses enable email enumeration depends on the installed version's error shape; this was not checked.
  - The Better Auth default session lifetime for the installed version was not read from node_modules.
  - Live RLS coverage per owned table relies on the status-matrix name match and arch:tenancy; the *.live suites were not run.
  - Per-table FORCE RLS relies on arch:tenancy's net-effect replay, because many FORCEs are applied in bulk DO-loops.
- **batch-2 (M06–M10)**
  - f2f.is_hospice_clinician compares userId with a client-supplied performed_by_user_id; whether the UI sends a user id or a membership id was not traced.
  - M10 Section I diagnosis value-set validation may be vacuous in prod if M38 hospice_terminal_diagnosis has no members.
  - Whether the M5 caseload store keys assignments by user id or membership id was not checked (cross-module concern).
  - Live suites were not executed; live-coverage findings use name matching.
  - Whether M09 admin PATCH routes reject a missing Idempotency-Key was not verified.
- **batch-3 (M11–M15)**
  - Whether UpdateOrderRequest's required `data: Type.Unknown()` accepts an absent key; if it does, a priority-only PATCH would wipe order data. Not tested.
  - Which seeded roles hold administration.void, idg.act, orders.read and prescribing.read; this sets the real blast radius of several ABAC findings. Not traced.
  - Whether the M14 spec's internal /api/v1/internal/idg/* consumers are fully served by in-process seams (assumed from spec §2.8).
  - Whether the web client always sends the order's true medClass, i.e. whether the M13 witness bypass needs a crafted request.
  - M11/M12 tables covered only by other live suites (m11-orm-recovery, m13-m12-draft-order-requested) were not read in detail.
  - Live suites were not run; only package unit suites were.
- **batch-4 (M16–M20)**
  - Whether any seeded role holds portal.visit.read_upcoming / portal.evv.read_arrival; the portal-scope finding may be latent.
  - Whether database-level encryption at rest mitigates the M18 base64 coordinates finding (infrastructure, outside the repo).
  - M16–M20 live suites were not executed; live-coverage claims come from reading files.
  - Whether the catalogued m17.visit.late_check_out_suspected (no producer, record-only per F-141) is meant to be removed.
- **batch-5 (M21–M25)**
  - M21–M25 unit/integration suites were not run by this worker.
  - Live RLS coverage relies on the status-matrix name match; RLS was not proven live as wardenx_app.
  - Per-table RLS/audit triggers were checked only through the passing global gates.
  - Whether the M23 launch gateway is configured in production is unknown; if not, no M23 workers are constructed at all (index.ts:4669-4673).
  - Whether production MAC submissions rely on mac_submitter_credential rows or only on env bearer tokens was not traced (affects the severity of the MAC credential finding).
  - Both M23 worker registrars construct ackPull999/ackPull277ca Workers (two consumers per cron queue); whether this double-processes was not verified.
  - Request/response schema accuracy against spec TypeBox was not compared field by field.
- **batch-6 (M26–M30)**
  - Whether FHIR bearer-token calls fall into the 30/min-per-IP 'unauthenticated' limiter bucket was not traced.
  - Whether every M30 registry measure code routes to a bound resolver was not enumerated exhaustively (the comfort-kit gap was found separately).
  - Whether M28 $export emits resource types beyond the four served ones was not checked.
  - Whether every M26–M30 mutating route receives the global applyIdempotency middleware was not traced.
  - The M26–M30 rls-isolation suites were not executed.
  - Signing and persistence of the M28 fhir_capability_snapshot were not verified.
- **batch-7 (M31–M35)**
  - Whether production sets the platform KEK or provision gateway that makes the real M34 TenantKeyProvider live; if neither is set, the M33 and M32 blockers are partly environmental.
  - Whether any other client path clears the Better Auth cookie after the portal logout no-op (only account.tsx was inspected).
  - Whether removing GET /api/v1/platform/dsar-export-jobs was a deliberate response to M34-F09 (no ADR found).
  - The exact HTTP status for DrilldownDekUnavailable (503 vs 500) was not checked.
  - The M31–M35 live RLS suites were not executed.
  - M31 and M34 routes were not exercised on the Docker stack.
- **batch-8 (M36–M40)**
  - M40 admin routes (/api/v1/admin/mdm/*) write global canonical data guarded only by requirePermission, with no platform-ops ABAC conjunct. It was not confirmed whether tenant custom roles can carry mdm.canonical.write or mdm.merge.approve; if they can, this would be at least P1 (compare GAP-001, M03 role-key spoofing).
  - Whether production terminology is loaded by an out-of-repo process; if it is not, M12 search and ICD-10 validation break (potentially P0).
  - Whether M31 session minting and M22 signed URLs call ConsentEvaluator at runtime (the downstream reach of the D13 defect) was not traced.
  - Which role templates receive messaging.manage_members was not traced.
  - IRC 'within_cap' gating at the M23 billing route was not traced.
  - M36–M40 backend route suites and live suites were not run (package suites 476/476 passed).
- **fitness**
  - The 255 skipped vitest files (live/RLS) were not run. The tracked live file count (249) vs arch:live-suites (256) vs vitest skipped (255) was not reconciled.
  - check:boot:platform was not run with a platform credential.
  - build ran incrementally; typecheck covered the full type pass.
  - The 12 todo tests were not inspected.
  - Gate-accepted deferrals (2 unbound outbox pairs, the M36 webhook registrar, 14 partial frame mappings) were left to the owning workers.
- **seams**
  - That the dbHandle.db pool connects as NOBYPASSRLS wardenx_app is assumed. If it were BYPASSRLS, the CAHPS cron would fail on unbound ports instead of silently reporting no_active_vendor; the pipeline is broken either way.
  - The runtime count of permanently pending m23.claim.rejected / m18.evv.aggregator_rejected rows was not measured.
  - The org-poll relay path (pollOrg) was not re-read line by line; the conclusion relies on the shared routing plan.
  - Whether the M30 frontend calls MetricsProvider over HTTP was not checked.
  - Seam live suites (m26-cost-report-cap-seam, m30-hci-indicator-inputs, m30-quality-scheduled-jobs, m25-denial-seed-consumers) were not run.
  - The per-job withOrgContext sweep outside M30 was a spot check.
- **ui**
  - The '~40 unbuilt specs' join is keyword-based; some specs may be partly covered by tabs or modals elsewhere.
  - Mounting of every M30 compliance route was taken from arch:route-reachability.
  - No screen was rendered in a browser; checks were static.
  - The admin ops-outbox screens are gated on member.manage (deliberate per the screens.ts header); the backend ops-outbox gate was not audited.
- **security**
  - The production host nginx.conf log_format is not in the repo; the default 'combined' format is assumed.
  - Whether the gitignored .env.production sets WARDENX_INMEM_ASSERT=warn could not be checked (prod running implies it does).
  - Whether a TLS terminator on the VPS adds security headers to the SPA was not checked (only the tracked :80 vhosts).
  - Whether the M29 /api/admin/external-interfaces GETs return patient identifiers was not fully traced.
  - The dev DB catalog reflects migrations through 0306; it is not proven identical to production.
  - Fastify's default 404 handler logs the raw URL with query string; impact is limited to non-existent routes, so it was not reported as a gap.
- **docs**
  - Whether the M31 TelehealthProvider taking telehealthVisitId (HMAC'd into the room name) violates M31 §8.5.2 was left to security review.
  - No dependency-cruiser rule restricts @daily-co imports, but no such dependency exists either.
  - The M34 signup-intent TODO(Phase 2D) at index.ts:241 looks partly superseded; not fully traced.
  - The spec-vs-architecture cross-check covered tenancy, session timeouts and SameSite, not outbox naming or retention.
  - docs/cartography 'Likely' paths are explicitly speculative and were not reported.
- **discovered**
  - No automated route-to-spec cross-reference across all ~160 registrars was built.
  - Whether production .env.production sets M24_LAUNCH_GATEWAY_ENABLED and the 10 keys missing from templates; assertProductionEnv implies the REQUIREMENTS keys are set.
  - Whether disabling CI was a deliberate owner decision (e.g. Actions minutes per #257); no docs/history entry exists either way.
  - The FK-index analysis used a dev DB one migration behind the repo.
  - The error-envelope scan used single-line regexes, so 29 is a lower bound.

**Merged near-duplicates (evidence combined, highest verified severity kept):**
- GAP-004: merged from batch-1 + security
- GAP-005: merged from batch-1 + seams
- GAP-056: merged from seams + batch-6
- GAP-063: merged from seams + batch-7
- GAP-144: merged from seams + batch-7
- GAP-155: merged from batch-1 + fitness
- GAP-187: merged from fitness + docs + discovered

**Dropped after disproof:** none (0 refuted findings).

## 8. Machine-readable appendix

```json
{
  "generated_at": "2026-10-03T00:12:31Z",
  "repo": "WardenX",
  "summary": {
    "p0": 1,
    "p1": 72,
    "p2": 80,
    "p3": 35
  },
  "gaps": [
    {
      "id": "GAP-001",
      "severity": "P0",
      "category": "security",
      "module": "M03",
      "title": "Tenants can create custom roles whose keys match platform-ops keys (platform_ops, platform_admin, ...). Self-assigning one passes the platform-only gates, so a tenant admin can suspend or close ANOTHER tenant (close is terminal and deletes its sessions). Static trace; not run live.",
      "evidence": [
        "apps/backend/src/modules/03-authorization/routes/authz-typebox.ts:150 (key pattern ^[a-z0-9_]+$, no reserved-key exclusion)",
        "apps/backend/src/modules/03-authorization/routes/authz-routes.ts:114-128 (assertNoEscalation compares permission keys only); :148-176 POST /api/v1/roles; :258-292 role assign (no self-grant / role-key check)",
        "apps/backend/src/modules/03-authorization/role-store.ts:184-210 (createCustom inserts key as given)",
        "packages/db/migrations/0008_authorization_m3_tables.sql:92 (unique (organization_id,key) only; no reserved-key CHECK/trigger)",
        "packages/auth/src/rbac/drizzle-store.ts:141-157 (ctx.roles = every enabled role key, tenant custom roles included)",
        "packages/auth/src/roles/templates.ts:76-80 (PLATFORM_OPS_ROLE_KEYS); apps/backend/src/modules/02-identity/abac-predicates.ts:19-21 (isPlatformOperator = string match)",
        "apps/backend/src/modules/02-identity/organization-lifecycle.ts:107-131 (withOrgContext on target org from URL; deletes target sessions)",
        "apps/backend/src/bootstrap/routes/system.ts:88-93 (requireRole(PLATFORM_OPS_ROLE))"
      ],
      "verified": true,
      "recommended_fix": "Reject tenant role create/rename whose key is in PLATFORM_OPS_ROLE_KEYS, any template key or ORG_WIDE_SCOPE_ROLES (authz-routes.ts / role-store.ts) and add a DB CHECK/trigger on role (organization_id IS NOT NULL => key not reserved). Better: decide platform-operator status from a platform-owned fact (platform-org membership or org_id IS NULL template role ids), not a key string. Audit every hasRole()/requireRole() caller.",
      "verification": "New live test: as tenant admin, POST /api/v1/roles {key:'platform_ops'} -> 422/409; POST /api/v1/platform/organizations/<otherOrg>/status -> 403. bun run arch:abac-predicates."
    },
    {
      "id": "GAP-002",
      "severity": "P1",
      "category": "security",
      "module": "M02",
      "title": "Binding SESSION_POLICY timeouts (staff 15-min idle / 8h absolute / 24h hard; auditor 10-min idle) are not enforced server-side. Better Auth sets no expiresIn/updateAge (library default lifetime applies); the authenticate hook has no idle/absolute check; only the client screen-lock overlay reads the policy, and POST /api/v1/auth/screen-unlock does not exist (HIPAA 164.312(a)(2)(iii)).",
      "evidence": [
        "packages/types/src/policy/session-policy.ts:62-72",
        "apps/web/src/modules/02-identity/screen-lock.tsx:1,19,25 (only runtime consumer of SESSION_POLICY)",
        "packages/auth/src/identity/auth.ts:270-300 (session block has only additionalFields)",
        "packages/auth/src/identity/session-snapshot.ts:18-32; apps/backend/src/bootstrap/plugins/authenticate.ts (no idle/absolute logic)",
        "packages/auth/src/identity/session-classes.ts:26-50 (expired_idle/expired_absolute never entered)",
        "docs/modules/WARDENX_MODULE_02_IDENTITY_SPEC_v0_4.md:1583 (D1)"
      ],
      "verified": true,
      "recommended_fix": "Set Better Auth session.expiresIn/updateAge from SESSION_POLICY and enforce per-class idle/absolute limits in the authenticate hook (compare session.updatedAt/createdAt; revoke and 401 on breach). Implement POST /api/v1/auth/screen-unlock.",
      "verification": "Live test: a staff session idle >15 min gets 401 on any /api/v1 route; a session older than 8h gets 401."
    },
    {
      "id": "GAP-003",
      "severity": "P1",
      "category": "spec-drift",
      "module": "M02",
      "title": "No API or production code creates provider_entity or location rows; only GET /api/v1/provider-entities and GET /api/v1/locations exist. A new tenant cannot register CCN/NPI/MAC or locations in-product; the provider-entity resolver fails closed (503) with zero entities. Only scripts/db/seed-org-structure.ts inserts them.",
      "evidence": [
        "docs/modules/WARDENX_MODULE_02_IDENTITY_SPEC_v0_4.md:754-755",
        "apps/backend/src/bootstrap/routes/provider-entities.ts:27-28; apps/backend/src/bootstrap/routes/locations.ts:46-47 (GET only)",
        "apps/backend/src/bootstrap/provider-entity-resolver.ts:13-14 (zero entities -> 503)",
        "apps/backend/src/modules/02-identity/tenant-org-creation-provider.ts:47-54 (inserts only organizations)"
      ],
      "verified": true,
      "recommended_fix": "Add org_admin-gated POST/PATCH /api/v1/provider-entities and /api/v1/locations, or provision them in the M34 tenant-provision flow; enrich in scripts/openapi/enrichments.ts.",
      "verification": "Live: org_admin creates a provider entity, resolver returns it; cross-tenant PATCH -> 404."
    },
    {
      "id": "GAP-004",
      "severity": "P1",
      "category": "stub",
      "module": "M03",
      "title": "Break-glass Compliance notification, auditor engagements and auditor sessions are in-memory on the production mount; the spec's m3.breakglass.invoked/ended, m3.engagement.closed, m3.role.assigned/revoked outbox events do not exist (no events-by-m3.ts) and the reap/close crons are absent. The TASK-001 ledger makes a NODE_ENV=production boot throw unless WARDENX_INMEM_ASSERT=warn, which no tracked deploy config sets, so prod either refuses to boot or runs with that downgrade permanently set (silencing every in-memory binding). Critical audit row on break-glass still survives.",
      "evidence": [
        "apps/backend/src/modules/03-authorization/index.ts:86-89,156-158 (createInMemory* engagements/auditorSessions/notifier)",
        "apps/backend/src/modules/03-authorization/authz-ports.ts:621-634 (in-memory notifier pushes to array)",
        "apps/backend/src/modules/03-authorization/routes/authz-routes.ts:360-366 (comment claims outbox path; calls in-memory notifier)",
        "docs/modules/WARDENX_MODULE_03_AUTHORIZATION_SPEC_v0_3.md:34,803,829-830",
        "apps/backend/src/index.ts:3069-3077 (noteInMemoryBinding for M3)",
        "apps/backend/src/bootstrap/in-memory-ledger.ts:68-76,85-100 (production enforce -> InMemoryBindingError)",
        "grep WARDENX_INMEM_ASSERT deploy/ .github/ -> no matches; Dockerfile:12 ENV NODE_ENV=production"
      ],
      "verified": true,
      "recommended_fix": "Add apps/backend/src/modules/03-authorization/events-by-m3.ts (m36 as consumer) and publish inside break-glass/engagement/role transactions; replace in-memory engagement/auditor-session/notifier with Drizzle stores over auditor_engagement; add reap/close crons; remove the ledger note. Until then document the production WARDENX_INMEM_ASSERT decision in deploy/production/README.md.",
      "verification": "Live test with real publisher: POST /api/v1/breakglass leaves an m3.breakglass.invoked outbox row; boot with NODE_ENV=production and WARDENX_INMEM_ASSERT unset succeeds with empty inMemoryBindingNotes(); bun run arch:outbox-bindings."
    },
    {
      "id": "GAP-005",
      "severity": "P1",
      "category": "stub",
      "module": "M04",
      "title": "M4 BullMQ workers are never constructed: audit exports stay 'pending' forever (no object-store adapter), approved destruction certificates never execute, the daily retention scan never opens certificates, partitions are never tiered and the quarterly integrity sample never runs. Documented deferral, fail-closed, but auditor exports and retention-driven destruction are not delivered.",
      "evidence": [
        "apps/backend/src/modules/04-audit/routes/audit-exports.ts:5-15",
        "apps/backend/src/modules/04-audit/routes/destruction-certificates.ts:5-17",
        "apps/backend/src/index.ts:4117-4123 (registerAuditWorkers/scheduleAuditJobs 'stay deferred')",
        "apps/backend/src/modules/04-audit/routes/audit-typebox.ts:306-313 (backupSampling optional)",
        "grep registerAuditWorkers|scheduleAuditJobs -> definition (jobs/audit-jobs.ts:29,45) + barrel only"
      ],
      "verified": true,
      "recommended_fix": "Build Drizzle-backed AuditJobAdapters (BuildExportPorts.store over a shared S3/MinIO adapter, ExecuteDestructionPorts, archive, integrity sample) and call registerAuditWorkers/scheduleAuditJobs in the worker-runner block of apps/backend/src/index.ts.",
      "verification": "Live: POST export, run worker, GET /audit/exports/:id is ready with downloadUrl; approve a certificate, run worker, status executed and held rows refused; grep -n 'registerAuditWorkers(' apps/backend/src/index.ts."
    },
    {
      "id": "GAP-006",
      "severity": "P1",
      "category": "security",
      "module": "M05",
      "title": "POST /api/v1/patients/:id/payers checks patient.edit instead of patient.edit_payers and is the only per-chart route without a caseload_or_scope guard; any patient.edit holder can rewrite coverage (billing-relevant) on any chart in the tenant. Missing patient throws plain Error -> 500.",
      "evidence": [
        "apps/backend/src/modules/05-patient/routes/patient-routes.ts:307-323 (preHandler [EDIT] only); :385-387 sibling uses [EDIT, SCOPE_EDIT]",
        "docs/modules/WARDENX_MODULE_05_PATIENT_SPEC_v0_4.md:1243",
        "packages/auth/src/permissions/contributed.ts:314-319 (patient.edit_payers unused)",
        "apps/backend/src/modules/05-patient/patient-route-service-db.ts:480-482 (throw new Error)"
      ],
      "verified": true,
      "recommended_fix": "Use preHandler [requirePermission('patient.edit_payers'), chartScope('patient.edit_payers')] and throw NotFoundError on a missing patient.",
      "verification": "patient-routes.test.ts: patient.edit-only actor -> 403; edit_payers without caseload -> 404."
    },
    {
      "id": "GAP-007",
      "severity": "P1",
      "category": "seam",
      "module": "M05",
      "title": "Production M5 write routes publish no outbox events: admit, addAddress, addPayer, submitAmendment, decideAmendment write rows only (addAddress even returns a false cascadeEmitted literal). Bound live consumers (M12 DoseSpot sync, M24 revalidate, M33 census refresh, M22 statement of disagreement) never fire on route-driven changes.",
      "evidence": [
        "apps/backend/src/modules/05-patient/patient-route-service-db.ts:8-10 (header lists outbox emission as follow-up); :686-723 (cascadeEmitted literal at :722)",
        "apps/backend/src/modules/05-patient/index.ts:243-248 (outbox passed only to merge path)",
        "repo grep for m5.patient.(created|address_changed|payer_changed|amendment_decided) -> consumers + catalog + in-memory fake only",
        "apps/backend/src/modules/12-dosespot/consumers/index.ts:73-76; apps/backend/src/modules/24-billing-medicaid/outbox-consumers/m24-revalidate-triggers.ts:21"
      ],
      "verified": true,
      "recommended_fix": "Thread m5OutboxPublisher into createDbPatientRouteService and publish m5.patient.created / address_changed / payer_changed / amendment_request_received / amendment_decided inside the write's withOrgContext transaction.",
      "verification": "New live suite with the real catalog-validating publisher: POST /patients, /:id/addresses, /:id/payers each leave a matching outbox_event row in the same tx; bun run arch:outbox-bindings."
    },
    {
      "id": "GAP-008",
      "severity": "P1",
      "category": "spec-drift",
      "module": "M05",
      "title": "No production path creates patient_assignment rows (spec section 4.3 assignment write routes not implemented; inserts exist only in tests/seeds). The caseload source of truth is therefore empty: a non-org-wide clinician sees an empty census except via M17 shift data. Fails closed but care-team management is unusable.",
      "evidence": [
        "docs/modules/WARDENX_MODULE_05_PATIENT_SPEC_v0_4.md:1246-1248",
        "apps/backend/src/modules/05-patient/routes/patient-routes.ts:325-336 (only read-only GET /care-team)",
        "apps/backend/src/modules/05-patient/seams/drizzle-stores.ts:413-442 (reads patient_assignment)",
        "apps/backend/src/modules/05-patient/events-by-m5.ts:90,98 (assignment_created/ended catalogued, never emitted)"
      ],
      "verified": true,
      "recommended_fix": "Implement GET/POST /patients/:id/assignments and POST .../assignments/:assignmentId/end (patient.assign + caseload_or_scope, caseload-cache invalidation, emits) in patient-routes.ts / patient-route-service-db.ts; enrich in scripts/openapi/enrichments.ts.",
      "verification": "Live: POST an assignment, then GET /api/v1/patients as that non-org-wide clinician returns the patient; bun run openapi:coverage --check."
    },
    {
      "id": "GAP-009",
      "severity": "P1",
      "category": "spec-drift",
      "module": "M05",
      "title": "13 of 29 spec section 4.3 routes are not implemented (PATCH /patients/:id, status, deceased, identifiers POST, caregivers, assignments, patient-matches queue, unmerge, privacy resync, amendment list/statement). Demographics cannot be corrected after admit, and soft-match triage (0.75-0.92, spec D2) is skipped: admit returns matchReviewIds: [] and writes no patient_match_review. Status matrix shows 16/16 routes. (Death recording still works via the M6 discharge-death consumer.)",
      "evidence": [
        "docs/modules/WARDENX_MODULE_05_PATIENT_SPEC_v0_4.md:1232-1260,311",
        "apps/backend/src/modules/05-patient/routes/patient-routes.ts:215-456 (16 routes)",
        "apps/backend/src/modules/05-patient/patient-route-service-db.ts:354-356 (soft_review -> [])",
        "audit/implementation-status/IMPLEMENTATION_STATUS.md:17 (M05 routes 16/16)"
      ],
      "verified": true,
      "recommended_fix": "Add the missing handlers with the spec permission/ABAC pairs; persist patient_match_review rows on soft_review; enrich in scripts/openapi/enrichments.ts; document extras (census-metrics, demographics, care-team) in the spec.",
      "verification": "patient-routes.test.ts per route; live test that a soft-match admit yields a non-empty matchReviewIds and a patient_match_review row; bun run openapi:coverage --check."
    },
    {
      "id": "GAP-010",
      "severity": "P1",
      "category": "spec-drift",
      "module": "M06",
      "title": "No UI for live discharge, revocation, transfer-out/in or for-cause cosign, although the backend routes are live and in the typed client. The 06-admission web module's 8 screens include none of these, so staff cannot end or move a hospice episode (drives election close, LOC end, NOTR, final claim) from the UI.",
      "evidence": [
        "apps/backend/src/modules/06-admission/routes/admission-routes.ts:1022,1044,1065,1091,1113",
        "apps/web/src/modules/06-admission/screens.ts:42-100",
        "apps/web/src/modules/06-admission/admission-detail.tsx:139,1946",
        "docs/design/screens/clinical/WARDENX_UI_DISCHARGE_REVOCATION_TRANSFER.md:11-13; docs/design/SCREENS.md:93"
      ],
      "verified": true,
      "recommended_fix": "Add a discharge/revocation/transfer stepper screen (e.g. admission.discharge at /admissions/:id/discharge) in apps/web/src/modules/06-admission, launched from admission-detail.tsx, calling the four POST routes plus cosign-for-cause via the typed client; register it and add a DOM test.",
      "verification": "grep -rn 'admissions/{id}/discharge' apps/web/src returns a caller; bun run ui:parity lists the screen; DOM test drives the stepper."
    },
    {
      "id": "GAP-011",
      "severity": "P1",
      "category": "spec-drift",
      "module": "M08",
      "title": "Late-entry tier is never computed and the override sign-gate never runs: finalize never sets encounter.late_entry_tier (stays 'normal'), sign never checks for an override, and computeLateEntryTier / override deciders run only in unit tests. Override routes overwrite the tier with no tier-mismatch check and emit daysLate: 0; billing receives 'normal' for every encounter.",
      "evidence": [
        "apps/backend/src/modules/08-encounters/encounters-route-service-db.ts:1668-1736 (finalize UPDATE at 1702-1707 omits tier); :1774 (sign); :1953-2011 (overrides, daysLate: 0 at 1978/2008)",
        "grep computeLateEntryTier|checkLateEntryOverrideSatisfied -> apps/backend/__tests__/encounter-late-entry.test.ts + barrel only",
        "apps/backend/src/modules/08-encounters/gate/checks.ts:78-86 (late_entry_ceiling marked 'elsewhere')",
        "packages/db/migrations/0030_encounters_m8_tables.sql:7,52-56 (no trigger computes tier)"
      ],
      "verified": true,
      "recommended_fix": "In finalize() compute the tier with computeLateEntryTier and persist it; in sign()/signAddendum() call checkLateEntryOverrideSatisfied; in the override methods call decideSignificantLateOverride/decideAdministrativeLateOverride with the real tier, role and step-up and emit the real daysLate.",
      "verification": "M8 live suite: serviceDate 5 days ago -> finalize gives significant_late_entry; sign returns SIGNIFICANT_LATE_ENTRY_OVERRIDE_REQUIRED until route 15; route 15 on 'normal' -> LATE_ENTRY_TIER_MISMATCH."
    },
    {
      "id": "GAP-012",
      "severity": "P1",
      "category": "security",
      "module": "M08",
      "title": "Author-ownership ABAC (is_author, is_author_or_supervisor, is_addendum_author) is never registered or composed; finalize/enhance/decisions/sign, vitals/mileage/link-delete/evv-reconcile and addenda routes are permission-gated only and most lack encounter.scope. Any encounter.sign holder can sign another clinician's note anywhere in the tenant.",
      "evidence": [
        "apps/backend/src/modules/08-encounters/routes/encounters-routes.ts:291,303,352,364,436,448,463,477,488,500,626,658,669",
        "apps/backend/src/modules/08-encounters/abac-predicates.ts:44 (only m8.cosigner_role_match, encounter.scope)",
        "packages/auth/src/permissions/contributed.ts:1003,1009,1033,1063,1069 (declaration only)",
        "docs/modules/WARDENX_MODULE_08_ENCOUNTERS_SPEC_v0_2.md:1124-1135,1536-1540",
        "apps/backend/src/modules/08-encounters/encounters-route-service-db.ts:1786 (signer not compared to author)"
      ],
      "verified": true,
      "recommended_fix": "Register encounter.is_author / is_author_or_supervisor / is_addendum_author in 08-encounters/abac-predicates.ts and compose them plus SCOPE_FOR on routes 4-7, 9-14, 23-25.",
      "verification": "Route test with real DB resolver: non-author with encounter.sign -> 403/404 on POST /encounters/:id/sign; author succeeds; bun run arch:abac-predicates."
    },
    {
      "id": "GAP-013",
      "severity": "P1",
      "category": "security",
      "module": "M08",
      "title": "Late-entry override, administrative >14-day override and cosignature supervisor-release (spec rows 15, 16, 21) have no server-verified step-up; the TypeBox schemas still require a client stepUpAuthAt that nothing reads, and the route header wrongly claims route 21 carries step-up.",
      "evidence": [
        "apps/backend/src/modules/08-encounters/routes/encounters-routes.ts:510-521,524-535,593-605 (permission only); :134 STEP_UP used only at 500/582/669; :12-14 header",
        "apps/backend/src/modules/08-encounters/routes/encounters-typebox.ts:211-227",
        "apps/backend/src/modules/08-encounters/cosignature/cosignature.ts:134-152",
        "docs/modules/WARDENX_MODULE_08_ENCOUNTERS_SPEC_v0_2.md:1138,1139,1144"
      ],
      "verified": true,
      "recommended_fix": "Add STEP_UP('encounter.late_entry_override'), STEP_UP('encounter.administrative_override'), STEP_UP('encounter.cosign_supervisor_release') to those preHandlers and drop stepUpAuthAt from the schemas.",
      "verification": "Route test: each route returns 412 STEP_UP_AUTH_REQUIRED with stale step-up and succeeds when fresh."
    },
    {
      "id": "GAP-014",
      "severity": "P1",
      "category": "seam",
      "module": "M08",
      "title": "EncounterCreator is registered over the Drizzle store, which spreads the in-memory fallback and does not override insertDraftEncounter. Production drafts go to a per-process array with counter-derived ids (00000000-0000-4000-8000-...), which M19 links to triage calls (and M17 visit seeding uses). Calls can never reach 'documented' and ids collide across orgs/restarts.",
      "evidence": [
        "apps/backend/src/index.ts:1172",
        "apps/backend/src/modules/08-encounters/seams/drizzle-store.ts:12-15,56-58",
        "apps/backend/src/modules/08-encounters/seams/store.ts:98-101,135-147",
        "apps/backend/src/modules/19-oncall/clinical/encounter-link.ts:196-198,218-230",
        "apps/backend/src/modules/19-oncall/routes/write-service-drizzle.ts:912,935"
      ],
      "verified": true,
      "recommended_fix": "Implement insertDraftEncounter in seams/drizzle-store.ts as a real INSERT into encounter under withOrgContext via M8's draft path (audit + outbox); port or explicitly deny renderPayload and mileageForClinician so no in-memory method is reachable in production.",
      "verification": "Live: getSeam('EncounterCreator').createDraftEncounter as wardenx_app persists an encounter row; the M19 disposition flow links a real encounter."
    },
    {
      "id": "GAP-015",
      "severity": "P1",
      "category": "security",
      "module": "M11",
      "title": "No M11 PHI route enforces caseload_or_scope (GET /orders, /orders/:id, discontinue, queues); the route header falsely claims it is bound by default ABAC, which requirePermission never reads (unremediated F-092). Any orders.read holder reads every patient's orders in the org.",
      "evidence": [
        "apps/backend/src/modules/11-orders/routes/orders-routes.ts:10-11 (false header); :127-134 (only discipline/signer/cosigner ABAC); :140-156,272-283,394,547-562 ([READ]/[DISCONTINUE] only)",
        "packages/auth/src/rbac/require-role.ts:126-135",
        "docs/modules/WARDENX_MODULE_11_ORDERS_SPEC_v0_4.md:1187,1563,2421",
        "docs/history/gates-authz-and-routes.md:14-28 (F-092 fixed for M5 only)"
      ],
      "verified": true,
      "recommended_fix": "Compose requireAbac(<key>, 'caseload_or_scope', {notFoundOnDeny:true}) on per-order/per-patient routes and narrow list/queue SQL by M5 caseloadPatientIds unless hasOrgWideScope (F-096 pattern); correct the header.",
      "verification": "Live suite (wardenx_app): RN with a two-patient caseload sees only those orders; 404 on a third patient's order; medical_director sees all."
    },
    {
      "id": "GAP-016",
      "severity": "P1",
      "category": "security",
      "module": "M12",
      "title": "M12 order list/detail/transmission and /patients/:id/medications/active|history routes have no caseload_or_scope; only the refill inbox is narrowed. Any prescribing.read holder reads every patient's active medication list. Header falsely claims default-ABAC binding.",
      "evidence": [
        "apps/backend/src/modules/12-dosespot/routes/dosespot-routes.ts:10-12,111-123,129-133,180-183,366-369,380-404",
        "apps/backend/src/modules/12-dosespot/dosespot-route-service-db.ts:424-451,488-496 (no caseload predicate); :157-251,856-886 (refill-only narrowing)",
        "docs/modules/WARDENX_MODULE_12_DOSESPOT_PRESCRIBING_SPEC_v0_2.md:1025-1048,1261-1273"
      ],
      "verified": true,
      "recommended_fix": "Add requireAbac('prescribing.read','caseload_or_scope',{notFoundOnDeny:true}) to per-order/per-patient routes; narrow GET /medication-orders in SQL via the existing caseloadPatientIds helper unless hasOrgWideScope.",
      "verification": "Live (wardenx_app): off-caseload RN gets 404 on /patients/:id/medications/active and an empty /medication-orders list."
    },
    {
      "id": "GAP-017",
      "severity": "P1",
      "category": "stub",
      "module": "M12",
      "title": "No live DoseSpot transport: packages/dosespot/src/client has no http.ts and no fetch; the worker defaults to the deny-stub client and index.ts passes none, so NewRx, patient sync, enrollment and med-history never reach DoseSpot in any environment. Documented Phase-1 deny-stub; status matrix shows M12 Adapter green.",
      "evidence": [
        "packages/dosespot/src/client/unbound.ts:1-6",
        "apps/backend/src/modules/12-dosespot/jobs/worker.ts:34-38,119",
        "apps/backend/src/index.ts:5382-5389 (no doseSpotClient passed)",
        "audit/implementation-status/IMPLEMENTATION_STATUS.md:24"
      ],
      "verified": true,
      "recommended_fix": "Build packages/dosespot/src/client/http.ts (circuit-breaker-wrapped, per-tenant credentials), add DOSESPOT_* to apps/backend/src/bootstrap/env.ts and .env.example, bind it in the composition root when configured; tighten the status-matrix adapter heuristic.",
      "verification": "Contract test against a DoseSpot sandbox mock; m12-vendor-boundary.live shows a queued row reaching 'transmitted'; bun run status:matrix."
    },
    {
      "id": "GAP-018",
      "severity": "P1",
      "category": "stub",
      "module": "M12",
      "title": "POST /api/v1/rx-benefit/lookup returns a hardcoded {covered: true, copayCents: null} for every drug and patient instead of failing closed; no RxBenefit client method or cache exists. Fabricated coverage data on a live production API (no UI caller today).",
      "evidence": [
        "apps/backend/src/modules/12-dosespot/dosespot-route-service-db.ts:994-996",
        "apps/backend/src/modules/12-dosespot/routes/service.ts:366-370,1019-1021",
        "apps/backend/src/modules/12-dosespot/routes/dosespot-routes.ts:489-494",
        "docs/modules/WARDENX_MODULE_12_DOSESPOT_PRESCRIBING_SPEC_v0_2.md:53,1048"
      ],
      "verified": true,
      "recommended_fix": "Add a lookupRxBenefit client method and route rxBenefitLookup through it; return 503 or formularyStatus:'unknown' while unbound, never covered:true.",
      "verification": "Unit test: with the unbound client, POST /rx-benefit/lookup returns unavailable/unknown."
    },
    {
      "id": "GAP-019",
      "severity": "P1",
      "category": "spec-drift",
      "module": "M12",
      "title": "refill_inbox_policy and controlled_substance_policy tables do not exist; GET returns hardcoded defaults, PATCH persists nothing yet emits m12.controlled_substance_policy_changed {before, after}, and tighten-only refusals return 404 NOT_FOUND. Enforcement sites read DEFAULT_CS_POLICY constants directly. Fail-safe but the audit trail records changes that never took effect.",
      "evidence": [
        "apps/backend/src/modules/12-dosespot/dosespot-route-service-db.ts:1082-1122; :549,608,916 (DEFAULT_CS_POLICY reads)",
        "packages/types/src/errors.ts:83-89",
        "docs/modules/WARDENX_MODULE_12_DOSESPOT_PRESCRIBING_SPEC_v0_2.md:91,399,537-538,2105"
      ],
      "verified": true,
      "recommended_fix": "Add both tables via a new migration (RLS, FORCE, audit trigger) and to M12 ownedTables in architecture/module-manifest.ts and .cjs; persist put*, read stored values in refill approve and the EPCS gate, use 409/422 for tighten-only refusals.",
      "verification": "Live: PATCH controlled-substance-policy {scheduleIiiToVMaxRefills:2}, GET returns 2, approve with 3 refills -> 422; bun run arch:tables && bun run arch:tenancy."
    },
    {
      "id": "GAP-020",
      "severity": "P1",
      "category": "security",
      "module": "M13",
      "title": "Controlled-substance witness requirement and administering-discipline ABAC are keyed on the client-supplied body medClass; the order port carries no controlled-substance flag although M12 exposes isControlledSubstance. Sending medClass:'standard' for a Schedule II order skips the witness. Offline-sync is [RECORD] only and checks no per-row eligibility despite its comment. Five-rights validation against the order is still open (documented).",
      "evidence": [
        "apps/backend/src/modules/13-emar/emar-route-service-db.ts:714,836 (isControlled from body); :171-192 (port lacks class); :42-44 (five-rights open); :1318; :1336-1344 (offlineSync loop)",
        "apps/backend/src/modules/13-emar/index.ts:38-53",
        "apps/backend/src/modules/12-dosespot/seams/providers.ts:139",
        "apps/backend/src/modules/13-emar/routes/emar-routes.ts:90-101,330-334",
        "docs/modules/WARDENX_MODULE_13_EMAR_SPEC_v0_2.md:1286"
      ],
      "verified": true,
      "recommended_fix": "Carry isControlledSubstance/medClass from M12 getAdministrationContext into the administrationIdentity port; derive isControlled from the order and 422 on body disagreement; evaluate eligibility per row in offlineSync; implement the five-rights comparison.",
      "verification": "apps/backend/__tests__/m13-emar-write.live.test.ts: controlled order with body medClass 'standard' and no witness -> 422; LPN offline-sync of a compounded order -> 403/422."
    },
    {
      "id": "GAP-021",
      "severity": "P1",
      "category": "security",
      "module": "M13",
      "title": "eMAR read and many write routes (administrations, scheduled/missed doses, reconciliation, comfort-kit deployments) have no caseload_or_scope check; the header claims a binding that does not exist (named in F-092, unresolved). Services take no caseload input.",
      "evidence": [
        "apps/backend/src/modules/13-emar/routes/emar-routes.ts:11-13 (header); :100-122 (no caseload guard); :270-297,303,368,396,421,435,523,537",
        "apps/backend/src/modules/13-emar/abac-predicates.ts:24-25",
        "docs/modules/WARDENX_MODULE_13_EMAR_SPEC_v0_2.md:1275-1300,1490-1507",
        "docs/history/gates-authz-and-routes.md:16-22"
      ],
      "verified": true,
      "recommended_fix": "Compose requireAbac(..., 'caseload_or_scope', {notFoundOnDeny:true}) per spec row in emar-routes.ts; narrow list routes in SQL via M5 caseloadPatientIds unless hasOrgWideScope.",
      "verification": "Live: off-caseload RN gets 404 on GET /administrations/:id and an empty GET /administrations?patient=<other>."
    },
    {
      "id": "GAP-022",
      "severity": "P1",
      "category": "spec-drift",
      "module": "M13",
      "title": "Administration hard-void and the admin-policy PUT have no step-up (comments say 'enforced upstream'; no upstream gate exists) and no clinical_supervisor_or_above check; worksheet void and kit acknowledge-return lack supervisor predicates. voidAdministration has no status guard and bypasses the pure machine, so an already voided/superseded row can be voided again (second voided event). Diversion-relevant.",
      "evidence": [
        "apps/backend/src/modules/13-emar/routes/emar-routes.ts:74,262-268,510,576-577",
        "apps/backend/src/modules/13-emar/emar-route-service-db.ts:1273-1292,349-353",
        "packages/emar/src/lifecycle/administration-record.ts:13,122-123,309",
        "packages/auth/src/permissions/contributed.ts:1598,1690",
        "docs/modules/WARDENX_MODULE_13_EMAR_SPEC_v0_2.md:1281,1297,1300,1302"
      ],
      "verified": true,
      "recommended_fix": "Add requireStepUp('administration.void') plus a clinical_supervisor_or_above predicate to void; step-up on the admin-policy PUT; supervisor predicates on worksheet void and kit ack-return; refuse voided/superseded rows with 409.",
      "verification": "Route tests: void without step-up -> 403/412; non-supervisor RN -> 403; m13-emar-write live: double void -> 409."
    },
    {
      "id": "GAP-023",
      "severity": "P1",
      "category": "spec-drift",
      "module": "M14",
      "title": "PATCH /idg/decisions/:id rewrites emitted or superseded decisions: updateDecision has no status guard (unconditional UPDATE), no edit guard exists in packages/idg, no immutability trigger exists, and the route lacks idg_meeting_scope. Minutes already published to M7/M11/M12 can be silently rewritten; three code comments rely on the non-existent invariant.",
      "evidence": [
        "apps/backend/src/modules/14-idg/routes/idg-routes.ts:602-608",
        "apps/backend/src/modules/14-idg/idg-route-service-db.ts:1797-1820; :1319 (comment relying on invariant)",
        "packages/idg/src/lifecycle/decision.ts:62,94,124",
        "packages/db/migrations/0043_idg_m14_rls_audit_triggers.sql:123",
        "docs/modules/WARDENX_MODULE_14_IDG_SPEC_v0_4.md:483,878"
      ],
      "verified": true,
      "recommended_fix": "Add planDecisionEdit (DECISION_NOT_OPEN 409 unless open) to packages/idg/src/lifecycle/decision.ts; call it in updateDecision with a conditional UPDATE ... WHERE status='open'; add idg_meeting_scope and If-Match.",
      "verification": "packages/idg/__tests__/decision.test.ts; m14-idg-write live: PATCH an emitted decision -> 409 DECISION_NOT_OPEN."
    },
    {
      "id": "GAP-024",
      "severity": "P1",
      "category": "spec-drift",
      "module": "M14",
      "title": "Supersede writes the successor into the prior (already adjourned) meeting with the prior payload, hardcodes wasQuorate: true, ignores the request body and skips quorate_decision and idg_meeting_scope. The successor stays 'open' forever (emit only happens at adjournment), while the prior is marked superseded.",
      "evidence": [
        "apps/backend/src/modules/14-idg/idg-route-service-db.ts:1822-1855; :1273-1281 (only emit path)",
        "packages/idg/src/lifecycle/decision.ts:124-138",
        "apps/backend/src/modules/14-idg/routes/idg-routes.ts:611-620 (vs record route :584-587)",
        "apps/backend/src/modules/14-idg/routes/idg-typebox.ts:212-214",
        "docs/modules/WARDENX_MODULE_14_IDG_SPEC_v0_4.md:483,877"
      ],
      "verified": true,
      "recommended_fix": "Require a target live meetingId and new payload in SupersedeDecisionRequest; gate with idg_meeting_scope + quorate_decision on the target; insert the successor into the target meeting with live quorum; mark the prior superseded in the same tx.",
      "verification": "m14-idg-write live: supersede into a live quorate meeting emits on its adjournment; into the adjourned origin or without quorum -> 422."
    },
    {
      "id": "GAP-025",
      "severity": "P1",
      "category": "stub",
      "module": "M14",
      "title": "PATCH /idg/agenda/:id discards its body and returns the row unchanged (undocumented); DELETE /idg/agenda/:id returns {removed: true} without writing (documented compromise #2). Because a patient-scoped agenda item is the Phase-1 decision-inclusion signal, a 'removed' patient stays decision-eligible. Both routes lack idg_meeting_scope.",
      "evidence": [
        "apps/backend/src/modules/14-idg/routes/idg-routes.ts:551-556,559-563",
        "apps/backend/src/modules/14-idg/idg-route-service-db.ts:1528-1547; :22-27 (compromises); :253-265 (patientIncluded)",
        "packages/db/migrations/0042_idg_m14_tables.sql:60-74",
        "docs/modules/WARDENX_MODULE_14_IDG_SPEC_v0_4.md:871-872"
      ],
      "verified": true,
      "recommended_fix": "Add a status/tombstone column (new migration, check arch:migration-numbering); implement real update and soft delete and exclude removed items from patientIncluded; return 501/409 until then; add idg_meeting_scope via meeting resolution.",
      "verification": "Live: DELETE an agenda item, then POST a decision for that patient -> 422 INCLUSION_CRITERIA_FAILED; PATCH reflects in GET /meetings/:id/agenda."
    },
    {
      "id": "GAP-026",
      "severity": "P1",
      "category": "spec-drift",
      "module": "M14",
      "title": "Child-resource mutations (attendance, agenda, decisions, supersede, action-items, recurring-policies) skip idg_meeting_scope, If-Match and Idempotency-Key (only discipline-notes PATCH implements the pattern); a location-A coordinator can edit location B's meetings. Attendance (418.56 quorum evidence) can be changed after adjournment and action-item updates do not check the assignee.",
      "evidence": [
        "apps/backend/src/modules/14-idg/routes/idg-routes.ts:210,428,436,551,559,603,611-613,684,692; :868-889 (discipline-notes pattern)",
        "apps/backend/src/modules/14-idg/abac-predicates.ts:6-10,71-73",
        "apps/backend/src/modules/14-idg/idg-route-service-db.ts:1475-1502,1894-1922",
        "docs/modules/WARDENX_MODULE_14_IDG_SPEC_v0_4.md:862,870-882,890"
      ],
      "verified": true,
      "recommended_fix": "Generalise the discipline-notes pattern: resolve meetingId from the child id, apply requireAbac(<key>,'idg_meeting_scope'), add IF_MATCH and IDEMPOTENCY_KEY to every PATCH/DELETE; refuse attendance changes post-start/adjourn; require assignee===actor for idg.act-only callers.",
      "verification": "14-idg route tests: cross-location PATCH -> 404; missing If-Match -> 400; attendance PATCH after adjourn -> 422 MINUTES_FINAL; m14-idg-write live."
    },
    {
      "id": "GAP-027",
      "severity": "P1",
      "category": "security",
      "module": "M14",
      "title": "IDG patient packet detail/list and GET /patients/:patientId/idg-history skip the per-patient caseload_or_scope check (only meeting-location scope + SUD filter; idg-history has only idg.read). The abac-predicates.ts header falsely claims caseload is carried.",
      "evidence": [
        "apps/backend/src/modules/14-idg/routes/idg-routes.ts:118-119,459-475,478-516,518-533",
        "apps/backend/src/modules/14-idg/abac-predicates.ts:38-39",
        "docs/modules/WARDENX_MODULE_14_IDG_SPEC_v0_4.md:872-873,1362,1437-1438"
      ],
      "verified": true,
      "recommended_fix": "Add requireAbac('idg.read','caseload_or_scope',{notFoundOnDeny:true}) with a patientId target to packet detail and idg-history; filter the packet list per patient by caseload unless hasOrgWideScope.",
      "verification": "Route + live test: an attendee outside the patient's caseload gets 403/404 on /packets/:patientId and /patients/:id/idg-history."
    },
    {
      "id": "GAP-028",
      "severity": "P1",
      "category": "stub",
      "module": "M16",
      "title": "M16 has no BullMQ workers: plans never close at death+13 months (CoP 418.64(d)), outreach never becomes 'missed' (so /outreach/:id/late-attempt can never succeed), anniversary alerts never fire and the unreachable detector never proposes. No documented deferral.",
      "evidence": [
        "apps/backend/src/modules/16-bereavement (no jobs/ directory)",
        "apps/backend/src/modules/16-bereavement/lifecycle/plan.ts:108,145,148,373; lifecycle/outreach.ts:56,83-85,177-189 (no callers)",
        "apps/backend/src/modules/16-bereavement/routes/outreach.routes.ts:143-148",
        "apps/backend/src/index.ts:445-462 (no M16 cron/worker)",
        "docs/modules/WARDENX_MODULE_16_BEREAVEMENT_SPEC_v0_5.md:1549-1566"
      ],
      "verified": true,
      "recommended_fix": "Add apps/backend/src/modules/16-bereavement/jobs/ with close-13mo, miss-deadline, anniversary-lookahead and unreachable-detector crons (active-org fan-out, withOrgContext, DB-state pre-check) wired in index.ts.",
      "verification": "Live: plan with death_date 14 months ago -> closed_completed after one tick; scheduled outreach past late_grace_until -> missed + m16.bereavement.outreach_missed."
    },
    {
      "id": "GAP-029",
      "severity": "P1",
      "category": "seam",
      "module": "M16",
      "title": "M16 section 4.5 subscriptions to m8.encounter.signed (bereavement_contact -> contact_log + complete outreach), m22.document.rendered (rendered_document_id) and m4.legal_hold.* are unbuilt; producers do not declare m16, so arch:outbox-bindings is silent. The M8 bereavement_contact subscriber is part of the spec's binding done gate.",
      "evidence": [
        "apps/backend/src/modules/16-bereavement/outbox-consumers/ (7 consumers, none for these events)",
        "apps/backend/src/modules/08-encounters/events-by-m8.ts:142; apps/backend/src/modules/22-documents/events-by-m22.ts:72; apps/backend/src/modules/04-audit/events-by-m4.ts:37,47",
        "docs/modules/WARDENX_MODULE_16_BEREAVEMENT_SPEC_v0_5.md:55,1456-1466"
      ],
      "verified": true,
      "recommended_fix": "Add M16 outbox consumers for m8.encounter.signed (encounter_type=bereavement_contact) and m22.document.rendered (bereavement templates); add m16 to the producers' declaredConsumers and bind both in apps/backend/src/index.ts.",
      "verification": "Live: signing a bereavement_contact encounter completes the linked outreach and appends contact_log; a rendered sympathy_letter sets rendered_document_id; bun run arch:outbox-bindings."
    },
    {
      "id": "GAP-030",
      "severity": "P1",
      "category": "security",
      "module": "M17",
      "title": "M17 visit reads (list, get, day/week/map views, proposals) and visit.start/arrive are gated by requirePermission only; listVisits applies no caseload or own-membership filter and visit.read_team is never checked. Any field clinician lists every patient's visits and address ids in the org.",
      "evidence": [
        "apps/backend/src/modules/17-scheduling/routes/scheduling-routes.ts:86-87,165-196,231-310,474-495",
        "apps/backend/src/modules/17-scheduling/scheduling-route-service-db.ts:852-885,2061-2075",
        "packages/db/migrations/0045_scheduling_m17_rls_audit_triggers.sql:182-186 (org-only RLS)",
        "docs/modules/WARDENX_MODULE_17_SCHEDULING_SPEC_v0_2.md:129,716,990-992,1235,1319"
      ],
      "verified": true,
      "recommended_fix": "Bind requireAbac(key,'caseload_or_scope',{getTarget: patientId from visit}) on per-visit routes; narrow listVisits/dayView/weekView to caseload or own membership unless visit.read_team or org-wide scope.",
      "verification": "Live (wardenx_app): RN without a caseload link sees zero rows for an unrelated patient and gets 404/403 on GET /visits/:id; scheduler with visit.read_team sees all."
    },
    {
      "id": "GAP-031",
      "severity": "P1",
      "category": "security",
      "module": "M17",
      "title": "Own-vs-any permission scoping is not enforced for availability and time-off: routes gate on *_own keys only and services ignore the caller, so any clinician can overwrite a colleague's availability, cancel their approved PTO or file PTO on their behalf (PTO feeds the not_on_pto scheduling gate).",
      "evidence": [
        "apps/backend/src/modules/17-scheduling/routes/scheduling-routes.ts:102-106,412-472",
        "apps/backend/src/modules/17-scheduling/scheduling-route-service-db.ts:1871-1905,1908-1955,2037-2058",
        "docs/modules/WARDENX_MODULE_17_SCHEDULING_SPEC_v0_2.md:710-715,976-983,991-992"
      ],
      "verified": true,
      "recommended_fix": "Resolve own-vs-any: require edit_any/read_team/approve when the target membership is not the caller's; force requestTimeOff.membershipId to the caller unless approve; add an ownership check to cancelTimeOff.",
      "verification": "Inject tests: *_own-only RN gets 403 on PUT /availability/<other>, POST /time-off for another membership, cancel of another's PTO, and sees only own rows on GET /time-off."
    },
    {
      "id": "GAP-032",
      "severity": "P1",
      "category": "spec-drift",
      "module": "M17",
      "title": "PTO approval never runs the reassignment scan or emits m17.reassignment_needed; affectedPublishedVisitCount and conflictingVisitCount are hardcoded 0 and no reassignment-scan worker exists (route comment falsely says it runs in-service). Visits assigned to a clinician on approved PTO stay published with no alert.",
      "evidence": [
        "apps/backend/src/modules/17-scheduling/scheduling-route-service-db.ts:1963,1984,2000",
        "apps/backend/src/modules/17-scheduling/jobs/index.ts (only recurringMaterialize, visitAttention)",
        "packages/scheduling/src/lifecycle/effects.ts:64",
        "apps/backend/src/modules/17-scheduling/routes/scheduling-routes.ts:450",
        "docs/modules/WARDENX_MODULE_17_SCHEDULING_SPEC_v0_2.md:83,270,305,713,1060"
      ],
      "verified": true,
      "recommended_fix": "In approveTimeOff's tx select overlapping published visits, emit m17.reassignment_needed (reason 'pto') per visit and populate the real counts in both events.",
      "verification": "Live: seed a published visit inside a PTO window, approve PTO, assert one m17.reassignment_needed outbox row and affectedPublishedVisitCount=1."
    },
    {
      "id": "GAP-033",
      "severity": "P1",
      "category": "security",
      "module": "M17",
      "title": "M17 (36 call sites) and M18 (25) open withOrgContext with userId: \"\", so M4 write-audit triggers record a NULL actor_user_id on visit, time_off, availability, evv_event and missing-resolution writes. Same pattern in the M5-M11 and M39 route services (documented 'M8-M17 convention' compromise).",
      "evidence": [
        "apps/backend/src/modules/18-evv/evv-route-service-db.ts:19-21 (compromise 1)",
        "apps/backend/src/modules/17-scheduling/scheduling-route-service-db.ts:1070-1093 (cancelVisit drops userId)",
        "packages/db/migrations/0045_scheduling_m17_rls_audit_triggers.sql:258 (NULLIF(app.user_id,''))",
        "packages/tenancy/src/context.ts:63",
        "grep -c 'userId: \"\"': scheduling 36, evv 25; admission 49, encounters 37, hope 32, orders 29, care-plan 21, assessments 19, consent 20, patient 9"
      ],
      "verified": true,
      "recommended_fix": "Pass the acting user/membership id into withOrgContext in every route DB service (M5-M11, M17, M18, M39), as M16/M19/M20 do.",
      "verification": "Live: POST /api/v1/visits/:id/cancel, assert audit_event.actor_user_id equals the caller."
    },
    {
      "id": "GAP-034",
      "severity": "P1",
      "category": "security",
      "module": "M18",
      "title": "EVV capture decides 'pass' from GPS accuracy alone and never computes distance to the patient address, yet emits m18.evv.at_patient_address (and breach) with a fabricated computedDistanceM: 0 and then visit_verified (consumed by M30). Documented compromise #3, but on the Cures Act EVV verification path.",
      "evidence": [
        "apps/backend/src/modules/18-evv/evv-route-service-db.ts:29-31,305-314,357,373-390,420-444,65",
        "apps/backend/src/modules/18-evv/domain/geofence.ts:64,98 (haversineMeters unused)",
        "apps/backend/src/modules/30-quality/outbox-consumers/upstream-events.ts"
      ],
      "verified": true,
      "recommended_fix": "Resolve the patient-address baseline via the M5 PatientAddressReader, compute haversine distance, drive decisions through the domain capture machine (outside_geofence -> open missing-resolution, spoof detection) and persist computed_distance_m.",
      "verification": "Live: check-in 5 km away with 10 m accuracy -> outside_geofence + open evv_missing_resolution, no at_patient_address/visit_verified."
    },
    {
      "id": "GAP-035",
      "severity": "P1",
      "category": "stub",
      "module": "M18",
      "title": "M18 has no BullMQ workers: no aggregator submission is ever created (Cures Act state-aggregator path cannot start), dispatchSubmission/pollSubmissionOnce have no caller, no late-check sweep creates missing-resolution rows, and 7 catalogued events (aggregator_submitted/accepted/rejected/timeout, gps_spoof_suspected, late_check_out_detected, verification_pdf_requested) are never emitted, leaving the M19 late-checkout and M20 gps-spoof consumers dead.",
      "evidence": [
        "apps/backend/src/modules/18-evv (no jobs/ directory)",
        "packages/db/migrations/0047_evv_m18_rls_audit_triggers.sql:184 (only grant; no insert into evv_aggregator_submission)",
        "apps/backend/src/modules/18-evv/submission-flow.ts:38,77",
        "apps/backend/src/modules/18-evv/evv-route-service-db.ts:660 (only insert(MR))",
        "apps/backend/src/modules/19-oncall/consumers/m18-late-checkout.ts:31-34; apps/backend/src/modules/20-field-safety/consumers/bindings.ts:359-361",
        "docs/modules/WARDENX_MODULE_18_EVV_SPEC_v0_2.md:1195-1212"
      ],
      "verified": true,
      "recommended_fix": "Add apps/backend/src/modules/18-evv/jobs/ with late-check-sweep, aggregator-submission-prep, submitter and poller workers (withOrgContext per org) registered in index.ts.",
      "verification": "Live: check-out on an aggregation-state visit produces a queued evv_aggregator_submission; an in_visit visit past grace produces an open missing_resolution and an m18.evv.late_check_out_detected row consumed by M19."
    },
    {
      "id": "GAP-036",
      "severity": "P1",
      "category": "security",
      "module": "M18",
      "title": "POST /evv/offline-sync gates only on evv.check_in and calls recordCapture with each event's client-supplied kind (check_out allowed) and visitId; assigned-clinician and visit-window ABAC run only on /check-in and /check-out. Any member with evv.check_in and an approved device can post EVV events for any visit at any time.",
      "evidence": [
        "apps/backend/src/modules/18-evv/routes/evv-routes.ts:112-115,123,141,157-174",
        "apps/backend/src/modules/18-evv/evv-route-service-db.ts:186-201,285-303,515-530",
        "docs/modules/WARDENX_MODULE_18_EVV_SPEC_v0_2.md:778-780"
      ],
      "verified": true,
      "recommended_fix": "Run assigned-clinician, window and per-kind permission checks per event in the offline-sync handler or captureInTx; reject or quarantine failures.",
      "verification": "Inject test: unassigned clinician offline-sync -> 403/per-event rejection; a check_out in the batch requires evv.check_out."
    },
    {
      "id": "GAP-037",
      "severity": "P1",
      "category": "security",
      "module": "M18",
      "title": "EVV GPS coordinates (PHI) are stored as base64('lat,lng') in coords_cipher / device_coords_cipher stamped coords_dek_version=1; that is not encryption and misleads erasure/audit reports. M20 deliberately refuses the same pattern. Documented deferral (compromise #2 / D10).",
      "evidence": [
        "apps/backend/src/modules/18-evv/coords.ts:12-18,25-27",
        "apps/backend/src/modules/18-evv/evv-route-service-db.ts:22-27,316,336,356",
        "apps/backend/src/index.ts:3771-3781 (M20 refuses cleartext in _cipher)"
      ],
      "verified": true,
      "recommended_fix": "Bind the per-tenant DEK envelope cipher (getTenantKeyProvider) in encodeStoredCoords; until then store NULL with a sentinel as M20 does.",
      "verification": "Unit: encodeStoredCoords output not decodable without the DEK; live: coords_cipher does not base64-decode to 'lat,lng'."
    },
    {
      "id": "GAP-038",
      "severity": "P1",
      "category": "stub",
      "module": "M19",
      "title": "M19 Tier-1 crons are unbuilt: shift-open/close, the proactive 24h coverage-gap watchdog, callback-sla, awaiting-callback-timeout, close-documented and escalation-sla. No callback/escalation SLA alerts, calls never time out or auto-close. (A reactive coverage_gap emit exists for no-show/late-checkout triggers; manual shift activate/complete routes exist.)",
      "evidence": [
        "apps/backend/src/modules/19-oncall/jobs/index.ts:19-22; jobs/worker.ts:151-160; apps/backend/src/index.ts:5414-5418",
        "apps/backend/src/modules/19-oncall/alerts.ts:194 (no caller)",
        "apps/backend/src/modules/19-oncall/roster/shift-machine.ts:212,217",
        "apps/backend/src/modules/19-oncall/consumers/bindings.ts:244,262 (reactive coverage_gap only)",
        "docs/modules/WARDENX_MODULE_19_ONCALL_TRIAGE_SPEC_v0_3.md:1339,1345-1356"
      ],
      "verified": true,
      "recommended_fix": "Add M19 cron workers for shift-open/close, coverage-gap-watchdog, callback-sla, awaiting-callback-timeout, close-documented and escalation-sla (active-org fan-out under withOrgContext, M19_PLATFORM_JOB_ID allowlist) registered in index.ts.",
      "verification": "Live: no clinical_rn shift in next 24h -> one m19.oncall_shift.coverage_gap + critical alert; awaiting_callback past SLA emits callback_sla_breached."
    },
    {
      "id": "GAP-039",
      "severity": "P1",
      "category": "stub",
      "module": "M20",
      "title": "The 30-second check-in overdue detector (core lone-worker safety control) does not exist; M20 registers only the SOS SLA watchdog and decideOverdueCheckIn has no production caller. A missed safety check-in raises no alert unless someone opens the dashboard. post-visit-window-closer, high-risk-area-evaluator, coverage-gap-watchdog, sos-location-stream, policy housekeeper and dek-rotation are also absent.",
      "evidence": [
        "apps/backend/src/modules/20-field-safety/jobs/index.ts:11-16; jobs/cron-workers.ts:567,645-647,656",
        "apps/backend/src/index.ts:5077,5083",
        "apps/backend/src/modules/20-field-safety/lifecycle/check-in-overdue.ts:206 (no caller)",
        "apps/backend/src/modules/20-field-safety/seams/providers.ts:652-663 (read-time only)",
        "docs/modules/WARDENX_MODULE_20_FIELD_SAFETY_SPEC_v0_3.md:1392-1410"
      ],
      "verified": true,
      "recommended_fix": "Add the overdue-detector cron over safety_check_in_schedule applying decideOverdueCheckIn effects (state flip, outbox, M36 alert) per org under withOrgContext; add post-visit-window-closer and coverage-gap-watchdog.",
      "verification": "Live: schedule row past expected_at+window becomes overdue after one tick and emits m20.safety.check_in_overdue."
    },
    {
      "id": "GAP-040",
      "severity": "P1",
      "category": "stub",
      "module": "M20",
      "title": "The M20 DEK cipher port is deliberately unbound, so POST /safety/incidents (and patch, narrative resolve, action plan) always return 503 SAFETY_CIPHER_UNBOUND and SOS/check-in coordinates are discarded for a sentinel. Field-staff incident reporting (workers-comp/OSHA) is unusable in production. Documented fail-closed.",
      "evidence": [
        "apps/backend/src/index.ts:3771-3792 (buildDrizzleM20WriteService without cipher)",
        "apps/backend/src/modules/20-field-safety/routes/write-service-drizzle.ts:121-134,288-292,337-346,565-569 (seal callers 1119,1203,1262,1266,1361,1365,1429,1534,2014)"
      ],
      "verified": true,
      "recommended_fix": "Provide the per-tenant DEK envelope cipher (shared M34 key ring via getTenantKeyProvider) and pass it as `cipher` to buildDrizzleM20WriteService in apps/backend/src/index.ts.",
      "verification": "Docker stack: POST /api/v1/safety/incidents -> 201 and narrative_cipher is not plaintext; SOS persists postedCoordinatesCipher."
    },
    {
      "id": "GAP-041",
      "severity": "P1",
      "category": "spec-drift",
      "module": "M21",
      "title": "None of the M21 section 4.6 crons exist: par_monitor, unreturned_kit_monitor (30-day overdue flip + compliance escalation), invoice_reconciliation. detectReturnEscalation and runParMonitor have no caller and markOverdue is never driven, so overdue comfort-kit (controlled substance) escalation and par alerts never fire. Only the manual declare-unreturnable route remains.",
      "evidence": [
        "grep par_monitor|unreturned_kit|invoice_reconciliation -> doc comments only",
        "apps/backend/src/modules/21-supplies/lifecycle/return.ts:196-208,409",
        "apps/backend/src/modules/21-supplies/lifecycle/par-stock.ts:9-12,72",
        "packages/emar/src/cascade/discharge-cascade.ts:140 (M13 counterpart also unwired)",
        "docs/modules/WARDENX_MODULE_21_SUPPLIES_DME_COMFORT_KITS_SPEC_v0_2.md:429,2322-2328,3020-3027"
      ],
      "verified": true,
      "recommended_fix": "Add apps/backend/src/modules/21-supplies/jobs/ with par-monitor and unreturned-kit-monitor crons (active-org fan-out, withOrgContext, detectReturnEscalation -> markOverdue effects, runParMonitor -> outbox/alerts) registered in index.ts.",
      "verification": "Integration tests unreturned-kit-cron-30d/90d: dispatch with patient deceased 31/91 days ago -> state flip + outbox events."
    },
    {
      "id": "GAP-042",
      "severity": "P1",
      "category": "stub",
      "module": "M23",
      "title": "NOE/NOTR 5-day window-watch and eligibility stale-watch crons are scheduled but every tick throws: buildM23WorkerDeps receives no activeOrgs or noticeWindow port (M23 is the only cron module without activeOrgs). Spec 4.8 rows and acceptance 7.5 (day-3 warning, breach stamp, claim block) never run; late NOE makes days non-covered. Only an inline TODO records it.",
      "evidence": [
        "apps/backend/src/index.ts:4619-4641 (no activeOrgs/noticeWindow); :4643-4650 (comment admits); :4661 scheduleM23Jobs",
        "apps/backend/src/modules/23-billing-medicare/jobs/m23-jobs.ts:566-576 (unboundWorkerPort default); :1361,1432,1494; :1771-1797; :1889-1933",
        "grep 'activeOrgs:' apps/backend/src/index.ts -> every cron module except M23"
      ],
      "verified": true,
      "recommended_fix": "Build an M23 enumerator with buildActiveOrgEnumerator (same as m24ActiveOrgs/m25ActiveOrgs) and pass activeOrgs; bind noticeWindow to the noe-notr-state-service breach stamp; register M23 cron jobIds in PLATFORM_CONTEXT_ALLOWLIST.",
      "verification": "Live: NOE with windowTargetAt in the past + runNoeWindowWatch with index.ts-built deps sets window_breached_at and emits m23.noe.window_breached."
    },
    {
      "id": "GAP-043",
      "severity": "P1",
      "category": "seam",
      "module": "M23",
      "title": "The revalidate.consumer queue has a live producer (six F-153 outbox triggers + F-162) but no Worker: only the never-called registerM23Workers constructs it (plus validationRun and eligibilityRefresh). Jobs pile up in Valkey and READY/VALIDATING claims are never re-validated when CTI/F2F/LOC change. index.ts and the trigger file header wrongly claim the worker is registered; enqueue/validationRunner ports are also unbound.",
      "evidence": [
        "apps/backend/src/index.ts:2404,6548 (producer; wrong comment 6545-6547); :4642-4651 (only Launch + Cron workers)",
        "apps/backend/src/modules/23-billing-medicare/jobs/m23-jobs.ts:396-404,1175-1199,1650-1715,1718-1764,1773-1800",
        "apps/backend/src/modules/23-billing-medicare/outbox-consumers/m23-revalidate-triggers.ts:7-9"
      ],
      "verified": true,
      "recommended_fix": "Register Workers for revalidateConsumer and validationRun in index.ts (call registerM23Workers with bound deps or add them to the launch set); bind enqueue and validationRunner; fix the header.",
      "verification": "Live: publish m6.cti.signed for a patient with a READY claim, drain with index.ts-built workers, assert a new validation_run row."
    },
    {
      "id": "GAP-044",
      "severity": "P1",
      "category": "stub",
      "module": "M23",
      "title": "POST /api/v1/claims/:id/validation-runs/:runId/results/:resultId/override always returns 503 SEAM_UNBOUND: the override audit port defaults to denyAudit and index.ts passes none; no implementation of recordOverrideAudit exists. The compliance_officer escape hatch for evv_bracket_coherence (severity error) is dead, blocking claims.",
      "evidence": [
        "apps/backend/src/modules/23-billing-medicare/routes/write-service-drizzle.ts:253-257,284,786-797",
        "apps/backend/src/index.ts:3494-3498",
        "apps/backend/src/modules/23-billing-medicare/routes/validation.routes.ts:86-95",
        "packages/billing/src/rules/evv-coherence.ts:23-26"
      ],
      "verified": true,
      "recommended_fix": "Implement an AuditEventPort over @wardenx/audit writing the audit_event in the caller tx and pass it as `audit` at apps/backend/src/index.ts:3494.",
      "verification": "Docker stack / Drizzle service as built by index.ts: override returns 200 and writes validation_override with non-null audit_event_id."
    },
    {
      "id": "GAP-045",
      "severity": "P1",
      "category": "stub",
      "module": "M23",
      "title": "POST /api/v1/billing/eligibility/check always returns 503: the outbox-backed submission gate admits only claim/noe/notr queue names, the eligibility.refresh worker lives in never-called registerM23Workers, and the HETS port is unbound. No eligibility_check rows are produced (spec route 22, acceptance 7.14); freshness rule skips so claims are not blocked.",
      "evidence": [
        "apps/backend/src/modules/23-billing-medicare/routes/write-service-drizzle.ts:1019-1033",
        "apps/backend/src/modules/23-billing-medicare/outbox-consumers/submit-requests.ts:8-13,100-112",
        "apps/backend/src/index.ts:3496,4645-4652",
        "apps/backend/src/modules/23-billing-medicare/jobs/m23-jobs.ts:506-516,1650,1700",
        "packages/billing/src/rules/eligibility-freshness.ts:24-31"
      ],
      "verified": true,
      "recommended_fix": "Bind a HETS 270/271 port, add an eligibility.refresh producer or dedicated queue port and register the eligibilityRefresh worker; until then document the deferral and disable the UI action.",
      "verification": "Docker stack: POST /api/v1/billing/eligibility/check -> 202 and the worker appends an eligibility_check row."
    },
    {
      "id": "GAP-046",
      "severity": "P1",
      "category": "stub",
      "module": "M24",
      "title": "rb_day rows are never created in production: the rb-day-daily-sweep worker body only lists active orgs, RbDaySweepStore has no implementation, and registerM24CronWorkers/scheduleM24Jobs are never called. Combined hospice + room-and-board claims never carry rev 0658 / Q5003 lines; the eligibility stale watchdog is the same no-op.",
      "evidence": [
        "apps/backend/src/modules/24-billing-medicaid/routes/write-service-drizzle.ts:608-651",
        "apps/backend/src/modules/24-billing-medicaid/jobs/index.ts:7-9,43-57",
        "apps/backend/src/modules/24-billing-medicaid/jobs/m24-jobs.ts:3-5",
        "apps/backend/src/index.ts:4705-4752",
        "docs/modules/WARDENX_MODULE_24_BILLING_MEDICAID_SPEC_v0_2_1.md:315,335,398,415",
        "docs/history/outbox-248-builds.md:788-789,1506-1508 (noted in passing only)"
      ],
      "verified": true,
      "recommended_fix": "Implement RbDaySweepStore.sweepPendingDays over the M6 LOC snapshot + rb_arrangement (idempotent on (patient_id, service_date)) and a real eligibility watchdog store; wire registerM24CronWorkers with m24ActiveOrgs and call scheduleM24Jobs in index.ts.",
      "verification": "Live: activate an rb_arrangement, run the sweep, assert rb_day rows; assemble a combined claim with revenue code 0658 lines."
    },
    {
      "id": "GAP-047",
      "severity": "P1",
      "category": "seam",
      "module": "M25",
      "title": "buildM23ClaimRejectedConsumer and buildM18EvvAggregatorRejectedConsumer are written and live-tested but never constructed in apps/backend/src/index.ts. m25 is the only declared consumer of both events, so the dispatcher defers them forever (rows stay pending, never dead-letter) and 277CA/999/aggregator rejections never seed denials. arch:outbox-bindings is falsely green (counts factories on disk); the deferral register says the group is 'GONE'.",
      "evidence": [
        "apps/backend/src/modules/25-remittance/outbox-consumers/m23-claim-rejected.ts:98; m18-evv-aggregator-rejected.ts:125",
        "apps/backend/src/modules/25-remittance/index.ts:134 (only buildM25EdiReceivedConsumer exported)",
        "apps/backend/src/index.ts:688,6422 (only EDI-received consumer wired)",
        "apps/backend/src/bootstrap/outbox-dispatcher.ts:287-290,438-446",
        "scripts/check-outbox-bindings.ts:157-163; scripts/outbox-deferred-consumers.ts:564-568"
      ],
      "verified": true,
      "recommended_fix": "Add both consumers to the org-scoped consumer array next to buildM25EdiReceivedConsumer in apps/backend/src/index.ts; harden scripts/check-outbox-bindings.ts so every discovered build*Consumer factory must be reachable from the composition root.",
      "verification": "grep -n 'buildM23ClaimRejectedConsumer\\|buildM18EvvAggregatorRejectedConsumer' apps/backend/src/index.ts; bun run test:m25:denial-seed-consumers:live; boot test asserting neither event is in buildOutboxRoutingPlan(...).deferred."
    },
    {
      "id": "GAP-048",
      "severity": "P1",
      "category": "security",
      "module": "M27",
      "title": "Cost-report submit's two-person check compares the actor with an optional, caller-supplied approvedByMembershipId; approveForSubmit never persists the approver (no column). A user holding both approve_for_submit and submit can approve then submit with the field omitted, defeating W-CR-11 and the STRIDE elevation-of-privilege mitigation.",
      "evidence": [
        "apps/backend/src/modules/27-cost-report/routes/write-service-drizzle.ts:1107-1134,1150-1157",
        "apps/backend/src/modules/27-cost-report/routes/cost-report-typebox.ts:152,158",
        "apps/backend/src/modules/27-cost-report/routes/cost-reports.routes.ts:180,197",
        "packages/db/src/schema/cost-report/cost-report.ts:26",
        "M27 spec section 7.11 W-CR-11 (lines 1552-1554), section 8.3 line 1599"
      ],
      "verified": true,
      "recommended_fix": "Add approved_by_membership_id to cost_report (migration + Drizzle schema), set it in approveForSubmit, compare actor.membershipId with the persisted value at submit; remove approvedByMembershipId from the submit body schemas.",
      "verification": "Live: same membership approves then submits with no approvedByMembershipId -> 403 TWO_PERSON_CONTROL_VIOLATION; run m27-cost-report-workflow-slice.live.test.ts."
    },
    {
      "id": "GAP-049",
      "severity": "P1",
      "category": "spec-drift",
      "module": "M28",
      "title": "The FHIR gateway serves only Patient, Encounter (search), MedicationRequest and MedicationAdministration; DiagnosticReport, Practitioner, Condition, CarePlan, Goal, Observation, DocumentReference, Coverage and the rest of the Phase-1 set are absent (W-FHIR-13..16 unmet). The DiagnosticReport projector exists and the M29 LabObservationReader is registered, but neither is used. Undermines the ONC/USCDI and information-blocking posture.",
      "evidence": [
        "apps/backend/src/modules/28-fhir/routes/projection.ts:8-29,41-51,74-87",
        "apps/backend/src/modules/28-fhir/seams/consumed.ts:225-233",
        "apps/backend/src/index.ts:1760",
        "docs/modules/WARDENX_MODULE_28_FHIR_GATEWAY_SPEC_v0_4.md:27,1957,1971,1983,2001,2421"
      ],
      "verified": true,
      "recommended_fix": "Add DiagnosticReport (read + ?patient) via projectDiagnosticReport with M11 OrderProvider + M29 LabObservationReader (after the contract fix) and Practitioner via M40 ExternalPhysicianReader to SERVED_RESOURCES; add remaining US Core types as producer seams land.",
      "verification": "Extend m28-fhir-gateway.live.test.ts with W-FHIR-13..16; GET /fhir/r4/metadata lists the new types."
    },
    {
      "id": "GAP-050",
      "severity": "P1",
      "category": "stub",
      "module": "M29",
      "title": "No inbound HL7 MLLP listener process is composed (startListenerProcess is defined nowhere; createTlsListenerRegistry is used only by tests) and no production MllpIngestSink exists; nothing inserts hl7_message_inbound. ADT proposals, lab auto-attach, the unmatched-lab queue and the M28/M22 lab back-refs have no live source. Credentials are stored as sha256 digests, so mTLS material is unrecoverable. Known residual (F-182).",
      "evidence": [
        "apps/backend/src/modules/29-external-interfaces/listener/index.ts:7-11,56",
        "apps/backend/src/modules/29-external-interfaces/listener/connection.ts:65",
        "apps/backend/src/modules/29-external-interfaces/routes/store-drizzle.ts:9-12,119,350,512,1016",
        "docs/history/outbox-248-builds.md:2064-2066,2131"
      ],
      "verified": true,
      "recommended_fix": "Build the M29 listener entrypoint (separate process or worker.ts branch): load active feeds under withPlatformContext, apply the BAA gate, start createTlsListenerRegistry, bind a Drizzle MllpIngestSink writing hl7_message_inbound under withOrgContext with DEK-encrypted payload; store real credential ciphertext.",
      "verification": "Live: TLS MLLP socket sends ADT^A08 and ORU^R01 -> hl7_message_inbound + proposal/lab_observation rows + ACK; add a ci.yml job row."
    },
    {
      "id": "GAP-051",
      "severity": "P1",
      "category": "security",
      "module": "M29",
      "title": "M29 lab-observation reads (list, unmatched, detail with values) have no config.auditRead and /api/clinical/labs and /api/admin/external-interfaces are outside DEFAULT_READ_AUDIT_PREFIXES, so the fail-closed boot gate never governs them and no read event is emitted (164.528 accounting gap). Spec requires auditRead() on every route surfacing lab values.",
      "evidence": [
        "apps/backend/src/modules/29-external-interfaces/routes/labs.routes.ts:34-49,53-68,71-89,165-166",
        "grep auditRead|auditPhiRead apps/backend/src/modules/29-external-interfaces -> 0 matches",
        "apps/backend/src/bootstrap/index.ts:120-250 (DEFAULT_READ_AUDIT_PREFIXES /api/v1/* only)",
        "docs/modules/WARDENX_MODULE_29_EXTERNAL_INTERFACES_SPEC_v0_4.md:16"
      ],
      "verified": true,
      "recommended_fix": "Add auditListRead to list/unmatched and auditPhiRead (patientIdPayloadPath 'observation.patientId') to detail; add auditRead or a justified waiver to every /api/admin/external-interfaces GET; add both prefixes to DEFAULT_READ_AUDIT_PREFIXES.",
      "verification": "bunx vitest run apps/backend/__tests__/read-audit-coverage.test.ts plus a boot-fail case; extend gap-079-read-audit-emission.live.test.ts with a lab read -> audit_event row."
    },
    {
      "id": "GAP-052",
      "severity": "P1",
      "category": "security",
      "module": "M29",
      "title": "GET /api/clinical/labs/observations is gated only by inOrg; the caseload predicate applies only to :observationId routes and no caller passes caseloadPatientIds, so any lab.read holder lists every patient's labs in the org. Filters also run after LIMIT in JS (wrong pagination).",
      "evidence": [
        "apps/backend/src/modules/29-external-interfaces/routes/labs.routes.ts:33-50",
        "apps/backend/src/modules/29-external-interfaces/routes/guards.ts:43-44,97-101",
        "apps/backend/src/modules/29-external-interfaces/routes/store-drizzle.ts:853-869",
        "packages/db/migrations/0148_external_interfaces_m29_rls_audit_triggers.sql:7-8",
        "docs/modules/WARDENX_MODULE_29_EXTERNAL_INTERFACES_SPEC_v0_4.md:16"
      ],
      "verified": true,
      "recommended_fix": "Resolve the actor's caseload (or wide-scope bypass) and pass caseloadPatientIds to listObservations; push patient/loinc/caseload filters into SQL before LIMIT.",
      "verification": "Live (wardenx_app): clinician with caseload {P1} receives no P2 observations; wide-scope role receives both."
    },
    {
      "id": "GAP-053",
      "severity": "P1",
      "category": "security",
      "module": "M30",
      "title": "SRA cycle close and QAPI PIP close take both cosigner ids from the request body; nothing checks the actor is a cosigner, that either holds the required role, or that the second person authenticated. qapiCloseAuthority/sraCloseAuthority predicates exist but are never attached; PIP close has no step-up and SRA hardcodes recentStepUp: true. One user can close a HIPAA 164.308 SRA cycle or a CMS QAPI PIP alone.",
      "evidence": [
        "apps/backend/src/modules/30-quality/routes/quality-typebox.ts:112-119",
        "apps/backend/src/modules/30-quality/routes/qapi.routes.ts:243-249",
        "apps/backend/src/modules/30-quality/routes/sra.routes.ts:13-19,68,191-200",
        "apps/backend/src/modules/30-quality/routes/write-service-drizzle.ts:1002-1018,1228-1243",
        "apps/backend/src/modules/30-quality/abac-predicates.ts:610-626"
      ],
      "verified": true,
      "recommended_fix": "In closeSraCycle/closeQapiPip require actor.membershipId to be a cosigner, load both memberships and check roles (reuse the predicate logic), add requireStepUp('qapi.close') to R-31; ideally use a pending-cosign record confirmed in the second signer's own step-up session.",
      "verification": "Route/live test: single actor with qapi.close (or sra.close + step-up) closing with two arbitrary distinct membership ids -> 403; bunx vitest run on the M30 route tests."
    },
    {
      "id": "GAP-054",
      "severity": "P1",
      "category": "spec-drift",
      "module": "M30",
      "title": "m6.discharge.death is not consumed, so mortality reviews are never auto-created (no create route exists, R-70..R-73 unusable) and CAHPS decedent sampling/export ports are unbound end to end (index.ts passes no cahpsAdapters). Documented deferral (F-150) with a stale exception reason: the deferral register no longer holds those events.",
      "evidence": [
        "apps/backend/src/modules/30-quality/outbox-consumers/upstream-consumer-ports.ts:8-21,109-118",
        "apps/backend/src/modules/30-quality/routes/mortality.routes.ts:1-11",
        "apps/backend/src/index.ts:5817-5847,4469-4488",
        "apps/backend/src/modules/30-quality/jobs/m30-jobs.ts:1805-1851,2081-2103",
        "scripts/outbox-subscription-exceptions.ts:241-247; scripts/outbox-deferred-consumers.ts:88",
        "docs/modules/WARDENX_MODULE_30_HQRP_QUALITY_SPEC_v0_5.md:110,2195"
      ],
      "verified": true,
      "recommended_fix": "Split handleDischargeDeath so the mortality-review draft binds now; bind buildM30DischargeDeathConsumer in index.ts (idempotent on createdViaEventIdempotencyKey); then bind CAHPS ports to getTenantKeyProvider().dekForOrg and an adapter registry; update the exception reason.",
      "verification": "Live: publish m6.discharge.death through the real publisher -> one mortality_review row as wardenx_app; redelivery no-op; bun run arch:outbox-bindings."
    },
    {
      "id": "GAP-055",
      "severity": "P1",
      "category": "seam",
      "module": "M30",
      "title": "The monthly CAHPS sample cron builds CahpsRepository on the base pool and calls findActiveBinding with no withOrgContext; under the org-keyed RLS policy it reads zero rows and silently records every org as 'no_active_vendor'. The cahps_export worker runs unscoped with unbound decrypt/bindingConfig/outbox ports and nothing enqueues it. No CAHPS Hospice sample is ever produced or sent to the vendor (HQRP obligation), and nothing reports the failure.",
      "evidence": [
        "apps/backend/src/modules/30-quality/jobs/m30-jobs.ts:2006,2080-2105,2214-2216,2309-2313,2484-2487",
        "packages/quality/src/workers/crons.ts:159-163",
        "packages/db/migrations/0067_quality_m30_rls.sql:28-31",
        "apps/backend/src/index.ts:4439-4444,4469-4487",
        "packages/quality/src/workers/params.ts:93"
      ],
      "verified": true,
      "recommended_fix": "Run activeVendorBinding and the sample insert inside withOrgContext; bind listPriorMonthDecedents to DeathDischargeReader, insertSampled/decrypt/bindingConfig to the tenant DEK helper, emits to deps.outboxPublisher; wrap cahps_export per job in withOrgContext; pass a CahpsAdapterRegistry; fail loudly until bound.",
      "verification": "Live (wardenx_app): active cahps_vendor_binding + decedent -> runCahpsMonthlySample outcome 'sampled' with a cahps_decedent_sample row and an m30.cahps.sample_ready outbox row."
    },
    {
      "id": "GAP-056",
      "severity": "P1",
      "category": "seam",
      "module": "M30",
      "title": "None of M30's twelve section 4.9 alerts reach M36: all trigger events are record-only (declaredConsumers []), no M30 code calls AlertEmitter, M36's clinical-alert consumer has no m30 events, the scheduled SRA-reminders cron's cycles/alerts ports are unbound (fails daily), and m30.incident.cap_overdue has no producer. Outbreaks and sentinel/abuse incidents are recorded but nobody is notified.",
      "evidence": [
        "docs/modules/WARDENX_MODULE_30_HQRP_QUALITY_SPEC_v0_5.md:2155-2162",
        "apps/backend/src/modules/30-quality/events-by-m30.ts:47,60-61,66,83-84,105,116-117,122,132-133,335,348-349",
        "apps/backend/src/modules/36-messaging/outbox-consumers/clinical-alerts.ts:4-21",
        "apps/backend/src/modules/30-quality/jobs/m30-jobs.ts:2136-2153,2341,2358",
        "apps/backend/src/index.ts:4469-4491"
      ],
      "verified": true,
      "recommended_fix": "Add an M36 outbox consumer for M30 alert-trigger events (validate M30_ALERT_PAYLOADS, dispatch via getSeam('AlertEmitter')) and declare m36 on those events; bind the SRA-reminders cycles and alerts.dispatch ports; add a CAP-overdue sweep emitting m30.incident.cap_overdue.",
      "verification": "Live: run the outbreak detector on 3 matching events -> M36 alert row eventType outbreak_detected; runSraReminders on a cycle due in 30 days dispatches an alert; bun run arch:outbox-bindings."
    },
    {
      "id": "GAP-057",
      "severity": "P1",
      "category": "stub",
      "module": "M31",
      "title": "Portal invitation routes are silent no-ops: issue returns 202 with invented ids and persists nothing, list returns [], revoke/invite-bereaved return ok. No production path creates portal_account or portal_access_grant, so caregivers cannot be onboarded and every downstream portal surface is unreachable. Header falsely claims M2 binding. Acknowledged in F-222 but open.",
      "evidence": [
        "apps/backend/src/modules/31-portal/routes/admin.routes.ts:6-11,66-76,87,101,115-117",
        "grep insert portal_account (non-test) -> none; apps/backend/src/modules/31-portal/outbox-consumers/m16-bereavement-plan-opened.ts:275 (only replaces existing grant)",
        "apps/backend/src/modules/31-portal/lifecycle/invitation.ts:64,101 (no callers)",
        "docs/modules/WARDENX_MODULE_31_PORTAL_TELEHEALTH_SPEC_v0_2.md:817-819,1556-1574",
        "docs/history/m31-portal-deferrals.md:62-64"
      ],
      "verified": true,
      "recommended_fix": "Wire issuance to issueInvitation + M2 collaborator-invite + M36 delivery outbox; persist invitation state (decide owner table); implement accept -> portal_account + portal_access_grant under withOrgContext; real list/revoke/invite-bereaved.",
      "verification": "Live: POST /api/v1/admin/portal-invitations -> accept -> GET /api/v1/portal/sessions/current shows an active grant."
    },
    {
      "id": "GAP-058",
      "severity": "P1",
      "category": "security",
      "module": "M31",
      "title": "Portal logout and step-up are no-ops: logout returns ok without revoking the server session (the SPA just navigates to '/'), and step-up returns ok for any TOTP without validating or stamping freshness, while the UI says 'Verified'. A PHI portal session stays valid after logout until expiry; STEP_UP-guarded writes still deny (fail closed).",
      "evidence": [
        "apps/backend/src/modules/31-portal/routes/session.routes.ts:5-6,118-122,124-133",
        "apps/portal/src/screens/account.tsx:65-80",
        "apps/backend/src/modules/02-identity/routes/session-step-up.ts:128,161",
        "docs/modules/WARDENX_MODULE_31_PORTAL_TELEHEALTH_SPEC_v0_2.md:779-780"
      ],
      "verified": true,
      "recommended_fix": "Delegate logout to Better Auth session revocation for the caller's session id and step-up to the M2 step-up verifier; return 401/422 on a bad TOTP.",
      "verification": "Live: portal sign-in -> logout -> same cookie on GET /portal/sessions/current -> 401; bad TOTP -> 4xx."
    },
    {
      "id": "GAP-059",
      "severity": "P1",
      "category": "stub",
      "module": "M31",
      "title": "POST /api/v1/portal/bereavement/opt-out returns ok without calling M16 (which has a working opt-out path), so bereaved families who opt out keep receiving outreach. PATCH /notification-preferences/:id is also a no-op and GET returns a static stub list.",
      "evidence": [
        "apps/backend/src/modules/31-portal/routes/write.routes.ts:253-264,266-280",
        "apps/backend/src/modules/31-portal/routes/read.routes.ts:370-389",
        "apps/backend/src/modules/16-bereavement/permission-keys.ts:27 (M16 opt-out exists)",
        "docs/modules/WARDENX_MODULE_31_PORTAL_TELEHEALTH_SPEC_v0_2.md:805-807"
      ],
      "verified": true,
      "recommended_fix": "Forward opt-out to M16 via its seam or an m31.* outbox event M16 consumes, returning 202 only once enqueued; bind preferences to an M36 seam or return 501 until one exists.",
      "verification": "Live: POST /api/v1/portal/bereavement/opt-out -> M16 contact shows opted-out; bun run arch:outbox-bindings."
    },
    {
      "id": "GAP-060",
      "severity": "P1",
      "category": "stub",
      "module": "M33",
      "title": "Report drilldown emit and bulk_export always fail closed: drilldownEncryption is never passed, so the stub throws DrilldownDekUnavailable, and the drilldown audit-flush worker is unbound. The justification ('the M1 envelope-DEK provider does not exist') is stale: a DB boot registers the real key-ring TenantKeyProvider used by M31/M39.",
      "evidence": [
        "apps/backend/src/modules/33-reporting/routes/export-drilldown-service.ts:482-487",
        "apps/backend/src/modules/33-reporting/wiring.ts:466-468,568-578",
        "apps/backend/src/index.ts:3341-3346,1799-1805,3181,3215,3254",
        "apps/backend/src/modules/33-reporting/jobs/m33-jobs.ts:670-681",
        "apps/backend/src/modules/31-portal/portal-crypto.ts:26-45"
      ],
      "verified": true,
      "recommended_fix": "Implement a DrilldownFilterEncryptionPort over getTenantKeyProvider() (portal-crypto pattern, AAD m33:report_drilldown_audit:filter_context:<org>), pass it into createDrizzleM33ExportDrilldownBackend and the audit-flush ports; fix the comment.",
      "verification": "Live (wardenx_app): POST /api/v1/reporting/drilldown/emit -> 200 + ciphertext report_drilldown_audit row; listed by GET /api/v1/reporting/admin/audit/drilldowns."
    },
    {
      "id": "GAP-061",
      "severity": "P1",
      "category": "spec-drift",
      "module": "M34",
      "title": "M34 ABAC predicates are always bound to SLICE_M34_ABAC_RESOLVER (all loaders null/false) even on a DB boot, so feature_flag_write_authority, support_session_actor_distinct_from_grantor and tenant_consented_support_active always deny: feature-flag writes, the kill switch and support-session start/elevate always 403. The boot comment wrongly says only role-only predicates are used.",
      "evidence": [
        "apps/backend/src/index.ts:1665-1670,1899-1910",
        "apps/backend/src/modules/34-saas-tenant-platform/abac-predicates.ts:136-143,162-169,194-198",
        "apps/backend/src/modules/34-saas-tenant-platform/routes/platform/feature-flags-admin.ts:60-65,95,116",
        "apps/backend/src/modules/34-saas-tenant-platform/routes/platform/support-sessions.ts:89-98",
        "apps/backend/src/index.ts:1465-1473 (M31 Drizzle-resolver contrast)"
      ],
      "verified": true,
      "recommended_fix": "Add a Drizzle TenantPlatformAbacResolver (support_consent_grant, support_session, onboarding_task, FeatureFlagAdmin seam) and bind it in index.ts when deps.db is present; fix the comment.",
      "verification": "Route test over the real resolver: platform_ops kill-switch -> 200; support-session start with a valid grant from another grantor -> 2xx."
    },
    {
      "id": "GAP-062",
      "severity": "P1",
      "category": "stub",
      "module": "M35",
      "title": "No live Stripe loop: mountM35Routes gets no webhook ingest (POST /api/v1/webhooks/stripe always 503 STRIPE_WEBHOOK_UNCONFIGURED), the outbound stripe-dispatcher worker is never wired, and createSetupIntent returns {clientSecret:null}. Subscriptions, payment methods and invoices are local rows only; dunning transitions never arrive. Documented deferral.",
      "evidence": [
        "apps/backend/src/index.ts:934,3390-3418",
        "apps/backend/src/modules/35-subscription/routes/mount.ts:38",
        "apps/backend/src/modules/35-subscription/routes/webhooks.routes.ts:44-51",
        "apps/backend/src/modules/35-subscription/routes/service-drizzle.ts:892-896",
        "packages/subscription-billing/src/stripe/dispatcher.ts (unbound)"
      ],
      "verified": true,
      "recommended_fix": "Build the section 4.14 ingest (verifier + Drizzle stripe_webhook_event + DEK + STRIPE_WEBHOOK_SECRET in env.ts) and pass mountM35Routes({webhook:{ingest}}); register a stripe-dispatcher worker with a LiveStripeClient gated on STRIPE_SECRET_KEY.",
      "verification": "Live: Stripe test-signature fixture POST /api/v1/webhooks/stripe -> 200 + stripe_webhook_event; invalid signature -> 401; dispatcher drains an outbox op into stripe_api_call_audit."
    },
    {
      "id": "GAP-063",
      "severity": "P1",
      "category": "seam",
      "module": "M35",
      "title": "None of M35's six published seams (SubscriptionStateProvider, BillingStatusProvider, UsageMeteringIngest, PatientCounterProvider, RevenueMetricsProvider, PlanCatalogReader) is registered (spec D20 'boot refuses on missing registration' is not enforced; deny-stubs apply), and no producer (M28, M32) calls UsageMeteringIngest.ingest. AI-token and FHIR-egress usage never reaches usage_event. (M32 AITokenMeterProvider / M34 OnboardingStatusProvider deny-stubs are documented Phase-1 interims; M34 entitlement reader is never set.)",
      "evidence": [
        "apps/backend/src/bootstrap/seams/registry.ts:591-630,632-655",
        "apps/backend/src/bootstrap/seams/providers.ts:1711-1717",
        "docs/modules/WARDENX_MODULE_35_SUBSCRIPTION_BILLING_SPEC_v0_3.md:1421-1423,2945",
        "apps/backend/src/modules/32-ai-platform/events-by-m32.ts:140,198 (claims a call that does not exist)",
        "packages/subscription-billing/src/service/usage-metering-service.ts:45"
      ],
      "verified": true,
      "recommended_fix": "Add apps/backend/src/modules/35-subscription/wiring.ts with registerM35PublishedSeams(db) for the six Drizzle impls (PHI denylist + idempotency), call it from wireModuleSeams; call ingest from M32's token ledger and M28's FHIR read audit; bind the M34 entitlement reader.",
      "verification": "Boot test: getSeam('UsageMeteringIngest') is not the deny-stub on a DB boot; live: one M32 invocation -> one usage_event row, replay no-op."
    },
    {
      "id": "GAP-064",
      "severity": "P1",
      "category": "spec-drift",
      "module": "M36",
      "title": "M36 out-of-band delivery (push/SMS/voice/email), Socket.IO realtime and delivery-reconcile webhooks are unbuilt: the 12-queue catalog is data only, no vendor send call exists, planned notification_delivery rows are never dispatched, the webhook registrar is deliberately unmounted, and m36.notification.delivery_failed has no producer (M19/M20 escalation consumers never fire). Tier-1 SOS voice path (7.7) and critical lab 4-channel alerts (7.10) are unmet. Known, documented; in-app inbox works.",
      "evidence": [
        "packages/messaging/src/jobs/queues.ts:35,54,171",
        "apps/backend/src/modules/36-messaging/messaging-route-service-db.ts:786",
        "scripts/check-route-reachability.ts:53-67",
        "apps/backend/src/modules/19-oncall/consumers/bindings.ts:594",
        "docs/history/gates-outbox-bindings.md:535-556",
        "docs/modules/WARDENX_MODULE_36_MESSAGING_SPEC_v0_4.md:1633,1674,1962,2261,2270"
      ],
      "verified": true,
      "recommended_fix": "Build the dispatch tier in apps/backend/src/modules/36-messaging/jobs/ (send_* workers over notification_delivery, delivery_reconcile with a concrete MessagingWebhookService), register @fastify/formbody, mount registerMessagingWebhookRoutes, emit delivery_failed; remove the DEFERRED entry.",
      "verification": "bun run arch:route-reachability with the entry removed; live suite: alert leaves notification_delivery 'pending' and vendor failure publishes m36.notification.delivery_failed."
    },
    {
      "id": "GAP-065",
      "severity": "P1",
      "category": "spec-drift",
      "module": "M37",
      "title": "Only 1 of 12 section 4.8 IPU crons exists (rn-coverage-watchdog). ipu_census_snapshot has no writer, so GET /api/v1/ipu-census/:date and IpuCensusProvider (M26 cap accrual, M27 S-3) always return 0; irc_episode.consecutive_day_count is never incremented, so the 5-day IRC cap never reaches approaching_cap/breached. Restraint, IV bedside, cleaning-SLA, transfer, settlement, staleness, reservation, equipment and nursing-note crons are also absent. Header cites #174, which is closed.",
      "evidence": [
        "docs/modules/WARDENX_MODULE_37_IPU_SPEC_v0_2.md:1646-1659",
        "apps/backend/src/modules/37-ipu/jobs/index.ts:21-41; jobs/cron-workers.ts:266-275",
        "apps/backend/src/index.ts:5452,5458",
        "packages/inpatient/src/machines/irc-episode.ts:69 (planIrcDailyTick unused)",
        "apps/backend/src/modules/37-ipu/routes/service-drizzle.ts:2390; apps/backend/src/modules/37-ipu/seams.ts:88-118 (reads only)"
      ],
      "verified": true,
      "recommended_fix": "Add Workers/schedules in apps/backend/src/modules/37-ipu/jobs/ for census-snapshot-builder, irc-cap-watchdog (calling planIrcDailyTick), restraint-reassessment, iv-bedside-check, bed-cleaning-SLA, transfer-completion, postclose-settlement and the rest; reopen tracking.",
      "verification": "Live suites: census row written for an active admission; IRC episode moves active -> approaching_cap -> breached over ticks; GET /api/v1/ipu-census/:date non-zero."
    },
    {
      "id": "GAP-066",
      "severity": "P1",
      "category": "spec-drift",
      "module": "M37",
      "title": "GIP criteria attestation does not enforce hospice-MD / active M40 ExternalPhysician eligibility: attestGip persists a client-supplied attestingPhysicianId unchecked, the route has no requireAbac, the attester_eligible predicate is a target-boolean stub nothing feeds, and stepUpAssertionId is written as the membership id. Any m37.gip_criteria.attest holder can attest GIP, driving GIP per-diem billing (CoP 418.108).",
      "evidence": [
        "apps/backend/src/modules/37-ipu/routes/service-drizzle.ts:1206-1227",
        "apps/backend/src/modules/37-ipu/routes/ipu.routes.ts:322-333",
        "apps/backend/src/modules/37-ipu/abac/predicates.ts:48",
        "packages/auth/src/permissions/contributed.ts:5883-5888",
        "docs/modules/WARDENX_MODULE_37_IPU_SPEC_v0_2.md:231,1641,2376,2437"
      ],
      "verified": true,
      "recommended_fix": "In attestGip resolve the actor's M2 discipline and the attesting physician via M40 (active ExternalPhysician bound to the actor) and reject with 403 GIP_ATTESTER_INELIGIBLE; persist the real step-up assertion id.",
      "verification": "Live: RN with attest + step-up -> 403; hospice MD bound to an active external_physician -> 201."
    },
    {
      "id": "GAP-067",
      "severity": "P1",
      "category": "seam",
      "module": "M37",
      "title": "POST /ipu-admissions/:id/confirm (spec: system-internal) is a normal session route gated by m37.ipu_admission.create; it ignores its body (including forceFlag) and always passes lcpConfirmed: true, so the ADMISSION_LCP_NOT_CONFIRMED guard is dead. No M37 consumer exists for m6.level_of_care.activated/requires_ipu_bed, and M6 never emits them. IPU/GIP admissions can go active (billing-relevant) with no M6 LCP.",
      "evidence": [
        "apps/backend/src/modules/37-ipu/routes/ipu.routes.ts:289-298",
        "apps/backend/src/modules/37-ipu/routes/service-drizzle.ts:1117-1133",
        "apps/backend/src/modules/37-ipu/routes/ipu-typebox.ts:169-172",
        "apps/backend/src/modules/06-admission/events-by-m6.ts:255-258",
        "docs/modules/WARDENX_MODULE_37_IPU_SPEC_v0_2.md:174,1386,1551-1552"
      ],
      "verified": true,
      "recommended_fix": "Implement the M6<->M37 LCP handshake (M6 emits requires_ipu_bed/activated; M37 consumers drive open/confirm) and restrict the user route, or require an explicit force-flag + coordinator-only permission + seam check for an M6 LCP before lcpConfirmed.",
      "verification": "Live: confirm without an M6 LCP -> 412; m6.level_of_care.activated consumer transitions to active exactly once."
    },
    {
      "id": "GAP-068",
      "severity": "P1",
      "category": "seam",
      "module": "M37",
      "title": "11 of 13 section 4.5 M37 consumers are absent (only the two M6 discharge consumers exist). No code path inserts ipu_iv_safety_overlay, so the D7 IV-continuous safety overlay is never operative (the registered seam reads an empty table), and outbreak-driven visitor restrictions (D8) have no producer. Producers do not declare m37, so the gate passes.",
      "evidence": [
        "apps/backend/src/modules/37-ipu/consumers/ (two files)",
        "docs/modules/WARDENX_MODULE_37_IPU_SPEC_v0_2.md:1545-1563",
        "apps/backend/src/modules/11-orders/events-by-m11.ts:179-183; apps/backend/src/modules/30-quality/events-by-m30.ts:348-349",
        "apps/backend/src/modules/37-ipu/seams.ts:186-195,356",
        "packages/inpatient/src/domain/iv-safety/overlay-builder.ts (pure builder, never persisted)"
      ],
      "verified": true,
      "recommended_fix": "Add consumers (m11-order-signed/discontinued, m13-administration-recorded, m8-encounter-signed, m30-outbreak-*) under apps/backend/src/modules/37-ipu/consumers/, declare m37 on producers and bind them in index.ts.",
      "verification": "bun run arch:outbox-bindings; live: m11.order.signed (medication_iv_continuous) for an IPU patient creates an overlay row; grep the factory in index.ts."
    },
    {
      "id": "GAP-069",
      "severity": "P1",
      "category": "stub",
      "module": "M38",
      "title": "No production terminology loader or worker: packages/terminology-loader does not exist, the processors in packages/terminology/src/jobs have no backend caller, and POST /api/v1/admin/terminology/:system/load only registers a version row (ingestion 'pending_loader_worker'). Concept tables are empty unless loaded out-of-band (only a dev seed writes concepts). ICD-10 validation and RxNorm search depend on this. Self-documented.",
      "evidence": [
        "apps/backend/src/modules/38-terminology/routes/admin-terminology-routes.ts:16-21,117",
        "packages/terminology/src/jobs/processors.ts:48,85; jobs/queues.ts:12 (no apps/ callers)",
        "apps/backend/src/index.ts:990-996,1094,1628,1960,3250 (no worker)",
        "scripts/db/seed-terminology.ts:1-15,82",
        "docs/modules/WARDENX_MODULE_38_TERMINOLOGY_SPEC_v0_2.md section 4.3 (~962-974)"
      ],
      "verified": true,
      "recommended_fix": "Build packages/terminology-loader (fetch/stage/diff/write, deprecation mapping, activate/supersede) and a BullMQ worker in apps/backend/src/modules/38-terminology/jobs consuming load_version / tenant_deprecation_scan / refresh_embeddings, wired from index.ts.",
      "verification": "Live: POST /api/v1/admin/terminology/icd10cm/load with a fixture, run the worker, GET /api/v1/terminology/icd10cm/validate?code=... valid; version 'active'."
    },
    {
      "id": "GAP-070",
      "severity": "P1",
      "category": "security",
      "module": "M39",
      "title": "Patient-scoped consent read routes (3, 4, 11, 14, 17, 21, 28) are gated by requirePermission only; no requireAbac exists in the module and services receive no actor. Any consent.read holder reads any patient's consents, including 42 CFR Part 2 recipients and DPOA agents. Route 3's comment claims a caseload check that does not exist.",
      "evidence": [
        "apps/backend/src/modules/39-consent/routes/consent-routes.ts:75-92,150-162,164-188",
        "apps/backend/src/modules/39-consent/consent-store-db.ts:412-438",
        "docs/modules/WARDENX_MODULE_39_CONSENT_SPEC_v0_3.md:1050,1064,1065,1068,1075",
        "apps/backend/src/modules/07-care-plan/abac-predicates.ts:11,39 (caseload_or_scope exists)"
      ],
      "verified": true,
      "recommended_fix": "Add requireAbac guards (caseload_or_scope with a patientId target adapter, consent_owner_or_compliance, is_consent_drafter, bereavement_window, compliance_officer) to consent-routes.ts; load patient_id for consentId routes (IDOR); log denies to consent_eval_audit.",
      "verification": "bun run arch:abac-predicates; live: consent.read holder off-caseload gets 403 on GET /api/v1/patients/:id/consents and /api/v1/consents/:id."
    },
    {
      "id": "GAP-071",
      "severity": "P1",
      "category": "security",
      "module": "M39",
      "title": "The production ConsentEvaluator never applies D13 post-death termination: the Drizzle store backing the seam returns isPatientDeceased = false unconditionally and no m39 consumer for m5.patient.deceased exists. After death, non-survives-death consents keep authorizing disclosure for every PHI-egress module consulting the seam. A working deceased query already exists in the same file.",
      "evidence": [
        "apps/backend/src/modules/39-consent/consent-store-db.ts:168-174,342-354",
        "apps/backend/src/index.ts:1544",
        "packages/consent/src/seams/consent-evaluator.ts:326-336",
        "apps/backend/src/modules/05-patient/events-by-m5.ts:141-142",
        "packages/consent/src/lifecycle/death.ts:18 (no caller)"
      ],
      "verified": true,
      "recommended_fix": "Implement isPatientDeceased in createDbConsentStore with the existing withOrgContext patient.status read; optionally bind an m39 consumer for m5.patient.deceased using decideDeceasedConsentExpiry and add m39 to the catalog.",
      "verification": "Live: sign portal_access consent, mark patient deceased, ConsentEvaluator.evaluate -> allowed=false, denyReason 'patient_deceased_consent_terminated'."
    },
    {
      "id": "GAP-072",
      "severity": "P1",
      "category": "build",
      "module": "global",
      "title": "Production deploys run with zero CI: deploy.yml `verify` job is commented out (release needs only debounce) and ci.yml's pull_request trigger only matches `fix/admission`, so neither PRs to main nor main pushes run build/typecheck/arch:fitness/tests before a PHI-bearing image ships. Undocumented; CLAUDE.md:78 still describes `verify` as active.",
      "evidence": [
        ".github/workflows/deploy.yml:91-95 (`# verify:` job commented out); :97-101 (`release: needs: debounce`, `# needs: verify`)",
        ".github/workflows/ci.yml:4-12 (push trigger commented; pull_request branches only `fix/admission`)",
        "git log: 8468d5530 'Skipped the CI'; 27b1ee094 'CI/CD'",
        "gh run view 37079437664 --json jobs -> only debounce / release / deploy jobs",
        "CLAUDE.md:78 still describes deploy.yml verify as running the full CI matrix"
      ],
      "verified": true,
      "recommended_fix": "Uncomment `verify` in .github/workflows/deploy.yml (needs: debounce, uses ./.github/workflows/ci.yml) and set release.needs: [debounce, verify] gated on verify success; restore ci.yml `pull_request: branches: [main]`. If Actions minutes are the reason, reduce cost with path filters / a smaller PR job set instead of removing the gate. Record the decision in docs/history and fix CLAUDE.md/AGENTS.md.",
      "verification": "gh run view <next deploy run> --json jobs lists CI matrix jobs before 'Build and publish immutable images'; grep -n 'needs: verify' .github/workflows/deploy.yml matches an uncommented line; a test PR to main triggers ci.yml."
    },
    {
      "id": "GAP-073",
      "severity": "P1",
      "category": "security",
      "module": "global",
      "title": "Production nginx vhosts proxy /api with no access_log/log_format override, so nginx's default combined format persists $request including ?q=<patient name|MRN> from patient search, the exact PHI that logger.ts strips from Pino and names as a downstream risk. Host-level nginx.conf is not in the repo.",
      "evidence": [
        "apps/backend/src/bootstrap/plugins/logger.ts:3-5,27-30",
        "deploy/production/nginx/wardenx-frontend.conf:6-13; deploy/production/nginx/wardenx-backend.conf:8-15",
        "apps/web/src/modules/05-patient/global-search.tsx:150",
        "repo grep access_log|log_format -> no nginx config"
      ],
      "verified": true,
      "recommended_fix": "Define a path-only log_format ($uri) for /api/ locations in both vhosts (or access_log off for /api/); better, move search needles into a POST body.",
      "verification": "On the VPS: curl 'https://<api>/api/v1/patients?q=TESTNEEDLE' then grep TESTNEEDLE /var/log/nginx/*.log returns nothing; nginx -T | grep log_format."
    },
    {
      "id": "GAP-074",
      "severity": "P2",
      "category": "spec-drift",
      "module": "M02",
      "title": "Several M2 spec routes have no handler (GET/DELETE /api/v1/auth/sessions, POST /api/v1/auth/screen-unlock, GET /api/v1/me/session, POST /api/v1/funeral/invite, orgs CRUD, step-up overrides); several implemented routes (device attestation, auth/context, invitations resend, elevated approvals) are absent from the spec inventory.",
      "evidence": [
        "docs/modules/WARDENX_MODULE_02_IDENTITY_SPEC_v0_4.md:736-756",
        "grep me/session|auth/sessions|screen-unlock|funeral/invite|step-up-overrides apps/backend/src apps/web/src scripts/openapi -> none"
      ],
      "verified": false,
      "recommended_fix": "Implement the missing handlers in apps/backend/src/modules/02-identity/routes or record explicit deferrals and update the spec inventory, including extras.",
      "verification": "identity-routes.test.ts per route; bun run openapi:coverage --check."
    },
    {
      "id": "GAP-075",
      "severity": "P2",
      "category": "security",
      "module": "M02",
      "title": "Email/password sign-up is open instead of invite-gated: Better Auth has no disableSignUp or hooks, the mount bridge forwards every /api/auth/* path, the credential throttle covers sign-in only, and the web accept-invitation page calls signUp.email without a token. Tenant data stays membership/RLS-gated; magicLink also lacks disableSignUp.",
      "evidence": [
        "packages/auth/src/identity/auth.ts:197-201",
        "packages/auth/src/identity/mount.ts:59-75",
        "packages/auth/src/identity/credential-throttle.ts:56",
        "apps/web/src/modules/02-identity/accept-invitation.tsx:98",
        "docs/modules/WARDENX_MODULE_02_IDENTITY_SPEC_v0_4.md:720"
      ],
      "verified": true,
      "recommended_fix": "Set disableSignUp (also for magicLink) and create the account server-side inside POST /api/v1/invitations/accept after token validation, or gate /api/auth/sign-up/* on a valid invitation in the mount bridge.",
      "verification": "Live: POST /api/auth/sign-up/email without an invitation token -> 403/404."
    },
    {
      "id": "GAP-076",
      "severity": "P2",
      "category": "coverage",
      "module": "M03",
      "title": "No live suite exercises the break-glass branch end to end (requireAbac deny -> durable grant -> critical audit row under wardenx_app); the audit insert is covered only in memory, and a regression would 500 every emergency access.",
      "evidence": [
        "apps/backend/__tests__/ac-01-break-glass-cosign.live.test.ts:33,105,134 (store only)",
        "apps/backend/src/modules/03-authorization/contract.ts:57-84",
        "packages/auth/src/abac/require-abac.ts:200-205"
      ],
      "verified": false,
      "recommended_fix": "Extend ac-01 (or add a suite + package.json script + ci.yml row) to invoke break-glass, run a denying guard and assert access allowed + m3.breakglass.access critical audit row as wardenx_app.",
      "verification": "bun run test:m3:break-glass:live; bun run arch:live-suites."
    },
    {
      "id": "GAP-077",
      "severity": "P2",
      "category": "spec-drift",
      "module": "M05",
      "title": "Amendment decide only flips status: no pending guard (can be re-decided), requested_changes always {} (documented interim), accepted changes not applied, unknown id -> 500; GET /patients/:id/amendments and POST /amendments/:id/statement are absent.",
      "evidence": [
        "apps/backend/src/modules/05-patient/patient-route-service-db.ts:725-757,759-790,777",
        "apps/backend/src/modules/05-patient/routes/patient-routes.ts:425-456",
        "docs/modules/WARDENX_MODULE_05_PATIENT_SPEC_v0_4.md:1256-1260,2422"
      ],
      "verified": true,
      "recommended_fix": "Guard status='pending' (409), use NotFoundError, carry requested_changes in the submit body and apply via PatientMutator on accept; add the list and statement routes.",
      "verification": "patient-routes.test.ts: second decide -> 409; unknown id -> 404."
    },
    {
      "id": "GAP-078",
      "severity": "P2",
      "category": "spec-drift",
      "module": "M05",
      "title": "Census list does not exclude merged patients and GET /patients/:id does not follow merged_into_id; clinicians can open and document on a merged-away chart.",
      "evidence": [
        "apps/backend/src/modules/05-patient/patient-route-service-db.ts:120-136,169-173",
        "docs/modules/WARDENX_MODULE_05_PATIENT_SPEC_v0_4.md:1232-1233"
      ],
      "verified": false,
      "recommended_fix": "Default the list filter to status <> 'merged'; return the canonical row or a redirect body from getPatient.",
      "verification": "Extend m5-patient-merge.live.test.ts: source absent from GET /patients; GET /patients/:source returns target/redirect."
    },
    {
      "id": "GAP-079",
      "severity": "P2",
      "category": "coverage",
      "module": "M05",
      "title": "POST /api/v1/patients has no location_scope guard and no module registers a location_scope predicate (catalog declares it; declaration only).",
      "evidence": [
        "apps/backend/src/modules/05-patient/routes/patient-routes.ts:352",
        "packages/auth/src/permissions/contributed.ts:290-295",
        "docs/modules/WARDENX_MODULE_05_PATIENT_SPEC_v0_4.md:1234"
      ],
      "verified": false,
      "recommended_fix": "Register a location_scope predicate (or change the declaration) and compose requireAbac('patient.create','location_scope').",
      "verification": "bun run arch:abac-predicates; unit test: creator outside the target location -> 403."
    },
    {
      "id": "GAP-080",
      "severity": "P2",
      "category": "spec-drift",
      "module": "M05",
      "title": "Admit persists only the patient row + MRN/MBI; SSN (encrypted), aliases, address, phone, email are follow-ups, so deterministic matcher keys (SSN+DOB+name, DOB+name+address) are never available.",
      "evidence": [
        "apps/backend/src/modules/05-patient/patient-route-service-db.ts:284-300",
        "docs/modules/WARDENX_MODULE_05_PATIENT_SPEC_v0_4.md:56"
      ],
      "verified": false,
      "recommended_fix": "Persist satellite rows in the admit tx (SSN via the KEK/DEK envelope into patient_identifier.value_encrypted).",
      "verification": "Live: admit with SSN + address creates encrypted patient_identifier(kind=ssn) and patient_address rows."
    },
    {
      "id": "GAP-081",
      "severity": "P2",
      "category": "seam",
      "module": "M05",
      "title": "PatientCaregiverReader has only the M1 deny-stub (no caregiver->user schema link exists), so the portal family_caregiver attestation path always denies; only DPOA/patient_self can attest. M31's registration header wrongly claims every producer is live.",
      "evidence": [
        "apps/backend/src/bootstrap/seams/providers.ts:228-238",
        "packages/types/src/patient.ts:403-417",
        "packages/db/src/schema/patient/caregivers.ts:8-27",
        "apps/backend/src/modules/31-portal/abac-predicates.ts:193-199,245-256",
        "apps/backend/src/modules/31-portal/seams/registration.ts:101-112"
      ],
      "verified": true,
      "recommended_fix": "Add a caregiver.user_id (or portal_account.caregiver_id) link via migration, then implement and register PatientCaregiverReader in apps/backend/src/modules/05-patient/seams/index.ts; fix the M31 header.",
      "verification": "Unit + live: primary family_caregiver grant passes portal_caregiver_is_primary_or_dpoa; non-primary denied."
    },
    {
      "id": "GAP-082",
      "severity": "P2",
      "category": "coverage",
      "module": "M06",
      "title": "3 of 15 M06 owned tables (referral_activity, referral_note, admission_evidence) have no live cross-tenant RLS test; they once shipped ENABLE without FORCE (fixed in 0233).",
      "evidence": [
        "audit/implementation-status/IMPLEMENTATION_STATUS.md:18",
        "packages/db/migrations/0233_rls_force_and_hope_result_event_rls.sql:8-16,34-36",
        "packages/db/migrations/__tests__/rls-isolation.live.test.ts:2280,2334 (structural only)"
      ],
      "verified": false,
      "recommended_fix": "Add cross-tenant cases for the three tables to an M6 live suite using _live-app-role.ts.",
      "verification": "bun run status:matrix shows M06 Live 15/15; new suite passes in CI."
    },
    {
      "id": "GAP-083",
      "severity": "P2",
      "category": "security",
      "module": "M06",
      "title": "cti.is_attending / is_hospice_md compare context.userId with M40 physician ids, which can never match, so the role escape (md/hospice_physician) is the live path and any such user can sign any CTI's attending certification (42 CFR 418.22(c)). Documented compromise.",
      "evidence": [
        "apps/backend/src/modules/06-admission/abac-predicates.ts:168-175,189-199",
        "docs/modules/WARDENX_MODULE_06_ADMISSION_ELECTION_CERTIFICATION_SPEC_v0_4.md section 4.1 rows 24-25"
      ],
      "verified": false,
      "recommended_fix": "Add a membership-to-M40-physician link and compare against it; narrow the role escape to the attending of record.",
      "verification": "Unit/live: md user who is not the CTI attending gets 403 on POST /cti/:id/sign-attending."
    },
    {
      "id": "GAP-084",
      "severity": "P2",
      "category": "doc",
      "module": "M07",
      "title": "Three implemented, gated read routes (GET /care-plans/:planId/readiness, /versions/:versionId/proposed-changes, /review-status) are not in the M07 spec section 4.1 inventory (19 rows vs 22 registrations).",
      "evidence": [
        "apps/backend/src/modules/07-care-plan/routes/care-plan-routes.ts:431-441,443-454,456-466",
        "docs/modules/WARDENX_MODULE_07_CARE_PLAN_SPEC_v0_3.md:774-794"
      ],
      "verified": true,
      "recommended_fix": "Add the three GETs to M07 spec section 4.1.",
      "verification": "Spec section 4.1 row count equals 22 registrations."
    },
    {
      "id": "GAP-085",
      "severity": "P2",
      "category": "security",
      "module": "M08",
      "title": "m8.cosigner_role_match and the M9 cosigner predicate compare a membership-id fact with context.userId (Better Auth id), so 'cosigner must not be the author' never denies. In M8 neither cosign service checks the author, so an RN author can cosign their own encounter; M9's service layer still blocks self-cosign (dead defense-in-depth). M10 already fixed the same bug.",
      "evidence": [
        "apps/backend/src/modules/08-encounters/abac-predicates.ts:110",
        "apps/backend/src/modules/08-encounters/encounters-route-service-db.ts:344,2052,2064-2100,2363",
        "apps/backend/src/bootstrap/plugins/authenticate.ts:81,115",
        "apps/backend/src/modules/09-assessments/abac-predicates.ts:146; apps/backend/src/modules/09-assessments/assessments-route-service-db.ts:996",
        "apps/backend/src/modules/10-hope/abac-predicates.ts:190-197"
      ],
      "verified": true,
      "recommended_fix": "Compare against context.attributes.membershipId in both predicates (M10 membershipIdOf pattern), failing closed when null.",
      "verification": "Unit test with distinct user/membership ids: author RN denied on /cosignature/acknowledge, /cosignature/sign and POST /assessments/:id/cosignatures."
    },
    {
      "id": "GAP-086",
      "severity": "P2",
      "category": "spec-drift",
      "module": "M08",
      "title": "Supervisor release stores the routed cosigner, not the releasing supervisor, as supervisor_released_by, and emits no outbox event for the release.",
      "evidence": [
        "apps/backend/src/modules/08-encounters/encounters-route-service-db.ts:2117-2139,2132",
        "apps/backend/src/modules/08-encounters/routes/encounters-routes.ts:596-607"
      ],
      "verified": false,
      "recommended_fix": "Pass the actor's membershipId into supervisorRelease and store it; emit the catalogued release event.",
      "verification": "Live: supervisor_released_by equals the releasing supervisor's membership id."
    },
    {
      "id": "GAP-087",
      "severity": "P2",
      "category": "stub",
      "module": "M08",
      "title": "Layer-3 sign-gate checks for required HOPE items (check 4) and Layer-2 decisions (check 7) are documented deferrals; a HOPE-timepoint visit note can be signed without the HOPE items.",
      "evidence": [
        "apps/backend/src/modules/08-encounters/gate/checks.ts:68-77,92-101",
        "apps/backend/src/modules/08-encounters/routes/encounters-routes.ts:466-484"
      ],
      "verified": false,
      "recommended_fix": "Add an encounter->HOPE-timepoint link and evaluate check 4 in gate/gate.ts; track Layer 2 under #123.",
      "verification": "Gate unit test: HOPE-timepoint encounter missing items fails sign with COMPLIANCE_GATE_FAILED."
    },
    {
      "id": "GAP-088",
      "severity": "P2",
      "category": "coverage",
      "module": "M10",
      "title": "hope_submission_result_event (CMS iQIES results for named patients) has no live RLS test of cross-tenant isolation or its append-only grant.",
      "evidence": [
        "audit/implementation-status/IMPLEMENTATION_STATUS.md:22",
        "packages/db/migrations/0226_hope_phase_7_manual_iqies_submission.sql:45-62",
        "packages/db/migrations/0233_rls_force_and_hope_result_event_rls.sql:21-27,43-52"
      ],
      "verified": false,
      "recommended_fix": "Add a live case: org-B session cannot read org-A result event; UPDATE/DELETE refused.",
      "verification": "bun run status:matrix shows M10 Live 12/12."
    },
    {
      "id": "GAP-089",
      "severity": "P2",
      "category": "spec-drift",
      "module": "M10",
      "title": "Spec mandates automated iQIES submit/reconcile workers; implementation ships a manual package/upload/import flow (9 extra routes) with the workers unscheduled. Reasoned in code but recorded in no spec or ADR.",
      "evidence": [
        "docs/modules/WARDENX_MODULE_10_HOPE_ENGINE_SPEC_v0_2.md:149,943-972",
        "apps/backend/src/modules/10-hope/jobs/cron-workers.ts:8-16,451-452",
        "packages/db/migrations/0226_hope_phase_7_manual_iqies_submission.sql:15"
      ],
      "verified": false,
      "recommended_fix": "Write an ADR for the manual iQIES transport and update M10 spec sections 1, 4.1 (9 routes), 4.2/4.8.",
      "verification": "bun run arch:module-docs; every hope-routes.ts route appears in spec 4.1."
    },
    {
      "id": "GAP-090",
      "severity": "P2",
      "category": "stub",
      "module": "M10",
      "title": "POST /hope/submissions/:id/retry only flips rejected -> queued and emits submission_queued; no worker processes 'queued' batches in the manual flow, so the retried batch is orphaned (operators can recover by re-running assemble). Spec still says retry re-validates and re-assembles.",
      "evidence": [
        "apps/backend/src/modules/10-hope/hope-route-service-db.ts:1764-1786,1796-1903,1821",
        "apps/backend/src/modules/10-hope/routes/hope-routes.ts:511-517",
        "apps/backend/src/modules/10-hope/jobs/cron-workers.ts:451-452",
        "docs/modules/WARDENX_MODULE_10_HOPE_ENGINE_SPEC_v0_2.md:965"
      ],
      "verified": true,
      "recommended_fix": "Make retrySubmission re-validate and re-package into a new packaged batch, or remove the route and document that assemble supersedes it.",
      "verification": "Route test: retry on a rejected submission yields a packaged batch with the rejected items, or a documented 4xx."
    },
    {
      "id": "GAP-091",
      "severity": "P2",
      "category": "spec-drift",
      "module": "M11",
      "title": "PATCH /orders/:id lets any orders.draft holder edit another clinician's draft (no author/supervisor check); indicationText is accepted by the schema but silently dropped.",
      "evidence": [
        "apps/backend/src/modules/11-orders/routes/orders-routes.ts:83,284-296",
        "apps/backend/src/modules/11-orders/orders-route-service-db.ts:1002-1018",
        "apps/backend/src/modules/11-orders/routes/orders-typebox.ts:87-91",
        "docs/modules/WARDENX_MODULE_11_ORDERS_SPEC_v0_4.md:1190"
      ],
      "verified": true,
      "recommended_fix": "Refuse in editDraft unless actor.membershipId === drafter_membership_id or the actor is a supervisor; persist indicationText or remove it from the schema.",
      "verification": "m11-orders-write live: RN B PATCHes RN A's draft -> 403."
    },
    {
      "id": "GAP-092",
      "severity": "P2",
      "category": "seam",
      "module": "M11",
      "title": "The M11 HOPE J2051 trigger consumer exists only as an unbound decider (documented handler-unbound exception); spec D7 order suggestion from m10.hope.j2051_trigger_fired is not fed.",
      "evidence": [
        "scripts/outbox-subscription-exceptions.ts:159-165",
        "apps/backend/src/modules/11-orders/consumers/hope-trigger.ts"
      ],
      "verified": false,
      "recommended_fix": "Bind decideHopeTrigger in consumers/bindings.ts, declare m11 on the M10 event, remove the exception and confirm index.ts reaches the factory.",
      "verification": "bun run arch:outbox-bindings; live publish of m10.hope.j2051_trigger_fired shows the M11 suggestion."
    },
    {
      "id": "GAP-093",
      "severity": "P2",
      "category": "security",
      "module": "M12",
      "title": "Prescriber enrollment and both policy PATCH routes lack step-up although the spec and permission catalog require it; enrollment sets deaAuthorizedSchedules used by dea_schedule_authorized.",
      "evidence": [
        "apps/backend/src/modules/12-dosespot/routes/dosespot-routes.ts:511-525,556,583-585",
        "packages/auth/src/permissions/contributed.ts:1484",
        "docs/modules/WARDENX_MODULE_12_DOSESPOT_PRESCRIBING_SPEC_v0_2.md:1049-1055"
      ],
      "verified": false,
      "recommended_fix": "Add requireStepUp('dosespot_prescriber.enroll') and requireStepUp('prescribing_policy.update') to the three routes.",
      "verification": "Route test: without fresh step-up the three routes return 403/412."
    },
    {
      "id": "GAP-094",
      "severity": "P2",
      "category": "stub",
      "module": "M12",
      "title": "EPCS controlled signing is a stub: deaScheduleAuthorized/prescriberIal2Verified hardcoded true, nonce is the order id, no TOTP verified, epcs_signing_attempt never written. Unreachable today (certification constant 'not_certified'), but a config flip would enable controlled signing without 2FA.",
      "evidence": [
        "apps/backend/src/modules/12-dosespot/dosespot-route-service-db.ts:148-152,597-622",
        "docs/modules/WARDENX_MODULE_12_DOSESPOT_PRESCRIBING_SPEC_v0_2.md:28"
      ],
      "verified": false,
      "recommended_fix": "Implement epcs_signing_attempt rows, TOTP verification and DEA/IAL2 reads from dosespot_prescriber; add a hard throw independent of the certification constant until then.",
      "verification": "Unit/live with certification forced on: complete without valid TOTP -> 401/422 and an epcs_signing_attempt row."
    },
    {
      "id": "GAP-095",
      "severity": "P2",
      "category": "coverage",
      "module": "M12",
      "title": "Spec ERD tables medication_order_discontinuation and rx_benefit_cache are absent from migrations and the manifest; discontinuation is only a status on medication_order.",
      "evidence": [
        "packages/db/migrations/0038_dosespot_m12_tables.sql:10",
        "docs/modules/WARDENX_MODULE_12_DOSESPOT_PRESCRIBING_SPEC_v0_2.md:248,524-536",
        "architecture/module-manifest.ts:516-530"
      ],
      "verified": false,
      "recommended_fix": "Add the tables (migration, schema, manifest, RLS suite) or amend the spec to record the simpler model/deferral.",
      "verification": "bun run arch:tables; bun run arch:module-docs."
    },
    {
      "id": "GAP-096",
      "severity": "P2",
      "category": "seam",
      "module": "M13",
      "title": "M13 subscribes to m9.prn_reassessment_overdue, which M9 never catalogues or emits (documented no-such-event exception); PRN follow-up never fires.",
      "evidence": [
        "apps/backend/src/modules/13-emar/consumers/index.ts:67",
        "scripts/outbox-subscription-exceptions.ts:166-171"
      ],
      "verified": false,
      "recommended_fix": "Catalogue and emit the M9 event (or run an M13 overdue sweep over prn_administration), then bind the consumer.",
      "verification": "bun run arch:outbox-bindings; live: overdue PRN produces the M13 follow-up."
    },
    {
      "id": "GAP-097",
      "severity": "P2",
      "category": "doc",
      "module": "M13",
      "title": "The patient eMAR empty state and header still say the scheduled-dose materializer 'is not yet wired', but F-166 bound it; clinicians get wrong guidance on a medication-safety path.",
      "evidence": [
        "apps/web/src/modules/13-emar/patient-emar.tsx:31-36,213,322",
        "apps/backend/src/index.ts:6304-6310"
      ],
      "verified": false,
      "recommended_fix": "Update the empty-state copy and comments; reassess whether the Administer panel should still be order-driven.",
      "verification": "grep -n 'not yet wired' apps/web/src/modules/13-emar returns nothing; DOM test asserts new text."
    },
    {
      "id": "GAP-098",
      "severity": "P2",
      "category": "spec-drift",
      "module": "M15",
      "title": "The discipline-plan list fetches limit+1 rows then post-filters by caseload and computes has_more from the filtered set, so pagination ends early and off-caseload rows hide reachable plans (F-096 anti-pattern).",
      "evidence": [
        "apps/backend/src/modules/15-discipline-care-plans/routes/read-service-drizzle.ts:288-307",
        "apps/backend/src/modules/15-discipline-care-plans/routes/concurrency.ts:123-136",
        "docs/history/gates-authz-and-routes.md:50-55"
      ],
      "verified": false,
      "recommended_fix": "Compute has_more/cursor from raw rows, or narrow in SQL with patient_id = ANY(caseloadPatientIds) unless hasOrgWideScope.",
      "verification": "Live: 3 visible plans after 10 off-caseload, limit=5, paging returns all 3."
    },
    {
      "id": "GAP-099",
      "severity": "P2",
      "category": "stub",
      "module": "M17",
      "title": "GET /api/v1/metrics/visits ignores its window and returns onTimeRate: 1; route-efficiency returns zeros for every membership. M30/M33 dashlets built on them show fabricated values. Caregiver-reminder cron has no producer (F-161).",
      "evidence": [
        "apps/backend/src/modules/17-scheduling/scheduling-route-service-db.ts:2096-2106",
        "apps/backend/src/modules/17-scheduling/jobs/index.ts",
        "docs/modules/WARDENX_MODULE_17_SCHEDULING_SPEC_v0_2.md:722-723,1052-1068"
      ],
      "verified": false,
      "recommended_fix": "Compute onTimeRate from actual vs scheduled start within [from,to]; compute route efficiency from route_segment or return 501/null with an 'unavailable' flag.",
      "verification": "Unit/live: seeded late visits give onTimeRate < 1; window changes counts."
    },
    {
      "id": "GAP-100",
      "severity": "P2",
      "category": "security",
      "module": "M17",
      "title": "Portal upcoming-visit (M17) and EVV arrival (M18) routes take patient/visit ids from the request and check only an RBAC key, with no M39 family_caregiver_access consent scope; M18 staff reads bind only evv.read with no caseload.",
      "evidence": [
        "apps/backend/src/modules/17-scheduling/routes/scheduling-routes.ts:525-533",
        "apps/backend/src/modules/17-scheduling/scheduling-route-service-db.ts:2082-2094",
        "apps/backend/src/modules/18-evv/routes/evv-routes.ts:481-491",
        "apps/backend/src/modules/18-evv/evv-route-service-db.ts:1268-1281",
        "docs/modules/WARDENX_MODULE_17_SCHEDULING_SPEC_v0_2.md:724; docs/modules/WARDENX_MODULE_18_EVV_SPEC_v0_2.md:801"
      ],
      "verified": false,
      "recommended_fix": "Bind requireAbac with the portal consent predicate (M19 portal_session_consent_active pattern) using the session patient; resolve visitId->patientId for arrival.",
      "verification": "Inject test: portal session for patient A requesting B's visits/arrival -> 403/404."
    },
    {
      "id": "GAP-101",
      "severity": "P2",
      "category": "spec-drift",
      "module": "M19",
      "title": "GET /triage-calls binds caseload_or_scope but the predicate allows collection reads and listTriageCalls applies no narrowing, so every triage.read holder sees all org triage calls.",
      "evidence": [
        "apps/backend/src/modules/19-oncall/routes/triage-calls.routes.ts:76-79",
        "apps/backend/src/modules/19-oncall/routes/read-service-drizzle.ts:220-270",
        "apps/backend/src/modules/07-care-plan/abac-predicates.ts:300-315",
        "docs/modules/WARDENX_MODULE_19_ONCALL_TRIAGE_SPEC_v0_3.md:895"
      ],
      "verified": false,
      "recommended_fix": "Narrow for callers without org-wide scope (own/escalated calls or caseload/on-call PE), or amend the spec to make triage.read org-wide.",
      "verification": "Inject/live: non-on-call RN without org scope sees only their own calls."
    },
    {
      "id": "GAP-102",
      "severity": "P2",
      "category": "doc",
      "module": "M21",
      "title": "Four implemented M21 routes (perpetual-log, assign-retriever, declare-unreturnable, caregiver-signature) are absent from spec section 4.1 (the /api/v1/supplies prefix is already documented at line 2079).",
      "evidence": [
        "apps/backend/src/modules/21-supplies/routes/comfort-kits.routes.ts:117,173,216",
        "apps/backend/src/modules/21-supplies/routes/supply-requests.routes.ts:173",
        "docs/modules/WARDENX_MODULE_21_SUPPLIES_DME_COMFORT_KITS_SPEC_v0_2.md:2079,2083-2120"
      ],
      "verified": true,
      "recommended_fix": "Add the four routes to spec section 4.1.",
      "verification": "Diff spec table vs route extraction."
    },
    {
      "id": "GAP-103",
      "severity": "P2",
      "category": "stub",
      "module": "M22",
      "title": "Spec routes POST /api/v1/documents and POST /documents/:id/versions are permanent 503 DegradedError stubs; the working /api/v1/document-uploads flow and other extra routes are not in spec section 4.1; header comment contradicts itself.",
      "evidence": [
        "apps/backend/src/modules/22-documents/documents-route-service-db.ts:2,488-499,882",
        "apps/backend/src/modules/22-documents/index.ts:83-94",
        "docs/modules/WARDENX_MODULE_22_DOCUMENTS_SPEC_v0_5.md:1489"
      ],
      "verified": false,
      "recommended_fix": "Remove or 410/308-redirect the legacy routes or document the verified-upload flow and extras in spec section 4.1; fix the header.",
      "verification": "Diff spec 4.1 against route extraction; curl POST /api/v1/documents on Docker returns the documented behaviour."
    },
    {
      "id": "GAP-104",
      "severity": "P2",
      "category": "spec-drift",
      "module": "M23",
      "title": "Four spec'd M23 routes are missing: GET /api/v1/billing/validation-overrides, POST /billing/mac-credentials/:id:test, POST /admin/billing/platform-rules, POST /admin/billing/wage-index:load (partly superseded by F-211, spec not updated).",
      "evidence": [
        "docs/modules/WARDENX_MODULE_23_BILLING_MEDICARE_SPEC_v0_2.md:1474,1493,1498,1499",
        "apps/backend/src/modules/24-billing-medicaid/routes/claims.routes.ts:355 (M24 equivalent only)"
      ],
      "verified": false,
      "recommended_fix": "Implement the override list and MAC credential test routes; implement or amend the platform admin routes in spec section 4.1.",
      "verification": "Re-run route extraction vs spec 4.1; bun run arch:openapi-coverage."
    },
    {
      "id": "GAP-105",
      "severity": "P2",
      "category": "stub",
      "module": "M23",
      "title": "POST /api/v1/billing/mac-credentials always returns 503 because secretCipher defaults to denyCipher and production passes none; per-tenant submitter credentials can never be stored (launch gateway uses env tokens).",
      "evidence": [
        "apps/backend/src/modules/23-billing-medicare/routes/write-service-drizzle.ts:248-252,283,1046-1053",
        "apps/backend/src/index.ts:3494-3498",
        "docs/modules/WARDENX_MODULE_23_BILLING_MEDICARE_SPEC_v0_2.md:1492"
      ],
      "verified": false,
      "recommended_fix": "Bind a tenant-DEK SecretCipherPort (M24 credential-crypto pattern) into the write-service construction.",
      "verification": "Docker: POST /api/v1/billing/mac-credentials with step-up -> 200 and an encrypted row."
    },
    {
      "id": "GAP-106",
      "severity": "P2",
      "category": "stub",
      "module": "M23",
      "title": "Internal routes /api/v1/internal/billing/claim-day-projection and /submissions are permanent 503 deny-stubs (no internalSeam passed) yet advertised in the typed client; consumers use the in-process seam.",
      "evidence": [
        "apps/backend/src/modules/23-billing-medicare/routes/internal.routes.ts:52-63,72",
        "apps/backend/src/modules/23-billing-medicare/routes/mount.ts:94",
        "packages/ui/src/core/api/schema.ts:9857,9874"
      ],
      "verified": false,
      "recommended_fix": "Bind a Drizzle M23InternalSeamProvider or remove the routes and amend spec section 4.1 #39/#40.",
      "verification": "GET /api/v1/internal/billing/submissions with a system principal -> 200."
    },
    {
      "id": "GAP-107",
      "severity": "P2",
      "category": "seam",
      "module": "M23",
      "title": "M23 still treats m26.cap.projection_updated (and m8.encounter.signed) as deny-stub/handler-unbound 'until M26 lands' although M26 emits it; M26's catalog lists no m23 consumer. freeze_new_claims for m5.patient.deceased has no schema or implementation. Documented exception with stale comments.",
      "evidence": [
        "apps/backend/src/modules/23-billing-medicare/consumers/subscription-map.ts:67,296,302,314-321",
        "apps/backend/src/modules/23-billing-medicare/consumers/index.ts:139",
        "scripts/outbox-subscription-exceptions.ts:185-191",
        "apps/backend/src/modules/26-cap/events-by-m26.ts:38-52",
        "apps/backend/src/modules/23-billing-medicare/outbox-consumers/m23-revalidate-triggers.ts:46-55"
      ],
      "verified": true,
      "recommended_fix": "Decide whether M23 consumes these events, then bind live consumers (or seam pull), update catalogs and remove the exceptions/stale comments.",
      "verification": "bun run arch:outbox-bindings with exceptions removed + a live real-publisher test."
    },
    {
      "id": "GAP-108",
      "severity": "P2",
      "category": "stub",
      "module": "M24",
      "title": "medicaid-ack-pull cron and medicaid-claim.submit.retry queue are declared names only; batch-file state channels cannot ingest acks and portal failures have no retry queue (Oregon uses sync/poll).",
      "evidence": [
        "apps/backend/src/modules/24-billing-medicaid/jobs/queues.ts:7,13,21",
        "apps/backend/src/modules/24-billing-medicaid/jobs/submission-jobs.ts:597-626",
        "docs/modules/WARDENX_MODULE_24_BILLING_MEDICAID_SPEC_v0_2_1.md:1775-1782"
      ],
      "verified": false,
      "recommended_fix": "Implement the ack-pull cron and submit.retry worker or amend spec section 4.9.",
      "verification": "Unit test of the ack-pull processor; grep index.ts for the registration."
    },
    {
      "id": "GAP-109",
      "severity": "P2",
      "category": "discovered",
      "module": "M24",
      "title": "M24_LAUNCH_GATEWAY_ENABLED is opt-in (default off, workers silently not constructed) contrary to env.ts's opt-out integration-switch policy, and it and M25_X12_WORKER_URL/TOKEN plus ~14 other code-read vars are undocumented in any template or doc.",
      "evidence": [
        "packages/medicaid-adapters/src/oregon/launch-gateway.ts:336",
        "apps/backend/src/index.ts:4697-4699,3588-3591",
        "apps/backend/src/bootstrap/env.ts:29-49",
        "apps/backend/src/modules/25-remittance/ingest/x12-worker-transport.ts:21-25"
      ],
      "verified": false,
      "recommended_fix": "Add M24_LAUNCH_GATEWAY_ENABLED to env.ts INTEGRATION_SWITCHES (opt-out, requiring M24_CREDENTIAL_ENCRYPTION_KEY) or document it as opt-in; document it, M25_X12_WORKER_* and other knobs in .env.example and the production template.",
      "verification": "grep -n M24_LAUNCH_GATEWAY_ENABLED .env.example apps/backend/src/bootstrap/env.ts; env test for production without the switch."
    },
    {
      "id": "GAP-110",
      "severity": "P2",
      "category": "spec-drift",
      "module": "M25",
      "title": "Appeal-deadline cron only alerts at T-30/14/7/1: no T-0 alert and no T-7 next-tier auto-spawn per spec 4.8 (spec itself is inconsistent).",
      "evidence": [
        "apps/backend/src/modules/25-remittance/jobs/m25-jobs.ts:94-111",
        "apps/backend/src/modules/25-remittance/domain/deadline.ts:25,68-78",
        "docs/modules/WARDENX_MODULE_25_REMITTANCE_SPEC_v0_2.md:132,535,1424"
      ],
      "verified": false,
      "recommended_fix": "Decide the rule; implement T-0 + T-7 auto-spawn or amend spec line 1424.",
      "verification": "Unit test runAppealDeadlineWatch at remaining=0 and 7."
    },
    {
      "id": "GAP-111",
      "severity": "P2",
      "category": "spec-drift",
      "module": "M26",
      "title": "Every cap period is created with sentinel CCN '000000'; no M40 CCN resolution and no PS&R CCN validation, so multi-CCN tenants cannot hold per-CCN periods.",
      "evidence": [
        "apps/backend/src/modules/26-cap/routes/write-service-drizzle.ts:110-111",
        "apps/backend/src/modules/26-cap/consumers/drizzle-store.ts:24",
        "docs/modules/WARDENX_MODULE_26_CAP_MANAGEMENT_SPEC_v0_3.md:1486"
      ],
      "verified": false,
      "recommended_fix": "Resolve CCN via the M40 provider-entity seam at period open and validate the PS&R file's CCN, rejecting on mismatch/unbound.",
      "verification": "Live: two CCNs open two periods for one cap year; wrong-CCN PS&R import -> 4xx."
    },
    {
      "id": "GAP-112",
      "severity": "P2",
      "category": "seam",
      "module": "M26",
      "title": "CapSettlementProvider (and Inpatient/Metrics/AlertSubscriber providers) are built but never registered; M33 Cap Watch's consumer bundle is never bound; aggregateForCostReport takes .limit(1) per cap year (multi-CCN under-aggregation); listSubscribers returns [].",
      "evidence": [
        "apps/backend/src/modules/26-cap/wiring.ts:8-9,16-21",
        "apps/backend/src/modules/26-cap/seam-impls.ts:132-133,202-230",
        "docs/modules/WARDENX_MODULE_26_CAP_MANAGEMENT_SPEC_v0_3.md:18",
        "packages/reporting/src/seam-registration.ts:171-178"
      ],
      "verified": false,
      "recommended_fix": "Register CapSettlementProvider and consume it from M27's per-beneficiary attachment; sum all cap_period rows per cap year; wire or delete the dead M33 Cap Watch bundle.",
      "verification": "bun run test:m26 live asserting getSeam('CapSettlementProvider') is live; multi-period fixture in m26-cost-report-cap-seam.live.test.ts."
    },
    {
      "id": "GAP-113",
      "severity": "P2",
      "category": "spec-drift",
      "module": "M27",
      "title": "Xero trial-balance pull, Gusto wage pull and statistics refresh workers are unbound (no OAuth storage), so jobs fail with M27WorkerPortUnbound; only manual imports work. The comment saying LevelOfCarePeriodReader is unavailable is stale.",
      "evidence": [
        "apps/backend/src/modules/27-cost-report/jobs/m27-jobs.ts:1192-1215",
        "apps/backend/src/index.ts:4528-4567,4456"
      ],
      "verified": false,
      "recommended_fix": "Bind statisticsSeams.serviceMonthlyBreakdown to LevelOfCarePeriodReader now; bind Xero/Gusto when tenant OAuth storage lands.",
      "verification": "m27-cost-report-workflow-slice.live.test.ts with statistics-refresh populating statistic_data."
    },
    {
      "id": "GAP-114",
      "severity": "P2",
      "category": "spec-drift",
      "module": "M27",
      "title": "submit and submit-past-deadline behave identically: submit delegates with reason '', the required reason is discarded, no deadline check runs in the service and no warn-severity audit is produced (only the validation rule gates deadlines).",
      "evidence": [
        "apps/backend/src/modules/27-cost-report/routes/write-service-drizzle.ts:1137-1140,1142-1235,1199",
        "apps/backend/src/modules/27-cost-report/routes/cost-reports.routes.ts:186-201",
        "apps/backend/src/modules/27-cost-report/jobs/validation-context-builder.ts:150-151",
        "packages/cost-report/src/validation/default-rules.ts:600-625"
      ],
      "verified": true,
      "recommended_fix": "In submit refuse with 409 past current_effective_deadline_date; in submitPastDeadline persist the reason and emit the warn-severity audit.",
      "verification": "Live: plain submit past deadline -> 409; submit-past-deadline succeeds with reason in audit."
    },
    {
      "id": "GAP-115",
      "severity": "P2",
      "category": "spec-drift",
      "module": "M27",
      "title": "W-CR-12 (close open cost reports on provider-entity offboarding) cannot bind because M40 emits no such event; the m25.denial.opened denial-accrual handler is unbound (documented exceptions).",
      "evidence": [
        "scripts/outbox-subscription-exceptions.ts:227-240",
        "docs/modules/WARDENX_MODULE_27_COST_REPORT_SPEC_v0_2.md:1556-1558"
      ],
      "verified": false,
      "recommended_fix": "Have M40 emit an offboarded/deactivated event and bind a closing consumer; bind or remove the denial-accrual handler.",
      "verification": "bun run arch:outbox-bindings; live offboarding closes cost_report."
    },
    {
      "id": "GAP-116",
      "severity": "P2",
      "category": "seam",
      "module": "M28",
      "title": "M28's LabObservationReader view expects loadById(org, id) but M29 publishes getById/listByPatient/getByObservationId with a different DTO; an `as unknown as` cast hides it, so wiring DiagnosticReport would throw 'loadById is not a function'. Latent (no caller yet); consumed.ts comment is stale.",
      "evidence": [
        "packages/fhir/src/r4/mappers/deps.ts:55-65",
        "packages/fhir/src/r4/mappers/diagnostic-report/projector.ts:60",
        "apps/backend/src/modules/29-external-interfaces/seams/published.ts:47-58,94-116",
        "apps/backend/src/modules/28-fhir/seams/consumed.ts:225-233"
      ],
      "verified": true,
      "recommended_fix": "Retype the @wardenx/fhir reader to M29's contract or add an adapter in consumed.ts; remove the cast and stale comment; add the per-value SUD flag if missing.",
      "verification": "Unit test registering the real reader and calling getFhirLabObservationReader().loadById; bun run typecheck."
    },
    {
      "id": "GAP-117",
      "severity": "P2",
      "category": "spec-drift",
      "module": "M28",
      "title": "Per-client tier rate limits (100/10/1 RPS, 429 + Retry-After) and the one-concurrent-export cap are not enforced; fhirRateLimitDecision exists but is unused.",
      "evidence": [
        "packages/fhir/src/rate-limit/sliding-window.ts:25,53",
        "grep fhirRateLimitDecision|isFhirBulkExportActive|429 in apps/backend/src/modules/28-fhir -> none"
      ],
      "verified": false,
      "recommended_fix": "Add a preHandler on /fhir/r4/* evaluating fhirRateLimitDecision against a Valkey counter; refuse a second $export per client with 429.",
      "verification": "Route test: tier-3 client above 1 RPS -> 429 Retry-After; concurrent $export -> 429."
    },
    {
      "id": "GAP-118",
      "severity": "P2",
      "category": "security",
      "module": "M28",
      "title": "FHIR client co-approval only requires a different fhir.client.admin holder; two org admins can activate a PHI egress client without a Compliance Officer.",
      "evidence": [
        "apps/backend/src/modules/28-fhir/routes/admin-clients.routes.ts:104-114",
        "apps/backend/src/modules/28-fhir/routes/store-drizzle.ts:372-381"
      ],
      "verified": false,
      "recommended_fix": "Require compliance_officer (or a fhir.client.approve key granted only to it) on R25 or check the approver's role in approveClient.",
      "verification": "Live: second org_admin (not compliance) approves -> 403."
    },
    {
      "id": "GAP-119",
      "severity": "P2",
      "category": "coverage",
      "module": "M28",
      "title": "None of the 11 M28 admin screens (client registry, onboarding wizard, bulk export, inbound proposal queues, disclosure accounting, etc.) exist; inbound FHIR proposals are API-only.",
      "evidence": [
        "audit/implementation-status/IMPLEMENTATION_STATUS.md:40",
        "architecture/module-manifest.ts:937",
        "docs/modules/WARDENX_MODULE_28_FHIR_GATEWAY_SPEC_v0_4.md:1743-1757"
      ],
      "verified": false,
      "recommended_fix": "Add an apps/web 28-fhir module with screens.ts for the section 5.1 screens; add codePaths to both manifests.",
      "verification": "bun run ui:parity; status matrix Screens column turns green."
    },
    {
      "id": "GAP-120",
      "severity": "P2",
      "category": "coverage",
      "module": "M29",
      "title": "No M29 operator/clinician screens (feeds, create-feed wizard, proposal detail, unmatched lab queue, NPPES history); ADT review and unmatched-lab review are API-only.",
      "evidence": [
        "audit/implementation-status/IMPLEMENTATION_STATUS.md:41",
        "architecture/module-manifest.ts:957",
        "docs/modules/WARDENX_MODULE_29_EXTERNAL_INTERFACES_SPEC_v0_4.md:2019-2175"
      ],
      "verified": false,
      "recommended_fix": "Add apps/web/src/modules/29-external-interfaces with screens.ts, update both manifests and main.tsx.",
      "verification": "bun run ui:parity && bun run status:matrix --check."
    },
    {
      "id": "GAP-121",
      "severity": "P2",
      "category": "stub",
      "module": "M29",
      "title": "POST /messages/inbound/:messageId/decrypt is a permanent 501 citing an unbound per-tenant DEK, which is stale (dekForOrg resolves and M29 outbound already decrypts per org). Fails closed; moot until inbound ingest exists.",
      "evidence": [
        "apps/backend/src/modules/29-external-interfaces/routes/message.routes.ts:64-85",
        "apps/backend/src/modules/29-external-interfaces/routes/store.ts:455-460",
        "apps/backend/src/modules/27-cost-report/jobs/m27-jobs.ts:1195-1200",
        "apps/backend/src/modules/29-external-interfaces/outbound/dispatch-worker.ts:1056"
      ],
      "verified": true,
      "recommended_fix": "Implement decrypt with getTenantKeyProvider().dekForOrg once raw payloads are envelope-encrypted and emit the M4 disclosure event.",
      "verification": "Route/live: decrypt a seeded inbound message -> plaintext + disclosure audit row."
    },
    {
      "id": "GAP-122",
      "severity": "P2",
      "category": "stub",
      "module": "M30",
      "title": "R-48 GET /v1/quality/sra/cycles/:cycle_id/export (NIST 800-66r2 export) is intentionally not registered; no m30 render_requested event exists.",
      "evidence": [
        "apps/backend/src/modules/30-quality/routes/sra.routes.ts:27-30,71",
        "docs/modules/WARDENX_MODULE_30_HQRP_QUALITY_SPEC_v0_5.md:1458"
      ],
      "verified": false,
      "recommended_fix": "Add the export route service emitting a catalogued m30.sra.render_requested to M22.",
      "verification": "Route test returns 202/document ref; bun run arch:outbox-bindings."
    },
    {
      "id": "GAP-123",
      "severity": "P2",
      "category": "spec-drift",
      "module": "M30",
      "title": "HCI indicators 5-7 are declared structurally unavailable, so the HCI composite is permanently withheld (documented, F-042).",
      "evidence": [
        "packages/quality/src/measures/hci/availability.ts:39-61",
        "packages/quality/src/measures/hci/index.ts:35-36"
      ],
      "verified": false,
      "recommended_fix": "Ingest CMS-published values or a claims feed for 5-7, and update the spec on externally sourced indicators.",
      "verification": "Unit test resolveHciCompositeInput computes once 5-7 have sourced values."
    },
    {
      "id": "GAP-124",
      "severity": "P2",
      "category": "seam",
      "module": "M30",
      "title": "MetricsProvider is registered by M33 but nothing consumes it; M33 has no quality/HQRP MV, its HQRP consumer is a dead deny-stub bundle and MV refresh subscriptions are deferred (nightly only). Documented GAP-066.",
      "evidence": [
        "apps/backend/src/modules/33-reporting/wiring.ts:295-298",
        "packages/reporting/src/refresh/outbox-subscriber.ts:101",
        "apps/backend/src/index.ts:1205-1218"
      ],
      "verified": false,
      "recommended_fix": "Add an M33 quality base/MV over quality_measure_value with a live m30.measure.value_emitted binding, or embed MetricsProvider in M30's measure screen; remove the dead bundle.",
      "verification": "Live: recompute writes quality_measure_value, then the HQRP tile returns isForwardSeamDenyStub:false."
    },
    {
      "id": "GAP-125",
      "severity": "P2",
      "category": "seam",
      "module": "M30",
      "title": "comfort_kit_deployment_to_admin_minutes is active from FY2025 but has no input resolver, so the nightly recompute enqueues a job per provider entity that always throws M30WorkerPortUnbound into the DLQ.",
      "evidence": [
        "packages/quality/src/measures/registry.ts:302-305",
        "apps/backend/src/modules/30-quality/jobs/m30-jobs.ts:412-416,648-663,1660-1732,2043-2049"
      ],
      "verified": false,
      "recommended_fix": "Bind the measure to M13 + M21 data or declare it unavailable (HCI_UNAVAILABLE pattern) so it writes a suppressed row.",
      "verification": "Unit test: resolveInput returns an input or declared-unavailable result."
    },
    {
      "id": "GAP-126",
      "severity": "P2",
      "category": "coverage",
      "module": "M30",
      "title": "M30 compliance backends (SRA, CAHPS, risk register, infection/outbreaks, mortality) have no UI; web registers only quality.hub and quality.qapi-incidents.",
      "evidence": [
        "apps/backend/src/modules/30-quality/routes/sra.routes.ts:77; cahps.routes.ts:92; risk-register.routes.ts:39",
        "audit/ui-parity/UI_PARITY.md (30-quality rows)"
      ],
      "verified": false,
      "recommended_fix": "Add M30 screens in apps/web/src/modules/30-quality/screens.ts for SRA, CAHPS, risk register, infection log and mortality review.",
      "verification": "grep the five quality sub-paths in apps/web/src; ui:parity lists the new screens."
    },
    {
      "id": "GAP-127",
      "severity": "P2",
      "category": "stub",
      "module": "M31",
      "title": "GET /api/v1/admin/portal-accounts/:id/audit-views (164.528 disclosure accounting) always returns {items: []}, which reads as 'no disclosures' rather than unavailable.",
      "evidence": [
        "apps/backend/src/modules/31-portal/routes/admin.routes.ts:10-11,218-231",
        "docs/modules/WARDENX_MODULE_31_PORTAL_TELEHEALTH_SPEC_v0_2.md:824"
      ],
      "verified": true,
      "recommended_fix": "Bind the M4 disclosure-trail read seam, or return 501/503 until bound.",
      "verification": "Route test: after a portal PHI read, audit-views returns >= 1 item."
    },
    {
      "id": "GAP-128",
      "severity": "P2",
      "category": "spec-drift",
      "module": "M31",
      "title": "Spec defines 15 portal/telehealth tables; implementation owns 3 (no invitation, recording, consent-capture or webhook-event persistence) and the spec was never amended.",
      "evidence": [
        "docs/modules/WARDENX_MODULE_31_PORTAL_TELEHEALTH_SPEC_v0_2.md:533-551",
        "architecture/module-manifest.ts:1013",
        "apps/backend/src/modules/31-portal/lifecycle/invitation.ts:8-9"
      ],
      "verified": false,
      "recommended_fix": "Amend the spec via ADR to the three-table model naming owners, or add the tables (manifest .ts/.cjs, migrations, RLS, audit triggers).",
      "verification": "bun run arch:manifest-mirror && bun run arch:module-docs."
    },
    {
      "id": "GAP-129",
      "severity": "P2",
      "category": "spec-drift",
      "module": "M31",
      "title": "The staff-facing portal admin pane (spec 5.3: accounts, invitations, telehealth visits, audit views, disclosure accounting) is not implemented in any app.",
      "evidence": [
        "docs/modules/WARDENX_MODULE_31_PORTAL_TELEHEALTH_SPEC_v0_2.md:1437-1452",
        "audit/implementation-status/IMPLEMENTATION_STATUS.md:43"
      ],
      "verified": false,
      "recommended_fix": "Add an apps/web/src/modules/31-portal staff slice registering the 5.3 screens; add the codePath to both manifests.",
      "verification": "bun run ui:parity && bun run status:matrix --check."
    },
    {
      "id": "GAP-130",
      "severity": "P2",
      "category": "doc",
      "module": "M31",
      "title": "M31 spec mandates `lint:portal-dto`, `lint:telehealth-phi-boundary` and a gated `test:security` CI job (and lists them in its sign-off checklist); none exists and no deferral is recorded. Runtime DTO validation and HMAC'd room names mitigate.",
      "evidence": [
        "docs/modules/WARDENX_MODULE_31_PORTAL_TELEHEALTH_SPEC_v0_2.md:1863,1877,1980-1983,2238-2239",
        "package.json (no such scripts); git grep 'lint:portal-dto|phi-boundary' -> spec only",
        "apps/backend/src/modules/31-portal/routes/portal-typebox.ts:1-8"
      ],
      "verified": true,
      "recommended_fix": "Add scripts/check-portal-dto.ts and scripts/check-telehealth-phi-boundary.ts and register them in scripts/run-fitness-gates.ts, or amend the spec to name existing enforcement and record a reasoned deferral.",
      "verification": "bun run lint:portal-dto && bun run lint:telehealth-phi-boundary, or grep shows the deferral note."
    },
    {
      "id": "GAP-131",
      "severity": "P2",
      "category": "stub",
      "module": "M32",
      "title": "All ten section 4.2 AI inference seams remain deny-stubs because no pipeline is passed; the stated blocker (no per-tenant DEK cipher) is stale since the key-ring TenantKeyProvider binds on a DB boot. Documented 'ai.full OFF' posture.",
      "evidence": [
        "apps/backend/src/index.ts:1686-1705,1799-1802",
        "apps/backend/src/modules/32-ai-platform/seams/index.ts:104-110"
      ],
      "verified": false,
      "recommended_fix": "Build the AiInvocationPipeline with a cipher over getTenantKeyProvider() behind the ai.full flag/kill switch/opt-in, or update the comment to the real blocker.",
      "verification": "Test: with ai.full enabled and opt-in, NarrativeEnhancementProvider writes an ai_invocation row with ciphertext."
    },
    {
      "id": "GAP-132",
      "severity": "P2",
      "category": "spec-drift",
      "module": "M33",
      "title": "Only 3 of 36 platform report MVs exist (33 'registered' placeholders since migration 0061; no later migration creates or activates more), so the spec's day-one HQRP/HOPE/cap/bereavement dashboards are absent. Documented scope.",
      "evidence": [
        "packages/db/migrations/0061_reporting_seed.sql:4-9,15-17,28,30",
        "grep -l 'CREATE MATERIALIZED VIEW' packages/db/migrations -> only 0060_reporting_mv.sql",
        "apps/backend/src/modules/33-reporting/system-dashboard-seeder.ts:17-23",
        "docs/modules/WARDENX_MODULE_33_REPORTING_SPEC_v0_2.md:141"
      ],
      "verified": true,
      "recommended_fix": "Add migrations for the remaining MVs whose upstream tables exist (HOPE window compliance, care-plan review overdue, cap, billing first), flip them active and run scripts/backfill-system-dashboards.ts.",
      "verification": "SELECT count(*) FROM materialized_view_metadata WHERE status='active' rises; GET /api/v1/reporting/dashboards lists them."
    },
    {
      "id": "GAP-133",
      "severity": "P2",
      "category": "spec-drift",
      "module": "M33",
      "title": "Reporting team/location scope always collapses to 'self' because M2 publishes no SupervisorReader; supervisors cannot see team data (fail-closed, documented).",
      "evidence": [
        "apps/backend/src/modules/33-reporting/abac-resolver-db.ts:12-16,54"
      ],
      "verified": false,
      "recommended_fix": "Publish an M2 SupervisorReader (or reuse M5 CaseloadProvider) and call it from buildDrizzleReportingAbacResolver.",
      "verification": "Route test: supervisor of member X sees X's rows on GET /api/v1/reporting/tiles/:tileKey."
    },
    {
      "id": "GAP-134",
      "severity": "P2",
      "category": "spec-drift",
      "module": "M34",
      "title": "Six spec'd M34 routes are not implemented (platform DSAR list, platform onboarding view/skip, tenant account read, tenant feature-flag read/write); two TypeBox schemas are orphaned. The DSAR list may be an unrecorded M34-F09 decision.",
      "evidence": [
        "docs/modules/WARDENX_MODULE_34_SAAS_TENANT_PLATFORM_SPEC_v0_3.md:1645,1646,1656,1670,1689,1690",
        "apps/backend/src/modules/34-saas-tenant-platform/routes/typebox.ts:160-163,263-266",
        "audit/AUDIT_M34.md:32"
      ],
      "verified": false,
      "recommended_fix": "Implement the routes (step-up on onboarding skip) and enrich them, or amend spec 4.1 via ADR and delete the orphan schemas.",
      "verification": "Spec-vs-route comparison has 0 spec-only rows; bun run openapi:coverage."
    },
    {
      "id": "GAP-135",
      "severity": "P2",
      "category": "spec-drift",
      "module": "M34",
      "title": "Four M34 routes (support-session events, POST/PATCH baa-register, signup-intents reject) are not in spec 4.1; the BAA-register writes are gated by the same READ guard as the GET with no step-up, unlike every other platform-ops write.",
      "evidence": [
        "docs/modules/WARDENX_MODULE_34_SAAS_TENANT_PLATFORM_SPEC_v0_3.md:1629-1665",
        "apps/backend/src/modules/34-saas-tenant-platform/routes/platform/support-sessions.ts:135-136",
        "apps/backend/src/modules/34-saas-tenant-platform/routes/platform/baa-register.ts:65-67,86-88",
        "apps/backend/src/modules/34-saas-tenant-platform/routes/platform/signup-intents.ts:82-84"
      ],
      "verified": true,
      "recommended_fix": "Document the four routes in spec 4.1 with permission/ABAC/step-up and decide the BAA-register write guard.",
      "verification": "Spec-vs-route comparison has 0 impl-only rows."
    },
    {
      "id": "GAP-136",
      "severity": "P2",
      "category": "security",
      "module": "M36",
      "title": "messaging.manage_members routes carry only requirePermission; addMember/removeMember check neither location nor channel kind, so a holder can add themselves to another pair's DM and then read it. Header claims channel_visibility ABAC.",
      "evidence": [
        "apps/backend/src/modules/36-messaging/routes/messaging-routes.ts:10-12,89,98-99,199-225",
        "apps/backend/src/modules/36-messaging/messaging-route-service-db.ts:506-550",
        "packages/auth/src/permissions/contributed.ts:220-225",
        "docs/modules/WARDENX_MODULE_36_MESSAGING_SPEC_v0_4.md:1720"
      ],
      "verified": true,
      "recommended_fix": "Add requireAbac('messaging.manage_members','location_membership') (or a channel_member_admin predicate) and refuse manual edits on 'dm' channels.",
      "verification": "bun run arch:abac-predicates; route test: clinical_lead adding to a DM or other-location channel -> 403."
    },
    {
      "id": "GAP-137",
      "severity": "P2",
      "category": "spec-drift",
      "module": "M36",
      "title": "channel_visibility implements only the membership branch, not caseload_membership (care_team) or bereavement_membership; with channel_sync unbuilt, care_team access can outlive caseload removal.",
      "evidence": [
        "apps/backend/src/modules/36-messaging/messaging-route-service-db.ts:337-363",
        "docs/modules/WARDENX_MODULE_36_MESSAGING_SPEC_v0_4.md section 4.5 (~1715)"
      ],
      "verified": false,
      "recommended_fix": "Branch canViewChannel on channel_kind: care_team -> CaseloadProvider seam, bereavement -> M16 seam.",
      "verification": "Live: user removed from a care team with a stale channel_member row is denied the channel."
    },
    {
      "id": "GAP-138",
      "severity": "P2",
      "category": "spec-drift",
      "module": "M36",
      "title": "Spec'd platform-ops route GET /api/v1/admin/messaging/alert-deliveries is not implemented (permission key exists).",
      "evidence": [
        "docs/modules/WARDENX_MODULE_36_MESSAGING_SPEC_v0_4.md:1554",
        "packages/auth/src/permissions/contributed.ts:259"
      ],
      "verified": false,
      "recommended_fix": "Add the route with messaging.admin.read plus a platform-ops ABAC conjunct, audited as elevated access, and enrich it.",
      "verification": "bun run arch:openapi-coverage; platform_ops 200 / tenant org_admin 403."
    },
    {
      "id": "GAP-139",
      "severity": "P2",
      "category": "coverage",
      "module": "M36",
      "title": "alert_receipt has no live RLS test although it shipped once with no RLS or grants (0243 -> 0247 production 42501).",
      "evidence": [
        "audit/implementation-status/IMPLEMENTATION_STATUS.md:48",
        "packages/db/migrations/0247_alert_receipt_rls_and_grants.sql:1-4"
      ],
      "verified": false,
      "recommended_fix": "Add a wardenx_app live suite asserting cross-tenant invisibility and insert refusal; add the package.json script and ci.yml job.",
      "verification": "bun run status:matrix shows M36 Live 16/16; bun run arch:live-suites."
    },
    {
      "id": "GAP-140",
      "severity": "P2",
      "category": "spec-drift",
      "module": "M37",
      "title": "The IRC 30-day resumption rule is not applied at episode open (resumedStartingDayCount unused), so IRC can be split into fresh episodes; combined with the missing watchdog the IRC cap is unenforced.",
      "evidence": [
        "apps/backend/src/modules/37-ipu/routes/service-drizzle.ts:536-543",
        "packages/inpatient/src/machines/irc-episode.ts:95-118",
        "docs/modules/WARDENX_MODULE_37_IPU_SPEC_v0_2.md:248"
      ],
      "verified": false,
      "recommended_fix": "Select episodes closed within the look-back in open_irc_episode and set consecutiveDayCount via resumedStartingDayCount.",
      "verification": "Live: close a 3-day episode, reopen within 30 days -> starts at day 4."
    },
    {
      "id": "GAP-141",
      "severity": "P2",
      "category": "spec-drift",
      "module": "M37",
      "title": "None of the five section 4.7 M37 predicates is consulted by any route (target-boolean stubs); ipu.staff_member unit scoping is unenforced (getAdmission is a plain RLS read) and RN-coverage is checked only in four service methods, not 'every mutation' (e.g. equipment assign). Removal documented in guards.ts.",
      "evidence": [
        "apps/backend/src/modules/37-ipu/abac/predicates.ts:42-50",
        "apps/backend/src/modules/37-ipu/routes/guards.ts:5-18",
        "apps/backend/src/modules/37-ipu/routes/service-drizzle.ts:303,933-938,947,1002,1155,1794,2240-2256",
        "docs/modules/WARDENX_MODULE_37_IPU_SPEC_v0_2.md:1368,1613-1642"
      ],
      "verified": true,
      "recommended_fix": "Enforce staff_member (unit assignment or IPU director) in the service on IPU admission reads/writes and extend RN coverage to the section 2.3 list, or amend spec 4.1/4.7.",
      "verification": "Route tests: non-IPU staff denied GET /api/v1/ipu-admissions/:id; equipment assign during uncovered hour -> 412."
    },
    {
      "id": "GAP-142",
      "severity": "P2",
      "category": "seam",
      "module": "M39",
      "title": "M39 section 4.6 consumers (m5.patient.merged re-point, m4.legal_hold.*, m22.document.rendered back-ref) have deciders but no bindings; after a merge the survivor has no consents (fail-closed denials) and the duplicate's consents are orphaned.",
      "evidence": [
        "apps/backend/src/modules/39-consent/consumers.ts:60,69",
        "apps/backend/src/modules/05-patient/events-by-m5.ts:166-167",
        "docs/modules/WARDENX_MODULE_39_CONSENT_SPEC_v0_3.md:1628-1639"
      ],
      "verified": false,
      "recommended_fix": "Bind M39 consumers for those events, add m39 to the producers' declaredConsumers and wire them in index.ts.",
      "verification": "bun run arch:outbox-bindings; live merge re-points consent_record.patient_id and publishes m39.consent.repointed."
    },
    {
      "id": "GAP-143",
      "severity": "P2",
      "category": "spec-drift",
      "module": "M39",
      "title": "4 of 6 M39 crons are unbuilt (revocation-cascade-retry, renewal-cycle-close, draft-auto-expire, eval-audit-partition); stuck cascades are not retried automatically and consent_eval_audit lands in the DEFAULT partition. Self-documented.",
      "evidence": [
        "apps/backend/src/modules/39-consent/jobs/index.ts:11-12",
        "apps/backend/src/modules/39-consent/jobs/cron-workers.ts:61-72",
        "packages/db/migrations/0023_consent_m39_rls_audit_triggers.sql:454"
      ],
      "verified": false,
      "recommended_fix": "Add the four workers and schedules in cron-workers.ts using withOrgContext per org.",
      "verification": "Live suite per job (e.g. a cascade stuck >5 min is re-fired)."
    },
    {
      "id": "GAP-144",
      "severity": "P2",
      "category": "stub",
      "module": "M40",
      "title": "ExternalGriefResourceReader is never registered (no external_grief_resource table), so GET /api/v1/portal/bereavement/resources returns 501 by design; the M22 tenant-catalog half is not composed either. M31 header claims every producer is live.",
      "evidence": [
        "apps/backend/src/modules/31-portal/routes/read.routes.ts:422-437",
        "apps/backend/src/bootstrap/seams/registry.ts:253-259",
        "apps/backend/src/bootstrap/seams/providers.ts:285-287",
        "apps/backend/src/modules/31-portal/seams/registration.ts:100,153",
        "docs/modules/WARDENX_MODULE_31_PORTAL_TELEHEALTH_SPEC_v0_2.md:804"
      ],
      "verified": true,
      "recommended_fix": "Build the M40 grief-resource catalog seam (or compose the M22 tenant catalog alone) and register it; correct the M31_REQUIRED_SEAMS header.",
      "verification": "Docker: portal bereavement resources -> 200 with items."
    },
    {
      "id": "GAP-145",
      "severity": "P2",
      "category": "spec-drift",
      "module": "M40",
      "title": "The M40 job tier is unbuilt: BAA 90/30/0-day and license expiration alerts, fuzzy dedup, execute_merge/repoint, NPPES fallback and provisional aging never run (queues defined as data only). mdm-routes.ts claims repoint jobs run in the background.",
      "evidence": [
        "packages/mdm/src/jobs/queues.ts:10,40",
        "grep MDM_QUEUES|MDM_JOB apps/backend/src -> 0 hits",
        "apps/backend/src/modules/40-mdm/routes/mdm-routes.ts:19-22",
        "docs/modules/WARDENX_MODULE_40_MDM_SPEC_v0_4.md:1020-1031"
      ],
      "verified": false,
      "recommended_fix": "Add apps/backend/src/modules/40-mdm/jobs/ with at least baa_expiration_scan, license_expiration_scan and execute_merge/repoint wired from index.ts; correct the header.",
      "verification": "Live: BAA expiring in 30 days produces an M36 alert after the scan."
    },
    {
      "id": "GAP-146",
      "severity": "P2",
      "category": "coverage",
      "module": "global",
      "title": "About 40 documented screen specs have no registered screen (keyword join; ui:parity does no per-screen join): e.g. CLINICAL_COPILOT, DEATH_PRONOUNCEMENT, WOUND_CARE, ALLERGY_MANAGEMENT, BREACH_SECURITY_INCIDENTS, OIG_COMPLIANCE_PROGRAM, PATIENT_RIGHTS_GRIEVANCES, PRIOR_AUTHORIZATION, TIMESHEETS_PAYROLL, FHIR_GATEWAY_CLIENTS, HL7_INTERFACE_LOGS and the six non-patient portals. Some are partly covered by other screens.",
      "evidence": [
        "audit/ui-parity/UI_PARITY.md:9,13",
        "docs/design/screens/ (cited spec files, e.g. clinical/WARDENX_UI_WOUND_CARE.md, revenue/WARDENX_UI_PRIOR_AUTHORIZATION.md)",
        "apps/backend/src/modules/28-fhir/routes/admin-clients.routes.ts:37 (backend exists, no UI caller)"
      ],
      "verified": true,
      "recommended_fix": "Add a spec-to-screen key (e.g. a `spec:` field on ScreenDef) so scripts/report-ui-parity.ts lists unbuilt specs; prioritise clinical/compliance specs whose backends exist.",
      "verification": "bun run ui:parity prints a per-spec 'unbuilt' list that shrinks as screens land."
    },
    {
      "id": "GAP-147",
      "severity": "P2",
      "category": "doc",
      "module": "global",
      "title": "Frame-fidelity notes for eMAR, Encounter and Patient Chart are stale (claim unbuilt writes/unbound selections/placeholder cards that now exist); the gate checks only report freshness, not note accuracy.",
      "evidence": [
        "scripts/frame-fidelity/registry.ts:108,143,188-189",
        "apps/web/src/modules/13-emar/emar-api.ts:278,301,312",
        "apps/web/src/modules/08-encounters/encounter-read.tsx:461",
        "apps/web/src/modules/05-patient/patient-overview.tsx:232,705"
      ],
      "verified": false,
      "recommended_fix": "Edit the three entries in scripts/frame-fidelity/registry.ts and regenerate with bun run frame:fidelity.",
      "verification": "bun run frame:fidelity:check green; the stale phrases no longer appear in the registry."
    },
    {
      "id": "GAP-148",
      "severity": "P2",
      "category": "coverage",
      "module": "global",
      "title": "Frame-fidelity maps 17 of 120 ledger frames (3 matched, 14 partial); the other 103 are not even 'pending', so '0 pending' reads as complete. No revenue (M23-M27) screen is mapped.",
      "evidence": [
        "audit/frame-fidelity/FRAME_FIDELITY.md:8-9",
        "bun run scripts/report-frame-fidelity.ts --check -> 17 mapped, 3/14/0"
      ],
      "verified": false,
      "recommended_fix": "Seed scripts/frame-fidelity/registry.ts with a 'pending' row for every ledger frame that has a built screen, starting with M23/M25/M26/M27.",
      "verification": "bun run frame:fidelity reports pending > 0."
    },
    {
      "id": "GAP-149",
      "severity": "P2",
      "category": "security",
      "module": "global",
      "title": "The SPA document is served without CSP, frame-ancestors, X-Frame-Options, HSTS, nosniff or Referrer-Policy (headers are set only on Fastify API responses), contrary to SECURITY_HARDENING 9.6.1; backend CSP also lacks report-uri.",
      "evidence": [
        "deploy/production/web-nginx.conf:1-21",
        "deploy/production/nginx/wardenx-frontend.conf:24-30",
        "apps/backend/src/bootstrap/plugins/security.ts:46-56,66-69",
        "docs/architecture/WARDENX_SECURITY_HARDENING_v0_2.md:1140-1155"
      ],
      "verified": true,
      "recommended_fix": "Add the security.ts header set with `always` at server level (and in add_header location blocks) in web-nginx.conf; verify CSP against the Vite build; optionally add report-uri.",
      "verification": "curl -sI https://wardenx.chartwarden.cloud/ | grep -i 'content-security-policy\\|x-frame-options\\|strict-transport'."
    },
    {
      "id": "GAP-150",
      "severity": "P2",
      "category": "coverage",
      "module": "global",
      "title": "check-fitness-gaps phi-guards regexes are vacuous: a table passes RLS if 'enable row level security' appears anywhere earlier in the corpus, and the audit-trigger check passes on any 'trigger' + 'on <table>' + 'audit'; not net-effect aware. Live dev DB is currently clean.",
      "evidence": [
        "scripts/check-fitness-gaps.ts:199-201,205-207",
        "scratch replica: fake table passes both checks",
        "psql dev DB (through 0306): 0 org tables lacking RLS/FORCE/policy; 0 patient tables lacking audit trigger"
      ],
      "verified": false,
      "recommended_fix": "Replace the regexes with a per-table net-effect replay (ENABLE/DISABLE RLS, CREATE/DROP TRIGGER) or a pg_catalog live assertion.",
      "verification": "Add a fixture migration with an untriggered org table and confirm bun run arch:gaps exits 1."
    },
    {
      "id": "GAP-151",
      "severity": "P2",
      "category": "doc",
      "module": "global",
      "title": "Ops runbook and security hardening cite unannotated infra/ artifacts (secret inventory, MinIO policies, Grafana dashboards, firewall rules) that do not exist; arch:architecture-docs cannot see them because PATH_PREFIXES omits infra/ and deploy/.",
      "evidence": [
        "docs/architecture/WARDENX_OPS_RUNBOOK_v0.1.md:816,985,1333",
        "docs/architecture/WARDENX_SECURITY_HARDENING_v0_2.md:793",
        "scripts/check-architecture-docs.ts:37"
      ],
      "verified": false,
      "recommended_fix": "Add infra|deploy to PATH_PREFIXES, then create the artifacts or annotate the four citations as not yet created.",
      "verification": "bun run arch:architecture-docs fails before annotation, passes after."
    },
    {
      "id": "GAP-152",
      "severity": "P2",
      "category": "build",
      "module": "global",
      "title": "bootstrap-vps.sh reads deploy/production/.env.production.example, which has never been committed (gitignored by `.env.*`); a first-time bootstrap / DR rebuild fails under set -eu. Ten production-required keys appear in no committed template (TRUSTED_ORIGINS, TWO_FACTOR_ENCRYPTION_KEY, M24_CREDENTIAL_ENCRYPTION_KEY, M13_WITNESS_SIGNING_KEY, MESSAGING_ENCRYPTION_KEY, CURSOR_SIGNING_KEY, PASSKEY_RP_ID, WEBAUTHN_RP_ID, TRUSTED_PROXY_CIDRS, INTERNAL_SERVICE_TOKEN).",
      "evidence": [
        "deploy/production/bootstrap-vps.sh:9,39-50",
        "git check-ignore -v deploy/production/.env.production.example -> .gitignore:25:.env.*",
        "git log --all -- 'deploy/production/.env.production*' -> empty",
        "deploy/production/README.md:23",
        "apps/backend/src/bootstrap/env.ts (keys present; 0 matches in .env.example/deploy/deploy.yml)"
      ],
      "verified": true,
      "recommended_fix": "Add deploy/production/.env.production.example with every env.ts REQUIREMENTS key using the REPLACE_WITH_* placeholders the bootstrap's sed expects; add `!deploy/production/.env.production.example` to .gitignore; optionally gate key coverage.",
      "verification": "git ls-files deploy/production/.env.production.example; run bootstrap-vps.sh with DEPLOY_DIR=/tmp/x in a container and confirm .env.production is produced."
    },
    {
      "id": "GAP-153",
      "severity": "P2",
      "category": "spec-drift",
      "module": "global",
      "title": "29+ error responses in M02, M12, M29, M33 and M37 bypass the M1 section 4.3 envelope with flat {code,message} or string {error:'...'} bodies, without correlationId.",
      "evidence": [
        "docs/modules/WARDENX_MODULE_01_FOUNDATION_SPEC_v0_4.md:2278-2300",
        "apps/backend/src/bootstrap/plugins/error-handler.ts:39-66",
        "apps/backend/src/modules/37-ipu/routes/ipu.routes.ts:236",
        "apps/backend/src/modules/29-external-interfaces/routes/feed.routes.ts:75 (also nppes/message/labs/proposal routes)",
        "apps/backend/src/modules/02-identity/routes/session-step-up.ts:68,178-194,242,244; device-attestation.ts:177-348",
        "apps/backend/src/modules/33-reporting/routes/exports.routes.ts:123-125; apps/backend/src/modules/12-dosespot/webhooks/webhook-route.ts:68-73"
      ],
      "verified": false,
      "recommended_fix": "Replace direct error sends with thrown WardenXError subclasses (extra fields via details); add a fitness grep with an allowlist for vendor-mandated webhook replies.",
      "verification": "grep -rnE 'code\\([45][0-9]{2}\\)\\.send\\(\\{ *(code:|error: *\")' apps/backend/src --include='*.ts' --exclude-dir=__tests__ returns only allowlisted lines; route tests assert body.error.correlationId."
    },
    {
      "id": "GAP-154",
      "severity": "P3",
      "category": "seam",
      "module": "M01",
      "title": "m1.system_status.changed and m1.feature_flag.updated are catalogued but never emitted; Socket.IO realtime events are an ADR-0036 deferral, but catalog entries without producers remain drift.",
      "evidence": [
        "packages/shared/src/outbox-events/events-by-m1.ts:12-43",
        "apps/backend/src/bootstrap/routes/system.ts:88-94",
        "docs/adr/ADR-0036-no-realtime-backbone.md"
      ],
      "verified": false,
      "recommended_fix": "Publish m1.system_status.changed from the admin upsert, or drop the catalog entries and record it in ADR-0036.",
      "verification": "Unit test: POST /admin/system/status leaves an outbox_event row; bun run arch:gaps."
    },
    {
      "id": "GAP-155",
      "severity": "P3",
      "category": "coverage",
      "module": "M01",
      "title": "5 bootstrap routes are unenriched (health/ready/version/metrics probes plus the client-consumed GET /api/v1/system/feature-flags, which has no response schema, so the UI uses a hand-written FeatureFlags type); the baseline allows a deficit of 5.",
      "evidence": [
        "apps/backend/src/bootstrap/routes/system.ts:82-86; apps/backend/src/bootstrap/routes/health.ts:30-46",
        "scripts/openapi/enrichments.ts:10731-10745",
        "docs/api/openapi.json paths['/api/v1/system/feature-flags'].get.responses['200'] = {description:'OK'}",
        "packages/ui/src/core/types.ts:18-19",
        "audit/openapi-coverage/OPENAPI_COVERAGE.md:53; audit/openapi-coverage/baseline.json:199-203"
      ],
      "verified": true,
      "recommended_fix": "Add ROUTE_ENRICHMENTS for GET /api/v1/system/feature-flags ({flags: Record<string,boolean>}) and the probes; run openapi:emit, client:gen, openapi:coverage --update.",
      "verification": "bun run openapi:coverage && bun run arch:openapi-coverage && bun run client:check; bootstrap deficit drops."
    },
    {
      "id": "GAP-156",
      "severity": "P3",
      "category": "doc",
      "module": "M03",
      "title": "The implementation-status matrix shows M03 Tests and M01 Routes/Screens as absent although authz tests and bootstrap routes exist (heuristic misses them).",
      "evidence": [
        "audit/implementation-status/IMPLEMENTATION_STATUS.md:13,15",
        "apps/backend/__tests__/authz-routes.test.ts, authz-idor.test.ts"
      ],
      "verified": false,
      "recommended_fix": "Teach the status:matrix heuristic the authz-*/break-glass-* slugs and count apps/backend/src/bootstrap/routes as M1 routes.",
      "verification": "bun run status:matrix --check shows M03 Tests and M01 Routes green."
    },
    {
      "id": "GAP-157",
      "severity": "P3",
      "category": "coverage",
      "module": "M03",
      "title": "No boot-level check that every requireAbac predicate name is registered at runtime; check-abac-predicates is static and per-module tests are scoped. Production is currently correct, but a dropped registrar call would 403 every caller with all gates green.",
      "evidence": [
        "scripts/check-abac-predicates.ts:31-33",
        "apps/backend/src/modules/11-orders/index.ts:94; apps/backend/src/modules/22-documents/index.ts:61",
        "scripts/check-boot-with-platform-credential.ts (no ABAC check)"
      ],
      "verified": true,
      "recommended_fix": "Add a DB-booted test (extend check:boot:platform or a live boot suite) asserting every requireAbac literal resolves in abacRegistry.names().",
      "verification": "Remove a registrar call on a scratch branch and confirm the new check fails."
    },
    {
      "id": "GAP-158",
      "severity": "P3",
      "category": "stub",
      "module": "M05",
      "title": "Census KPIs (Admissions, Discharges, GIP, Recerts due) are hardcoded '—' placeholders; M6 list endpoints exist but are paginated lists, not counts.",
      "evidence": [
        "apps/web/src/modules/05-patient/patient-list-census.tsx:83-86,104-105",
        "packages/ui/src/core/api/schema.ts:1859-1867,5180-5187",
        "audit/frame-fidelity/FRAME_FIDELITY.md:29"
      ],
      "verified": true,
      "recommended_fix": "Add a count/metrics read (or census-metrics extension) and bind the KPIs; update the frame-fidelity note.",
      "verification": "Census DOM test asserts numeric KPI values from mocked responses."
    },
    {
      "id": "GAP-159",
      "severity": "P3",
      "category": "doc",
      "module": "M06",
      "title": "22 implemented M06 routes (referral phase-1 workflow, readiness, patient admissions, evidence uploads, confirm-bed) are not in the spec section 4.1 inventory (68 vs 46).",
      "evidence": [
        "apps/backend/src/modules/06-admission/routes/admission-routes.ts",
        "docs/modules/WARDENX_MODULE_06_ADMISSION_ELECTION_CERTIFICATION_SPEC_v0_4.md:1787-1846"
      ],
      "verified": false,
      "recommended_fix": "Add the 22 routes with permission/ABAC to spec section 4.1.",
      "verification": "Route-vs-spec diff reports no unmatched routes."
    },
    {
      "id": "GAP-160",
      "severity": "P3",
      "category": "doc",
      "module": "M08",
      "title": "6 M08 read routes are missing from the spec's '31 routes' inventory (37 registered); route header says 34.",
      "evidence": [
        "apps/backend/src/modules/08-encounters/routes/encounters-routes.ts:1-2,245,320",
        "docs/modules/WARDENX_MODULE_08_ENCOUNTERS_SPEC_v0_2.md:1152"
      ],
      "verified": false,
      "recommended_fix": "Add the six GETs to spec 4.1 and fix the header count.",
      "verification": "Spec total equals 37."
    },
    {
      "id": "GAP-161",
      "severity": "P3",
      "category": "doc",
      "module": "M09",
      "title": "Two implemented M09 routes (summary/document POST, GET /scales) are not in spec 4.1.",
      "evidence": [
        "apps/backend/src/modules/09-assessments/routes/assessments-routes.ts:219,417",
        "docs/modules/WARDENX_MODULE_09_CLINICAL_ASSESSMENTS_SPEC_v0_3.md:757-776"
      ],
      "verified": false,
      "recommended_fix": "Add both routes to spec 4.1.",
      "verification": "Spec 4.1 matches 20 registrations."
    },
    {
      "id": "GAP-162",
      "severity": "P3",
      "category": "coverage",
      "module": "M10",
      "title": "GET /hope/submissions/{id}/package (ZIP download) declares no response content type, so the generated client cannot type it.",
      "evidence": [
        "audit/openapi-coverage/OPENAPI_COVERAGE.md:22",
        "docs/api/openapi.json paths['/api/v1/hope/submissions/{id}/package']"
      ],
      "verified": false,
      "recommended_fix": "Add a 200 application/zip binary response to the M10 enrichment.",
      "verification": "bun run openapi:coverage shows 10-hope GET-no-resp 0; bun run client:check."
    },
    {
      "id": "GAP-163",
      "severity": "P3",
      "category": "spec-drift",
      "module": "M10",
      "title": "HOPE draft update and answer/HUV PATCH routes omit the discipline ABAC (authorDisciplineAllowed) the spec requires; GET /hope/sfv deliberately skips caseload scope and returns an org-wide PHI worklist.",
      "evidence": [
        "apps/backend/src/modules/10-hope/routes/hope-routes.ts:270-271,376-377,393,432-447",
        "docs/modules/WARDENX_MODULE_10_HOPE_ENGINE_SPEC_v0_2.md:952,957"
      ],
      "verified": false,
      "recommended_fix": "Add ABAC_AUTHOR to PUT/PATCH routes; filter listSfv by caseload for non-org-wide roles.",
      "verification": "Route test: non-RN/NP/MD with write -> 403; SFV list excludes off-caseload patients."
    },
    {
      "id": "GAP-164",
      "severity": "P3",
      "category": "doc",
      "module": "M11",
      "title": "Six M11 routes (verbal-orders, held-transmissions, resend/recover-transmission and its cosign/cancel) are absent from spec 4.1 (only in docs/history and openapi.json).",
      "evidence": [
        "apps/backend/src/modules/11-orders/routes/orders-routes.ts:253,462,486,511,530",
        "apps/backend/src/modules/11-orders/routes/held-transmissions-routes.ts:38"
      ],
      "verified": false,
      "recommended_fix": "Add the routes with permissions/step-up to M11 spec 4.1.",
      "verification": "bun run arch:module-docs and a manual diff."
    },
    {
      "id": "GAP-165",
      "severity": "P3",
      "category": "doc",
      "module": "M12",
      "title": "POST /medication-orders/:id/report-error (F-205) and its permission are absent from the M12 spec route inventory (the event is documented), and the status matrix's 'Adapter' green overstates readiness while the only DoseSpot client is the deny-stub.",
      "evidence": [
        "apps/backend/src/modules/12-dosespot/routes/dosespot-routes.ts:294-299",
        "docs/modules/WARDENX_MODULE_12_DOSESPOT_PRESCRIBING_SPEC_v0_2.md:1021-1059,1234",
        "audit/implementation-status/IMPLEMENTATION_STATUS.md:9,24",
        "packages/dosespot/src/client/unbound.ts:5"
      ],
      "verified": true,
      "recommended_fix": "Add the route to spec 4.1; refine the status-matrix adapter heuristic to exclude deny-stub-only clients.",
      "verification": "bun run status:matrix --check; bun run arch:module-docs."
    },
    {
      "id": "GAP-166",
      "severity": "P3",
      "category": "doc",
      "module": "M14",
      "title": "M14 implements routes absent from spec 4.1 (ad-hoc meeting create, agenda/attendance/decisions/recert-windows GETs, idg-history) while the spec's internal /api/v1/internal/idg/* routes are served via in-process seams instead; DECISION_PAYLOAD_INVALID is never emitted.",
      "evidence": [
        "apps/backend/src/modules/14-idg/routes/idg-routes.ts:219,522",
        "docs/modules/WARDENX_MODULE_14_IDG_SPEC_v0_4.md:884-886"
      ],
      "verified": false,
      "recommended_fix": "Update spec 4.1/4.3 to the implemented routes and seams; drop or implement DECISION_PAYLOAD_INVALID.",
      "verification": "bun run arch:module-docs."
    },
    {
      "id": "GAP-167",
      "severity": "P3",
      "category": "coverage",
      "module": "M17",
      "title": "membership_credential (M17) and bereavement_cop_opt_out_credit (M16) have no direct cross-tenant RLS assertion on the app role (only setup inserts / admin reads).",
      "evidence": [
        "packages/db/migrations/__tests__/m17-rls-isolation.live.test.ts",
        "apps/backend/__tests__/m16-opt-out-changed.live.test.ts:153,299,355-371"
      ],
      "verified": false,
      "recommended_fix": "Add both tables to the m16/m17 rls-isolation live suites.",
      "verification": "Run the m16/m17 rls-isolation live suites against Docker Postgres."
    },
    {
      "id": "GAP-168",
      "severity": "P3",
      "category": "spec-drift",
      "module": "M17",
      "title": "Implemented routes absent from spec 4.1: M17 /visits/:id/arrive and membership credentials; M19 paper-reentry (+worklist) and vendor-sessions/bind; M20 GET /safety/incidents list.",
      "evidence": [
        "apps/backend/src/modules/17-scheduling/routes/scheduling-routes.ts:253,575,592,610",
        "apps/backend/src/modules/19-oncall/routes/triage-calls.routes.ts:307,325; vendor-sessions.routes.ts:71",
        "apps/backend/src/modules/20-field-safety/routes/incidents.routes.ts:87-88",
        "docs/modules/WARDENX_MODULE_20_FIELD_SAFETY_SPEC_v0_3.md:1042-1047,1598"
      ],
      "verified": true,
      "recommended_fix": "Add these rows (permission/ABAC) to the M17, M19 and M20 spec 4.1 tables.",
      "verification": "bun run arch:module-docs or a manual route-table diff."
    },
    {
      "id": "GAP-169",
      "severity": "P3",
      "category": "stub",
      "module": "M22",
      "title": "M22's DocLens resolver is hard-wired to the deny-stub; rewiring alone would change nothing because M32 registers DocLens seams only when a pipeline is passed (none is). Latent, documented (F-231).",
      "evidence": [
        "apps/backend/src/modules/22-documents/extraction/doclens-capability.ts:12-16,23-31",
        "apps/backend/src/modules/22-documents/index.ts:125",
        "apps/backend/src/modules/32-ai-platform/seams/index.ts:111-112,122-125",
        "apps/backend/src/index.ts:1693-1705",
        "docs/history/outbox-248-builds.md:2197"
      ],
      "verified": true,
      "recommended_fix": "Project getSeam('DocLensClassifier'/'DocLensExtractor') into DocLensCapabilityPort with a fail-closed fallback once the M32 pipeline binds.",
      "verification": "With M32 seams registered and the flag on, POST /api/v1/intake/uploads/:id/extraction/run is not capability_unavailable."
    },
    {
      "id": "GAP-170",
      "severity": "P3",
      "category": "spec-drift",
      "module": "M22",
      "title": "M22, M25 and M31 specs prescribe tenant_id / app.tenant_id RLS, which ADR-0010 D2 bans (architecture wins); shipped migrations correctly use app.org_id. Spec-text drift only.",
      "evidence": [
        "docs/adr/ADR-0010-tenancy-rls-invariants.md:31-35",
        "docs/modules/WARDENX_MODULE_22_DOCUMENTS_SPEC_v0_5.md:2806-2807",
        "docs/modules/WARDENX_MODULE_25_REMITTANCE_SPEC_v0_2.md:1802",
        "docs/modules/WARDENX_MODULE_31_PORTAL_TELEHEALTH_SPEC_v0_2.md:2034"
      ],
      "verified": false,
      "recommended_fix": "Rewrite M22 8.2, M25 8.1 and M31 task A4 to organization_id / app.org_id with revision rows (M17-F10 precedent).",
      "verification": "grep -n 'app.tenant_id' docs/modules/*.md returns only lines citing it as banned."
    },
    {
      "id": "GAP-171",
      "severity": "P3",
      "category": "doc",
      "module": "M23",
      "title": "M23 route paths drift from spec 4.1 (NOE/NOTR/validation not under /billing, duplicate validate route, rule-configs path).",
      "evidence": [
        "Route extraction: POST /api/v1/billing/claims/:id/validate and /api/v1/claims/:id/validate",
        "docs/modules/WARDENX_MODULE_23_BILLING_MEDICARE_SPEC_v0_2.md:1471-1488"
      ],
      "verified": false,
      "recommended_fix": "Update spec 4.1 to implemented paths and drop one duplicate validate route.",
      "verification": "Diff spec table vs route extraction."
    },
    {
      "id": "GAP-172",
      "severity": "P3",
      "category": "doc",
      "module": "M25",
      "title": "M25 spec WX-PR-012 note says the M23 claim-match seam 'remains unbound', but it is now bound.",
      "evidence": [
        "docs/modules/WARDENX_MODULE_25_REMITTANCE_SPEC_v0_2.md:1010",
        "apps/backend/src/modules/23-billing-medicare/cost-report-seams.ts:114",
        "apps/backend/src/index.ts:3603-3604"
      ],
      "verified": false,
      "recommended_fix": "Amend the M25 spec note.",
      "verification": "bun run arch:module-docs."
    },
    {
      "id": "GAP-173",
      "severity": "P3",
      "category": "spec-drift",
      "module": "M26",
      "title": "PS&R import is registered as POST /api/v1/cap/periods/:periodId/psr-imports while the spec declares POST /v1/cap/psr-imports.",
      "evidence": [
        "apps/backend/src/modules/26-cap/routes/psr.routes.ts:35",
        "docs/modules/WARDENX_MODULE_26_CAP_MANAGEMENT_SPEC_v0_3.md:1095"
      ],
      "verified": false,
      "recommended_fix": "Update spec 4.1 to the period-scoped path (or alias).",
      "verification": "bun run arch:module-docs."
    },
    {
      "id": "GAP-174",
      "severity": "P3",
      "category": "spec-drift",
      "module": "M30",
      "title": "The m6.election.signed HCI-denominator recompute handler is implemented but unbound (nightly recompute covers it with <=24h staleness); exception reason is stale.",
      "evidence": [
        "packages/quality/src/consumers/handlers.ts:150-157",
        "scripts/outbox-subscription-exceptions.ts:241-247"
      ],
      "verified": false,
      "recommended_fix": "Bind a buildM30ElectionSignedConsumer using the existing enqueueRecompute port.",
      "verification": "bun run arch:outbox-bindings + m30-upstream-consumers.live.test.ts."
    },
    {
      "id": "GAP-175",
      "severity": "P3",
      "category": "spec-drift",
      "module": "M31",
      "title": "GET /api/v1/admin/telehealth/visits/:id returns 200 with lifecycleState 'not_found' instead of 404.",
      "evidence": [
        "apps/backend/src/modules/31-portal/routes/admin.routes.ts:257",
        "apps/backend/src/modules/31-portal/routes/telehealth.routes.ts:101"
      ],
      "verified": false,
      "recommended_fix": "Throw NotFoundError when telehealthById returns null.",
      "verification": "Route test: unknown id -> 404."
    },
    {
      "id": "GAP-176",
      "severity": "P3",
      "category": "security",
      "module": "M31",
      "title": "The portal SPA has no chromed-route auth guard (web/admin have RequireChrome); framed routes render for anonymous visitors (server still enforces auth). Portal not deployed today.",
      "evidence": [
        "apps/portal/src/app.tsx:73-81",
        "apps/web/src/shell/app.tsx:68-75; apps/admin/src/shell/require-chrome.tsx:14-22"
      ],
      "verified": false,
      "recommended_fix": "Add a portal session provider + RequireChrome equivalent around PortalFrame before deployment.",
      "verification": "DOM test: anonymous PortalApp at /patient-picker redirects to '/'."
    },
    {
      "id": "GAP-177",
      "severity": "P3",
      "category": "spec-drift",
      "module": "M35",
      "title": "Four M35 admin GETs (dunning, plans/:id, promos/:id, refunds/:id) are registered but absent from spec 4.2.",
      "evidence": [
        "docs/modules/WARDENX_MODULE_35_SUBSCRIPTION_BILLING_SPEC_v0_3.md:1281-1314",
        "apps/backend/src/modules/35-subscription/routes/admin.routes.ts"
      ],
      "verified": false,
      "recommended_fix": "Add the four rows to M35 spec 4.2.",
      "verification": "Spec-vs-route comparison has 0 impl-only rows."
    },
    {
      "id": "GAP-178",
      "severity": "P3",
      "category": "doc",
      "module": "M36",
      "title": "Stale 'writes defer to FB-T05 (501)' comments although M36 writes are live; POST /api/v1/alerts/:id/read is missing from spec 4.1.",
      "evidence": [
        "apps/backend/src/modules/36-messaging/index.ts:136",
        "apps/backend/src/index.ts:3257",
        "apps/backend/src/modules/36-messaging/routes/messaging-routes.ts:307"
      ],
      "verified": false,
      "recommended_fix": "Update both comments and add the route to spec 4.1.",
      "verification": "Manual grep; bun run arch:module-docs."
    },
    {
      "id": "GAP-179",
      "severity": "P3",
      "category": "doc",
      "module": "M37",
      "title": "M37 spec says 38 routes (lines 554, 1368, 2337) versus 52 implemented; seven read/confirm routes are absent from 4.1 and row 31 lists only visitor_restriction.apply although the spec's own catalog defines .lift for DELETE.",
      "evidence": [
        "apps/backend/src/modules/37-ipu/routes/ipu.routes.ts:203-204,372-406,505-507,582-585,610-612",
        "docs/modules/WARDENX_MODULE_37_IPU_SPEC_v0_2.md:554,1368,1402,1600,2337",
        "audit/openapi-coverage/OPENAPI_COVERAGE.md:49"
      ],
      "verified": true,
      "recommended_fix": "Update spec 4.1 with the added routes and the lift key.",
      "verification": "bun run arch:module-docs."
    },
    {
      "id": "GAP-180",
      "severity": "P3",
      "category": "spec-drift",
      "module": "M39",
      "title": "Portal consent routes #25-27 (/api/v1/portal/consents/*) are not implemented; the spec marks them Phase 2 (recorded deferral).",
      "evidence": [
        "grep 'portal/consents' apps/backend/src -> 0 hits",
        "docs/modules/WARDENX_MODULE_39_CONSENT_SPEC_v0_3.md:1804"
      ],
      "verified": false,
      "recommended_fix": "Build when M31 Phase 2 lands; track only.",
      "verification": "bun run arch:openapi-coverage shows 30 M39 routes."
    },
    {
      "id": "GAP-181",
      "severity": "P3",
      "category": "doc",
      "module": "global",
      "title": "Stale composition-root/M30 comments describe live seams as unbound or in-memory (provider-entity resolver, SignedEncountersReader, emitThresholdBreached), and several outbox-subscription-exception reasons say events are 'already deferred' though the register holds only m22 pairs.",
      "evidence": [
        "apps/backend/src/index.ts:3355 vs :3366; :4448-4449 vs :1172; :1201-1203",
        "apps/backend/src/modules/30-quality/jobs/m30-jobs.ts:2461-2463 vs :1780-1792",
        "bun run arch:outbox-bindings -> 'Declared-but-unbound: 2 (module, event) pair(s)'"
      ],
      "verified": false,
      "recommended_fix": "Update the comments and refresh the reason strings in scripts/outbox-subscription-exceptions.ts for m30/m23/m27/m11.",
      "verification": "Re-read cited lines; bun run arch:outbox-bindings stays green."
    },
    {
      "id": "GAP-182",
      "severity": "P3",
      "category": "doc",
      "module": "global",
      "title": "SameSite policy contradicts itself: SECURITY_HARDENING 5.1 says Lax (matching csrf.ts:127) while 9.6.4, SYSTEM_DESIGN 5.1 and M31 9.3 say Strict.",
      "evidence": [
        "docs/architecture/WARDENX_SECURITY_HARDENING_v0_2.md:189,576,1173",
        "docs/architecture/WARDENX_SYSTEM_DESIGN_v0.3.md:942",
        "docs/modules/WARDENX_MODULE_31_PORTAL_TELEHEALTH_SPEC_v0_2.md:1985",
        "apps/backend/src/bootstrap/plugins/csrf.ts:127"
      ],
      "verified": false,
      "recommended_fix": "Change the Strict references to Lax + double-submit token.",
      "verification": "grep -rn 'SameSite=Strict' docs/architecture docs/modules returns nothing current."
    },
    {
      "id": "GAP-183",
      "severity": "P3",
      "category": "doc",
      "module": "global",
      "title": "CLAUDE.md:66 (and AGENTS.md) says audit-fitness has a --check mode inside arch:fitness; it has neither and is not a package.json script.",
      "evidence": [
        "CLAUDE.md:66",
        "scripts/run-fitness-gates.ts:56-59",
        "docs/architecture/ARCHITECTURE_25_15_FITNESS.md:162"
      ],
      "verified": false,
      "recommended_fix": "Move audit-fitness out of the --check list in CLAUDE.md and copy CLAUDE.md to AGENTS.md verbatim.",
      "verification": "diff CLAUDE.md AGENTS.md empty; line 66 updated."
    },
    {
      "id": "GAP-184",
      "severity": "P3",
      "category": "doc",
      "module": "global",
      "title": "Four broken relative links: docs/history/status-overview.md:77,78,81 (./docs/... resolves under docs/history) and docs/REMEDIATION_SUMMARY.md:41 (../ARCHITECTURE_25_15_FITNESS.md).",
      "evidence": [
        "docs/history/status-overview.md:77,78,81",
        "docs/REMEDIATION_SUMMARY.md:41"
      ],
      "verified": true,
      "recommended_fix": "Change to ../DEVELOPMENT.md, ../PHASE_0_SCAFFOLD_PLAN.md, ../adr/ADR-0027-... and ./architecture/ARCHITECTURE_25_15_FITNESS.md.",
      "verification": "Markdown link check over docs/ reports 0 broken."
    },
    {
      "id": "GAP-185",
      "severity": "P3",
      "category": "doc",
      "module": "global",
      "title": "Specs/plans cite non-existent `bun run` scripts (check:manifest, check:cruiser, check:table-ownership, test:rls-isolation, lint:deps, db:migrate:up/down, gen:proto, db:seed:admissions).",
      "evidence": [
        "docs/modules/WARDENX_MODULE_29_EXTERNAL_INTERFACES_SPEC_v0_4.md:2964-2966",
        "docs/modules/WARDENX_MODULE_31_PORTAL_TELEHEALTH_SPEC_v0_2.md:2034,2212",
        "docs/modules/WARDENX_MODULE_32_AI_PLATFORM_SPEC_v0_2.md:2661",
        "docs/modules/module-29-tasks/WARDENX_T-29.02_SCHEMA_PACKAGE.md:1838",
        "docs/plans/WAVE_M6_LIVE_WIRE_PLAN.md:104"
      ],
      "verified": false,
      "recommended_fix": "Update to current names (arch:manifest-mirror, arch:boundaries, arch:tables, test:rls:live:m31, ...) or mark historical.",
      "verification": "Re-run the script-name diff; only intentional names remain."
    },
    {
      "id": "GAP-186",
      "severity": "P3",
      "category": "doc",
      "module": "global",
      "title": "Stale TODOs: M23/M27/M30 erasers still say step (1) is adding their DataClass to REQUIRED_ERASERS (done), and the M34 alert-rules TODO step (2) is done by wireM34AlertRuleSeed. 38 TODO(CMS-fixture) placeholders (e.g. ECR byte layout) are the main live placeholder set.",
      "evidence": [
        "apps/backend/src/modules/23-billing-medicare/erasers/billing-eraser.ts:564",
        "apps/backend/src/modules/27-cost-report/erasers/cost-report-eraser.ts:204",
        "apps/backend/src/modules/30-quality/erasers/quality-eraser.ts:192",
        "apps/backend/src/bootstrap/erasers/registry.ts:236-238",
        "apps/backend/src/modules/34-saas-tenant-platform/alert-rules.ts:506 vs apps/backend/src/index.ts:4090-4115",
        "packages/cost-report/src/ecr/records.ts:9"
      ],
      "verified": false,
      "recommended_fix": "Trim the eraser and M34 TODOs to the remaining steps; track CMS-fixture placeholders as one issue.",
      "verification": "grep for the stale 'add \"billing_record\"'-style TODO text returns nothing."
    },
    {
      "id": "GAP-187",
      "severity": "P3",
      "category": "doc",
      "module": "global",
      "title": "The audit brief cites /Users/fabrice/Apps/WardenX and apps/backend/src/db/migrations/ (actual: repo root and packages/db/migrations/) and omits typecheck and check:boot:platform from its command list; PHASE_4_PLAN claims a non-existent @wardenx/mobile-offline package.",
      "evidence": [
        "docs/audits/GAP_ANALYSIS_AUDIT_PROMPT.md:5,96-105,115",
        "docs/PHASE_4_PLAN.md:35",
        "CLAUDE.md (typecheck + check:boot:platform are required central steps)"
      ],
      "verified": false,
      "recommended_fix": "Fix the brief path, migrations directory and command list; correct the PHASE_4_PLAN claim.",
      "verification": "grep -n 'Apps/WardenX\\|apps/backend/src/db/migrations\\|mobile-offline' docs/audits/GAP_ANALYSIS_AUDIT_PROMPT.md docs/PHASE_4_PLAN.md returns nothing."
    },
    {
      "id": "GAP-188",
      "severity": "P3",
      "category": "discovered",
      "module": "global",
      "title": "516 of 1085 foreign keys have no index whose leading columns cover the FK (134 location_id, 132 provider_entity_id); 16 unindexed FKs are ON DELETE CASCADE and 29 SET NULL, each forcing a child seq-scan on parent delete. No gate covers non-org FK indexing.",
      "evidence": [
        "dev DB pg_catalog query -> 516 unindexed of 1085",
        "by confdeltype: a|93 c|16 n|29 r|378",
        "bun run arch:org-indexes -> passes (422 tables)"
      ],
      "verified": false,
      "recommended_fix": "Add indexes for the 16 CASCADE / 29 SET NULL FKs and admission_id FKs in a new migration (check arch:migration-numbering); decide policy for location_id/provider_entity_id; optionally extend scripts/check-org-index-coverage.ts.",
      "verification": "Re-run the FK-index query on a fresh DB; CASCADE/SET NULL rows drop to 0."
    }
  ],
  "test_infra_failures": [
    {
      "suite": "bun run check:boot:platform (scripts/check-boot-with-platform-credential.ts)",
      "error": "Exit 1: 'DATABASE_PLATFORM_URL is required — this check exists to exercise the platform-credential boot.' The local .env has DATABASE_URL but not DATABASE_PLATFORM_URL; CI's outbox-boot job sets it (.github/workflows/ci.yml:980-986).",
      "remediation": "Run locally against a throwaway Docker Postgres after `bun run db:provision-roles`, exporting DATABASE_PLATFORM_URL=postgresql://wardenx_platform_login:<pw>@localhost:5432/<db> (the check starts the outbox relay, so do not use the shared dev DB), or rely on the CI outbox-boot job; optionally document DATABASE_PLATFORM_URL in .env.example."
    }
  ]
}
```
