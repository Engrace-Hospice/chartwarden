# ChartWarden — Workflow 46: Cross-Workflow Integration Audit & Release Gates

**Target path:** `docs/implementation/46-cross-workflow-integration-audit.md`
**Executor:** Claude Code (read-only audit first; no application changes without explicit approval)
**Status:** PROPOSED — not an executed audit
**Baseline:** The user-supplied `chartwarden-main.zip` and the 45 prior workflow implementation specifications. Current Git checkout, not this historical ZIP, is authoritative when executing.
**Priority:** P0 integration safety and regulatory correctness; P1 UX continuity; P2 operational efficiency.

## Executive mandate

**Question to answer:** Can an authorized staff member carry a hospice patient from referral to admission, assessment, plan of care, scheduling, visit documentation, IDG, recertification, discharge/death, bereavement, and claims/payment **without inconsistent data, missing handoffs, broken permissions, phantom success states, or navigation dead ends**?

This is a **cross-workflow evidence audit**, not permission to rewrite 45 modules. Audit current implementation and compare it with the 45 *proposed* redesign plans. Do not assume those plans have been implemented. Distinguish existing runtime behavior, tested code, design proposals, feature-flagged code, mocks, and unbound integrations. Prioritize patient safety, privacy, billing integrity, and staff task completion. Preserve existing architecture, authoritative backend transitions, PostgreSQL/RLS, domain-event outbox, and Lantern design tokens.

### Source and authority hierarchy

1. Read `AGENTS.md`, `docs/DEVELOPMENT.md`, architecture documents and applicable ADRs in the **current checkout**. Repository guide states architecture documents outrank module/UI specifications, and `architecture/module-manifest.ts` owns module dependencies/table ownership.
2. Read current generated `audit/implementation-status/IMPLEMENTATION_STATUS.md` (regenerate via `bun run status:matrix` when feasible); do not copy stale route/table/test counts.
3. Read the 45 implementation plans under `docs/implementation/`, plus any original-name files for workflows 01–17, and note which are present, superseded, implemented, or missing.
4. Trace code, schemas, tests, fixtures, actual runtime behavior, and external vendor contracts. A file's presence is **not** proof of functionality.
5. When sources disagree, record the conflict and cite exact `path:line` and commit SHA; do not silently choose the most convenient interpretation.

### Audit boundaries

- In scope: staff web app, admin app, family portal, backend, data layer, integrations, workers/jobs, event outbox, permission/RLS, UX navigation, audit, notifications, and reporting across the workflows below.
- Out of scope during audit: production data changes, live claims submission, vendor messages, clinical signing, automatic patient merge, real e-prescriptions, migrations, external AI calls with PHI, and unapproved Rust migration changes.
- Use deterministic synthetic patient/provider/agency fixtures; no real PHI in logs, screenshots, test artifacts, prompts, or external services.
- If an integration is stubbed, missing, or unavailable, label it `UNVERIFIED_EXTERNAL` or `STUB`; never mark end-to-end `PASS` on a simulated vendor response without qualification.

## 1. Coverage ledger: all 45 planned workflows

