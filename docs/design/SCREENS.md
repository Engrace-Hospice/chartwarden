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

> **Status: ALL 97 screens generated in Pencil** (`◐`), across 12 phase files
> (`wardenx-P0-foundation.pen` … `wardenx-P11-core-clinical-cleanup.pen`), each screenshot-verified
> against the Lantern design system. The full P0–P5 core corpus, the P6–P10 gap-fill expansion
> (compliance/privacy/quality, EPCS+staffing+patient-billing, external portals, mobile/integration/
> ops, cert+billing-ops+note-lifecycle+facility+role-dashboards), and the P11 cleanup of the 7
> index entries the original P0–P5 prompts had skipped (help/training, user profile, admissions
> intake, election & cert, eligibility/CTI, document mgmt, DocLens) are all complete. Every named
> pattern in the [layout glossary](./WARDENX_UI_LAYOUT_PATTERNS.md) is represented. The corpus is
> closed at **97/97**. Next step is design review (`◐` → `●`) and frontend implementation.

> **Generation order** follows the phase batches in [`pencil-prompts/`](./pencil-prompts/)
> (P0 foundation → P5 portal/mobile). Generate via the Pencil MCP into an open `.pen` file;
> record the returned node id in the relevant row.

---

## Core / App Shell — Module M01 Foundation · M02 Identity (10)

| Screen | Module(s) | Layout pattern | Pencil |
| :-- | :-- | :-- | :-- |
| [App Shell & Role Home](./screens/core/WARDENX_UI_APP_SHELL_HOME.md) | M01 | App Shell (Dashboard content) | `● node:AQAhY` (wardenx-P0-foundation.pen) |
| [Authentication & Session](./screens/core/WARDENX_UI_AUTH.md) | M02 | Auth Flow | `● node:a1dbhD` (P0 .pen) |
| [Global Search Results](./screens/core/WARDENX_UI_GLOBAL_SEARCH_RESULTS.md) | M01 · M33 | Work Queue | `● node:Cp053` (P0 .pen) |
| [Help & Training](./screens/core/WARDENX_UI_HELP_TRAINING.md) | M01 | Work Queue | `● node:nNKhB` (P11 .pen) |
| [Notifications & Tasks](./screens/core/WARDENX_UI_NOTIFICATIONS_TASKS.md) | M01 · M36 | Work Queue | `● node:mK4co` (P0 .pen) |
| [Reporting & Analytics](./screens/core/WARDENX_UI_REPORTING_ANALYTICS.md) | M33 | Dashboard | `● node:H3JUcW` (P0 .pen) |
| [Staff Messaging](./screens/core/WARDENX_UI_STAFF_MESSAGING.md) | M36 | Conversation View | `● node:A016Y` (P0 .pen) |
| [System / Utility Pages](./screens/core/WARDENX_UI_SYSTEM_UTILITY_PAGES.md) | M01 | System Page | `● node:dT1Bt` (P0 .pen) |
| [User Profile & Preferences](./screens/core/WARDENX_UI_USER_PROFILE_PREFERENCES.md) | M02 | Admin Settings | `● node:fGKwq` (P11 .pen) |
| [Agency Command Center](./screens/core/WARDENX_UI_AGENCY_COMMAND_CENTER.md) | M33 · M01 | Dashboard | `● node:LRfYv` (P0 .pen) |

## Clinical — Patient, Care, Assessments, Visits (28)

