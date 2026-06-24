# WardenX Screen Inventory — Pencil Reference

Version: 1.0
Status: Screen ledger (design ↔ module ↔ Pencil)

> The bridge between three things: the [screen specs](./WARDENX_UI_COMPLETE_SCREEN_INDEX.md)
> (what each screen contains), the WardenX **module architecture** (M1–M40 — who owns the data),
> and the **Pencil** design files (the wireframes/hi-fi we generate). Each row ties a screen to
> its owning module(s), its [layout pattern](./WARDENX_UI_LAYOUT_PATTERNS.md), and its Pencil
> generation status.
>
> This complements — does not replace —
> [`DEFERRED_SCREENS.md`](./DEFERRED_SCREENS.md), which tracks *frontend implementation* status.
> This file tracks **design/Pencil** status.

## Legend — Pencil status

| Mark | Meaning |
| :-- | :-- |
| `⬚` | Not yet generated in Pencil |
| `◐` | Generated (wireframe) — needs design review |
| `●` | Generated + reviewed, on-system |
| `node:<id>` | Pencil node id once generated |

> **Generation order** follows the phase batches in [`pencil-prompts/`](./pencil-prompts/)
> (P0 foundation → P5 portal/mobile). Generate via the Pencil MCP into an open `.pen` file;
> record the returned node id in the relevant row.

---

## Core / App Shell — Module M01 Foundation · M02 Identity (10)

| Screen | Module(s) | Layout pattern | Pencil |
| :-- | :-- | :-- | :-- |
| [App Shell & Role Home](./screens/core/WARDENX_UI_APP_SHELL_HOME.md) | M01 | App Shell (Dashboard content) | `◐ node:AQAhY` (wardenx-P0-foundation.pen) |
| [Authentication & Session](./screens/core/WARDENX_UI_AUTH.md) | M02 | Auth Flow | `◐ node:a1dbhD` (P0 .pen) |
| [Global Search Results](./screens/core/WARDENX_UI_GLOBAL_SEARCH_RESULTS.md) | M01 · M33 | Work Queue | `◐ node:Cp053` (P0 .pen) |
| [Help & Training](./screens/core/WARDENX_UI_HELP_TRAINING.md) | M01 | Work Queue | `⬚` |
| [Notifications & Tasks](./screens/core/WARDENX_UI_NOTIFICATIONS_TASKS.md) | M01 · M36 | Work Queue | `◐ node:mK4co` (P0 .pen) |
| [Reporting & Analytics](./screens/core/WARDENX_UI_REPORTING_ANALYTICS.md) | M33 | Dashboard | `◐ node:H3JUcW` (P0 .pen) |
| [Staff Messaging](./screens/core/WARDENX_UI_STAFF_MESSAGING.md) | M36 | Conversation View | `◐ node:A016Y` (P0 .pen) |
| [System / Utility Pages](./screens/core/WARDENX_UI_SYSTEM_UTILITY_PAGES.md) | M01 | System Page | `◐ node:dT1Bt` (P0 .pen) |
| [User Profile & Preferences](./screens/core/WARDENX_UI_USER_PROFILE_PREFERENCES.md) | M02 | Admin Settings | `⬚` |
| [Agency Command Center](./screens/core/WARDENX_UI_AGENCY_COMMAND_CENTER.md) | M33 · M01 | Dashboard | `◐ node:LRfYv` (P0 .pen) |

## Clinical — Patient, Care, Assessments, Visits (28)

