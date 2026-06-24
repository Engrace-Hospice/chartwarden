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
| [App Shell & Role Home](./screens/core/WARDENX_UI_APP_SHELL_HOME.md) | M01 | App Shell (Dashboard content) | `⬚` |
| [Authentication & Session](./screens/core/WARDENX_UI_AUTH.md) | M02 | Auth Flow | `⬚` |
| [Global Search Results](./screens/core/WARDENX_UI_GLOBAL_SEARCH_RESULTS.md) | M01 · M33 | Work Queue | `⬚` |
| [Help & Training](./screens/core/WARDENX_UI_HELP_TRAINING.md) | M01 | Work Queue | `⬚` |
| [Notifications & Tasks](./screens/core/WARDENX_UI_NOTIFICATIONS_TASKS.md) | M01 · M36 | Work Queue | `⬚` |
| [Reporting & Analytics](./screens/core/WARDENX_UI_REPORTING_ANALYTICS.md) | M33 | Dashboard | `⬚` |
| [Staff Messaging](./screens/core/WARDENX_UI_STAFF_MESSAGING.md) | M36 | Conversation View | `⬚` |
| [System / Utility Pages](./screens/core/WARDENX_UI_SYSTEM_UTILITY_PAGES.md) | M01 | System Page | `⬚` |
| [User Profile & Preferences](./screens/core/WARDENX_UI_USER_PROFILE_PREFERENCES.md) | M02 | Admin Settings | `⬚` |
| [Agency Command Center](./screens/core/WARDENX_UI_AGENCY_COMMAND_CENTER.md) | M33 · M01 | Dashboard | `⬚` |

## Clinical — Patient, Care, Assessments, Visits (28)

| Screen | Module(s) | Layout pattern | Pencil |
| :-- | :-- | :-- | :-- |
| [Patient Chart](./screens/clinical/WARDENX_UI_PATIENT_CHART.md) | M05 | Patient Workspace | `⬚` |
| [Patient List / Census](./screens/clinical/WARDENX_UI_PATIENT_LIST_CENSUS.md) | M05 | Work Queue | `⬚` |
| [Patient Clinical Timeline](./screens/clinical/WARDENX_UI_PATIENT_CLINICAL_TIMELINE.md) | M05 | Patient Workspace + Timeline | `⬚` |
| [Admissions / Referral Intake](./screens/clinical/WARDENX_UI_ADMISSIONS_REFERRAL_INTAKE.md) | M06 | Stepper Workflow + Review Workspace | `⬚` |
| [Election & Certification](./screens/clinical/WARDENX_UI_ELECTION_CERTIFICATION.md) | M06 | Patient Workspace + Stepper Workflow | `⬚` |
| [Eligibility Worksheet / CTI](./screens/clinical/WARDENX_UI_ELIGIBILITY_WORKSHEET_CTI.md) | M06 | Patient Workspace + Stepper Workflow | `⬚` |
| [Care Plan](./screens/clinical/WARDENX_UI_CARE_PLAN.md) | M07 | Patient Workspace + Documentation Workspace | `⬚` |
| [Encounter / Visit Documentation](./screens/clinical/WARDENX_UI_ENCOUNTER_VISIT_DOCUMENTATION.md) | M08 | Patient Workspace + Documentation Workspace | `⬚` |
| [Clinical Assessments Suite](./screens/clinical/WARDENX_UI_CLINICAL_ASSESSMENTS_SUITE.md) | M09 | Patient Workspace + Documentation Workspace | `⬚` |
| [Wound Care](./screens/clinical/WARDENX_UI_WOUND_CARE.md) | M09 | Patient Workspace + Documentation Workspace | `⬚` |
| [Allergy Management](./screens/clinical/WARDENX_UI_ALLERGY_MANAGEMENT.md) | M05 · M11 | Patient Workspace | `⬚` |
| [HOPE Assessment](./screens/clinical/WARDENX_UI_HOPE_ASSESSMENT.md) | M10 | Patient Workspace + Documentation Workspace | `⬚` |
| [Orders](./screens/clinical/WARDENX_UI_ORDERS.md) | M11 | Patient Workspace | `⬚` |
| [Medications — Prescribing & eMAR](./screens/clinical/WARDENX_UI_MEDICATIONS_EMAR.md) | M12 · M13 | MAR Grid | `⬚` |
| [IDG Meeting](./screens/clinical/WARDENX_UI_IDG_MEETING.md) | M14 | Work Queue + Documentation Workspace | `⬚` |
| [Scheduling / Visit Calendar](./screens/clinical/WARDENX_UI_SCHEDULING_VISIT_CALENDAR.md) | M17 | Scheduling Calendar | `⬚` |
| [EVV](./screens/clinical/WARDENX_UI_EVV.md) | M18 | Work Queue | `⬚` |
| [On-Call Triage](./screens/clinical/WARDENX_UI_ON_CALL_TRIAGE.md) | M19 | Work Queue + Documentation Workspace | `⬚` |
| [Field Safety](./screens/clinical/WARDENX_UI_FIELD_SAFETY.md) | M20 | Dashboard + Mobile Task Flow | `⬚` |
| [Supplies / DME / Comfort Kit](./screens/clinical/WARDENX_UI_SUPPLIES_DME_COMFORT_KIT.md) | M21 | Patient Workspace | `⬚` |
| [Document Management](./screens/clinical/WARDENX_UI_DOCUMENT_MANAGEMENT.md) | M22 | Work Queue + Review Workspace | `⬚` |
| [DocLens Extraction Review](./screens/clinical/WARDENX_UI_DOCLENS_EXTRACTION_REVIEW.md) | M22 · M32 | Work Queue + Review Workspace | `⬚` |
| [Clinical Copilot & Chart Search](./screens/clinical/WARDENX_UI_CLINICAL_COPILOT.md) | M32 | Assistant | `⬚` |
| [Bereavement](./screens/clinical/WARDENX_UI_BEREAVEMENT.md) | M16 | Work Queue + Patient/Family Detail | `⬚` |
| [Death & Pronouncement](./screens/clinical/WARDENX_UI_DEATH_PRONOUNCEMENT.md) | M06 · M16 | Stepper Workflow | `⬚` |
| [Discharge / Revocation / Transfer](./screens/clinical/WARDENX_UI_DISCHARGE_REVOCATION_TRANSFER.md) | M06 | Stepper Workflow | `⬚` |
| [HQRP Quality](./screens/clinical/WARDENX_UI_HQRP_QUALITY.md) | M30 | Dashboard | `⬚` |
| [Volunteer Management](./screens/clinical/WARDENX_UI_VOLUNTEER_MANAGEMENT.md) | M30 | Work Queue | `⬚` |
| [IPU / GIP Bed Board](./screens/clinical/WARDENX_UI_IPU_BED_BOARD.md) | M37 | Bed Board | `⬚` |