| Screen | Module(s) | Layout pattern | Pencil |
| :-- | :-- | :-- | :-- |
| [Patient Chart](./screens/clinical/WARDENX_UI_PATIENT_CHART.md) | M05 | Patient Workspace | `● node:fQjjh` (P0 .pen) |
| [Patient List / Census](./screens/clinical/WARDENX_UI_PATIENT_LIST_CENSUS.md) | M05 | Work Queue | `● node:DNqXm` (P0 .pen) |
| [Patient Clinical Timeline](./screens/clinical/WARDENX_UI_PATIENT_CLINICAL_TIMELINE.md) | M05 | Patient Workspace + Timeline | `● node:KfY70` (P1 .pen) |
| [Admissions / Referral Intake](./screens/clinical/WARDENX_UI_ADMISSIONS_REFERRAL_INTAKE.md) | M06 | Stepper Workflow + Review Workspace | `● node:d9ZJU` (P11 .pen) |
| [Election & Certification](./screens/clinical/WARDENX_UI_ELECTION_CERTIFICATION.md) | M06 | Patient Workspace + Stepper Workflow | `● node:LXxxD` (P11 .pen) |
| [Eligibility Worksheet / CTI](./screens/clinical/WARDENX_UI_ELIGIBILITY_WORKSHEET_CTI.md) | M06 | Patient Workspace + Stepper Workflow | `● node:lZPbZ` (P11 .pen) |
| [Care Plan](./screens/clinical/WARDENX_UI_CARE_PLAN.md) | M07 | Patient Workspace + Documentation Workspace | `● node:UaKVf` (P1 .pen) |
| [Encounter / Visit Documentation](./screens/clinical/WARDENX_UI_ENCOUNTER_VISIT_DOCUMENTATION.md) | M08 | Patient Workspace + Documentation Workspace | `● node:AohyV` (P1 .pen) |
| [Clinical Assessments Suite](./screens/clinical/WARDENX_UI_CLINICAL_ASSESSMENTS_SUITE.md) | M09 | Patient Workspace + Documentation Workspace | `● node:aSIwN` (P1 .pen) |
| [Wound Care](./screens/clinical/WARDENX_UI_WOUND_CARE.md) | M09 | Patient Workspace + Documentation Workspace | `● node:T6KHo` (P1 .pen) |
| [Allergy Management](./screens/clinical/WARDENX_UI_ALLERGY_MANAGEMENT.md) | M05 · M11 | Patient Workspace | `● node:TFdIR` (P1 .pen) |
| [HOPE Assessment](./screens/clinical/WARDENX_UI_HOPE_ASSESSMENT.md) | M10 | Patient Workspace + Documentation Workspace | `● node:KQ8kz` (P1 .pen) |
| [Orders](./screens/clinical/WARDENX_UI_ORDERS.md) | M11 | Patient Workspace | `● node:pQiC0` (P1 .pen) |
| [Medications — Prescribing & eMAR](./screens/clinical/WARDENX_UI_MEDICATIONS_EMAR.md) | M12 · M13 | MAR Grid | `● node:ANbhv` (P1 .pen) |
| [IDG Meeting](./screens/clinical/WARDENX_UI_IDG_MEETING.md) | M14 | Work Queue + Documentation Workspace | `● node:Wqf1e` (P1 .pen) |
| [Scheduling / Visit Calendar](./screens/clinical/WARDENX_UI_SCHEDULING_VISIT_CALENDAR.md) | M17 | Scheduling Calendar | `● node:xeeXk` (P2 .pen) |
| [EVV](./screens/clinical/WARDENX_UI_EVV.md) | M18 | Work Queue | `● node:vw0AC` (P2 .pen) |
| [On-Call Triage](./screens/clinical/WARDENX_UI_ON_CALL_TRIAGE.md) | M19 | Work Queue + Documentation Workspace | `● node:H6PP83` (P2 .pen) |
| [Field Safety](./screens/clinical/WARDENX_UI_FIELD_SAFETY.md) | M20 | Dashboard + Mobile Task Flow | `● node:qOmAz` (P2 .pen) |
| [Supplies / DME / Comfort Kit](./screens/clinical/WARDENX_UI_SUPPLIES_DME_COMFORT_KIT.md) | M21 | Patient Workspace | `● node:WYFsN` (P2 .pen) |
| [Document Management](./screens/clinical/WARDENX_UI_DOCUMENT_MANAGEMENT.md) | M22 | Work Queue + Review Workspace | `● node:plO9v` (P11 .pen) |
| [DocLens Extraction Review](./screens/clinical/WARDENX_UI_DOCLENS_EXTRACTION_REVIEW.md) | M22 · M32 | Work Queue + Review Workspace | `● node:SCV56` (P11 .pen) |
| [Clinical Copilot & Chart Search](./screens/clinical/WARDENX_UI_CLINICAL_COPILOT.md) | M32 | Assistant | `● node:c96zD` (P1 .pen) |
| [Bereavement](./screens/clinical/WARDENX_UI_BEREAVEMENT.md) | M16 | Work Queue + Patient/Family Detail | `● node:hyJ3j` (P2 .pen) |
| [Death & Pronouncement](./screens/clinical/WARDENX_UI_DEATH_PRONOUNCEMENT.md) | M06 · M16 | Stepper Workflow | `● node:f7o1r` (P2 .pen) |
| [Discharge / Revocation / Transfer](./screens/clinical/WARDENX_UI_DISCHARGE_REVOCATION_TRANSFER.md) | M06 | Stepper Workflow | `● node:m8VaU` (P2 .pen) |
| [HQRP Quality](./screens/clinical/WARDENX_UI_HQRP_QUALITY.md) | M30 | Dashboard | `● node:cFmyk` (P2 .pen) |
| [Volunteer Management](./screens/clinical/WARDENX_UI_VOLUNTEER_MANAGEMENT.md) | M30 | Work Queue | `● node:p4tXCO` (P2 .pen) |
| [IPU / GIP Bed Board](./screens/clinical/WARDENX_UI_IPU_BED_BOARD.md) | M37 | Bed Board | `● node:m1prt` (P2 .pen) |