| # | Workflow | Planned document | Cross-workflow audit focus |
|---|---|---|---|
| 01 | Referral & Intake | `CHARTWARDEN_INTAKE_REDESIGN_IMPLEMENTATION_PLAN.md` | Referral → patient match → admission handoff |
| 02 | Patient Admission | `ChartWarden_Patient_Admission_Implementation_Plan.md` | Election, CTI, consent → episode activation |
| 03 | Patient Chart & Demographics | `ChartWarden_Workflow_03_Patient_Chart_Demographics.md` | Patient identity, contacts, payer and care team consistency |
| 04 | Initial Assessments | `ChartWarden_Workflow_04_Initial_Assessments.md` | Assessment → care plan/HOPE/visit downstream |
| 05 | HOPE Assessments | `ChartWarden_Workflow_05_HOPE_Assessments.md` | HOPE time windows, symptom follow-up, iQIES status |
| 06 | Care Plan Management | `ChartWarden_Workflow_06_Care_Plan_Management.md` | Plan interventions → disciplines, visits, IDG |
| 07 | Discipline-Specific Care Plans | `ChartWarden_Workflow_07_Discipline_Specific_Care_Plans.md` | Discipline plans → shared plan and assignments |
| 08 | Visit Scheduling | `ChartWarden_Workflow_08_Visit_Scheduling.md` | Plan proposals → scheduled visit → encounter |
| 09 | Clinical Visits & Documentation | `ChartWarden_Workflow_09_Clinical_Visits_Documentation.md` | Visit → note/sign/cosign → downstream evidence |
| 10 | Electronic Visit Verification | `ChartWarden_Workflow_10_Electronic_Visit_Verification.md` | Visit clock events → exception → billing |
| 11 | Medication Orders | `ChartWarden_Workflow_11_Medication_Orders.md` | Medication order → prescriber authorization → MAR |
| 12 | Pharmacy / DoseSpot | `ChartWarden_Workflow_12_Pharmacy_DoseSpot.md` | Authorized Rx → vendor acknowledgment/failure |
| 13 | Medication Administration (eMAR) | `ChartWarden_Workflow_13_Medication_Administration_eMAR.md` | Order → MAR administration and exceptions |
| 14 | IDG Meetings | `ChartWarden_Workflow_14_IDG_Meetings.md` | IDG review → care plan/recert actions |
| 15 | Recertification & Benefit Periods | `ChartWarden_Workflow_15_Recertification_Benefit_Periods.md` | Benefit period → certification → claims eligibility |
| 16 | On-Call Management | `ChartWarden_Workflow_16_On-Call_Management.md` | After-hours triage → encounter/order/follow-up |
| 17 | Field Safety | `ChartWarden_Workflow_17_Field_Safety.md` | Safety alert → response and incident evidence |
| 18 | Medical Supplies | `18-medical-supplies-workflow-redesign.md` | Supply order → fulfillment and patient record |
| 19 | Inpatient / IPU Care | `19-inpatient-ipu-care-workflow-redesign.md` | Level of care → facility events and billing |
| 20 | Discharge, Death, Transfer & Revocation | `20-discharge-death-transfer-revocation-workflow-redesign.md` | Termination event → notifications, claims, bereavement |
| 21 | Bereavement | `21-bereavement-workflow-redesign.md` | Death → family support and follow-up |
| 22 | Medicare Hospice Billing | `22-medicare-hospice-billing-workflow-redesign.md` | NOE/NOTR → claim → ack → ERA |
| 23 | Medicaid Billing | `23-medicaid-billing-workflow-redesign.md` | Coverage → Medicaid claim and payer status |
| 24 | Commercial Insurance Billing | `24-commercial-insurance-billing-workflow-redesign.md` | Authorization → commercial claim and payer status |
| 25 | Remittance & Payment Posting | `25-remittance-payment-posting-workflow-redesign.md` | 835 → posting → balance/ledger reconciliation |
| 26 | Denials, Rejections & Appeals | `26-denials-rejections-appeals-workflow-redesign.md` | Denial → correction/appeal → final disposition |
| 27 | Hospice Aggregate Cap | `27-hospice-aggregate-cap-workflow-redesign.md` | Utilization → cap estimate and reconciliation |
| 28 | Medicare Cost Reporting | `28-medicare-cost-reporting-workflow-redesign.md` | Utilization/cost inputs → report and approval |
| 29 | Clinical Quality Management | `29-clinical-quality-management-workflow-redesign.md` | Clinical incidents → QAPI corrective actions |
| 30 | Document Management | `30-document-management-workflow-redesign.md` | Referral/clinical files → provenance, access, retention |
| 31 | Electronic Signatures & Consents | `31-electronic-signatures-consents-workflow-redesign.md` | Election/CTI/consent → signature evidence |
| 32 | Clinical Messaging | `32-clinical-messaging-workflow-redesign.md` | Care team messages → patient-linked task/escalation |
| 33 | Audit & Compliance Monitoring | `33-audit-compliance-monitoring-workflow-redesign.md` | All sensitive actions → searchable immutable evidence |
| 34 | Clinical Reporting & Analytics | `34-clinical-reporting-analytics-workflow-redesign.md` | Source-of-truth metrics → dashboards/export |
| 35 | FHIR & External Interfaces | `35-fhir-external-interfaces-workflow-redesign.md` | Inbound/outbound interfaces → reconciliation |
| 36 | Terminology & Master Data | `36-terminology-master-data-workflow-redesign.md` | Code versions → validation across clinical/billing |
| 37 | Family Portal | `37-family-portal-workflow-redesign.md` | Family-visible records → consent-aware read models |
| 38 | Family Access & Permissions | `38-family-access-permissions-workflow-redesign.md` | Relationship verification → scoped access/revocation |
| 39 | Family Document Signing | `39-family-document-signing-workflow-redesign.md` | Document signing → immutable evidence/notifications |
| 40 | Family Support & Bereavement | `40-family-support-bereavement-workflow-redesign.md` | Death/bereavement → support visibility and consent |
| 41 | Staff Identity & Authentication | `41-staff-identity-authentication-workflow-redesign.md` | Session/step-up → high-risk clinical actions |
| 42 | Roles & Permissions | `42-roles-permissions-workflow-redesign.md` | RBAC/ABAC → all transitions and tenant boundaries |
| 43 | Agency Onboarding | `43-agency-onboarding-workflow-redesign.md` | Agency provisioning → defaults, access and billing |
| 44 | Subscription & SaaS Billing | `44-subscription-saas-billing-workflow-redesign.md` | Usage metering → invoices without PHI leakage |
| 45 | AI Platform Operations | `45-ai-platform-operations-workflow-redesign.md` | AI outputs → provenance, human approval, kill switch |