## Revenue Cycle — Billing, Remittance, Cap, Cost (7)

| Screen | Module(s) | Layout pattern | Pencil |
| :-- | :-- | :-- | :-- |
| [Claims & Billing](./screens/revenue/WARDENX_UI_CLAIMS_BILLING.md) | M23 · M24 | Work Queue | `⬚` |
| [Eligibility Verification](./screens/revenue/WARDENX_UI_ELIGIBILITY_VERIFICATION.md) | M23 · M29 | Work Queue + Patient Detail | `⬚` |
| [Prior Authorization](./screens/revenue/WARDENX_UI_PRIOR_AUTHORIZATION.md) | M23 | Work Queue | `⬚` |
| [Remittance / ERA Posting](./screens/revenue/WARDENX_UI_REMITTANCE_ERA_POSTING.md) | M25 | Work Queue | `⬚` |
| [Denials Management](./screens/revenue/WARDENX_UI_DENIALS_MANAGEMENT.md) | M25 | Work Queue | `⬚` |
| [Cap Management](./screens/revenue/WARDENX_UI_CAP_MANAGEMENT.md) | M26 | Dashboard | `⬚` |
| [Cost Report Workspace](./screens/revenue/WARDENX_UI_COST_REPORT_WORKSPACE.md) | M27 | Stepper Workflow | `⬚` |

## Admin — Tenant, Identity, Interop, Master Data (15)

| Screen | Module(s) | Layout pattern | Pencil |
| :-- | :-- | :-- | :-- |
| [Org / Provider / Location Setup](./screens/admin/WARDENX_UI_ORG_PROVIDER_LOCATION_SETUP.md) | M01 · M34 | Admin Hierarchy | `⬚` |
| [Roles & Permissions](./screens/admin/WARDENX_UI_ROLES_PERMISSIONS.md) | M03 | Admin Split | `⬚` |
| [Staff Management](./screens/admin/WARDENX_UI_STAFF_MANAGEMENT.md) | M02 · M34 | Work Queue | `⬚` |
| [Tenant Settings](./screens/admin/WARDENX_UI_TENANT_SETTINGS.md) | M34 | Admin Settings | `⬚` |
| [Feature Flags](./screens/admin/WARDENX_UI_FEATURE_FLAGS.md) | M01 · M34 | Work Queue | `⬚` |
| [Audit Log Viewer](./screens/admin/WARDENX_UI_AUDIT_LOG_VIEWER.md) | M04 | Work Queue | `⬚` |
| [AI Governance Console](./screens/admin/WARDENX_UI_AI_GOVERNANCE_CONSOLE.md) | M32 | Work Queue | `⬚` |
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
| [Ops Console](./screens/platform/WARDENX_UI_OPS_CONSOLE.md) | M34 | Admin Console | `⬚` |
| [Subscription Billing](./screens/platform/WARDENX_UI_SUBSCRIPTION_BILLING.md) | M35 | Detail Page | `⬚` |
| [Support / Impersonation Audit](./screens/platform/WARDENX_UI_SUPPORT_IMPERSONATION_AUDIT.md) | M34 | Gated Action Flow | `⬚` |
| [System Health / Degraded Mode](./screens/platform/WARDENX_UI_SYSTEM_HEALTH_DEGRADED_MODE.md) | M01 · M34 | Status Board | `⬚` |

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