## Revenue Cycle — Billing, Remittance, Cap, Cost (7)

| Screen | Module(s) | Layout pattern | Pencil |
| :-- | :-- | :-- | :-- |
| [Claims & Billing](./screens/revenue/WARDENX_UI_CLAIMS_BILLING.md) | M23 · M24 | Work Queue | `● node:RSFHC` (P3 .pen) |
| [Eligibility Verification](./screens/revenue/WARDENX_UI_ELIGIBILITY_VERIFICATION.md) | M23 · M29 | Work Queue + Patient Detail | `● node:fRVXt` (P3 .pen) |
| [Prior Authorization](./screens/revenue/WARDENX_UI_PRIOR_AUTHORIZATION.md) | M23 | Work Queue | `● node:RCdgT` (P3 .pen) |
| [Remittance / ERA Posting](./screens/revenue/WARDENX_UI_REMITTANCE_ERA_POSTING.md) | M25 | Work Queue | `● node:eeoJ4` (P3 .pen) |
| [Denials Management](./screens/revenue/WARDENX_UI_DENIALS_MANAGEMENT.md) | M25 | Work Queue | `● node:l00Umf` (P3 .pen) |
| [Cap Management](./screens/revenue/WARDENX_UI_CAP_MANAGEMENT.md) | M26 | Dashboard | `● node:B1Wukv` (P3 .pen) |
| [Cost Report Workspace](./screens/revenue/WARDENX_UI_COST_REPORT_WORKSPACE.md) | M27 | Stepper Workflow | `● node:ogmWK` (P3 .pen) |

## Admin — Tenant, Identity, Interop, Master Data (15)

| Screen | Module(s) | Layout pattern | Pencil |
| :-- | :-- | :-- | :-- |
| [Org / Provider / Location Setup](./screens/admin/WARDENX_UI_ORG_PROVIDER_LOCATION_SETUP.md) | M01 · M34 | Admin Hierarchy | `● node:MZZY2` (P4 .pen) |
| [Roles & Permissions](./screens/admin/WARDENX_UI_ROLES_PERMISSIONS.md) | M03 | Admin Split | `● node:q5UDi` (P4 .pen) |
| [Staff Management](./screens/admin/WARDENX_UI_STAFF_MANAGEMENT.md) | M02 · M34 | Work Queue | `● node:g7sGoJ` (P4 .pen) |
| [Tenant Settings](./screens/admin/WARDENX_UI_TENANT_SETTINGS.md) | M34 | Admin Settings | `● node:LcUWy` (P4 .pen) |
| [Feature Flags](./screens/admin/WARDENX_UI_FEATURE_FLAGS.md) | M01 · M34 | Work Queue | `● node:bxUqf` (P4 .pen) |
| [Audit Log Viewer](./screens/admin/WARDENX_UI_AUDIT_LOG_VIEWER.md) | M04 | Work Queue | `● node:o18aS` (P4 .pen) |
| [AI Governance Console](./screens/admin/WARDENX_UI_AI_GOVERNANCE_CONSOLE.md) | M32 | Work Queue | `● node:ejsox` (P4 .pen) |
| [Master Data (MDM)](./screens/admin/WARDENX_UI_MASTER_DATA_MDM.md) | M40 | Work Queue | `● node:mrj17` (P4 .pen) |
| [Terminology Admin](./screens/admin/WARDENX_UI_TERMINOLOGY_ADMIN.md) | M38 | Work Queue | `● node:r6axh` (P4 .pen) |
| [Clinical Content Admin](./screens/admin/WARDENX_UI_CLINICAL_CONTENT_ADMIN.md) | M38 · M01 | Work Queue | `● node:nxzBw` (P4 .pen) |
| [FHIR / Interop API](./screens/admin/WARDENX_UI_FHIR_INTEROP_API.md) | M28 | Work Queue | `● node:c0Ibms` (P4 .pen) |
| [Integration Monitoring](./screens/admin/WARDENX_UI_INTEGRATION_MONITORING.md) | M29 | Work Queue | `● node:CsLJv` (P4 .pen) |
| [Referral Source CRM](./screens/admin/WARDENX_UI_REFERRAL_SOURCE_CRM.md) | M06 · M29 | Work Queue | `● node:L9t1M` (P4 .pen) |
| [Onboarding Wizard](./screens/admin/WARDENX_UI_ONBOARDING_WIZARD.md) | M34 | Stepper Workflow | `● node:U01CF` (P4 .pen) |