| Screen | Module(s) | Layout pattern | Pencil |
| :-- | :-- | :-- | :-- |
| [Patient Chart](./screens/clinical/WARDENX_UI_PATIENT_CHART.md) | M05 | Patient Workspace | `◐ node:fQjjh` (P0 .pen) |
| [Patient List / Census](./screens/clinical/WARDENX_UI_PATIENT_LIST_CENSUS.md) | M05 | Work Queue | `◐ node:DNqXm` (P0 .pen) |
| [Patient Clinical Timeline](./screens/clinical/WARDENX_UI_PATIENT_CLINICAL_TIMELINE.md) | M05 | Patient Workspace + Timeline | `◐ node:KfY70` (P1 .pen) |
| [Admissions / Referral Intake](./screens/clinical/WARDENX_UI_ADMISSIONS_REFERRAL_INTAKE.md) | M06 | Stepper Workflow + Review Workspace | `⬚` |
| [Election & Certification](./screens/clinical/WARDENX_UI_ELECTION_CERTIFICATION.md) | M06 | Patient Workspace + Stepper Workflow | `⬚` |
| [Eligibility Worksheet / CTI](./screens/clinical/WARDENX_UI_ELIGIBILITY_WORKSHEET_CTI.md) | M06 | Patient Workspace + Stepper Workflow | `⬚` |
| [Care Plan](./screens/clinical/WARDENX_UI_CARE_PLAN.md) | M07 | Patient Workspace + Documentation Workspace | `◐ node:UaKVf` (P1 .pen) |
| [Encounter / Visit Documentation](./screens/clinical/WARDENX_UI_ENCOUNTER_VISIT_DOCUMENTATION.md) | M08 | Patient Workspace + Documentation Workspace | `◐ node:AohyV` (P1 .pen) |
| [Clinical Assessments Suite](./screens/clinical/WARDENX_UI_CLINICAL_ASSESSMENTS_SUITE.md) | M09 | Patient Workspace + Documentation Workspace | `◐ node:aSIwN` (P1 .pen) |
| [Wound Care](./screens/clinical/WARDENX_UI_WOUND_CARE.md) | M09 | Patient Workspace + Documentation Workspace | `◐ node:T6KHo` (P1 .pen) |
| [Allergy Management](./screens/clinical/WARDENX_UI_ALLERGY_MANAGEMENT.md) | M05 · M11 | Patient Workspace | `◐ node:TFdIR` (P1 .pen) |
| [HOPE Assessment](./screens/clinical/WARDENX_UI_HOPE_ASSESSMENT.md) | M10 | Patient Workspace + Documentation Workspace | `◐ node:KQ8kz` (P1 .pen) |
| [Orders](./screens/clinical/WARDENX_UI_ORDERS.md) | M11 | Patient Workspace | `◐ node:pQiC0` (P1 .pen) |
| [Medications — Prescribing & eMAR](./screens/clinical/WARDENX_UI_MEDICATIONS_EMAR.md) | M12 · M13 | MAR Grid | `◐ node:ANbhv` (P1 .pen) |
| [IDG Meeting](./screens/clinical/WARDENX_UI_IDG_MEETING.md) | M14 | Work Queue + Documentation Workspace | `◐ node:Wqf1e` (P1 .pen) |
| [Scheduling / Visit Calendar](./screens/clinical/WARDENX_UI_SCHEDULING_VISIT_CALENDAR.md) | M17 | Scheduling Calendar | `◐ node:xeeXk` (P2 .pen) |
| [EVV](./screens/clinical/WARDENX_UI_EVV.md) | M18 | Work Queue | `◐ node:vw0AC` (P2 .pen) |
| [On-Call Triage](./screens/clinical/WARDENX_UI_ON_CALL_TRIAGE.md) | M19 | Work Queue + Documentation Workspace | `◐ node:H6PP83` (P2 .pen) |
| [Field Safety](./screens/clinical/WARDENX_UI_FIELD_SAFETY.md) | M20 | Dashboard + Mobile Task Flow | `◐ node:qOmAz` (P2 .pen) |
| [Supplies / DME / Comfort Kit](./screens/clinical/WARDENX_UI_SUPPLIES_DME_COMFORT_KIT.md) | M21 | Patient Workspace | `◐ node:WYFsN` (P2 .pen) |
| [Document Management](./screens/clinical/WARDENX_UI_DOCUMENT_MANAGEMENT.md) | M22 | Work Queue + Review Workspace | `⬚` |
| [DocLens Extraction Review](./screens/clinical/WARDENX_UI_DOCLENS_EXTRACTION_REVIEW.md) | M22 · M32 | Work Queue + Review Workspace | `⬚` |
| [Clinical Copilot & Chart Search](./screens/clinical/WARDENX_UI_CLINICAL_COPILOT.md) | M32 | Assistant | `◐ node:c96zD` (P1 .pen) |
| [Bereavement](./screens/clinical/WARDENX_UI_BEREAVEMENT.md) | M16 | Work Queue + Patient/Family Detail | `◐ node:hyJ3j` (P2 .pen) |
| [Death & Pronouncement](./screens/clinical/WARDENX_UI_DEATH_PRONOUNCEMENT.md) | M06 · M16 | Stepper Workflow | `◐ node:f7o1r` (P2 .pen) |
| [Discharge / Revocation / Transfer](./screens/clinical/WARDENX_UI_DISCHARGE_REVOCATION_TRANSFER.md) | M06 | Stepper Workflow | `◐ node:m8VaU` (P2 .pen) |
| [HQRP Quality](./screens/clinical/WARDENX_UI_HQRP_QUALITY.md) | M30 | Dashboard | `◐ node:cFmyk` (P2 .pen) |
| [Volunteer Management](./screens/clinical/WARDENX_UI_VOLUNTEER_MANAGEMENT.md) | M30 | Work Queue | `◐ node:p4tXCO` (P2 .pen) |
| [IPU / GIP Bed Board](./screens/clinical/WARDENX_UI_IPU_BED_BOARD.md) | M37 | Bed Board | `◐ node:m1prt` (P2 .pen) |