**Document note:** Filenames in the ledger reflect the supplied artifacts where available; the executor must resolve the canonical `docs/implementation/NN-...md` in the current checkout. An original standalone file is not evidence that it was committed.

## 2. Twelve cross-workflow journeys (required trace and tests)

For each journey, deliver: sequence diagram, exact UI route hops, API route/method and handler, domain service and state transition, persisted tables/keys, outbox event and consumer, authorization/tenant checks, audit records, rollback/compensation, test evidence, and a plain-language UX walkthrough. Mark each step `PASS`, `FAIL`, `PARTIAL`, `STUB`, `BLOCKED`, or `NOT_TESTED`.

### J01 — Referral to active hospice episode (01, 02, 03, 30, 31, 41, 42)
- Receive/upload referral, review DocLens extraction with source provenance, resolve duplicates, verify demographics and contacts, create admission, complete required election/consent/certification evidence, activate episode.
- Negative cases: conflicting referral values, missing patient match, duplicate creation, unauthorized signature, wrong agency, interrupted conversion, repeated request, invalid backdating.
- Prove a single authoritative patient/episode identity across screens and documents; do not treat draft admission as active care.

### J02 — Admission to initial assessment, HOPE, and care plan (02, 04, 05, 06, 07, 14)
- Admission triggers appropriate assessments and HOPE tasks; clinician documents findings; care plan proposals/updates require proper review; IDG sees authoritative data.
- Check CMS deadlines using the **effective rules for the relevant event date**, not UI assumptions; test late and corrected submissions.
- Prove assessment changes do not silently mutate signed plans or signed assessments.

### J03 — Care plan to scheduled and documented visit (06–10, 14, 32)
- Approved plan intervention → visit proposal → schedule/assignment → visit check-in/out (when applicable) → note draft → finalize/sign/cosign → plan progress and IDG visibility.
- Separate scheduling, encounter, and EVV lifecycles; test cancellation, reassignment, conflict, offline retry, missed visit, late entry, and duplicate submit.
- Verify care-plan linkage and that clinical completion does not falsely imply EVV or payer eligibility completion.

### J04 — Medication order to administration and pharmacy (11–13, 09, 31, 32)
- Reconcile reported medications → draft order → allergy/consent/authorization review → prescriber sign → optional DoseSpot transmit → acknowledgment/failure → eMAR display/administration.
- Test discontinued/modified orders, wrong patient, changed allergy, refused dose, PRN indication, controlled substance restrictions, unbound vendor, and uncertain transmission.
- **No auto-activation or dose administration solely from AI extraction or a queued transmission.**