## Platform / Ops — WardenX-internal (4)

| Screen | Module(s) | Layout pattern | Pencil |
| :-- | :-- | :-- | :-- |
| [Ops Console](./screens/platform/WARDENX_UI_OPS_CONSOLE.md) | M34 | Admin Console | `● node:WGWP7` (P4 .pen) |
| [Subscription Billing](./screens/platform/WARDENX_UI_SUBSCRIPTION_BILLING.md) | M35 | Detail Page | `● node:C0ljC` (P4 .pen) |
| [Support / Impersonation Audit](./screens/platform/WARDENX_UI_SUPPORT_IMPERSONATION_AUDIT.md) | M34 | Gated Action Flow | `● node:j3z3U` (P4 .pen) |
| [System Health / Degraded Mode](./screens/platform/WARDENX_UI_SYSTEM_HEALTH_DEGRADED_MODE.md) | M01 · M34 | Status Board | `● node:cFG0u` (P4 .pen) |

## Portal — Patient / Family / Telehealth — Module M31 (5)

> Portal family inherits the stricter constraints (AA→AAA, single-column, Fraunces warmth, plain
> compassionate language, persistent after-hours safety affordance — see DESIGN.md §10.11).

| Screen | Module(s) | Layout pattern | Pencil |
| :-- | :-- | :-- | :-- |
| [Patient / Family Portal Dashboard](./screens/portal/WARDENX_UI_PATIENT_FAMILY_PORTAL_DASHBOARD.md) | M31 | Portal Dashboard | `● node:ltVaw` (P5 .pen) |
| [Portal Care Team Messages](./screens/portal/WARDENX_UI_PORTAL_CARE_TEAM_MESSAGES.md) | M31 · M36 | Conversation View | `● node:y8N8k` (P5 .pen) |
| [Portal Documents / Consents](./screens/portal/WARDENX_UI_PORTAL_DOCUMENTS_CONSENTS.md) | M31 · M22 · M39 | Document Viewer | `● node:tCfQ6` (P5 .pen) |
| [Portal Visit Schedule](./screens/portal/WARDENX_UI_PORTAL_VISIT_SCHEDULE.md) | M31 · M17 | Portal List | `● node:R1Qzuj` (P5 .pen) |
| [Telehealth Visit Room](./screens/portal/WARDENX_UI_TELEHEALTH_VISIT_ROOM.md) | M31 | Media Room | `● node:NRM8F` (P5 .pen) |

---

## Missing-domain expansion — P6–P10 (28)

> Added to close the gap vs. a comprehensive hospice EHR — whole domains the original 69 specs
> never covered (compliance/privacy, EPCS, staffing/HR, external portals, mobile, integration,
> cert/billing-ops). Specs live in `screens/**`; Pencil generation is the next batch (`⬚`).

### P6 — Compliance, Privacy & Quality (8)