## Revenue Cycle — Billing, Remittance, Cap, Cost (7)

| Screen | Module(s) | Layout pattern | Pencil |
| :-- | :-- | :-- | :-- |
| [Claims & Billing](./screens/revenue/WARDENX_UI_CLAIMS_BILLING.md) | M23 · M24 | Work Queue | `◐ node:RSFHC` (P3 .pen) |
| [Eligibility Verification](./screens/revenue/WARDENX_UI_ELIGIBILITY_VERIFICATION.md) | M23 · M29 | Work Queue + Patient Detail | `◐ node:fRVXt` (P3 .pen) |
| [Prior Authorization](./screens/revenue/WARDENX_UI_PRIOR_AUTHORIZATION.md) | M23 | Work Queue | `◐ node:RCdgT` (P3 .pen) |
| [Remittance / ERA Posting](./screens/revenue/WARDENX_UI_REMITTANCE_ERA_POSTING.md) | M25 | Work Queue | `◐ node:eeoJ4` (P3 .pen) |
| [Denials Management](./screens/revenue/WARDENX_UI_DENIALS_MANAGEMENT.md) | M25 | Work Queue | `◐ node:l00Umf` (P3 .pen) |
| [Cap Management](./screens/revenue/WARDENX_UI_CAP_MANAGEMENT.md) | M26 | Dashboard | `◐ node:B1Wukv` (P3 .pen) |
| [Cost Report Workspace](./screens/revenue/WARDENX_UI_COST_REPORT_WORKSPACE.md) | M27 | Stepper Workflow | `◐ node:ogmWK` (P3 .pen) |

## Admin — Tenant, Identity, Interop, Master Data (15)

| Screen | Module(s) | Layout pattern | Pencil |
| :-- | :-- | :-- | :-- |
| [Org / Provider / Location Setup](./screens/admin/WARDENX_UI_ORG_PROVIDER_LOCATION_SETUP.md) | M01 · M34 | Admin Hierarchy | `◐ node:MZZY2` (P4 .pen) |
| [Roles & Permissions](./screens/admin/WARDENX_UI_ROLES_PERMISSIONS.md) | M03 | Admin Split | `◐ node:q5UDi` (P4 .pen) |
| [Staff Management](./screens/admin/WARDENX_UI_STAFF_MANAGEMENT.md) | M02 · M34 | Work Queue | `◐ node:g7sGoJ` (P4 .pen) |
| [Tenant Settings](./screens/admin/WARDENX_UI_TENANT_SETTINGS.md) | M34 | Admin Settings | `◐ node:LcUWy` (P4 .pen) |
| [Feature Flags](./screens/admin/WARDENX_UI_FEATURE_FLAGS.md) | M01 · M34 | Work Queue | `⬚` |
| [Audit Log Viewer](./screens/admin/WARDENX_UI_AUDIT_LOG_VIEWER.md) | M04 | Work Queue | `◐ node:o18aS` (P4 .pen) |
| [AI Governance Console](./screens/admin/WARDENX_UI_AI_GOVERNANCE_CONSOLE.md) | M32 | Work Queue | `◐ node:ejsox` (P4 .pen) |
| [Master Data (MDM)](./screens/admin/WARDENX_UI_MASTER_DATA_MDM.md) | M40 | Work Queue | `⬚` |
| [Terminology Admin](./screens/admin/WARDENX_UI_TERMINOLOGY_ADMIN.md) | M38 | Work Queue | `⬚` |
| [Clinical Content Admin](./screens/admin/WARDENX_UI_CLINICAL_CONTENT_ADMIN.md) | M38 · M01 | Work Queue | `⬚` |
| [FHIR / Interop API](./screens/admin/WARDENX_UI_FHIR_INTEROP_API.md) | M28 | Work Queue | `⬚` |
| [Integration Monitoring](./screens/admin/WARDENX_UI_INTEGRATION_MONITORING.md) | M29 | Work Queue | `⬚` |
| [Referral Source CRM](./screens/admin/WARDENX_UI_REFERRAL_SOURCE_CRM.md) | M06 · M29 | Work Queue | `⬚` |
| [Onboarding Wizard](./screens/admin/WARDENX_UI_ONBOARDING_WIZARD.md) | M34 | Stepper Workflow | `⬚` |

