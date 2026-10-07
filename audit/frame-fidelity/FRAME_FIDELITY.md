# WardenX — Frame-Fidelity Report

> **Generated, advisory report** (`bun run frame:fidelity`). Tracks how much of the built
> web surface has been visually matched to its Pencil frame — the layout-fidelity gap the
> Lantern reconciliation left open. Do not hand-edit; edit the registry and regenerate.
> Process: `docs/design/FRAME_FIDELITY_PLAYBOOK.md`.

**Coverage:** 19 screen(s) mapped to frames · 120 frames in the design ledger.
**By status:** 🟢 3 matched · 🟡 14 partial · ⚪ 2 pending.

## Mapped screens

| Status | Screen | Module | Frame | `.pen` | Notes |
|:--|---|:--:|---|---|---|
| 🟡 partial | App Shell & Role Home | M01 | `node:AQAhY` | wardenx-P0-foundation.pen | Role-home launcher reconciled to Lantern (Fraunces headline, No-Line tiles on warm paper). Role-curated dashboard widgets (My Patients, AR snapshot, cosign queue) await their modules. |
| 🟢 matched | Authentication & Session — Sign in | M02 | `node:a1dbhD` | wardenx-P0-foundation.pen | Rebuilt to the frame's 'Card Sign in': gold hearth mark + Fraunces 'WardenX' lockup, Sign in title + subtitle, filled fields, full-width pill button, and a 'Forgot password? · Use a passkey' links row. Fully real — email/password + passkey both go through Better Auth; no placeholders. |
| 🟢 matched | Authentication & Session — Two-factor verification | M02 | `node:a1dbhD` | wardenx-P0-foundation.pen | Rebuilt to the frame's 'Card Two-factor verification' (same a1dbhD frame as Sign in): branded card, Fraunces title + subtitle, a segmented 6-digit mono OTP input (auto-advance + paste), full-width pill Verify. Fully real (TOTP + backup code via Better Auth). The frame's 'Resend code' link — which implies SMS/email OTP — is replaced by the functional backup-code toggle (our 2FA is authenticator/TOTP, which has no resend). |
| 🟡 partial | Care Plan | M07 | `node:UaKVf` | wardenx-P1-clinical.pen | Rebuilt to the frame's Patient Workspace: patient banner + module nav rail | a document-style 'Interdisciplinary care plan' card (every problem with its goals + interventions inline) | a right rail (IDG review + AI suggestion), over a sticky footer (IDG-quorum guard + actions). REAL: problems/goals/interventions, version+signers, patient banner. Honest substitutions — AI suggestion is a placeholder (M29 Clinical Copilot not built, no fabricated suggestion); no next-review date in the API (CoP note + signers shown instead); footer uses the real nav actions (Version history / summary / open draft) rather than the frame's unbuilt Save-draft / Submit-for-IDG write paths. |
| 🟡 partial | Clinical Assessments Suite | M09 | `node:aSIwN` | wardenx-P1-clinical.pen | Rebuilt to the frame's Patient Workspace: banner | scale list | selected scale's score + capture history | a right-rail score trend. REAL throughout (scales, per-capture total scores + interpretation, captured-at/by, cosign-needed, SUD/redacted, the trend bars computed from the real score series). Honest substitution — the timeline exposes each capture's TOTAL score, not the per-item breakdown the frame's symptom bars show, so the center shows the score + history rather than fabricating per-symptom values. |
| ⚪ pending | Death & Pronouncement | M06 | `node:f7o1r` | wardenx-P2-operational.pen | Built as a stepper workflow (Record death -> Review & sign -> Post-death cascade) in the same patient workspace frame as admission.discharge (chart banner, step navigator, flat sections, right rail); not yet matched region-by-region to the frame. The write is REAL (POST /admissions/:id/discharge, reason death) with the pronouncing physician and the place of death (claim patient status 40/41/42). Honest gaps: the frame's family-notification and body-release steps have no backing route, so they are stated as cascade, not drawn as fillable steps. |
| ⚪ pending | Discharge / Revocation / Transfer | M06 | `node:m8VaU` | wardenx-P2-operational.pen | Built as a stepper workflow (Reason -> Details -> Effective date -> Review -> Confirm) in the patient workspace on the 2026-09-25 redesign kit; not yet matched region-by-region to the frame. All writes are REAL (POST /admissions/:id/discharge | /revocation | /transfer-out). The rail's current benefit period is best-effort from election-certification. Transfer-out records whether the receiving hospice cares for the patient at home or in a facility (claim patient status 50/51), and a for-cause filing links to the cosign screen (admission.discharge-cosign, same workspace frame). Death is its own workflow (admission.death-pronouncement). |
| 🟡 partial | Encounter / Visit Documentation | M08 | `node:AohyV` | wardenx-P1-clinical.pen | Rebuilt to the frame's Patient Workspace: banner | visit-note document (note title + status, a vitals strip, a SUBJECTIVE/OBJECTIVE/ASSESSMENT/PLAN scaffold) | right rail (Sign-off + EVV/visit), over a sticky footer (cosign guard + actions). REAL: header (type/discipline/date/status/late-entry/version), cosignature state, signed/cosigned timestamps, patient banner, the four sign/cosign ceremonies (/sign, /cosignature/acknowledge, /cosignature/sign, /cosignature/supervisor-release — TASK-031, real step-up + 412/403 handling), and — since #92 — the vitals strip, bound to the real GET /encounters/:id/vitals (newest set, per-cell units, abnormal tone from the server's own flags; an em dash now means 'nobody recorded it', not 'the API can't say'). The note body is BOUND: since #114 the persisted HearthNote selections are read back assembled (GET /encounters/:id/selections) and the screen shows the assembled Layer-1 note — authored in the composer ('Compose note' / 'Edit note'), which replaced a single free-text box that could not satisfy the §2.6 Layer-3 gate — never a fabricated note. Vitals, mileage and care-plan links have their own save paths. Honest gap that remains: the EVV/visit join (M17/M18) isn't on the DTO. This note used to say Sign-note and the note body were unbuilt — they are not, and an external audit repeated that back as a release blocker (#107). |
| 🟡 partial | Feature Flags | M34 | `node:bxUqf` | wardenx-P4-admin-platform.pen | Added the frame's KPI strip (total / enabled / kill-switches / per-tenant, counted from the loaded flags) over the existing flags Work Queue — table (key · scope · kind · value · kill-switch state) + right detail panel + the §6/D10 confirm-by-typing kill-switch CeremonyModal. All real (GET /platform/feature-flags). Honest gaps: no separate count endpoint, so KPIs reflect the loaded page; the frame's per-row enable TOGGLES aren't replicated as a generic write (only the step-up-gated kill-switch is a real write path) — the kill-switch ceremony is kept instead. |
| 🟡 partial | Global Search Results | M01 · M33 | `node:Cp053` | wardenx-P0-foundation.pen | Rebuilt to the frame's centered results column: per-scope No-Line cards with avatar + name + meta + status + chevron rows that navigate to the record. Patient + staff scopes are REAL (RLS/caseload + member.manage scoped); documents/orders/visits/commands are honest 'available when <module> ships' rows. |
| 🟡 partial | HOPE Assessment | M10 | `node:KQ8kz` | wardenx-P1-clinical.pen | Rebuilt to the frame's Patient Workspace: banner | HOPE timepoint rail (real patient HOPE timeline) | the timepoint's section list + clinical-context snapshot | a right rail (validation & triggers + iQIES submission), over a sticky footer (submission guard + actions). REAL: timepoint rail, status/target/author/signed metadata, J2051 max-severity + SFV trigger, the D8 PPS/ESAS-r snapshot, and the validation findings. Honest gap: per-section completion isn't exposed (section data is opaque server-side except Section J/J2051), so the section list shows J2051 real and the rest 'completion not exposed —', never fabricated completeness. NB the frame maps to hope.assessment-detail (the section view), not the patient HOPE timeline. |
| 🟡 partial | IDG Meeting | M14 | `node:Wqf1e` | wardenx-P1-clinical.pen | Rebuilt to the frame's 3-pane meeting view: a meeting header (status + packets-ready + Live surface) over a packet list | the selected patient's review packet | a right rail (attendance/quorum + schedule). REAL: meeting lifecycle/schedule, the packet-readiness list + freeze state, packets-ready count. Honest gaps: the packets read carries patient + freeze state, NOT the packet content (as-presented summary / eligibility / recommendations live on the full packet, /packets/:patientId) — so the center is a section scaffold + Open full packet; and attendance/quorum isn't on these reads (it's on the live meeting surface), so that rail is an honest placeholder. |
| 🟡 partial | Medications — Prescribing & eMAR | M13 | `node:ANbhv` | wardenx-P1-clinical.pen | Rebuilt to the frame's MAR Grid: Patient Workspace (banner + module rail) | the Medication Administration Record grid (rows = medication orders, columns = dose times, cells = the dose's §2.2 status, selectable) + a recent-administrations strip | a right 'Administer' rail (five-rights scaffold). REAL: scheduled-dose grid + administration history + late-entry/controlled/RN-review pills, and — since the eMAR write waves — the administration WRITE paths: 'Record administration' opens the real AdministerModal (single-dose / PRN / hold, witness attestation, IV segments, send-to-prescriber) over the server's §2.9 gates and step-up. This note used to call that button an inert scaffold; it is not. Honest gap that remains: dose rows carry the medication ORDER id, not the drug/dose text the frame shows (no fabricated drug name). |
| 🟡 partial | Notifications & Tasks | M01 · M36 | `node:mK4co` | wardenx-P0-foundation.pen | Rebuilt to the frame: Fraunces title, Notifications/Tasks/Mentions pill tabs + an inline stats strip, and a §6.2 No-Line card of rows (severity glyph + summary + source chip + status pill + relative time). The Notifications tab is the REAL alert inbox (GET /api/v1/alerts/inbox) with live Unread/Urgent/Failed stats; Tasks & Mentions are honest placeholders (Tasks/worklist module). |
| 🟡 partial | Orders | M11 | `node:pQiC0` | wardenx-P1-clinical.pen | Rebuilt to the frame's Patient Workspace: banner + module rail | orders table (kind · priority · status · live 48h verbal countdown, row-select) | right rail with the selected order's detail + Open order. All real (M11 order lifecycle data + CountdownChip on the real verbal deadline). Honest gap: the list carries the order KIND, not the clinical order text (drug/dose) the frame shows — that lives on /orders/:id — so rows label by kind, never a fabricated drug name. |
| 🟡 partial | Patient Chart | M05 | `node:fQjjh` | wardenx-P0-foundation.pen | Banner (avatar + Fraunces name + DOB·age meta + MRN/status chips + Message action), icon nav rail, and Summary card composition + right Alerts/Tasks rail all match the frame. The care-plan (problems) and admission/election (benefit-period) cards are bound to the real M7/M6 reads (usePatientChartData). A card whose module has no patient surface yet renders an honest empty note rather than fabricated content. |
| 🟡 partial | Patient List / Census | M05 | `node:DNqXm` | wardenx-P0-foundation.pen | Header (title + Admit action), KPI strip, work table, and right detail panel match the frame. Census KPI is the REAL active count (GET /patients/census-metrics); Admissions/Discharges/GIP/Recerts KPIs are honest '—' placeholders noting their owning module (M6 / billing). |
| 🟡 partial | Staff Messaging | M36 | `node:A016Y` | wardenx-P0-foundation.pen | Rebuilt to the frame's Conversation View: a 'Messages' list (avatar + title + scope + unread dot, active row indigo-tinted) | a thread of chat bubbles (mine right/indigo via the real session user id, others left/paper) under a patient-scoped chip header, over a rounded composer. All real M36 data; the list's last-message preview/time isn't exposed by the channels read yet, so the secondary line shows the channel's real scope instead. |
| 🟢 matched | System / Utility Pages | M01 | `node:dT1Bt` | wardenx-P0-foundation.pen | All 7 chromeless states (404/403/500/offline/maintenance/session-expired/suspended) render the System Page pattern matched to the frame: a circular tonal icon badge holding a Lantern inline-SVG Glyph (replacing the old emoji — §10.10), Fraunces headline, muted explanation, forward action, mono correlation id. CenteredStatusLayout enhanced to draw the badge. |