| Screen | Module(s) | Layout pattern | Pencil |
| :-- | :-- | :-- | :-- |
| [HIPAA Privacy & Disclosure](./screens/compliance/WARDENX_UI_HIPAA_PRIVACY_DISCLOSURE.md) | M04 · M39 | Work Queue | `● node:nPnkV` (P6 .pen) |
| [Breach & Security Incidents](./screens/compliance/WARDENX_UI_BREACH_SECURITY_INCIDENTS.md) | M04 | Work Queue | `● node:c5WGQ9` (P6 .pen) |
| [Business Associate Agreements](./screens/compliance/WARDENX_UI_BAA_MANAGER.md) | M40 · M34 | Work Queue | `● node:Y1ubGH` (P6 .pen) |
| [Patient Rights & Grievances](./screens/compliance/WARDENX_UI_PATIENT_RIGHTS_GRIEVANCES.md) | M30 | Work Queue | `● node:GQMdF` (P6 .pen) |
| [QAPI Program & Incidents](./screens/compliance/WARDENX_UI_QAPI_INCIDENTS.md) | M30 | Dashboard | `● node:k7H99` (P6 .pen) |
| [Quality Measures & Chart Audit](./screens/compliance/WARDENX_UI_QUALITY_MEASURES_CHART_AUDIT.md) | M30 | Dashboard | `● node:jbNOR` (P6 .pen) |
| [Accreditation & Survey Readiness](./screens/compliance/WARDENX_UI_ACCREDITATION_SURVEY.md) | M30 | Work Queue | `● node:SHZre` (P6 .pen) |
| [OIG Exclusion & Compliance Program](./screens/compliance/WARDENX_UI_OIG_COMPLIANCE_PROGRAM.md) | M30 · M34 | Work Queue | `● node:gOyIA` (P6 .pen) |

### P7 — Prescribing Controls, Staffing & Patient Billing (5)

| Screen | Module(s) | Layout pattern | Pencil |
| :-- | :-- | :-- | :-- |
| [EPCS & Controlled Substances](./screens/clinical/WARDENX_UI_EPCS_CONTROLLED_SUBSTANCES.md) | M12 | Work Queue | `● node:seR8n` (P7 .pen) |
| [Staff Credentials & Compliance](./screens/staffing/WARDENX_UI_STAFF_CREDENTIALS_COMPLIANCE.md) | M02 · M34 | Work Queue | `● node:m0wtL7` (P7 .pen) |
| [Staff Scheduling & Caseload](./screens/staffing/WARDENX_UI_STAFF_SCHEDULING_CASELOAD.md) | M02 · M17 · M34 | Work Queue | `● node:XySvp` (P7 .pen) |
| [Timesheets & Payroll](./screens/staffing/WARDENX_UI_TIMESHEETS_PAYROLL.md) | M34 | Work Queue | `● node:ERZ5p` (P7 .pen) |
| [Patient Statements & Financial Assistance](./screens/revenue/WARDENX_UI_PATIENT_STATEMENTS_ASSISTANCE.md) | M23 · M24 | Work Queue | `● node:JvkW0` (P7 .pen) |

### P8 — External & Coordination Portals (6)

| Screen | Module(s) | Layout pattern | Pencil |
| :-- | :-- | :-- | :-- |
| [External Physician Portal](./screens/portal/WARDENX_UI_EXTERNAL_PHYSICIAN_PORTAL.md) | M29 · M31 | Portal Dashboard | `● node:HIRCS` (P8 .pen) |
| [Consulting Physician Portal](./screens/portal/WARDENX_UI_CONSULTING_PHYSICIAN_PORTAL.md) | M31 | Portal Dashboard | `● node:z58Qbh` (P8 .pen) |
| [Referral Source Portal](./screens/portal/WARDENX_UI_REFERRAL_SOURCE_PORTAL.md) | M29 | Portal Dashboard | `● node:m23Lw` (P8 .pen) |
| [Facility Nurse Portal](./screens/portal/WARDENX_UI_FACILITY_NURSE_PORTAL.md) | M31 | Portal Dashboard | `● node:CzFUq` (P8 .pen) |
| [DME Vendor Portal](./screens/portal/WARDENX_UI_DME_VENDOR_PORTAL.md) | M31 | Portal Dashboard | `● node:r7RLV` (P8 .pen) |
| [Surveyor Access Portal](./screens/portal/WARDENX_UI_SURVEYOR_ACCESS_PORTAL.md) | M30 | Work Queue | `● node:LISN8` (P8 .pen) |