### J05 — IDG to recertification and next benefit period (04–07, 09, 14, 15, 31)
- IDG review, symptom and functional evidence, physician certification and required face-to-face processes, benefit-period transition and care-plan revision.
- Test late certification, missing signers, overlapping benefit periods, invalid physician authority, and backdated edits.

### J06 — On-call event to care-team handoff (09, 11, 16, 17, 32)
- After-hours call → triage → urgency/escalation → clinician assignment → visit/order/documentation → closed-loop acknowledgment.
- Test no acknowledgment, shift change, duplicate pages, communications outage, PHI in push previews, and role escalation.

### J07 — Change in level of care and inpatient coordination (08, 09, 15, 18, 19, 22)
- Transfer between care settings, orders, facility coordination, visit/level-of-care dates and claim line accuracy.
- Test overlap, conflicting dates, interrupted transfer, GIP/respite eligibility, and downstream reporting.

### J08 — Death/discharge/transfer/revocation to bereavement and billing (20–22, 30, 31, 37–40)
- Event record → episode closeout → future visits/orders/notifications reviewed → required notices/claims → family access policy → bereavement enrollment when applicable.
- Test death recorded late, event reversal/correction, transfer, revocation, wrong family contact, and revoked access.
- Do not assume all termination events create the same bereavement or billing outcomes.

### J09 — Medicare/Medicaid/commercial claim through remittance (03, 15, 19, 22–27, 35)
- Coverage and authorization → NOE/NOTR where applicable → institutional claim assembly → validation → clearinghouse/MAC → acknowledgments → 835 → posting → denial/appeal.
- Test duplicate claims/ERA, replayed webhooks, late corrections, payer differences, tenant payment routing, partial payment, recoupment, and missing vendor credentials.
- Distinguish `submitted`, `accepted by intermediary`, `accepted by payer`, `adjudicated`, and `paid`; never invent a payer acknowledgment.

### J10 — Clinical records to quality, cost report, analytics and cap (04, 05, 09, 15, 20, 27–29, 33, 34)
- Verify reporting lineage from source events to calculated measures and financial/quality dashboards; check reporting-period boundaries, corrections, reconciliation and freshness.
- No dashboard should imply regulatory submission or financial finality solely because internal calculations exist.

### J11 — Family access, messaging, signing, and bereavement (30–32, 37–40, 41, 42)
- Authorized representative invitation → identity/relationship verification → scoped chart access → messages → document signing → permissions change/revocation → death and bereavement-specific access.
- Test multiple family members, disputed representative authority, patient transfer, consent withdrawal, deep links, old cached content, and push notification redaction.

### J12 — Tenant onboarding, permissions, integrations, and AI governance (33–36, 41–45)
- Provision new agency → staff roles → integration setup → permitted data flow → usage metering → administrative audit → AI capability governance and kill switch.
- Test agency boundary in every read/write/event/job/export/cache/object-store key; staff role changes mid-session; AI provider outage and disabled capability; financial billing tenant isolation.

## 3. Mandatory seam inventory and contracts

Produce a machine-readable matrix (`csv` or JSON) with **one row per producer→consumer edge**, not one row per module. Fields:

`seam_id, journey_id, producer_workflow, consumer_workflow, source_route, source_handler, domain_event_or_api, schema_version, entity_id, org_id, patient_id, episode_id, encounter_id, benefit_period_id, idempotency_key, transaction_boundary, outbox_location, consumer_worker, retry_policy, dead_letter_policy, reconciliation_job, permission, abac, rls_policy, audit_event, failure_mode, test_path, evidence_path_line, status, owner`.

For each seam prove:

1. **Identity:** Stable patient, admission, episode, payer, and agency IDs; duplicate detection and safe matching; no cross-tenant ID aliasing.
2. **Authority:** Exactly one owner of each state transition and calculation. UI-derived labels must not replace backend state.
3. **Data contract:** Versioned request/event schemas, nullability, timezone/date semantics, units, codes, backward compatibility and idempotency.
4. **Transactions:** DB commit and event publication are atomic via outbox or demonstrably reconciled; no lost event or double side effect.
5. **Recovery:** Retries, deduplication, poison messages, dead-letter handling, cancellation, timeout, race conditions, and operator repair path.
6. **Auditability:** Actor, authority, patient/tenant, before/after intent, time, provenance, immutable evidence, and safe redaction.
7. **Observability:** Correlation ID, metrics, failure alerts, runbooks, and health status without PHI leakage.
8. **UX:** User can identify current step, next action, pending dependency, owner, deadline, outcome, and failure recovery without navigating across multiple disconnected worklists.

## 4. Cross-cutting invariants (P0; fail closed)

- **Tenant isolation:** RLS + ABAC + object-storage namespace + event consumer + cache + export + family portal; negative tests for cross-org access on every seam.
- **Identity and relationship:** Patient merge/match, authorized representative, episode and benefit-period uniqueness, and immutable clinical record references.
- **Signatures and orders:** Signed clinical notes, physician certifications, elections, and prescriptions remain immutable; addenda and corrections are explicit and traceable; step-up requirements enforced server-side.
- **Clinical safety:** Allergy and medication reconciliation gates; no AI-generated clinical fact promoted without review; clinician authorization; correct effective dates.
- **Regulatory deadlines:** Hospice rules, HOPE, notices, certifications and reporting must be checked against current official requirements, payer, state, and event dates; document rule provenance and unresolved interpretation.
- **Financial correctness:** Exactly-once *effects* despite at-least-once delivery; no duplicate claims/postings; payer status accuracy; correct direct-to-agency payment flow.
- **Data retention and access:** Record retention, legal holds, family revocation, minimum necessary access, PHI-safe telemetry and secure downloads.
- **Offline/mobile:** No phantom saved/signed status, no silent overwrite, explicit sync conflict, bounded PHI caching and revocation behavior.
- **Feature flags:** Unsupported or unbound vendor capabilities clearly disabled and surfaced; fail closed on high-risk paths.
- **Compatibility:** Architecture docs and ADRs outrank plans; keep APIs and schema stable unless a separately approved ADR/migration is justified.

## 5. WP0 — Read-only baseline and plan reconciliation (G0: STOP)

1. Capture SHA, branch, worktree status, versions, scripts, architecture/ADR baseline and current module status matrix. Read `.agents/rules/`, `.claude/rules/` when present.
2. Enumerate and hash the 45 plan files; identify absent/duplicate/outdated filenames, overlaps, conflicting assumptions, and dependencies. Classify each plan `PROPOSED`, `AUDITED`, `IN_PROGRESS`, `IMPLEMENTED_UNVERIFIED`, `VERIFIED`, or `BLOCKED` with evidence.
3. Build a **plan conflict register**: route ownership, shared UI components, duplicated status vocabulary, competing forms, overlapping migrations, API changes, workflow gates, feature flags and common permissions.
4. Trace all 12 journeys and produce a first-pass seam inventory. Mark unknowns explicitly. Do not make code changes.
5. Run only documented read-only or test commands in isolated/sanitized environment; note commands, exit codes, database dependencies and blockers. `bun run status:matrix`, `bun run arch:fitness`, typecheck and targeted tests are candidates only after checking current scripts and environment safety.
6. Produce `docs/implementation/evidence/46-baseline-and-plan-reconciliation.md`, `46-workflow-dependency-graph.mmd`, `46-plan-conflicts.csv`, `46-seam-inventory.csv`, `46-test-inventory.md`, `46-p0-risks.md`.
7. **STOP and request approval** of baseline, test environment, and audit scope before WP1. No application-code edits or external side effects.

## 6. WP1 — Contract and dependency audit (G1)

- Build dependency DAG across all 45 workflows. Mark hard prerequisites vs optional integrations vs external blockers. Explicitly include `01→02→04/05→06/07→08→09→14/15→20/21` and `02/15/19/20→22/23/24→25/26→27/28`; these are **hypotheses to validate**, not presumed actual wiring.
- For every seam, map UI action → API → service → transaction → outbox → consumer → read model → user-visible result; include exact evidence links.
- Generate per-entity lifecycle and transition diagrams for patient, referral, admission, episode, visit, encounter, EVV, medication order, prescription, claim, remittance, signature, and family authorization.
- Identify cycles, orphaned states, conflicting ownership, missing consumers, and irreversible transitions without recovery paths.
- Produce `46-contracts-and-state-machines.md`, `46-dependency-graph.mmd`, `46-unverified-integrations.md`. **Gate:** security, clinical, billing and architecture owners approve the contracts or document blockers.