## Frames with no registry row

102 frame(s) are not yet mapped to a built screen: **25 deferred** (the spec has no screen — see `docs/design/SCREEN_SPEC_STATUS.md`), **7 design-library** frame(s) (shared variant/state/ceremony libraries, not one screen's composition) and **70 unmatched** (a screen set serves the spec; its composition has not been compared to the frame — this is NOT a fidelity claim).

| Disposition | Frame | Spec | Detail |
|:--|---|---|---|
| ◻ unmatched | `node:B1Wukv` | `screens/revenue/WARDENX_UI_CAP_MANAGEMENT.md` | built · `web/26-cap` |
| ◻ unmatched | `node:C0ljC` | `screens/platform/WARDENX_UI_SUBSCRIPTION_BILLING.md` | built · `admin/35-subscription-billing` `web/35-subscription` |
| 📚 library | `node:CUzYC` | `(design library)` | wardenx-D3-states.pen — Universal empty / loading / error / no-perm / degraded |
| ⏸ deferred | `node:CsLJv` | `screens/admin/WARDENX_UI_INTEGRATION_MONITORING.md` | M29 has no screen set; interface health is read from the ops outbox console and logs. |
| ⏸ deferred | `node:CzFUq` | `screens/portal/WARDENX_UI_FACILITY_NURSE_PORTAL.md` | No facility-nurse portal app. |
| 📚 library | `node:E0REv` | `(design library)` | wardenx-D6-subviews.pen — Heavyweight screens' secondary tabs / panels |
| ⏸ deferred | `node:ERZ5p` | `screens/staffing/WARDENX_UI_TIMESHEETS_PAYROLL.md` | No timesheet / payroll screen; payroll export is out of scope of every shipped module. |
| ◻ unmatched | `node:FkRoZ` | `screens/clinical/WARDENX_UI_SUPPLY_DME_INVENTORY.md` | built · `web/21-supplies` |
| ⏸ deferred | `node:GQMdF` | `screens/compliance/WARDENX_UI_PATIENT_RIGHTS_GRIEVANCES.md` | No grievance screen; M30 models QAPI incidents and mortality, not patient-rights grievances. |
| 📚 library | `node:GyRUU` | `(design library)` | wardenx-D1-ceremonies.pen — Guardrail & signing-ceremony library |
| ◻ unmatched | `node:H3JUcW` | `screens/core/WARDENX_UI_REPORTING_ANALYTICS.md` | built · `web/33-reporting` |
| ◻ unmatched | `node:H6PP83` | `screens/clinical/WARDENX_UI_ON_CALL_TRIAGE.md` | built · `web/19-oncall` |
| ◻ unmatched | `node:HFIqN` | `screens/revenue/WARDENX_UI_MEDICAID_VALIDATION_OVERRIDE.md` | built · `web/24-billing-medicaid` |
| ⏸ deferred | `node:HIRCS` | `screens/portal/WARDENX_UI_EXTERNAL_PHYSICIAN_PORTAL.md` | No external-physician portal app; apps/portal serves patient/family only. |
| ◻ unmatched | `node:I9nE3S` | `screens/admin/WARDENX_UI_MDM_HEALTH_SYNC.md` | partial · `web/40-mdm` |
| ⏸ deferred | `node:JvkW0` | `screens/revenue/WARDENX_UI_PATIENT_STATEMENTS_ASSISTANCE.md` | No patient-statement / financial-assistance screen; no route models patient responsibility statements. |
| ◻ unmatched | `node:KfY70` | `screens/clinical/WARDENX_UI_PATIENT_CLINICAL_TIMELINE.md` | built · `web/09-assessments` `web/10-hope` |
| ◻ unmatched | `node:KpBpz` | `screens/core/WARDENX_UI_ROLE_DASHBOARDS.md` | built · `web/33-reporting` |
| ⏸ deferred | `node:L9t1M` | `screens/admin/WARDENX_UI_REFERRAL_SOURCE_CRM.md` | No CRM / community-liaison screen; M6 referrals carry the source channel only. |
| ◻ unmatched | `node:L9tUSV` | `screens/clinical/WARDENX_UI_MEDICATION_REFILL_INBOX.md` | built · `web/12-dosespot` |
| ⏸ deferred | `node:LISN8` | `screens/portal/WARDENX_UI_SURVEYOR_ACCESS_PORTAL.md` | No surveyor portal app; M23/M24 expose surveyor read-only views inside the staff app. |
| ◻ unmatched | `node:LRfYv` | `screens/core/WARDENX_UI_AGENCY_COMMAND_CENTER.md` | partial · `web/33-reporting` |
| ◻ unmatched | `node:LXxxD` | `screens/clinical/WARDENX_UI_ELECTION_CERTIFICATION.md` | built · `web/06-admission` |
| ◻ unmatched | `node:LcUWy` | `screens/admin/WARDENX_UI_TENANT_SETTINGS.md` | partial · `web/34-saas` |
| ◻ unmatched | `node:MZZY2` | `screens/admin/WARDENX_UI_ORG_PROVIDER_LOCATION_SETUP.md` | partial · `web/34-saas` `web/40-mdm` |
| ◻ unmatched | `node:NRM8F` | `screens/portal/WARDENX_UI_TELEHEALTH_VISIT_ROOM.md` | built · `portal/31-portal` |
| ◻ unmatched | `node:R1Qzuj` | `screens/portal/WARDENX_UI_PORTAL_VISIT_SCHEDULE.md` | built · `portal/31-portal` |
| ⏸ deferred | `node:RCdgT` | `screens/revenue/WARDENX_UI_PRIOR_AUTHORIZATION.md` | No prior-authorization screen; no M23/M24 route models an authorization. |
| ◻ unmatched | `node:RSFHC` | `screens/revenue/WARDENX_UI_CLAIMS_BILLING.md` | built · `web/23-billing-medicare` `web/24-billing-medicaid` |
| ◻ unmatched | `node:SCV56` | `screens/clinical/WARDENX_UI_DOCLENS_EXTRACTION_REVIEW.md` | built · `web/22-documents` |
| ⏸ deferred | `node:SHZre` | `screens/compliance/WARDENX_UI_ACCREDITATION_SURVEY.md` | No accreditation / survey-readiness screen; surveyor read-only billing views exist but are a different surface. |
| 📚 library | `node:T2caK` | `(design library)` | wardenx-D5-variants.pen — Role dashboards · discipline care plans · assessments |
| ⏸ deferred | `node:T6KHo` | `screens/clinical/WARDENX_UI_WOUND_CARE.md` | No wound-care screen; wound detail is a line item in the assessments suite. Spec promotes it to a longitudinal surface (M09/M08/M22 composed). |
| ⏸ deferred | `node:TFdIR` | `screens/clinical/WARDENX_UI_ALLERGY_MANAGEMENT.md` | No allergy screen; allergies are shown on the patient chart only. |
| ◻ unmatched | `node:U01CF` | `screens/admin/WARDENX_UI_ONBOARDING_WIZARD.md` | built · `web/34-saas` `admin/34-saas-platform` |
| ◻ unmatched | `node:URHlL` | `screens/clinical/WARDENX_UI_CERTIFICATION_RECERT_LIFECYCLE.md` | built · `web/06-admission` |
| 📚 library | `node:UyQt9` | `(design library)` | wardenx-D7-breadth-depth.pen — Depth for the **breadth** screens (P12–P14) — the variant surface their specs declare |
| ◻ unmatched | `node:V6ZmB` | `screens/clinical/WARDENX_UI_ONCALL_ROSTER_PROTOCOLS.md` | built · `web/19-oncall` |
| ◻ unmatched | `node:V8bGq` | `screens/revenue/WARDENX_UI_MEDICAID_RB_ARRANGEMENT.md` | built · `web/24-billing-medicaid` |
| ◻ unmatched | `node:WGWP7` | `screens/platform/WARDENX_UI_OPS_CONSOLE.md` | built · `admin/01-ops` |
| ◻ unmatched | `node:WYFsN` | `screens/clinical/WARDENX_UI_SUPPLIES_DME_COMFORT_KIT.md` | built · `web/21-supplies` |
| ◻ unmatched | `node:XMaBy` | `screens/compliance/WARDENX_UI_CONSENT_RECIPIENTS_DPOA.md` | built · `web/39-consent` |
| ◻ unmatched | `node:Xnsde` | `screens/platform/WARDENX_UI_WORKFLOW_EVENT_OPS.md` | partial · `admin/01-ops` |
| ◻ unmatched | `node:XySvp` | `screens/staffing/WARDENX_UI_STAFF_SCHEDULING_CASELOAD.md` | built · `web/17-scheduling` |
| ◻ unmatched | `node:Y1ubGH` | `screens/compliance/WARDENX_UI_BAA_MANAGER.md` | built · `admin/34-saas-platform` |
| ◻ unmatched | `node:Y4HEp` | `screens/clinical/WARDENX_UI_DOSESPOT_TRANSMIT_QUEUE.md` | partial · `web/12-dosespot` |
| 📚 library | `node:ZgXYC` | `(design library)` | wardenx-D4-steppers.pen — Multi-step workflows — all steps |
| ◻ unmatched | `node:aIMIx` | `screens/compliance/WARDENX_UI_CONSENT_RECORD_MANAGER.md` | built · `web/39-consent` |
| ⏸ deferred | `node:c0Ibms` | `screens/admin/WARDENX_UI_FHIR_INTEROP_API.md` | M28 has no web or admin screen set; the FHIR API is consumed by partners, not browsed. |
| ⏸ deferred | `node:c5WGQ9` | `screens/compliance/WARDENX_UI_BREACH_SECURITY_INCIDENTS.md` | No breach / security-incident screen; M4 audit holds the evidence and has no incident workflow. |
| ⏸ deferred | `node:c96zD` | `screens/clinical/WARDENX_UI_CLINICAL_COPILOT.md` | M32 copilot / semantic chart search has no clinician-facing screen (only compliance, opt-in, routing and preferences). |
| ⏸ deferred | `node:cFG0u` | `screens/platform/WARDENX_UI_SYSTEM_HEALTH_DEGRADED_MODE.md` | No system-health / degraded-mode screen; the shell shows a maintenance page on 503 only. |
| ◻ unmatched | `node:cFmyk` | `screens/clinical/WARDENX_UI_HQRP_QUALITY.md` | built · `web/30-quality` |
| ◻ unmatched | `node:d9ZJU` | `screens/clinical/WARDENX_UI_ADMISSIONS_REFERRAL_INTAKE.md` | built · `web/06-admission` |
| ⏸ deferred | `node:dFRJ9` | `screens/integration/WARDENX_UI_HL7_INTERFACE_LOGS.md` | M29 has no screen set; interface logs are read from the database / ops tooling. |
| ◻ unmatched | `node:e7rV0x` | `screens/revenue/WARDENX_UI_CAP_SETTLEMENT.md` | built · `web/26-cap` |
| ◻ unmatched | `node:eI32Z` | `screens/clinical/WARDENX_UI_FIELD_SAFETY_INCIDENTS.md` | built · `web/20-field-safety` |
| ◻ unmatched | `node:eIAe7` | `screens/revenue/WARDENX_UI_MEDICAID_TRADING_PARTNER_CREDS.md` | built · `web/24-billing-medicaid` |
| ◻ unmatched | `node:eeoJ4` | `screens/revenue/WARDENX_UI_REMITTANCE_ERA_POSTING.md` | built · `web/25-remittance` |
| ◻ unmatched | `node:ejsox` | `screens/admin/WARDENX_UI_AI_GOVERNANCE_CONSOLE.md` | built · `admin/32-ai-platform` |
| ◻ unmatched | `node:eq20w` | `screens/revenue/WARDENX_UI_NOE_NOTR_CLAIM_OPS.md` | built · `web/23-billing-medicare` `admin/23-billing-medicare` |
| ◻ unmatched | `node:fGKwq` | `screens/core/WARDENX_UI_USER_PROFILE_PREFERENCES.md` | partial · `web/32-ai-platform` `web/02-identity` |
| ◻ unmatched | `node:fRVXt` | `screens/revenue/WARDENX_UI_ELIGIBILITY_VERIFICATION.md` | built · `web/23-billing-medicare` `web/24-billing-medicaid` |
| ◻ unmatched | `node:g7sGoJ` | `screens/admin/WARDENX_UI_STAFF_MANAGEMENT.md` | built · `web/02-identity` |
| ⏸ deferred | `node:gOyIA` | `screens/compliance/WARDENX_UI_OIG_COMPLIANCE_PROGRAM.md` | No OIG compliance-program screen (exclusion screening, hotline, training attestations); no module owns the data. |
| ◻ unmatched | `node:hyJ3j` | `screens/clinical/WARDENX_UI_BEREAVEMENT.md` | built · `web/16-bereavement` |
| ◻ unmatched | `node:j3z3U` | `screens/platform/WARDENX_UI_SUPPORT_IMPERSONATION_AUDIT.md` | built · `admin/34-saas-platform` |
| ◻ unmatched | `node:jFySy` | `screens/compliance/WARDENX_UI_CONSENT_EXPIRATION_RENEWAL.md` | built · `web/39-consent` |
| ◻ unmatched | `node:jbNOR` | `screens/compliance/WARDENX_UI_QUALITY_MEASURES_CHART_AUDIT.md` | partial · `web/30-quality` |
| ◻ unmatched | `node:k7H99` | `screens/compliance/WARDENX_UI_QAPI_INCIDENTS.md` | built · `web/30-quality` |
| ◻ unmatched | `node:kEXWg` | `screens/clinical/WARDENX_UI_DOSESPOT_PRESCRIBER_ROSTER.md` | built · `web/12-dosespot` |
| ◻ unmatched | `node:l00Umf` | `screens/revenue/WARDENX_UI_DENIALS_MANAGEMENT.md` | built · `web/25-remittance` |
| ◻ unmatched | `node:lZPbZ` | `screens/clinical/WARDENX_UI_ELIGIBILITY_WORKSHEET_CTI.md` | partial · `web/06-admission` |
| ◻ unmatched | `node:lbY0m` | `screens/clinical/WARDENX_UI_FACILITY_SUPPLY_OPERATIONS.md` | partial · `web/21-supplies` `web/37-ipu` |
| ◻ unmatched | `node:ltVaw` | `screens/portal/WARDENX_UI_PATIENT_FAMILY_PORTAL_DASHBOARD.md` | built · `portal/31-portal` |
| ⏸ deferred | `node:lynRU` | `screens/mobile/WARDENX_UI_MOBILE_FIELD_SUITE.md` | No mobile app; the web SPA is responsive but there is no native/offline field client (M17/M18/M22 mobile surface). |
| ◻ unmatched | `node:m0wtL7` | `screens/staffing/WARDENX_UI_STAFF_CREDENTIALS_COMPLIANCE.md` | built · `web/17-scheduling` |
| ◻ unmatched | `node:m1prt` | `screens/clinical/WARDENX_UI_IPU_BED_BOARD.md` | built · `web/37-ipu` |
| ⏸ deferred | `node:m23Lw` | `screens/portal/WARDENX_UI_REFERRAL_SOURCE_PORTAL.md` | No referral-source portal app. |
| ◻ unmatched | `node:m6Iqp` | `screens/integration/WARDENX_UI_SUBMISSION_RESUBMISSION.md` | partial · `web/10-hope` |
| ◻ unmatched | `node:mrj17` | `screens/admin/WARDENX_UI_MASTER_DATA_MDM.md` | built · `web/40-mdm` |
| ⏸ deferred | `node:nNKhB` | `screens/core/WARDENX_UI_HELP_TRAINING.md` | No help / training centre; no backend module owns it. |
| ◻ unmatched | `node:nPnkV` | `screens/compliance/WARDENX_UI_HIPAA_PRIVACY_DISCLOSURE.md` | partial · `web/04-audit` `web/05-patient` |
| ⏸ deferred | `node:nxzBw` | `screens/admin/WARDENX_UI_CLINICAL_CONTENT_ADMIN.md` | No clinical-content (template / scale / order-set) authoring screen; M08/M09/M11 content is seeded and edited by migration. Backend: none beyond M9 licenses/policies (built under the assessments screen set). |
| ◻ unmatched | `node:o18aS` | `screens/admin/WARDENX_UI_AUDIT_LOG_VIEWER.md` | built · `web/04-audit` |
| ◻ unmatched | `node:ogmWK` | `screens/revenue/WARDENX_UI_COST_REPORT_WORKSPACE.md` | built · `web/27-cost-report` |
| ◻ unmatched | `node:p4tXCO` | `screens/clinical/WARDENX_UI_VOLUNTEER_MANAGEMENT.md` | built · `web/15-discipline-care-plans` |
| ◻ unmatched | `node:plO9v` | `screens/clinical/WARDENX_UI_DOCUMENT_MANAGEMENT.md` | built · `web/22-documents` |
| ◻ unmatched | `node:q5UDi` | `screens/admin/WARDENX_UI_ROLES_PERMISSIONS.md` | built · `web/03-authorization` |
| ◻ unmatched | `node:qOmAz` | `screens/clinical/WARDENX_UI_FIELD_SAFETY.md` | built · `web/20-field-safety` |
| ◻ unmatched | `node:r6axh` | `screens/admin/WARDENX_UI_TERMINOLOGY_ADMIN.md` | built · `web/38-terminology` |
| ⏸ deferred | `node:r7RLV` | `screens/portal/WARDENX_UI_DME_VENDOR_PORTAL.md` | No DME-vendor portal app. |
| ◻ unmatched | `node:seR8n` | `screens/clinical/WARDENX_UI_EPCS_CONTROLLED_SUBSTANCES.md` | partial · `web/12-dosespot` |
| ◻ unmatched | `node:tCfQ6` | `screens/portal/WARDENX_UI_PORTAL_DOCUMENTS_CONSENTS.md` | built · `portal/31-portal` |
| ◻ unmatched | `node:v72Yj` | `screens/clinical/WARDENX_UI_CLINICAL_NOTE_LIFECYCLE.md` | built · `web/08-encounters` |
| ◻ unmatched | `node:vw0AC` | `screens/clinical/WARDENX_UI_EVV.md` | built · `web/18-evv` |
| 📚 library | `node:wMcvc` | `(design library)` | wardenx-D2-sensitivity.pen — PHI masking / SUD-Part2 / consent / break-glass |
| ◻ unmatched | `node:wtqs3` | `screens/revenue/WARDENX_UI_MEDICAID_ELIGIBILITY_MCO.md` | built · `web/24-billing-medicaid` |
| ⏸ deferred | `node:x0R4jb` | `screens/admin/WARDENX_UI_FHIR_GATEWAY_CLIENTS.md` | M28 has no web or admin screen set; client registration and monitoring are API/ops-only. |
| ◻ unmatched | `node:xeeXk` | `screens/clinical/WARDENX_UI_SCHEDULING_VISIT_CALENDAR.md` | built · `web/17-scheduling` |
| ◻ unmatched | `node:y8N8k` | `screens/portal/WARDENX_UI_PORTAL_CARE_TEAM_MESSAGES.md` | built · `portal/31-portal` |
| ⏸ deferred | `node:z58Qbh` | `screens/portal/WARDENX_UI_CONSULTING_PHYSICIAN_PORTAL.md` | No consulting-physician portal app. |

## Hard-fail consistency checks

- ✅ Every mapped frame node exists in SCREENS.md, no duplicate screen mappings, every screen id resolves, every unmapped frame joins to a spec status row.
