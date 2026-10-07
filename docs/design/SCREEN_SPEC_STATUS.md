# WardenX — Screen-Spec Implementation Status (per spec)

> **Why this file exists (GAP-186).** `audit/ui-parity/UI_PARITY.md` reports documented specs and registered
> screens as two *counts* — UI specs are feature-named files with no shared key to a registered screen, so
> that report cannot say which spec is unbuilt. This table is the per-spec join: one row per spec in
> [`WARDENX_UI_COMPLETE_SCREEN_INDEX.md`](./WARDENX_UI_COMPLETE_SCREEN_INDEX.md), the registered screen set(s)
> that serve it, and — for every spec with no screen — the reason. A spec with no screen is roadmap, not a
> defect, but it must be *stated* here rather than left to look like an oversight.
>
> **Enforced by `bun run docs:ui`** ([`scripts/check-ui-screens.ts`](../../scripts/check-ui-screens.ts), check 4):
> every indexed spec has exactly one row; `status` is `built` / `partial` / `deferred`; `built` and `partial`
> rows cite at least one registered screen set (`<app>/<module-dir>`, as listed in
> `audit/ui-parity/ui-parity.json`); `deferred` rows carry a reason. Counts are intentionally not restated.
>
> **Status meanings.** `built` — every surface the spec describes is served by the cited screen set (a note
> names read-only limits). `partial` — part of the spec is served; the note says what is missing.
> `deferred` — no registered screen serves the spec.