## 7. WP2 — Executable cross-workflow integration harness (G2)

- Prefer existing test infrastructure and fixtures. Build synthetic multi-tenant fixtures: Agency A and B, two patients with similar identifiers, two family representatives, clinician/RN/medical director/biller/admin, payer variants, benefit periods and deterministic timestamps.
- Use an isolated test DB with production-equivalent RLS and migrations; preserve schema parity and test cleanup. No external production accounts.
- Write API/DB integration tests per J01–J12; mock only **explicit** external boundaries and separately test adapter contract against a sanctioned sandbox if available.
- Assert state changes, audit events, outbox emission/consumption, retries, duplicate suppression, and compensating actions. Include at least one failure-injection case and one cross-tenant negative case per journey.
- Test concurrent actions, lost responses, retries, clock skew, DST, cancellation, stale sessions, changed permissions, and rollback behavior.
- Record observed results with evidence; do not mark unrun tests as passed. **Gate:** all P0 invariants proven or explicitly blocked with owner and risk acceptance.

## 8. WP3 — Task-based UI/UX continuity audit (G3)

- Use browser automation for desktop (1440px), tablet (~768px), mobile (~390px), 200% zoom, keyboard-only and screen-reader-oriented checks. Synthetic data only.
- Personas: intake coordinator, RN case manager, hospice aide, MSW, chaplain, physician, scheduler, biller, QA officer, agency admin, family representative.
- For each journey capture starting page, target outcome, number of screen transitions, redundant fields, confusing status labels, dead-end links, save/error/recovery states, accessible focus order, and screenshots.
- Record quantitative baselines (task success, steps, errors, time if measured) rather than inventing improvement percentages.
- Verify Lantern tokens and shared components; avoid new visual systems or duplicated navigation. Propose shared cross-workflow affordances: patient context bar, global task queue, authoritative blockers, resume-in-progress, breadcrumbs, audit/history drawer, and deep links with permission checks.
- Produce `46-ux-journey-findings.md`, `46-screen-to-action-map.csv`, `46-accessibility-results.md`. **Gate:** product/clinical owners approve a prioritized UX remediation backlog, not wholesale implementation.

## 9. WP4 — Security, compliance, and financial adversarial review (G4)

- Perform permission matrix by role/action/tenant/patient; negative tests across APIs, workers, portal, reports, exports, objects, notifications and signed URLs.
- Verify audit completeness for sensitive read/write and break-glass actions; confirm logs are append-only and redact PHI/secrets.
- Verify healthcare vendor BAAs/contract scope as an operational dependency; a code check alone cannot establish HIPAA compliance.
- Verify CMS and payer requirements from authoritative current sources; maintain a regulatory assumption log with citations/effective dates, including any state-specific EVV requirements.
- Test claim/ERA replay, wrong-payer routing, tenant financial isolation, reconciliation mismatches, signed-document tampering, consent revocation, and AI prompt injection.
- Produce `46-security-and-compliance-findings.md`, `46-financial-reconciliation-results.md`, `46-regulatory-assumptions.md` and **STOP on any P0 patient-safety, PHI leak, unauthorized signing or double-payment risk**.

## 10. WP5 — Remediation roadmap and staged implementation (G5)

No remediation during WP0–WP4 unless separately authorized as an emergency fix. After review:

- **P0:** Patient safety, privacy breach, wrong-patient/tenant data, unauthorized signature, broken certification, duplicate claims/payment, irreversible data loss. Block rollout until fixed.
- **P1:** Broken workflow handoffs, contradictory states, inaccessible critical tasks, missing recovery, false success messages, materially incorrect reporting. Fix before broad rollout.
- **P2:** Excess navigation, duplicated entry, low-priority visual polish, noncritical performance and convenience issues. Schedule behind P0/P1.
- Create one PR per bounded seam or shared component, not one giant cross-module rewrite. Require contract tests and rollback for every change.
- Explicitly reconcile affected workflow plans: update references/dependency assumptions rather than silently changing clinical scope.
- Produce `46-prioritized-remediation-backlog.md`, `46-release-train.md`, `46-risk-acceptance-register.md`, `46-rollback-runbook.md`.

## 11. WP6 — Pilot and production readiness (G6)

- Run end-to-end tests in an environment resembling production, with vendor sandboxes only when authorized. Test degraded dependencies and disaster recovery.
- Pilot with synthetic patients first, then a separately approved controlled live pilot; define consent, monitoring, on-call rollback ownership and no-go criteria.
- Verify metrics and alerts: stalled admissions, overdue HOPE, unsigned notes, failed outbox consumers, delayed claims, unmatched ERA, cross-tenant denial attempts, orphaned tasks, family revocation propagation.
- Require sign-off from engineering, clinical leadership, compliance/security, billing, QA, and product. Record outstanding blockers and evidence of remediation.
- No claim of production readiness until live-environment evidence supports it; an all-green mocked test suite is insufficient.

## 12. Scoring and evidence rubric

Each journey receives five independently scored dimensions, each 0–4: **correctness**, **security/tenant isolation**, **failure recovery**, **UX task completion**, **operational observability**. `0 = failed/absent`, `1 = substantial gaps`, `2 = partial`, `3 = validated in isolated tests`, `4 = validated in representative runtime with evidence`. `NOT_TESTED`, `BLOCKED`, and `STUB` are **not** scored as success. Report a coverage denominator and confidence level separately; do not fabricate a single production-readiness percentage.

A P0 failure overrides any aggregate score. For every finding provide `ID`, severity, user/patient impact, reproduction, expected vs actual, `path:line` and SHA, test/run evidence, owning module, affected journeys, proposed fix, acceptance test, and rollback.

## 13. Required final deliverable structure

```text
docs/implementation/
  46-cross-workflow-integration-audit.md
  evidence/
    46-baseline-and-plan-reconciliation.md
    46-workflow-dependency-graph.mmd
    46-plan-conflicts.csv
    46-seam-inventory.csv
    46-test-inventory.md
    46-p0-risks.md
    46-contracts-and-state-machines.md
    46-unverified-integrations.md
    46-ux-journey-findings.md
    46-screen-to-action-map.csv
    46-accessibility-results.md
    46-security-and-compliance-findings.md
    46-financial-reconciliation-results.md
    46-regulatory-assumptions.md
    46-prioritized-remediation-backlog.md
    46-release-train.md
    46-risk-acceptance-register.md
    46-rollback-runbook.md
    46-final-scorecard.md
```

## 14. Claude Code first-run prompt (copy verbatim)

> Read `AGENTS.md`, the authoritative architecture and ADRs, the module manifest, current implementation status matrix, and all 45 workflow plans. Execute **WP0 of `docs/implementation/46-cross-workflow-integration-audit.md` only**. Work read-only against application code; do not modify schema, source, configuration, secrets, vendor accounts, or production data. Produce the WP0 evidence files, identify missing/stale plan documents and conflicting assumptions, list the top P0 integration risks with `path:line` evidence and current SHA, report tests actually run with exit codes, and present the dependency graph and recommended WP1–WP6 sequence. Stop and ask for approval before proceeding. Never claim a stub, mock, or unrun test is operational.

## 15. Definition of done

- All 45 workflows inventoried, with current implementation status separated from proposed design status.
- All 12 journeys traced with evidence and tests or explicit blockers.
- All producer→consumer seams have owner, contract, permission, tenant, retry, audit and failure mapping.
- No unresolved P0 without an explicit no-go decision; no unresolved P1 without approved mitigation/owner/date.
- Tested UX journeys and accessibility findings documented; no invented success metrics.
- Security/clinical/billing owners approve release gates; integration sandbox and vendor limitations are transparent.
- Rollback tested for changed seams; production rollout remains a separate approval.