### P9 — Mobile, Integration & Ops (4)

| Screen | Module(s) | Layout pattern | Pencil |
| :-- | :-- | :-- | :-- |
| [Mobile Field Suite](./screens/mobile/WARDENX_UI_MOBILE_FIELD_SUITE.md) | M17 · M18 · M22 | Dashboard + Mobile Task Flow | `● node:lynRU` (P9 .pen) |
| [HL7 & Interface Logs](./screens/integration/WARDENX_UI_HL7_INTERFACE_LOGS.md) | M29 | Work Queue | `● node:dFRJ9` (P9 .pen) |
| [Submission & Resubmission](./screens/integration/WARDENX_UI_SUBMISSION_RESUBMISSION.md) | M10 · M29 | Work Queue | `● node:m6Iqp` (P9 .pen) |
| [Workflow & Event Operations](./screens/platform/WARDENX_UI_WORKFLOW_EVENT_OPS.md) | M01 | Status Board | `● node:Xnsde` (P9 .pen) |

### P10 — Certification, Billing-Ops, Note Lifecycle, Facility & Role Dashboards (5)

| Screen | Module(s) | Layout pattern | Pencil |
| :-- | :-- | :-- | :-- |
| [Certification & Recert Lifecycle](./screens/clinical/WARDENX_UI_CERTIFICATION_RECERT_LIFECYCLE.md) | M06 | Stepper Workflow | `● node:URHlL` (P10 .pen) |
| [Clinical Note Lifecycle](./screens/clinical/WARDENX_UI_CLINICAL_NOTE_LIFECYCLE.md) | M08 | Work Queue + Review Workspace | `● node:v72Yj` (P10 .pen) |
| [NOE/NOTR & Claim Ops](./screens/revenue/WARDENX_UI_NOE_NOTR_CLAIM_OPS.md) | M23 | Work Queue | `● node:eq20w` (P10 .pen) |
| [Facility & Supply Operations](./screens/clinical/WARDENX_UI_FACILITY_SUPPLY_OPERATIONS.md) | M21 · M37 | Admin Hierarchy Layout | `● node:lbY0m` (P10 .pen) |
| [Role Dashboards](./screens/core/WARDENX_UI_ROLE_DASHBOARDS.md) | M33 | Dashboard | `● node:KpBpz` (P10 .pen) |

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
| **Original corpus** | **69** |
| Missing-domain expansion (P6–P10) | 28 |
| **Total** | **97** |

> Each screen spec lists its own **variants** (in its `## Pencil Notes` section) — e.g. Patient
> Chart wants active / just-admitted / discharged / deceased / merged / SSN-masked-vs-revealed.
> Generate the variants Pencil-side as frames within the screen's node. Variant count, not screen
> count, is the true size of the design surface (~600 frames; see the Depth track below).

## Depth track (D1–D6) — the sub-view / variant surface

