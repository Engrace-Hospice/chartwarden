# ChartWarden Documentation — Master Index

Single entry point for **every document under `docs/`**. Each entry links to its
canonical location; nothing here duplicates content — the sub-indexes and specs
remain the source of truth.

> **Repo-level guides** ([`../CLAUDE.md`](../CLAUDE.md), [`../AGENTS.md`](../AGENTS.md))
> live at the repository root, not under `docs/`, and are intentionally left in place.

## Authority rule

**Architecture documents are authoritative.** Module specs and UI screen specs are
**implementation proposals**. If a module or screen spec conflicts with architecture,
**architecture wins** (see [`architecture/`](#architecture-authoritative)). Where an
[ADR](#architecture-decision-records-adrs) and an older spec sentence disagree, the ADR
wins until the spec is re-locked.

## Map of `docs/`

| Area | Location | Index |
|---|---|---|
| Getting started & runbooks | `docs/*.md` | [below](#getting-started--runbooks) |
| Architecture (authoritative) | [`architecture/`](./architecture/) | [below](#architecture-authoritative) |
| Module specifications (40) | [`modules/`](./modules/) | [`modules/README.md`](./modules/README.md) |
| Design & UI corpus | [`design/`](./design/) | [`design/README.md`](./design/README.md) |
| Architecture Decision Records | [`adr/`](./adr/) | [`adr/README.md`](./adr/README.md) |
| AI capability catalog (19) | [`ai/capabilities/`](./ai/capabilities/) | [below](#ai-capability-catalog) |
| Roadmap & phase plans | `docs/*PHASE*` · `IMPLEMENTATION_ROADMAP.md` | [below](#roadmap--phase-plans) |
| Implementation guides | [`implementation/`](./implementation/) | [below](#implementation-guides) |
| Reference sources | [`reference/`](./reference/) | [below](#reference-sources) |
| API contract & integrator changes | [`api/`](./api/) | [`api/CHANGES.md`](./api/CHANGES.md) |
| Mobile architecture & cross-repository contracts | [`mobile/`](./mobile/) | [`mobile/README.md`](./mobile/README.md) |
| Governance & history | audit + remediation pointers | [below](#governance--history) |

---

## Getting started & runbooks

| Document | Purpose |
|---|---|
| [`START_PROJECT.md`](./START_PROJECT.md) | Step-by-step local startup guide — dependencies, migrations, API, worker, web app, and demo seed. **Start here to run the project.** |
| [`DEVELOPMENT.md`](./DEVELOPMENT.md) | Development runbook + "how to add a module". **Start here to build/extend.** |
| [`runbooks/security-alert-review.md`](./runbooks/security-alert-review.md) | Operator and security-officer runbook: the scheduled review of the audit trail (CW-MON-01) — the two lanes, `OPS_ALERT_WEBHOOK_URL` and the platform grant, reading the review log, the weekly review, what to do for each alert, and how another control adds a detection. |
| [`runbooks/mfa-enforcement-rollout.md`](./runbooks/mfa-enforcement-rollout.md) | Operator runbook: the second-factor matrix is enforced by default (CW-AC-45, CW-AC-55) — the enrolment path, the inventory-enrol-deploy-verify order, the audited bounded relaxation and its rollback. |
| [`runbooks/claimmd-webhook-first-delivery.md`](./runbooks/claimmd-webhook-first-delivery.md) | Operator runbook: CW-TX-02 — what the Claim.MD webhook receiver already guarantees, the `claimmd.webhook.refused` verdicts, and the operator's steps to capture the first real test-account delivery on loopback and check it offline (`claimmd:webhook:capture`, `claimmd:webhook:replay`) without sharing a field value. |
| [`runbooks/transactional-email-postmark.md`](./runbooks/transactional-email-postmark.md) | Operator runbook: Postmark account/BAA, verified sender + SPF/DKIM, env vars, verification and rollback for transactional email. |
| [`runbooks/terminology-catalog-loading.md`](./runbooks/terminology-catalog-loading.md) | Operator runbook: loading CARC/RARC, LOINC, SNOMED CT and RxNorm into M38 — licence to hold, who attests, download, endpoints, expected counts, verification and rollback. |
| [`runbooks/m34-platform-console-hardening.md`](./runbooks/m34-platform-console-hardening.md) | Operator runbook: CW-AC-22 rollout — the platform console address allowlist (`PLATFORM_CONSOLE_ALLOWED_CIDRS`, what it covers and does not) and the `platform_ops` split into the BAA steward, go-live approver and pricing operator roles (migration 1559, an expand), in order, with the lockout recovery and the monitoring query. |
| [`runbooks/m36-global-search-enablement.md`](./runbooks/m36-global-search-enablement.md) | Operator runbook: enabling M36 global search in production (ADR-0058) — Valkey, ring seal scheme, escrow drill, body backfill, the platform/escrow flags, the tenant switch and the index build, with rollback. |
| [`runbooks/m36-retention-destruction.md`](./runbooks/m36-retention-destruction.md) | Operator runbook: enabling the M36 message destruction executor (WP 5.6, ADR-0086 proposed) - the two switches (tenant ops flag, then the deployment execute key), dry run first, what it never touches (held, object-bearing and referenced messages), the audit evidence and how to stop. |
| [`runbooks/m36-restore-drill.md`](./runbooks/m36-restore-drill.md) | Operator runbook: the M36 restore drill (`bun run m36:restore-drill`) — what production actually backs up, the restore procedure, the consistency checks, demo-scale RPO/RTO and the detection proof. |
| [`runbooks/messaging-escalation-fallback.md`](./runbooks/messaging-escalation-fallback.md) | Operator runbook: M36 escalation fallback (WP 4.11) - when to invoke, the detection signals that exist, a telephone-tree template, the supervisor procedure, the supervisor reassign path (acknowledge-by-phone rejected by decision), stand-down, post-incident review, and the quarterly tabletop and live drill with an evidence record template. |
| [`runbooks/m23-sia-revisions-deployment.md`](./runbooks/m23-sia-revisions-deployment.md) | Operator runbook: M23 SIA revisions migration (1510 to 1513): what a merge to `main` does with and without the deploy hold, why old writers must drain first, the hand-apply, the legacy-visit delivery-mode follow-up, and the one-way rollback boundary. |
| [`runbooks/m8-note-closure-policy-reset.md`](./runbooks/m8-note-closure-policy-reset.md) | Operator runbook: undoing a mistaken visit-note closure `block` policy (M8, ADR-0113) — who can reset it in the product, what to do when every policy admin is blocked themselves (close the notes, a clear supervisor's override), and the audited database fallback for platform operations, with how to verify. |
| [`runbooks/m25-835-deployment.md`](./runbooks/m25-835-deployment.md) | Operator runbook: M25 835 group-identity migration preflight, old-writer drain, compatible startup, verification, and the unsafe application-only rollback boundary. |
| [`runbooks/m25-835-real-file-intake.md`](./runbooks/m25-835-real-file-intake.md) | Procedure and checklist for validating real, de-identified MAC 835 files (CW-PI-03): de-identification table, a PHI-free checker, how to classify each result. |
| [`runbooks/m24-payer-readiness-deployment.md`](./runbooks/m24-payer-readiness-deployment.md) | Operator runbook: M24/M25 payer-readiness and ERA-review migrations (1535 to 1539, 1541 to 1544): why a merge to `main` is held at exit 75, what each contract migration does, the previous-release drain, the hand-apply, read-only verification queries and the recovery boundary. |
| [`runbooks/object-store-sse-cutover.md`](./runbooks/object-store-sse-cutover.md) | Operator runbook: object-store encryption at rest (CW-AC-05) - the key and where it lives, the flag, versioning, the re-encryption tool (dry run, apply, gate), purging the plaintext versions and vacuuming the volume, the other plaintext copies, rollback, and what a delete leaves on the volume. |
| [`runbooks/object-destruction-copies.md`](./runbooks/object-destruction-copies.md) | Operator runbook: destroyed documents and their copies (CW-DS-01) - the append-only tombstone per destroyed object, legal holds and the audit trail, applying the list to the second copy (outside the mass-delete guard) and on a restore, what a delete leaves on the volume, and the copies it does not reach (the retired MinIO volume, the off-site mirror) with a verification checklist. |
| [`runbooks/object-key-column-rename-deployment.md`](./runbooks/object-key-column-rename-deployment.md) | Operator runbook: the object-key column rename (migration 1546, `minio_object_key` to `object_key`): what a merge to `main` does with the deploy hold, the drain, the hand-apply, the catalog and audit-scrub checks, the names kept as public contracts, restoring an older backup, and the one-way rollback boundary. |
| [`runbooks/wardenlens-intake-recovery.md`](./runbooks/wardenlens-intake-recovery.md) | Operator runbook: detect and recover WardenLens intake dependency, queue, Docling, object-storage and governed-AI failures without bypassing M22/M6 ownership or admission-readiness controls. |
| [`runbooks/main-branch-protection.md`](./runbooks/main-branch-protection.md) | Operator runbook: applying, verifying and rolling back the `main` ruleset (CW-CM-01, CW-SEC-01) — plan prerequisite, sole-owner bypass decision, pre-flight, the `gh api` commands, Environment reviewers, `ops:verify-branch-protection`, closing the register rows. |
| [`runbooks/incident-response-drill.md`](./runbooks/incident-response-drill.md) | Operator runbook: the incident-response tabletop drill kit (CW-IR-01) - ground rules (nothing outward-facing, synthetic data, no contacts in the repo), roles and checklist, roster check, facilitator script, clock fields with targets, scoring, filing the record under `audit/incident-drill/`. The kit exists; no drill has been run. |
| [`runbooks/incident-response-drill-scenarios.md`](./runbooks/incident-response-drill-scenarios.md) | Drill cards for the three tabletop scenarios (suspected PHI exposure, leaked backup key, compromised operator account): timed injects, expected actions with the runbook section to reach for, probes and traps, the runbook corrections made while preparing them and what is still open. Facilitator only. |
| [`APP_OVERVIEW.md`](./APP_OVERVIEW.md) | Guided map of what the codebase is and how it fits together — for an engineer joining the project. |
| [`BUSINESS_LOGIC.md`](./BUSINESS_LOGIC.md) | Business logic, workflows & functionality **as built** across the implemented modules — state machines, validation, calculations, cross-module flows. |
| [`PLATFORM_TOOLS_MANUAL.md`](./PLATFORM_TOOLS_MANUAL.md) | Private-cloud platform operating manual — Talos, Kubernetes, Cilium, Envoy Gateway, CloudNativePG, SeaweedFS, Valkey, OpenBao, Argo CD, Kyverno and the rest: role, deployment baseline, day-2 operations, HIPAA notes and failure modes per tool. Hosting phases: Hostinger test → OVHcloud production → Hostinger playground (ADR-0050). |
| [`PHASE_0_SCAFFOLD_PLAN.md`](./PHASE_0_SCAFFOLD_PLAN.md) | Phase 0 scaffold plan — the manifest→tree generation model (ADR-0027). |
| [`TENANT_SUBDOMAINS_PLAN.md`](./TENANT_SUBDOMAINS_PLAN.md) | Implementation plan for per-tenant subdomains on `chartwarden.com` — phases, tests, risks (ADR-0049, ADR-0087). |
| [`ARCHON_SETUP.md`](./ARCHON_SETUP.md) | ChartWarden × Archon deterministic-coding setup. |
| [`chartwarden-hospice-ehr.prd.md`](./chartwarden-hospice-ehr.prd.md) | Product Requirements Document (retrospective intent) — problem, thesis, hypothesis, pilot MVP, success metrics. |

---

## Architecture (authoritative)

These **win over module and screen specs** in any conflict. All in [`architecture/`](./architecture/):

| Document | Scope |
|---|---|
| [`CHARTWARDEN_ARCHITECTURE_v0_11.md`](./architecture/CHARTWARDEN_ARCHITECTURE_v0_11.md) | System architecture (top authority). |
| [`CHARTWARDEN_SYSTEM_DESIGN_v0.3.md`](./architecture/CHARTWARDEN_SYSTEM_DESIGN_v0.3.md) | System design document. |
| [`CHARTWARDEN_SECURITY_HARDENING_v0_2.md`](./architecture/CHARTWARDEN_SECURITY_HARDENING_v0_2.md) | Security hardening guide. |
| [`CHARTWARDEN_AI_GOVERNANCE_v0.2.md`](./architecture/CHARTWARDEN_AI_GOVERNANCE_v0.2.md) | AI governance (see also the [capability catalog](#ai-capability-catalog)). |
| [`CHARTWARDEN_DR_BCP_v0.1.md`](./architecture/CHARTWARDEN_DR_BCP_v0.1.md) | Disaster recovery & business continuity. |
| [`CHARTWARDEN_OPS_RUNBOOK_v0.1.md`](./architecture/CHARTWARDEN_OPS_RUNBOOK_v0.1.md) | Operations runbook. |
| [`M23_MEDICARE_PROVIDER_ROUTING.md`](./architecture/M23_MEDICARE_PROVIDER_ROUTING.md) | M23 provider routing ownership, effective dates, and legacy backfill policy. |
| [`M23_MEDICARE_NOTICE_RENDERING.md`](./architecture/M23_MEDICARE_NOTICE_RENDERING.md) | CM-4A authoritative notice source mapping, encrypted exact X12 artifact persistence, and remaining dispatch holds. |
| [`CHARTWARDEN_INTEGRATIONS_v0_1.md`](./architecture/CHARTWARDEN_INTEGRATIONS_v0_1.md) | Integration catalog. |
| [`ARCHITECTURE_25_15_FITNESS.md`](./architecture/ARCHITECTURE_25_15_FITNESS.md) | Architecture-fitness & boundary-enforcement rules (the gates). |

---

## Module specifications

All 41 module specs live in [`modules/`](./modules/) — see the full versioned table in
**[`modules/README.md`](./modules/README.md)**. The Module 29 forward-engineering sub-tasks
(T-29.01–T-29.13) are in [`modules/module-29-tasks/`](./modules/module-29-tasks/).

---

## Design & UI corpus

The design language, 113 screen specs, layout glossary, and Pencil prompts live in
[`design/`](./design/) — mapped by **[`design/README.md`](./design/README.md)**. Key entries:

| Document | Answers |
|---|---|
| [`design/DESIGN.md`](./design/DESIGN.md) | The "Lantern" visual system — tokens, components, Guardrail/Sensitivity/Provenance rules. |
| [`design/CHARTWARDEN_UI_LAYOUT_PATTERNS.md`](./design/CHARTWARDEN_UI_LAYOUT_PATTERNS.md) | Layout-pattern glossary (source of truth for the `docs:ui` gate). |
| [`design/CHARTWARDEN_UI_COMPLETE_SCREEN_INDEX.md`](./design/CHARTWARDEN_UI_COMPLETE_SCREEN_INDEX.md) | Canonical screen list (drives the `docs:ui` parity gate). |
| [`design/screens/`](./design/screens/) | 113 screen specs — admin · clinical · compliance · core · integration · mobile · platform · portal · revenue · staffing. |
| [`design/SCREENS.md`](./design/SCREENS.md) | Module ↔ Pencil ledger (owner + design status per screen). |
| [`design/pencil-prompts/`](./design/pencil-prompts/) | Phase-batched Pencil generation prompts + MCP workflow ([`pencil-prompts/README.md`](./design/pencil-prompts/README.md)). |
| [`design/FRAME_FIDELITY_PLAYBOOK.md`](./design/FRAME_FIDELITY_PLAYBOOK.md) | Built-screen ↔ Pencil-frame fidelity process (`frame:fidelity` tracker). |
| [`design/DEFERRED_SCREENS.md`](./design/DEFERRED_SCREENS.md) | Frontend implementation tracking (Track B / ADR-0030). |
| [`design/SCREEN_SPEC_STATUS.md`](./design/SCREEN_SPEC_STATUS.md) | Per-spec implementation status (built / partial / deferred) joined to the registered screen sets; enforced by `docs:ui`. |
| [`design/UI_README.md`](./design/UI_README.md) · [`design/DESIGN_REVIEW.md`](./design/DESIGN_REVIEW.md) · [`design/FRONTEND_RECONCILIATION_SCOPE.md`](./design/FRONTEND_RECONCILIATION_SCOPE.md) | Supporting design-corpus notes. |

---

## Architecture Decision Records (ADRs)

Every ADR lives in [`adr/`](./adr/); the full list (titles, resolved findings, status) is the index in
**[`adr/README.md`](./adr/README.md)** — the count is not restated here, it is guarded by `arch:adr-docs`.

---

## AI capability catalog

The 19 governed AI capabilities registered against M32 (per
[`architecture/CHARTWARDEN_AI_GOVERNANCE_v0.2.md`](./architecture/CHARTWARDEN_AI_GOVERNANCE_v0.2.md)),
in [`ai/capabilities/`](./ai/capabilities/):

| Capability | File |
|---|---|
| AI Copilot — Clinical | [`ai-copilot-clinical.md`](./ai/capabilities/ai-copilot-clinical.md) |
| AI Copilot — Administrative | [`ai-copilot-administrative.md`](./ai/capabilities/ai-copilot-administrative.md) |
| DocLens Classifier | [`doclens-classifier.md`](./ai/capabilities/doclens-classifier.md) |
| DocLens Extractor | [`doclens-extractor.md`](./ai/capabilities/doclens-extractor.md) |
| DocLens SUD Indicator Detection | [`doclens-sud-detection.md`](./ai/capabilities/doclens-sud-detection.md) |
| DocLens Vision Verification | [`doclens-vision-verification.md`](./ai/capabilities/doclens-vision-verification.md) |
| HearthNote Layer 2 | [`hearthnote-layer-2.md`](./ai/capabilities/hearthnote-layer-2.md) |
| HearthNote IDG Aggregation (Layer 2) | [`hearthnote-idg-aggregation-layer-2.md`](./ai/capabilities/hearthnote-idg-aggregation-layer-2.md) |
| Semantic Search | [`semantic-search.md`](./ai/capabilities/semantic-search.md) |
| Embeddings Generation | [`embeddings-generation.md`](./ai/capabilities/embeddings-generation.md) |
| 30-Day Hospitalization Risk | [`hospitalization-risk-30d.md`](./ai/capabilities/hospitalization-risk-30d.md) |
| Mortality / Decline Prediction | [`mortality-decline-prediction.md`](./ai/capabilities/mortality-decline-prediction.md) |
| Level of Care Prediction | [`level-of-care-prediction.md`](./ai/capabilities/level-of-care-prediction.md) |
| Falls Risk Prediction | [`falls-risk-prediction.md`](./ai/capabilities/falls-risk-prediction.md) |
| Bereavement Risk Narrative | [`bereavement-risk-narrative.md`](./ai/capabilities/bereavement-risk-narrative.md) |
| On-Call Triage Protocol Suggestion | [`protocol-suggestion-oncall.md`](./ai/capabilities/protocol-suggestion-oncall.md) |
| Denial Outcome / Appeal Prediction | [`denial-outcome-prediction.md`](./ai/capabilities/denial-outcome-prediction.md) |
| ADR Documentation Readiness (advisory) | [`adr-documentation-readiness.md`](./ai/capabilities/adr-documentation-readiness.md) |
| Aggregate Cap Projection | [`aggregate-cap-projection.md`](./ai/capabilities/aggregate-cap-projection.md) |

---

## Roadmap & phase plans

Historical/forward roadmap at the `docs/` root. These are **planning records** (phases 1–4);
per-module build truth is the generated matrix (`bun run status:matrix`).

| Document | Scope |
|---|---|
| [`IMPLEMENTATION_ROADMAP.md`](./IMPLEMENTATION_ROADMAP.md) | Roadmap index across all phases. |
| [`PHASE_1_PLAN.md`](./PHASE_1_PLAN.md) | Phase 1 — Engrace go-live. |
| [`PHASE_2_PLAN.md`](./PHASE_2_PLAN.md) | Phase 2 — AI activation + operational depth. |
| [`PHASE_3_PLAN.md`](./PHASE_3_PLAN.md) | Phase 3 — multi-tenant scale + inpatient. |
| [`PHASE_4_PLAN.md`](./PHASE_4_PLAN.md) | Phase 4 — state expansion, enterprise & certifications. |

---

## Implementation guides

| Document | Scope |
|---|---|
| [`implementation/wardenlens-unified-review-v3-spec.md`](./implementation/wardenlens-unified-review-v3-spec.md) | WardenLens V3 patient-centered review projection, safety invariants, interaction architecture, responsive behavior, tests, and phased roadmap. |
| [`implementation/CHARTWARDEN_INTAKE_REDESIGN_IMPLEMENTATION_PLAN.md`](./implementation/CHARTWARDEN_INTAKE_REDESIGN_IMPLEMENTATION_PLAN.md) | Unified intake redesign scope, work packages, delivery gates, and testing matrix. |
| [`implementation/intake-current-state-audit.md`](./implementation/intake-current-state-audit.md) | Verified intake routes, controls, state transitions, preservation matrix, and rollout constraints. |
| [`implementation/intake-workspace-user-guide.md`](./implementation/intake-workspace-user-guide.md) | Frontline workflow guidance for referral intake, patient matching, admission handoff, and readiness correction. |
| [`implementation/intake-redesign-follow-up-backlog.md`](./implementation/intake-redesign-follow-up-backlog.md) | Optional, unapproved enhancements kept separate from the closed intake redesign initiative. |
| [`implementation/ChartWarden_Workflow_03_Patient_Chart_Demographics.md`](./implementation/ChartWarden_Workflow_03_Patient_Chart_Demographics.md) | Patient chart and demographics workflow plan, approval gates, work packages, and test matrix. |
| [`implementation/03-patient-chart-current-state-audit.md`](./implementation/03-patient-chart-current-state-audit.md) | Workflow 03 G0 audit of chart IA, canonical ownership, permissions, integrity, privacy, performance, tests, and proposed presentation boundaries. |
| [`implementation/ChartWarden_Workflow_04_Visit_Encounter_Documentation.md`](./implementation/ChartWarden_Workflow_04_Visit_Encounter_Documentation.md) | Proposed Workflow 04 definition for scheduled visit, encounter documentation, signature/cosignature, EVV truth, and downstream continuity. |
| [`implementation/04-visit-encounter-current-state-audit.md`](./implementation/04-visit-encounter-current-state-audit.md) | Workflow 04 G0 audit of visit-to-encounter continuity, lifecycle authority, security, EVV/mobile truth, draft recovery, runtime behavior, tests, and the proposed first implementation boundary. |
| [`implementation/04-visit-note-drafting-redesign.md`](./implementation/04-visit-note-drafting-redesign.md) | Workflow 04 redesign: visit notes pre-drafted from structured records, section-by-section confirmation, mobile offline and dictation, slice plan and open items (decisions in ADR-0114). |
| [`implementation/05-hope-current-state-audit.md`](./implementation/05-hope-current-state-audit.md) | Workflow 05 WP0 audit of HOPE navigation, persisted states, timepoint/SFV clocks, manual iQIES transport truth, authorization, PHI, friction, risk register, and decisions requested at Stop Gate A. |
| [`implementation/ChartWarden_Workflow_06_Care_Plan_Management.md`](./implementation/ChartWarden_Workflow_06_Care_Plan_Management.md) | Workflow 06 plan for care-plan management UX and workflow redesign (audit complete, defect track applied; workspace redesign awaits approval). |
| [`implementation/06-care-plan-current-state-audit.md`](./implementation/06-care-plan-current-state-audit.md) | Workflow 06 WP0 audit of module 07: corrected plan claims, real lifecycle states, endpoint and role inventory, the defect register with dispositions (sign race, Part 2 snapshot leak, readmission plan selection, M15 discharge), verification results, and decisions requested. |
| [`implementation/ChartWarden_Workflow_07_Discipline_Specific_Care_Plans.md`](./implementation/ChartWarden_Workflow_07_Discipline_Specific_Care_Plans.md) | Workflow 07 plan for the patient-scoped discipline-plan overview, authoring, version, signature, IDG, and supervisory experience. |
| [`implementation/evidence/07-acceptance-report.md`](./implementation/evidence/07-acceptance-report.md) | Workflow 07 engineering acceptance: delivered behavior, exact automated results, security controls, and the remaining clinician/live-DB/rollback release gates. |
| [`implementation/evidence/07-discipline-plans-current-state.md`](./implementation/evidence/07-discipline-plans-current-state.md) | Workflow 07 WP0 evidence: current UI/API/lifecycle/security inventory, regulatory verification, usability evidence, test results, risks, wireframes, and staged delivery decision. |
| [`implementation/evidence/07-initial-version-contract-proposal.md`](./implementation/evidence/07-initial-version-contract-proposal.md) | Approved and implemented contract for opening initial and interim discipline-plan versions and the additive server-derived overview action projection. |

---

## Reference sources

| Document | Scope |
|---|---|
| [`reference/cms/README.md`](./reference/cms/README.md) | CMS primary sources — Form CMS-1984-14 (hospice cost report). |
| [`api/CHANGES.md`](./api/CHANGES.md) | Dated API changes integrators must act on (request fields, error codes, new routes), with example bodies. The contract itself is [`api/openapi.json`](./api/openapi.json). |

---

## Governance & history

| Document | Scope |
|---|---|
| [`REMEDIATION_SUMMARY.md`](./REMEDIATION_SUMMARY.md) | Architecture remediation summary (phases 0–6). |
| [`history/`](./history/README.md) | Audit findings (F-0xx), #248 outbox-binding rounds, and per-gate incident history, split by topic (moved out of `CLAUDE.md`). |
| [`adr/`](./adr/) | Decision records — see [`adr/README.md`](./adr/README.md). |
| [`../audit/`](../audit/) | Generated audit & fitness-enforcement reports (outside `docs/`) — the source for counts (routes, tables, ADRs, modules); read them instead of trusting a number in prose. |
| [`audits/`](./audits/) | Gap-analysis reports and audit prompts, plus live-browser/production-readiness audit folders, [`audits/billing-e2e/M24_1075_OREGON_EOCCO_READINESS_AUDIT_20261121.md`](./audits/billing-e2e/M24_1075_OREGON_EOCCO_READINESS_AUDIT_20261121.md) (M24 Oregon/EOCCO hospice billing readiness audit), [`audits/billing-e2e/M24_1075_L2_POLICY_REGISTER_20261121.md`](./audits/billing-e2e/M24_1075_L2_POLICY_REGISTER_20261121.md) (M24-1075 L2 regulatory/payer source register and qualification limits), [`audits/billing-e2e/M24_1075_L3_TECHNICAL_QUALIFICATION_20261122.md`](./audits/billing-e2e/M24_1075_L3_TECHNICAL_QUALIFICATION_20261122.md) (M24-1075 L3 synthetic 837I and offline contract qualification), [`audits/billing-e2e/M24_1075_L4_TECHNICAL_QUALIFICATION_20261122.md`](./audits/billing-e2e/M24_1075_L4_TECHNICAL_QUALIFICATION_20261122.md) (M24-1075 L4 synthetic ERA observation and reconciliation foundation), [`audits/billing-e2e/M24_1075_L5_TECHNICAL_QUALIFICATION_20261122.md`](./audits/billing-e2e/M24_1075_L5_TECHNICAL_QUALIFICATION_20261122.md) (M24-1075 L5 trusted Medicaid ERA attribution and nonposting review), [`audits/billing-e2e/M24_1075_L6_ENGINEERING_DISPOSITION_20261122.md`](./audits/billing-e2e/M24_1075_L6_ENGINEERING_DISPOSITION_20261122.md) (M24-1075 L6 engineering disposition for the Medicaid ERA review integration), [`audits/billing-e2e/M24_1075_L6A_IMPLEMENTATION_QUALIFICATION_20261122.md`](./audits/billing-e2e/M24_1075_L6A_IMPLEMENTATION_QUALIFICATION_20261122.md) (M24-1075 L6A payer classification and submission-evidence implementation qualification), [`audits/billing-e2e/M24_1075_L7_OPERATOR_WORKFLOW_QUALIFICATION_20261124.md`](./audits/billing-e2e/M24_1075_L7_OPERATOR_WORKFLOW_QUALIFICATION_20261124.md) (M24-1075 L7 Medicaid ERA operator workflow qualification), [`audits/billing-e2e/M24_1075_L8A1_RATE_POLICY_PRICING_QUALIFICATION_20261125.md`](./audits/billing-e2e/M24_1075_L8A1_RATE_POLICY_PRICING_QUALIFICATION_20261125.md) (M24-1075 L8A.1 rate-policy and pricing qualification), [`audits/billing-e2e/M24_1075_L8A2_CLINICAL_QUANTITY_AND_PRICING_SNAPSHOT_QUALIFICATION_20261125.md`](./audits/billing-e2e/M24_1075_L8A2_CLINICAL_QUANTITY_AND_PRICING_SNAPSHOT_QUALIFICATION_20261125.md) (M24-1075 L8A.2 clinical quantity and pricing-snapshot qualification), [`audits/billing-e2e/M24_1075_L8A2C_ADVANCED_CLINICAL_PRICING_QUALIFICATION_20261125.md`](./audits/billing-e2e/M24_1075_L8A2C_ADVANCED_CLINICAL_PRICING_QUALIFICATION_20261125.md) (M24-1075 L8A.2C advanced clinical pricing qualification), [`audits/billing-e2e/`](./audits/billing-e2e/), [`audits/clearinghouse-integration/STEDI_ARCHITECTURE_AND_EVIDENCE_20261118.md`](./audits/clearinghouse-integration/STEDI_ARCHITECTURE_AND_EVIDENCE_20261118.md) (Stedi evidence, OAuth target and readiness plan), [`audits/clearinghouse-integration/EPISODE_ALERT_ARCHITECTURE_AND_EVIDENCE_20261118.md`](./audits/clearinghouse-integration/EPISODE_ALERT_ARCHITECTURE_AND_EVIDENCE_20261118.md) (Episode Alert evidence, account boundaries and capability blockers), and [`audits/clearinghouse-integration/M23_DIRECT_MAC_NOTICE_GATEWAY_CONTRACT_V1.md`](./audits/clearinghouse-integration/M23_DIRECT_MAC_NOTICE_GATEWAY_CONTRACT_V1.md) (proposed Direct-MAC v1 integration and conformance requirements). |
| [`cartography/`](./cartography/) | Workflow cartographies (admission/intake, patient care, encounters/visits, HOPE) used as audit inputs. |
| [`research/`](./research/) | Regulatory research notes (e.g. `FY2027_HOSPICE_COP_RESEARCH.md`); [`PAIN_ASSESSMENT_AND_PLAN_OF_CARE_TRIGGERS_RESEARCH.md`](./research/PAIN_ASSESSMENT_AND_PLAN_OF_CARE_TRIGGERS_RESEARCH.md) — sourced pain-assessment content and plan-of-care review triggers behind the pain helper in the visit-note composer (regulation vs CMS guidance vs guideline vs common practice); [`HOSPICE_VISIT_PLAN_AND_NEXT_VISIT_RESEARCH.md`](./research/HOSPICE_VISIT_PLAN_AND_NEXT_VISIT_RESEARCH.md) — what a hospice visit's plan and next-visit entry should hold and how it ties to scheduling and the plan of care (42 CFR 418.56, SOM Appendix M, HOPE, NHPCO, NCP), each claim labelled regulation, CMS guidance, guideline or common practice, with what could not be sourced; [`DYSPNEA_ASSESSMENT_AND_PLAN_OF_CARE_RESEARCH.md`](./research/DYSPNEA_ASSESSMENT_AND_PLAN_OF_CARE_RESEARCH.md) — sourced dyspnea assessment content and plan-of-care review reasons behind the dyspnea helper (no dyspnea severity band or trigger exists in any source read, so none is built); [`ESAS_R_CUTOFFS_RESEARCH.md`](./research/ESAS_R_CUTOFFS_RESEARCH.md) — published ESAS and ESAS-r item cut-offs and the single sourced prompt (a score of 4 or more calls for a fuller assessment) behind the composer's ESAS-r item prompt. |
| [`reviews/`](./reviews/) | Review prompt templates (architecture compliance, exceedance, red-team, lock-grade, production readiness). |
| [`agents/`](./agents/) | Agent-skill config: issue tracker, triage labels, domain docs. |
| [`clinical-review/`](./clinical-review/) | [`CLINICAL_SIGNOFF_2026-11-VISIT_NOTE_COMPOSER.md`](./clinical-review/CLINICAL_SIGNOFF_2026-11-VISIT_NOTE_COMPOSER.md) — sign-off sheet for the clinical wording, thresholds and prompts added to the visit-note composer (ADL dependence, pain helper and plan-of-care prompt, Plan and Next Visit, late-entry reason, section chips, dyspnea helper, ESAS-r item prompt, M9 ESAS-r alert and record line); sections 1-8 and 8a were signed off by Lora, RN on 2026-11-25 (not item by item), and rows added later are marked unreviewed. |
| [`compliance/`](./compliance/) | [`AGENT_HARNESS.md`](./compliance/AGENT_HARNESS.md) — how Claude Code + ECC agents work without PHI or secrets (hooks, rules, register gate); [`AISOC_INTEGRATION.md`](./compliance/AISOC_INTEGRATION.md) — runtime SOC plan for audit-event review (CW-MON-01); [`WARDENLENS_PART_2_ADMINISTRATOR_ACCESS.md`](./compliance/WARDENLENS_PART_2_ADMINISTRATOR_ACCESS.md) — the explicit permitted-purpose, role, route, audit and review policy for ADR-0115's tenant-administrator Part 2 intake access; [`risk-analysis/`](./compliance/risk-analysis/README.md) — the HIPAA security risk analysis pack (CW-RA-01): asset and data-flow inventory, scoring method, threats and vulnerabilities mapped to register rows and ADRs, a residual-risk register and a blank sign-off page; a draft, unscored and unsigned until the accountable owner completes it. The register itself is [`../compliance/controls.yaml`](../compliance/controls.yaml). |
| [`UI-UX/`](./UI-UX/) | UI redesign plan, component catalog, migration matrix and phase-0 UI inventory. |
| [`testing/manual-a11y-protocol.md`](./testing/manual-a11y-protocol.md) | Manual WCAG 2.2 AA protocol (keyboard/focus, 200%/400% zoom, VoiceOver/NVDA) with a results template — the half of accessibility an axe scan cannot cover (#852). |
| [`messaging-hub/`](./messaging-hub/README.md) | Proposal: evolve M36 into a Clinical Communication & Care Coordination Hub — baseline/gap map, architecture, phased work packages (0–6), clinical workflows & safety, UX, testing/release gates, 88-capability register. |

---

*This index is hand-maintained. When adding a document under `docs/`, add a row here in the
matching section. The design corpus (`design/`) is additionally guarded by the `docs:ui` gate.*