| Spec | Status | Screen set(s) | Note |
|------|--------|---------------|------|
| `screens/admin/WARDENX_UI_AI_GOVERNANCE_CONSOLE.md` | built | `admin/32-ai-platform` | AI Safety Owner console (capabilities, kill switches, invocations, hallucinations, tokens, evaluations, drift) |
| `screens/admin/WARDENX_UI_AUDIT_LOG_VIEWER.md` | built | `web/04-audit` |  |
| `screens/admin/WARDENX_UI_CLINICAL_CONTENT_ADMIN.md` | deferred | — | No clinical-content (template / scale / order-set) authoring screen; M08/M09/M11 content is seeded and edited by migration. Backend: none beyond M9 licenses/policies (built under the assessments screen set). |
| `screens/admin/WARDENX_UI_FEATURE_FLAGS.md` | built | `admin/34-saas-platform` | Platform feature-flag console (the tenant-level view is deferred with Tenant Settings) |
| `screens/admin/WARDENX_UI_FHIR_GATEWAY_CLIENTS.md` | deferred | — | M28 has no web or admin screen set; client registration and monitoring are API/ops-only. |
| `screens/admin/WARDENX_UI_FHIR_INTEROP_API.md` | deferred | — | M28 has no web or admin screen set; the FHIR API is consumed by partners, not browsed. |
| `screens/admin/WARDENX_UI_INTEGRATION_MONITORING.md` | deferred | — | M29 has no screen set; interface health is read from the ops outbox console and logs. |
| `screens/admin/WARDENX_UI_MASTER_DATA_MDM.md` | built | `web/40-mdm` |  |
| `screens/admin/WARDENX_UI_MDM_HEALTH_SYNC.md` | partial | `web/40-mdm` | Sync-health panel lives inside the MDM console; no dedicated health screen. |
| `screens/admin/WARDENX_UI_ONBOARDING_WIZARD.md` | built | `web/34-saas` `admin/34-saas-platform` | Tenant-side wizard (web) and platform onboarding templates (admin) |
| `screens/admin/WARDENX_UI_ORG_PROVIDER_LOCATION_SETUP.md` | partial | `web/34-saas` `web/40-mdm` | Provider entity / location master data is edited in the MDM console; the dedicated setup screen is not built. |
| `screens/admin/WARDENX_UI_REFERRAL_SOURCE_CRM.md` | deferred | — | No CRM / community-liaison screen; M6 referrals carry the source channel only. |
| `screens/admin/WARDENX_UI_ROLES_PERMISSIONS.md` | built | `web/03-authorization` |  |
| `screens/admin/WARDENX_UI_STAFF_MANAGEMENT.md` | built | `web/02-identity` | staff-management screen |
| `screens/admin/WARDENX_UI_TENANT_SETTINGS.md` | partial | `web/34-saas` | Account / support-grant panes only; the full tenant-settings surface is not built. |
| `screens/admin/WARDENX_UI_TERMINOLOGY_ADMIN.md` | built | `web/38-terminology` |  |
| `screens/core/WARDENX_UI_AGENCY_COMMAND_CENTER.md` | partial | `web/33-reporting` | Role dashboards cover the same data; the cross-cutting command centre is not a separate screen. |
| `screens/core/WARDENX_UI_APP_SHELL_HOME.md` | built | `web/02-identity` `web/33-reporting` | Shell + role home |
| `screens/core/WARDENX_UI_AUTH.md` | built | `web/02-identity` |  |
| `screens/core/WARDENX_UI_GLOBAL_SEARCH_RESULTS.md` | built | `web/05-patient` | global search |
| `screens/core/WARDENX_UI_HELP_TRAINING.md` | deferred | — | No help / training centre; no backend module owns it. |
| `screens/core/WARDENX_UI_NOTIFICATIONS_TASKS.md` | built | `web/36-messaging` | notifications |
| `screens/core/WARDENX_UI_REPORTING_ANALYTICS.md` | built | `web/33-reporting` |  |
| `screens/core/WARDENX_UI_STAFF_MESSAGING.md` | built | `web/36-messaging` |  |
| `screens/core/WARDENX_UI_SYSTEM_UTILITY_PAGES.md` | built | `web/02-identity` | System pages are owned by the M1 shell (apps/web/src/shell/system-pages) |
| `screens/core/WARDENX_UI_USER_PROFILE_PREFERENCES.md` | partial | `web/32-ai-platform` `web/02-identity` | AI preferences and passkeys exist; profile + notification/vacation preferences are not a single screen. |
| `screens/clinical/WARDENX_UI_ADMISSIONS_REFERRAL_INTAKE.md` | built | `web/06-admission` |  |
| `screens/clinical/WARDENX_UI_ALLERGY_MANAGEMENT.md` | deferred | — | No allergy screen; allergies are shown on the patient chart only. |
| `screens/clinical/WARDENX_UI_BEREAVEMENT.md` | built | `web/16-bereavement` |  |
| `screens/clinical/WARDENX_UI_CARE_PLAN.md` | built | `web/07-care-plan` `web/15-discipline-care-plans` |  |
| `screens/clinical/WARDENX_UI_CLINICAL_ASSESSMENTS_SUITE.md` | built | `web/09-assessments` |  |
| `screens/clinical/WARDENX_UI_CLINICAL_COPILOT.md` | deferred | — | M32 copilot / semantic chart search has no clinician-facing screen (only compliance, opt-in, routing and preferences). |
| `screens/clinical/WARDENX_UI_DEATH_PRONOUNCEMENT.md` | built | `web/06-admission` | death-pronouncement |
| `screens/clinical/WARDENX_UI_DISCHARGE_REVOCATION_TRANSFER.md` | built | `web/06-admission` | discharge, transfer-in, readmit, discharge-cosign |
| `screens/clinical/WARDENX_UI_DOCLENS_EXTRACTION_REVIEW.md` | built | `web/22-documents` | review-queue, review-workspace |
| `screens/clinical/WARDENX_UI_DOCUMENT_MANAGEMENT.md` | built | `web/22-documents` |  |
| `screens/clinical/WARDENX_UI_ELECTION_CERTIFICATION.md` | built | `web/06-admission` | patient-election-cert |
| `screens/clinical/WARDENX_UI_ELIGIBILITY_WORKSHEET_CTI.md` | partial | `web/06-admission` | CTI is built under election/certification; the terminal-decline eligibility worksheet is not. |
| `screens/clinical/WARDENX_UI_ENCOUNTER_VISIT_DOCUMENTATION.md` | built | `web/08-encounters` |  |
| `screens/clinical/WARDENX_UI_EVV.md` | built | `web/18-evv` |  |
| `screens/clinical/WARDENX_UI_FIELD_SAFETY.md` | built | `web/20-field-safety` |  |
| `screens/clinical/WARDENX_UI_FIELD_SAFETY_INCIDENTS.md` | built | `web/20-field-safety` | incidents |
| `screens/clinical/WARDENX_UI_HOPE_ASSESSMENT.md` | built | `web/10-hope` |  |
| `screens/clinical/WARDENX_UI_HQRP_QUALITY.md` | built | `web/30-quality` |  |
| `screens/clinical/WARDENX_UI_IDG_MEETING.md` | built | `web/14-idg` |  |
| `screens/clinical/WARDENX_UI_IPU_BED_BOARD.md` | built | `web/37-ipu` |  |
| `screens/clinical/WARDENX_UI_MEDICATIONS_EMAR.md` | built | `web/12-dosespot` `web/13-emar` |  |
| `screens/clinical/WARDENX_UI_ONCALL_ROSTER_PROTOCOLS.md` | built | `web/19-oncall` |  |
| `screens/clinical/WARDENX_UI_ON_CALL_TRIAGE.md` | built | `web/19-oncall` |  |
| `screens/clinical/WARDENX_UI_ORDERS.md` | built | `web/11-orders` | plus the held lab-transmission recovery queue (`/orders/held-transmissions`, GAP-125) and, on the order detail, the refused-transmission reason + "Resend transmission" (F-182) |
| `screens/clinical/WARDENX_UI_PATIENT_CHART.md` | built | `web/05-patient` |  |
| `screens/clinical/WARDENX_UI_PATIENT_CLINICAL_TIMELINE.md` | built | `web/09-assessments` `web/10-hope` | patient timelines |
| `screens/clinical/WARDENX_UI_PATIENT_LIST_CENSUS.md` | built | `web/05-patient` |  |
| `screens/clinical/WARDENX_UI_SCHEDULING_VISIT_CALENDAR.md` | built | `web/17-scheduling` |  |
| `screens/clinical/WARDENX_UI_SUPPLIES_DME_COMFORT_KIT.md` | built | `web/21-supplies` |  |
| `screens/clinical/WARDENX_UI_SUPPLY_DME_INVENTORY.md` | built | `web/21-supplies` | par stock, items |
| `screens/clinical/WARDENX_UI_VOLUNTEER_MANAGEMENT.md` | built | `web/15-discipline-care-plans` | volunteer |
| `screens/clinical/WARDENX_UI_WOUND_CARE.md` | deferred | — | No wound-care screen; wound detail is a line item in the assessments suite. Spec promotes it to a longitudinal surface (M09/M08/M22 composed). |
| `screens/platform/WARDENX_UI_OPS_CONSOLE.md` | built | `admin/01-ops` | outbox console only; the broader ops surface is deferred |
| `screens/platform/WARDENX_UI_SUBSCRIPTION_BILLING.md` | built | `admin/35-subscription-billing` `web/35-subscription` |  |
| `screens/platform/WARDENX_UI_SUPPORT_IMPERSONATION_AUDIT.md` | built | `admin/34-saas-platform` | support-sessions |
| `screens/platform/WARDENX_UI_SYSTEM_HEALTH_DEGRADED_MODE.md` | deferred | — | No system-health / degraded-mode screen; the shell shows a maintenance page on 503 only. |
| `screens/portal/WARDENX_UI_PATIENT_FAMILY_PORTAL_DASHBOARD.md` | built | `portal/31-portal` |  |
| `screens/portal/WARDENX_UI_PORTAL_CARE_TEAM_MESSAGES.md` | built | `portal/31-portal` | messages |
| `screens/portal/WARDENX_UI_PORTAL_DOCUMENTS_CONSENTS.md` | built | `portal/31-portal` | documents |
| `screens/portal/WARDENX_UI_PORTAL_VISIT_SCHEDULE.md` | built | `portal/31-portal` | visits |
| `screens/portal/WARDENX_UI_TELEHEALTH_VISIT_ROOM.md` | built | `portal/31-portal` | telehealth |
| `screens/revenue/WARDENX_UI_CAP_MANAGEMENT.md` | built | `web/26-cap` | read views only (no cap write is wired in the SPA) |
| `screens/revenue/WARDENX_UI_CLAIMS_BILLING.md` | built | `web/23-billing-medicare` `web/24-billing-medicaid` |  |
| `screens/revenue/WARDENX_UI_COST_REPORT_WORKSPACE.md` | built | `web/27-cost-report` |  |
| `screens/revenue/WARDENX_UI_DENIALS_MANAGEMENT.md` | built | `web/25-remittance` | denials, appeals |
| `screens/revenue/WARDENX_UI_ELIGIBILITY_VERIFICATION.md` | built | `web/23-billing-medicare` `web/24-billing-medicaid` | eligibility |
| `screens/revenue/WARDENX_UI_PRIOR_AUTHORIZATION.md` | deferred | — | No prior-authorization screen; no M23/M24 route models an authorization. |
| `screens/revenue/WARDENX_UI_REMITTANCE_ERA_POSTING.md` | built | `web/25-remittance` | worklist |
| `screens/revenue/WARDENX_UI_NOE_NOTR_CLAIM_OPS.md` | built | `web/23-billing-medicare` `admin/23-billing-medicare` | noe, notr, transfer-notices; rate-schedule config = rate-tables + wage-indexes (GAP-125) + the platform CMS wage-index load (admin, `/admin/billing/wage-indexes/load`); no SIA-parameter config route exists to build on |
| `screens/revenue/WARDENX_UI_PATIENT_STATEMENTS_ASSISTANCE.md` | deferred | — | No patient-statement / financial-assistance screen; no route models patient responsibility statements. |
| `screens/revenue/WARDENX_UI_MEDICAID_RB_ARRANGEMENT.md` | built | `web/24-billing-medicaid` | rb-arrangements |
| `screens/revenue/WARDENX_UI_MEDICAID_ELIGIBILITY_MCO.md` | built | `web/24-billing-medicaid` | eligibility |
| `screens/revenue/WARDENX_UI_MEDICAID_TRADING_PARTNER_CREDS.md` | built | `web/24-billing-medicaid` | trading-partners |
| `screens/revenue/WARDENX_UI_MEDICAID_VALIDATION_OVERRIDE.md` | built | `web/24-billing-medicaid` | validation-worklist, overrides |
| `screens/revenue/WARDENX_UI_CAP_SETTLEMENT.md` | built | `web/26-cap` | settlement (read) |
| `screens/clinical/WARDENX_UI_CERTIFICATION_RECERT_LIFECYCLE.md` | built | `web/06-admission` | patient-election-cert |
| `screens/clinical/WARDENX_UI_CLINICAL_NOTE_LIFECYCLE.md` | built | `web/08-encounters` | compose, cosignature-queue, my-drafts |
| `screens/clinical/WARDENX_UI_EPCS_CONTROLLED_SUBSTANCES.md` | partial | `web/12-dosespot` | Prescribing, sign inbox and policy are built; the EPCS two-factor ceremony is gated on the DoseSpot vendor flow. |
| `screens/clinical/WARDENX_UI_FACILITY_SUPPLY_OPERATIONS.md` | partial | `web/21-supplies` `web/37-ipu` | IPU equipment and supply dispatch exist; the facility-wide composed operations view does not. |
| `screens/core/WARDENX_UI_ROLE_DASHBOARDS.md` | built | `web/33-reporting` | role-dashboard |
| `screens/platform/WARDENX_UI_WORKFLOW_EVENT_OPS.md` | partial | `admin/01-ops` | Outbox status and detail only; workflow-event replay is not a screen. |
| `screens/compliance/WARDENX_UI_HIPAA_PRIVACY_DISCLOSURE.md` | partial | `web/04-audit` `web/05-patient` | Audit exports and the patient privacy tab exist; the §164.528 accounting-of-disclosures workspace does not. |
| `screens/compliance/WARDENX_UI_BREACH_SECURITY_INCIDENTS.md` | deferred | — | No breach / security-incident screen; M4 audit holds the evidence and has no incident workflow. |
| `screens/compliance/WARDENX_UI_BAA_MANAGER.md` | built | `admin/34-saas-platform` | baa-register |
| `screens/compliance/WARDENX_UI_PATIENT_RIGHTS_GRIEVANCES.md` | deferred | — | No grievance screen; M30 models QAPI incidents and mortality, not patient-rights grievances. |
| `screens/compliance/WARDENX_UI_QAPI_INCIDENTS.md` | built | `web/30-quality` | qapi-incidents |
| `screens/compliance/WARDENX_UI_QUALITY_MEASURES_CHART_AUDIT.md` | partial | `web/30-quality` | Quality hub; the chart-audit worklist is not built. |
| `screens/compliance/WARDENX_UI_ACCREDITATION_SURVEY.md` | deferred | — | No accreditation / survey-readiness screen; surveyor read-only billing views exist but are a different surface. |
| `screens/compliance/WARDENX_UI_OIG_COMPLIANCE_PROGRAM.md` | deferred | — | No OIG compliance-program screen (exclusion screening, hotline, training attestations); no module owns the data. |
| `screens/staffing/WARDENX_UI_STAFF_CREDENTIALS_COMPLIANCE.md` | built | `web/17-scheduling` | clinician-credentials |
| `screens/staffing/WARDENX_UI_STAFF_SCHEDULING_CASELOAD.md` | built | `web/17-scheduling` |  |
| `screens/staffing/WARDENX_UI_TIMESHEETS_PAYROLL.md` | deferred | — | No timesheet / payroll screen; payroll export is out of scope of every shipped module. |
| `screens/mobile/WARDENX_UI_MOBILE_FIELD_SUITE.md` | deferred | — | No mobile app; the web SPA is responsive but there is no native/offline field client (M17/M18/M22 mobile surface). |
| `screens/integration/WARDENX_UI_HL7_INTERFACE_LOGS.md` | deferred | — | M29 has no screen set; interface logs are read from the database / ops tooling. |
| `screens/integration/WARDENX_UI_SUBMISSION_RESUBMISSION.md` | partial | `web/10-hope` | HOPE submission worklist and detail are built; the cross-feed M29 resubmission console is not. |
| `screens/portal/WARDENX_UI_EXTERNAL_PHYSICIAN_PORTAL.md` | deferred | — | No external-physician portal app; apps/portal serves patient/family only. |
| `screens/portal/WARDENX_UI_CONSULTING_PHYSICIAN_PORTAL.md` | deferred | — | No consulting-physician portal app. |
| `screens/portal/WARDENX_UI_REFERRAL_SOURCE_PORTAL.md` | deferred | — | No referral-source portal app. |
| `screens/portal/WARDENX_UI_FACILITY_NURSE_PORTAL.md` | deferred | — | No facility-nurse portal app. |
| `screens/portal/WARDENX_UI_DME_VENDOR_PORTAL.md` | deferred | — | No DME-vendor portal app. |
| `screens/portal/WARDENX_UI_SURVEYOR_ACCESS_PORTAL.md` | deferred | — | No surveyor portal app; M23/M24 expose surveyor read-only views inside the staff app. |
| `screens/clinical/WARDENX_UI_DOSESPOT_PRESCRIBER_ROSTER.md` | built | `web/12-dosespot` | prescriber-roster |
| `screens/clinical/WARDENX_UI_MEDICATION_REFILL_INBOX.md` | built | `web/12-dosespot` | refill-inbox |
| `screens/clinical/WARDENX_UI_DOSESPOT_TRANSMIT_QUEUE.md` | partial | `web/12-dosespot` | Sign inbox and refill inbox exist; the "Retry a transmission_failed order" action is the Retransmit button on the medication-order detail (GAP-125, mints a replacement order). There is no separate transmit-queue status board (no list-by-transmission-state read). |
| `screens/compliance/WARDENX_UI_CONSENT_RECORD_MANAGER.md` | built | `web/39-consent` |  |
| `screens/compliance/WARDENX_UI_CONSENT_RECIPIENTS_DPOA.md` | built | `web/39-consent` | recipients-dpoa |
| `screens/compliance/WARDENX_UI_CONSENT_EXPIRATION_RENEWAL.md` | built | `web/39-consent` |  |