## Platform / Ops — WardenX-internal (4)

| Screen | Module(s) | Layout pattern | Pencil |
| :-- | :-- | :-- | :-- |
| [Ops Console](./screens/platform/WARDENX_UI_OPS_CONSOLE.md) | M34 | Admin Console | `◐ node:WGWP7` (P4 .pen) |
| [Subscription Billing](./screens/platform/WARDENX_UI_SUBSCRIPTION_BILLING.md) | M35 | Detail Page | `◐ node:C0ljC` (P4 .pen) |
| [Support / Impersonation Audit](./screens/platform/WARDENX_UI_SUPPORT_IMPERSONATION_AUDIT.md) | M34 | Gated Action Flow | `◐ node:j3z3U` (P4 .pen) |
| [System Health / Degraded Mode](./screens/platform/WARDENX_UI_SYSTEM_HEALTH_DEGRADED_MODE.md) | M01 · M34 | Status Board | `◐ node:cFG0u` (P4 .pen) |

## Portal — Patient / Family / Telehealth — Module M31 (5)

> Portal family inherits the stricter constraints (AA→AAA, single-column, Fraunces warmth, plain
> compassionate language, persistent after-hours safety affordance — see DESIGN.md §10.11).

| Screen | Module(s) | Layout pattern | Pencil |
| :-- | :-- | :-- | :-- |
| [Patient / Family Portal Dashboard](./screens/portal/WARDENX_UI_PATIENT_FAMILY_PORTAL_DASHBOARD.md) | M31 | Portal Dashboard | `⬚` |
| [Portal Care Team Messages](./screens/portal/WARDENX_UI_PORTAL_CARE_TEAM_MESSAGES.md) | M31 · M36 | Conversation View | `⬚` |
| [Portal Documents / Consents](./screens/portal/WARDENX_UI_PORTAL_DOCUMENTS_CONSENTS.md) | M31 · M22 · M39 | Document Viewer | `⬚` |
| [Portal Visit Schedule](./screens/portal/WARDENX_UI_PORTAL_VISIT_SCHEDULE.md) | M31 · M17 | Portal List | `⬚` |
| [Telehealth Visit Room](./screens/portal/WARDENX_UI_TELEHEALTH_VISIT_ROOM.md) | M31 | Media Room | `⬚` |

---

## Summary

| Domain | Screens |
| :-- | :-- |
| Core / App Shell | 10 |
| Clinical | 28 |
| Revenue Cycle | 7 |
| Admin | 15 |
| Platform / Ops | 4 |
| Portal | 5 |
| **Total** | **69** |

> Each screen spec lists its own **variants** (in its `## Pencil Notes` section) — e.g. Patient
> Chart wants active / just-admitted / discharged / deceased / merged / SSN-masked-vs-revealed.
> Generate the variants Pencil-side as frames within the screen's node. Variant count, not screen
> count, is the true size of the design surface (~250+ frames).

## How to generate a screen in Pencil

1. Open a WardenX `.pen` file in the Pencil editor (the MCP needs an open file).
2. Apply the Lantern design system once (see [`pencil-prompts/README.md`](./pencil-prompts/README.md)).
3. Run the screen's prompt from its phase batch in [`pencil-prompts/`](./pencil-prompts/) via the
   Pencil MCP (`mcp__pencil__batch_design`), generating the frames listed in its `Pencil Notes`.
4. Record the returned node id in this ledger (`⬚` → `node:<id>` / `◐` / `●`).
