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
| Execution plans (waves) | [`plans/`](./plans/) | [below](#execution-plans-waves) |
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
| [`runbooks/transactional-email-postmark.md`](./runbooks/transactional-email-postmark.md) | Operator runbook: Postmark account/BAA, verified sender + SPF/DKIM, env vars, verification and rollback for transactional email. |
| [`runbooks/terminology-catalog-loading.md`](./runbooks/terminology-catalog-loading.md) | Operator runbook: loading CARC/RARC, LOINC, SNOMED CT and RxNorm into M38 — licence to hold, who attests, download, endpoints, expected counts, verification and rollback. |
| [`runbooks/m36-global-search-enablement.md`](./runbooks/m36-global-search-enablement.md) | Operator runbook: enabling M36 global search in production (ADR-0058) — Valkey, ring seal scheme, escrow drill, body backfill, the platform/escrow flags, the tenant switch and the index build, with rollback. |
| [`runbooks/m36-retention-destruction.md`](./runbooks/m36-retention-destruction.md) | Operator runbook: enabling the M36 message destruction executor (WP 5.6, ADR-0086 proposed) - the two switches (tenant ops flag, then the deployment execute key), dry run first, what it never touches (held, object-bearing and referenced messages), the audit evidence and how to stop. |
| [`runbooks/m36-restore-drill.md`](./runbooks/m36-restore-drill.md) | Operator runbook: the M36 restore drill (`bun run m36:restore-drill`) — what production actually backs up, the restore procedure, the consistency checks, demo-scale RPO/RTO and the detection proof. |
| [`runbooks/messaging-escalation-fallback.md`](./runbooks/messaging-escalation-fallback.md) | Operator runbook: M36 escalation fallback (WP 4.11) - when to invoke, the detection signals that exist, a telephone-tree template, the supervisor procedure, the supervisor reassign path (acknowledge-by-phone rejected by decision), stand-down, post-incident review, and the quarterly tabletop and live drill with an evidence record template. |
| [`APP_OVERVIEW.md`](./APP_OVERVIEW.md) | Guided map of what the codebase is and how it fits together — for an engineer joining the project. |
| [`BUSINESS_LOGIC.md`](./BUSINESS_LOGIC.md) | Business logic, workflows & functionality **as built** across the implemented modules — state machines, validation, calculations, cross-module flows. |
| [`PLATFORM_TOOLS_MANUAL.md`](./PLATFORM_TOOLS_MANUAL.md) | Private-cloud platform operating manual — Talos, Kubernetes, Cilium, Envoy Gateway, CloudNativePG, Garage, Valkey, OpenBao, Argo CD, Kyverno and the rest: role, deployment baseline, day-2 operations, HIPAA notes and failure modes per tool. Hosting phases: Hostinger test → OVHcloud production → Hostinger playground (ADR-0050). |
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

## Execution plans (waves)

Per-wave Archon task plans in [`plans/`](./plans/). These are **authority inputs to the
deterministic build harness** and are read-only to automation — the `arch:plan-integrity`
gate fails on any change under `docs/plans/**` (human override: `ALLOW_PLAN_EDITS=1`). Most
represent **completed, merged** waves and are retained as historical governance records.

| Plan | Wave / scope |
|---|---|
| [`M01-M02_VERTICAL_SLICE_PLAN.md`](./plans/M01-M02_VERTICAL_SLICE_PLAN.md) | Phase 1 vertical slice — M1 Foundation + M2 Identity. |
| [`WAVE_AUTH_BETTER_AUTH_PLAN.md`](./plans/WAVE_AUTH_BETTER_AUTH_PLAN.md) | Better Auth mount + M2 sign-in front door. |
| [`AUTH_T06_SCHEMA_RECONCILE.md`](./plans/AUTH_T06_SCHEMA_RECONCILE.md) | Better Auth ↔ M1 schema reconciliation. |
| [`WAVE_A_M3-M4_PLAN.md`](./plans/WAVE_A_M3-M4_PLAN.md) | Wave A — M3 Authorization + M4 Audit. |
| [`WAVE_B_M36-M38-M40_PLAN.md`](./plans/WAVE_B_M36-M38-M40_PLAN.md) | Wave B — M36 Messaging + M38 Terminology + M40 MDM. |
| [`WAVE_C_M5-M39_PLAN.md`](./plans/WAVE_C_M5-M39_PLAN.md) | Wave C — M5 Patient + M39 Consent. |
| [`WAVE_D_M6-M7-M8_PLAN.md`](./plans/WAVE_D_M6-M7-M8_PLAN.md) | Wave D — M6 Admission + M7 Care Plan + M8 Encounters. |
| [`WAVE_M6_LIVE_WIRE_PLAN.md`](./plans/WAVE_M6_LIVE_WIRE_PLAN.md) | M6 Admission live-wire. |
| [`WAVE_E_M9-M13_PLAN.md`](./plans/WAVE_E_M9-M13_PLAN.md) | Wave E — clinical depth (M9 · M10 · M11 · M12 · M13). |
| [`WAVE_F_M14-M17-M18-M22_PLAN.md`](./plans/WAVE_F_M14-M17-M18-M22_PLAN.md) | Wave F — M14 IDG · M17 Scheduling · M18 EVV · M22 Documents. |
| [`WAVE_G_M23-M25-M26_PLAN.md`](./plans/WAVE_G_M23-M25-M26_PLAN.md) | Wave G — revenue cycle (M23 · M25 · M26). |
| [`WAVE_H_M28-M29-M30-M32-M34_PLAN.md`](./plans/WAVE_H_M28-M29-M30-M32-M34_PLAN.md) | Wave H — M28 FHIR · M29 Interfaces · M30 HQRP · M32 AI · M34 SaaS. |
| [`WAVE_P2-1_M15-M16-M21-M24_PLAN.md`](./plans/WAVE_P2-1_M15-M16-M21-M24_PLAN.md) | Wave P2-1 — M15 · M16 · M21 · M24. |
| [`WAVE_P2-2_M19-M20_PLAN.md`](./plans/WAVE_P2-2_M19-M20_PLAN.md) | Wave P2-2 — M19 On-Call · M20 Field Safety. |
| [`WAVE_P2-3_M27-M31-M33-M35_PLAN.md`](./plans/WAVE_P2-3_M27-M31-M33-M35_PLAN.md) | Wave P2-3 — M27 · M31 · M33 · M35. |
| [`WAVE_P3_M37_IPU_PLAN.md`](./plans/WAVE_P3_M37_IPU_PLAN.md) | Phase 3 — M37 Inpatient Unit (IPU). |
| [`WAVE_ADMIN_CONSOLE_M35_SUBSCRIPTION_PLAN.md`](./plans/WAVE_ADMIN_CONSOLE_M35_SUBSCRIPTION_PLAN.md) | Admin console — M34 shell + M35 §5.2 platform-ops screens. |
| [`WAVE_FRONTEND_BACKLOG_PLAN.md`](./plans/WAVE_FRONTEND_BACKLOG_PLAN.md) | Frontend backlog (Track A). |
| [`FRONTEND_INTEGRATION_PLAN.md`](./plans/FRONTEND_INTEGRATION_PLAN.md) | Frontend integration (Foundation + backlog + per-module). |
| [`PHASE_2A_UPGRADES_PLAN.md`](./plans/PHASE_2A_UPGRADES_PLAN.md) | Phase 2 Part A — flag-activation upgrades. |
| [`PHASE_3_UPGRADES_PLAN.md`](./plans/PHASE_3_UPGRADES_PLAN.md) | Phase 3 — flag activations. |
| [`ARCHON_RUN_TRACKER.md`](./plans/ARCHON_RUN_TRACKER.md) | Archon run tracker (execution log). |

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
| [`audits/`](./audits/) | Gap-analysis reports and the audit prompt (`GAP_ANALYSIS_*.md`), plus live-browser and production-readiness audit folders, and [`audits/billing-e2e/`](./audits/billing-e2e/) (billing scenario-to-test matrix, plan, issue drafts). |
| [`cartography/`](./cartography/) | Workflow cartographies (admission/intake, patient care, encounters/visits, HOPE) used as audit inputs. |
| [`research/`](./research/) | Regulatory research notes (e.g. `FY2027_HOSPICE_COP_RESEARCH.md`). |
| [`reviews/`](./reviews/) | Review prompt templates (architecture compliance, exceedance, red-team, lock-grade, production readiness). |
| [`agents/`](./agents/) | Agent-skill config: issue tracker, triage labels, domain docs. |
| [`UI-UX/`](./UI-UX/) | UI redesign plan, component catalog, migration matrix and phase-0 UI inventory. |
| [`testing/manual-a11y-protocol.md`](./testing/manual-a11y-protocol.md) | Manual WCAG 2.2 AA protocol (keyboard/focus, 200%/400% zoom, VoiceOver/NVDA) with a results template — the half of accessibility an axe scan cannot cover (#852). |
| [`messaging-hub/`](./messaging-hub/README.md) | Proposal: evolve M36 into a Clinical Communication & Care Coordination Hub — baseline/gap map, architecture, phased work packages (0–6), clinical workflows & safety, UX, testing/release gates, 88-capability register. |

---

*This index is hand-maintained. When adding a document under `docs/`, add a row here in the
matching section. The design corpus (`design/`) and wave plans (`plans/`) are additionally
guarded by the `docs:ui` and `arch:plan-integrity` gates respectively.*