The 97 screens above are each built as **one frame**. A [coverage diagnosis](#coverage-diagnosis)
found the specs declare ~6.35 frames each (~600 total), so ~500 sub-views/variants were unbuilt.
The **Depth track** ([`pencil-prompts/D1-D6-depth.md`](./pencil-prompts/D1-D6-depth.md)) builds
that surface — reusable treatments (ceremonies, masking, states) built once and instanced.

> **Depth track COMPLETE (D1–D6): 137 frames** across 6 `.pen` files. Three reusable foundation
> libraries (D1 ceremonies · D2 sensitivity · D3 states) + the per-screen depth (D4 steppers ·
> D5 variants · D6 sub-views). Combined with the 97 top-level screens, the corpus now stands at
> **~234 frames** — the frame-depth surface the diagnosis identified. The D5 discipline plans also
> closed the M15 breadth gap. Remaining: the ~45–65 missing *whole* screens (a future breadth track).

| Phase | File | Theme | Status |
| :-- | :-- | :-- | :-- |
| D1 | `wardenx-D1-ceremonies.pen` | Guardrail & signing-ceremony library | `● node:GyRUU` — 21 frames (signature ×4 · guard-blocked ×2 · step-up ×3 · EPCS 2FA ×5 · cosign ×3 · witness ×3 · destructive ×1) |
| D2 | `wardenx-D2-sensitivity.pen` | PHI masking / SUD-Part2 / consent / break-glass | `● node:wMcvc` — 10 frames (PHI mask↔reveal ×3 · sensitive-row badges table · SUD seal→consent→break-glass→reveal ×4 · consent-gated section · min-necessary redaction) |
| D3 | `wardenx-D3-states.pen` | Universal empty / loading / error / no-perm / degraded | `● node:CUzYC` — 12 frames (state panels ×6: loading·empty·zero-filter·error·no-perm·degraded · skeletons ×3: work-queue·dashboard·patient-workspace · in-context ×3: empty·no-perm·degraded-ribbon) |
| D4 | `wardenx-D4-steppers.pen` | Multi-step workflows — all steps | `● node:ZgXYC` — 33 frames (Admissions ×8 · Recert ×7 · Election ×4 · Death ×4 · Discharge ×4 · Onboarding ×6) |
| D5 | `wardenx-D5-variants.pen` | Role dashboards · discipline care plans · assessments | `◐ node:T2caK` — 32 frames: discipline plans ×5 (Aide/MSW/Spiritual/Spiritual-declined/Volunteer **[closes M15]**) · role dashboards ×4 (Bereavement/QA/Compliance/Intake) · chart lifecycle ×5 (active/admitted/discharged/deceased/merged) · MAR states grid · assessment scales ×8 (PPS/PAINAD/ESAS-r/Karnofsky/FAST/RASS/Spiritual-FICA/RDOS) · care-plan master IPOC + states ×5 (IPOC/review-overdue/IDG-revision/aide-supervisory-due/amendment) · entry & MAR sub-flows ×4 (PPS-entry/PAINAD-entry/PRN-reassessment/comfort-kit-drawdown) |
| D6 | `wardenx-D6-subviews.pen` | Heavyweight screens' secondary tabs / panels | `◐ node:E0REv` — 29 sub-views: Patient Chart ×6 (summary/allergies/problems/meds/documents/financial) · Claims & Billing ×4 (AR/workbench/editor/Medicaid-R&B) · Note Lifecycle ×5 (unsigned/versions/compare/amendment/audit) · IDG Meeting ×4 (agenda/live/packet/decisions) · HQRP ×4 (measures/CAHPS/QAPI-kanban/survey-ready) · Scheduling & EVV ×3 (route/EVV-exceptions/caseload) · eMAR ×3 (med-list/prescribe/reconcile) |
| D7 | `wardenx-D7-breadth-depth.pen` | Depth for the **breadth** screens (P12–P14) — the variant surface their specs declare | `◐ node:UyQt9` — **121 variant cards** across all 16 breadth screens (~7–8 each: ceremony/guard states, Part-2 seal/break-glass, empty/loading/no-permission, stepper sub-steps, screen-specific states). Brings the 16 breadth screens to the same depth as the original 97. |

### Coverage diagnosis

Corpus completeness against the 40-module architecture (2026-06-24):
**100% by screen-count · ~16% by frame-depth (97 of ~600) · ~65% by module-breadth.**
Breadth gaps: M15 Discipline Care Plans (0 screens), M12/M24/M39 (no dedicated screen), and
~12 flagship modules compressed to 1 screen. The **depth track** (D1–D6) was built first; the
**breadth track** (P12–P14, below) then addressed the missing whole screens. M15 was closed by D5.

## Breadth track (P12–P14) — missing whole screens for thin modules

16 NEW top-level screens for modules that had no dedicated surface, grounded in each module spec
and deduped against the corpus + depth-track sub-views. Plan in
[`pencil-prompts/P12-P14-breadth.md`](./pencil-prompts/P12-P14-breadth.md). Corpus index now 113.

> **Breadth track COMPLETE (P12–P14): all 16 generated** across 3 `.pen` files. M12 DoseSpot, M24
> Medicaid, and M39 Consent now have dedicated screens; the thin flagships (M19/M20/M21/M26/M28/M40)
> each gained their missing surface. Combined: **113 top-level screens + 137 depth frames ≈ 250
> frames**. The corpus is now comprehensive across all 40 modules by breadth, and deep on the
> high-traffic surfaces. Remaining work is design review (`◐ → ●`) and frontend reconciliation.

| Screen | Module | Layout pattern | Pencil |
| :-- | :-- | :-- | :-- |
| [DoseSpot Prescriber Roster](./screens/clinical/WARDENX_UI_DOSESPOT_PRESCRIBER_ROSTER.md) | M12 | Admin Hierarchy Layout | `● node:kEXWg` (P12 .pen) |
| [Medication Refill Inbox](./screens/clinical/WARDENX_UI_MEDICATION_REFILL_INBOX.md) | M12 | Work Queue | `● node:L9tUSV` (P12 .pen) |
| [DoseSpot Transmit / Failure Queue](./screens/clinical/WARDENX_UI_DOSESPOT_TRANSMIT_QUEUE.md) | M12 | Status Board | `● node:Y4HEp` (P12 .pen) |
| [Consent Record Manager](./screens/compliance/WARDENX_UI_CONSENT_RECORD_MANAGER.md) | M39 | Stepper Workflow | `● node:aIMIx` (P12 .pen) |
| [Consent Recipients & DPOA Agents](./screens/compliance/WARDENX_UI_CONSENT_RECIPIENTS_DPOA.md) | M39 | Detail Page | `● node:XMaBy` (P12 .pen) |
| [Consent Expiration & Renewal](./screens/compliance/WARDENX_UI_CONSENT_EXPIRATION_RENEWAL.md) | M39 | Dashboard | `● node:jFySy` (P12 .pen) |
| [Medicaid R&B Arrangement Manager](./screens/revenue/WARDENX_UI_MEDICAID_RB_ARRANGEMENT.md) | M24 | Admin Hierarchy Layout | `● node:V8bGq` (P13 .pen) |
| [Medicaid Eligibility & MCO Routing](./screens/revenue/WARDENX_UI_MEDICAID_ELIGIBILITY_MCO.md) | M24 | Gated Action Flow | `● node:wtqs3` (P13 .pen) |
| [Medicaid Trading-Partner Credentials](./screens/revenue/WARDENX_UI_MEDICAID_TRADING_PARTNER_CREDS.md) | M24 | Admin Settings Layout | `● node:eIAe7` (P13 .pen) |
| [Medicaid Validation Override](./screens/revenue/WARDENX_UI_MEDICAID_VALIDATION_OVERRIDE.md) | M24 | Work Queue | `● node:HFIqN` (P13 .pen) |
| [Cap Year Close & Settlement](./screens/revenue/WARDENX_UI_CAP_SETTLEMENT.md) | M26 | Stepper Workflow | `● node:e7rV0x` (P13 .pen) |
| [On-Call Roster & Protocols](./screens/clinical/WARDENX_UI_ONCALL_ROSTER_PROTOCOLS.md) | M19 | Work Queue | `● node:V6ZmB` (P14 .pen) |
| [Field Staff Safety Incidents](./screens/clinical/WARDENX_UI_FIELD_SAFETY_INCIDENTS.md) | M20 | Work Queue | `● node:eI32Z` (P14 .pen) |
| [Supply & DME Inventory](./screens/clinical/WARDENX_UI_SUPPLY_DME_INVENTORY.md) | M21 | Work Queue | `● node:FkRoZ` (P14 .pen) |
| [FHIR Gateway & Client Management](./screens/admin/WARDENX_UI_FHIR_GATEWAY_CLIENTS.md) | M28 | Admin Settings Layout | `● node:x0R4jb` (P14 .pen) |
| [MDM Health Check & Sync](./screens/admin/WARDENX_UI_MDM_HEALTH_SYNC.md) | M40 | Status Board | `● node:I9nE3S` (P14 .pen) |

## How to generate a screen in Pencil

1. Open a WardenX `.pen` file in the Pencil editor (the MCP needs an open file).
2. Apply the Lantern design system once (see [`pencil-prompts/README.md`](./pencil-prompts/README.md)).
3. Run the screen's prompt from its phase batch in [`pencil-prompts/`](./pencil-prompts/) via the
   Pencil MCP (`mcp__pencil__batch_design`), generating the frames listed in its `Pencil Notes`.
4. Record the returned node id in this ledger (`⬚` → `node:<id>` / `◐` / `●`).
