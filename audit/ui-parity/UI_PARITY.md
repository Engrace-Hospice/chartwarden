# WardenX — UI Implementation-Parity Report

> **Generated, advisory report** (`bun run ui:parity`). `docs:ui` proves the screen-spec
> corpus is consistent; this shows how much of it is BUILT across all three SPAs
> (`apps/web`, `apps/portal`, `apps/admin`). Do not hand-edit — the `ui:parity --check`
> gate (in `arch:fitness`) keeps it in sync with source.

**Coverage:** 113 documented screen specs · 41 module screen-sets registered · 301 screens wired across web/portal/admin.
- **admin**: 34 screen(s)
- **portal**: 13 screen(s)
- **web**: 254 screen(s)

> The documented vs implemented counts are a deliberate gap *summary*, not a per-screen join: UI specs are feature-named docs with no shared key to a registered screen, and screen `path`s are frontend routes (not API paths). The per-screen table below is the precise, checkable surface.

## Documented surface (by category)

- **admin**: 16 spec(s)
- **clinical**: 39 spec(s)
- **compliance**: 11 spec(s)
- **core**: 11 spec(s)
- **integration**: 2 spec(s)
- **mobile**: 1 spec(s)
- **platform**: 5 spec(s)
- **portal**: 11 spec(s)
- **revenue**: 14 spec(s)
- **staffing**: 3 spec(s)

## Implemented surface (registered screens)

| App | Module | Screen id | Route path | Required permission | Permission resolves |
|---|---|---|---|---|:--:|
| web | 02-identity | `identity.sign-in` | `/login` | `(none)` | ✅ |
| web | 02-identity | `identity.mfa-challenge` | `/login/2fa` | `(none)` | ✅ |
| web | 02-identity | `identity.forgot-password` | `/forgot` | `(none)` | ✅ |
| web | 02-identity | `identity.reset-password` | `/reset-password` | `(none)` | ✅ |
| web | 02-identity | `identity.step-up` | `/step-up` | `(none)` | ✅ |
| web | 02-identity | `identity.organization-select` | `/login/organization` | `(none)` | ✅ |
| web | 02-identity | `identity.accept-invitation` | `/invite/:token` | `(none)` | ✅ |
| web | 02-identity | `identity.security-passkeys` | `/security/passkeys` | `(none)` | ✅ |
| web | 02-identity | `identity.staff-management` | `/admin/staff` | `member.manage` | ✅ |
| web | 03-authorization | `authz.roles-permissions` | `/roles` | `role.read` | ✅ |
| web | 04-audit | `audit.log-viewer` | `/audit` | `audit.read` | ✅ |
| web | 04-audit | `audit.legal-holds` | `/compliance/legal-holds` | `legalhold.read` | ✅ |
| web | 04-audit | `audit.integrity-report` | `/compliance/audit/integrity` | `audit.integrity` | ✅ |
| web | 04-audit | `audit.exports` | `/compliance/audit/exports` | `audit.export` | ✅ |
| web | 05-patient | `patient.census` | `/patients` | `patient.read` | ✅ |
| web | 05-patient | `search.global` | `/search` | `patient.read` | ✅ |
| web | 05-patient | `patient.chart` | `/patients/:id` | `patient.read` | ✅ |
| web | 06-admission | `admission.referrals` | `/referrals` | `referral.read` | ✅ |
| web | 06-admission | `admission.referral-new` | `/referrals/new` | `referral.create` | ✅ |
| web | 06-admission | `admission.census` | `/admissions` | `admission.read` | ✅ |
| web | 06-admission | `admission.compliance` | `/compliance/admissions` | `compliance.read` | ✅ |
| web | 06-admission | `admission.detail` | `/admissions/:id` | `admission.read` | ✅ |
| web | 06-admission | `admission.referral-detail` | `/referrals/:id` | `referral.read` | ✅ |
| web | 06-admission | `admission.create` | `/admissions/new` | `admission.create` | ✅ |
| web | 06-admission | `admission.patient-election-cert` | `/patients/:patientId/election-certification` | `election.read` | ✅ |
| web | 07-care-plan | `care-plan.view` | `/patients/:patientId/care-plan` | `care_plan.read` | ✅ |
| web | 07-care-plan | `care-plan.versions` | `/care-plans/:planId/versions` | `care_plan.read` | ✅ |
| web | 07-care-plan | `care-plan.version-detail` | `/care-plans/:planId/versions/:versionId` | `care_plan.read` | ✅ |
| web | 07-care-plan | `care-plan.summary` | `/care-plans/:planId/summary` | `care_plan.read_summary` | ✅ |
| web | 08-encounters | `encounter.patient-list` | `/patients/:patientId/encounters` | `encounter.read` | ✅ |
| web | 08-encounters | `encounter.read` | `/patients/:patientId/encounters/:encounterId` | `encounter.read` | ✅ |
| web | 08-encounters | `encounter.compose` | `/patients/:patientId/encounters/:encounterId/compose` | `encounter.author` | ✅ |
| web | 08-encounters | `encounter.cosignature-queue` | `/work/cosignatures` | `encounter.cosign` | ✅ |
| web | 08-encounters | `encounter.my-drafts` | `/work/drafts` | `encounter.author` | ✅ |
| web | 09-assessments | `assessment.timeline` | `/patients/:patientId/assessments` | `assessment.read` | ✅ |
| web | 09-assessments | `assessment.scale-trend` | `/patients/:patientId/scales/:scaleType` | `assessment.read_trend` | ✅ |
| web | 09-assessments | `assessment.changes` | `/patients/:patientId/assessments/changes` | `assessment.read` | ✅ |
| web | 09-assessments | `assessment.summary` | `/patients/:patientId/assessments/summary` | `assessment.read_summary` | ✅ |
| web | 09-assessments | `assessment.scale-licenses` | `/admin/scales/licenses` | `assessment.license_read` | ✅ |
| web | 09-assessments | `assessment.scale-policies` | `/admin/scales/policies` | `assessment.policy_read` | ✅ |
| web | 10-hope | `hope.dashboard` | `/hope` | `hope.schedule.read` | ✅ |
| web | 10-hope | `hope.admission-overview` | `/admissions/:admissionId/hope` | `hope.timepoint.read` | ✅ |
| web | 10-hope | `hope.timepoint-capture` | `/admissions/:admissionId/hope/timepoints/:kind` | `hope.timepoint.write` | ✅ |
| web | 10-hope | `hope.sfv-capture` | `/admissions/:admissionId/hope/sfv/:sfvId` | `hope.timepoint.write` | ✅ |
| web | 10-hope | `hope.patient-timeline` | `/patients/:patientId/hope` | `hope.timepoint.read` | ✅ |
| web | 10-hope | `hope.sfv-worklist` | `/hope/sfv` | `hope.sfv.read` | ✅ |
| web | 10-hope | `hope.assessment-detail` | `/hope/assessments/:id` | `hope.timepoint.read` | ✅ |
| web | 10-hope | `hope.submission-worklist` | `/hope/submissions` | `hope.submission.read` | ✅ |
| web | 10-hope | `hope.submission-detail` | `/hope/submissions/:id` | `hope.submission.read` | ✅ |
| web | 10-hope | `hope.compliance` | `/hope/compliance` | `hope.dashboard.read` | ✅ |
| web | 11-orders | `orders.sign-inbox` | `/orders` | `orders.read` | ✅ |
| web | 11-orders | `orders.patient-list` | `/patients/:patientId/orders` | `orders.read` | ✅ |
| web | 11-orders | `orders.detail` | `/orders/:id` | `orders.read` | ✅ |
| web | 11-orders | `orders.verbal-expiring` | `/orders/verbal-expiring` | `orders.read` | ✅ |
| web | 11-orders | `orders.cosign-pending` | `/orders/cosign-pending` | `orders.read` | ✅ |
| web | 11-orders | `orders.results-review` | `/orders/results-pending-review` | `orders.read` | ✅ |
| web | 11-orders | `orders.standing` | `/standing-orders` | `orders.read` | ✅ |
| web | 12-dosespot | `prescribing.patient-medications` | `/patients/:patientId/medications` | `prescribing.read` | ✅ |
| web | 12-dosespot | `prescribing.new-medication` | `/patients/:patientId/medications/new` | `prescribing.draft` | ✅ |
| web | 12-dosespot | `prescribing.edit-medication-draft` | `/medication-orders/:id/edit` | `prescribing.draft` | ✅ |
| web | 12-dosespot | `prescribing.medication-detail` | `/medication-orders/:id` | `prescribing.read` | ✅ |
| web | 12-dosespot | `prescribing.sign-inbox` | `/prescribing/sign-inbox` | `prescribing.read` | ✅ |
| web | 12-dosespot | `prescribing.verbal-orders` | `/prescribing/verbal-orders` | `prescribing.read` | ✅ |
| web | 12-dosespot | `prescribing.refill-inbox` | `/refills` | `prescribing.read` | ✅ |
| web | 12-dosespot | `prescribing.refill-detail` | `/refills/:id` | `prescribing.read` | ✅ |
| web | 12-dosespot | `prescribing.reconciliation` | `/patients/:patientId/medications/reconciliation` | `prescribing.history.read` | ✅ |
| web | 12-dosespot | `prescribing.prescriber-roster` | `/admin/prescribers` | `prescribing.admin.roster` | ✅ |
| web | 12-dosespot | `prescribing.policy` | `/admin/prescribing-policy` | `prescribing.admin.policy` | ✅ |
| web | 13-emar | `emar.patient-emar` | `/patients/:patientId/emar` | `administration.read` | ✅ |
| web | 13-emar | `emar.administration-detail` | `/patients/:patientId/administrations/:id` | `administration.read` | ✅ |
| web | 13-emar | `emar.iv-session` | `/patients/:patientId/iv-sessions/:sessionId` | `administration.read` | ✅ |
| web | 13-emar | `emar.missed-doses` | `/patients/:patientId/missed-doses` | `administration.read_missed` | ✅ |
| web | 13-emar | `emar.reconciliation-worksheet` | `/patients/:patientId/reconciliation/:worksheetId` | `reconciliation.read` | ✅ |
| web | 13-emar | `emar.comfort-kit` | `/patients/:patientId/comfort-kit/:deploymentId` | `comfort_kit.read` | ✅ |
| web | 13-emar | `emar.administration-policy` | `/admin/administration-policy` | `administration.admin.policy` | ✅ |
| web | 14-idg | `idg.schedule` | `/idg/schedule` | `idg.read` | ✅ |
| web | 14-idg | `idg.meeting-detail` | `/idg/meetings/:id` | `idg.read` | ✅ |
| web | 14-idg | `idg.meeting-live` | `/idg/meetings/:id/live` | `idg.read` | ✅ |
| web | 14-idg | `idg.packet` | `/idg/meetings/:meetingId/packets/:patientId` | `idg.read` | ✅ |
| web | 14-idg | `idg.patient-history` | `/patients/:patientId/idg-history` | `idg.read` | ✅ |
| web | 14-idg | `idg.action-items` | `/idg/action-items` | `idg.read` | ✅ |
| web | 14-idg | `idg.minutes` | `/idg/meetings/:id/minutes` | `idg.read` | ✅ |
| web | 15-discipline-care-plans | `discipline-plan.index` | `/patients/:patientId/discipline-plans` | `discipline_plan.read` | ✅ |
| web | 15-discipline-care-plans | `discipline-plan.aide-poc` | `/patients/:patientId/discipline-plans/aide-poc` | `discipline_plan.read` | ✅ |
| web | 15-discipline-care-plans | `discipline-plan.aide-poc.edit` | `/patients/:patientId/discipline-plans/aide-poc/:versionId/edit` | `discipline_plan.author` | ✅ |
| web | 15-discipline-care-plans | `discipline-plan.msw` | `/patients/:patientId/discipline-plans/msw-plan` | `discipline_plan.read` | ✅ |
| web | 15-discipline-care-plans | `discipline-plan.assessment` | `/patients/:patientId/discipline-plans/msw-plan/:planId/assessments/:assessmentId` | `discipline_assessment.author` | ✅ |
| web | 15-discipline-care-plans | `discipline-plan.spiritual` | `/patients/:patientId/discipline-plans/spiritual-plan` | `discipline_plan.read` | ✅ |
| web | 15-discipline-care-plans | `discipline-plan.volunteer` | `/patients/:patientId/discipline-plans/volunteer-plan` | `discipline_plan.read` | ✅ |
| web | 15-discipline-care-plans | `discipline-plan.summary` | `/patients/:patientId/discipline-plans/summary` | `discipline_plan.read_summary` | ✅ |
| web | 15-discipline-care-plans | `discipline-plan.versions` | `/patients/:patientId/discipline-plans/:kind/versions` | `discipline_plan.read` | ✅ |
| web | 15-discipline-care-plans | `discipline-plan.idg-revision` | `/patients/:patientId/discipline-plans/:kind/idg-revisions/:versionId` | `discipline_plan.idg_revise` | ✅ |
| web | 15-discipline-care-plans | `volunteer.compliance` | `/admin/volunteer-compliance` | `volunteer_compliance.read` | ✅ |
| web | 15-discipline-care-plans | `volunteer.ratio` | `/admin/volunteer-ratio` | `volunteer_compliance.read_ratio` | ✅ |
| web | 16-bereavement | `bereavement.caseload` | `/bereavement` | `bereavement.dashboard.counselor` | ✅ |
| web | 16-bereavement | `bereavement.supervisor` | `/bereavement/supervisor` | `bereavement.dashboard.supervisor` | ✅ |
| web | 16-bereavement | `bereavement.intake` | `/bereavement/eligible` | `bereavement.plan.assign_counselor` | ✅ |
| web | 16-bereavement | `bereavement.plan` | `/bereavement/plans/:planId` | `bereavement.plan.read` | ✅ |
| web | 16-bereavement | `bereavement.plan.seed` | `/bereavement/plans/:planId/seed` | `bereavement.plan.activate` | ✅ |
| web | 16-bereavement | `bereavement.plan.closeout` | `/bereavement/plans/:planId/closeout` | `bereavement.plan.read` | ✅ |
| web | 16-bereavement | `bereavement.plan.outreach` | `/bereavement/plans/:planId/outreach` | `bereavement.outreach.read` | ✅ |
| web | 16-bereavement | `bereavement.plan.risk` | `/bereavement/plans/:planId/risk` | `bereavement.risk.read` | ✅ |
| web | 16-bereavement | `bereavement.contact` | `/bereavement/plans/:planId/contacts/:contactId` | `bereavement.plan.read` | ✅ |
| web | 16-bereavement | `bereavement.contact.screen` | `/bereavement/plans/:planId/contacts/:contactId/screen` | `bereavement.contact.flag_complicated_grief` | ✅ |
| web | 16-bereavement | `bereavement.plan.history` | `/bereavement/plans/:planId/history` | `bereavement.plan.read` | ✅ |
| web | 17-scheduling | `scheduling.calendar` | `/calendar` | `(none)` | ✅ |
| web | 17-scheduling | `scheduling.day` | `/scheduling/day` | `visit.read_team` | ✅ |
| web | 17-scheduling | `scheduling.week` | `/scheduling/week` | `visit.read_team` | ✅ |
| web | 17-scheduling | `scheduling.proposals` | `/scheduling/proposals` | `visit.proposal.read` | ✅ |
| web | 17-scheduling | `scheduling.recurring` | `/scheduling/recurring` | `recurring_visit.read` | ✅ |
| web | 17-scheduling | `scheduling.time-off` | `/scheduling/time-off` | `time_off.read_team` | ✅ |
| web | 17-scheduling | `scheduling.visit-detail` | `/scheduling/visits/:visitId` | `visit.read` | ✅ |
| web | 17-scheduling | `scheduling.my-visits` | `/me/visits` | `visit.read` | ✅ |
| web | 17-scheduling | `scheduling.metrics` | `/admin/scheduling-metrics` | `visit.read_metrics` | ✅ |
| web | 18-evv | `evv.dashboard` | `/evv/dashboard` | `evv.read_metrics` | ✅ |
| web | 18-evv | `evv.events` | `/evv/events` | `evv.read` | ✅ |
| web | 18-evv | `evv.event-detail` | `/evv/events/:eventId` | `evv.read` | ✅ |
| web | 18-evv | `evv.missing-resolutions` | `/evv/missing-resolutions` | `evv.missing_resolution.read` | ✅ |
| web | 18-evv | `evv.aggregator-submissions` | `/evv/aggregator-submissions` | `evv.aggregator.read` | ✅ |
| web | 18-evv | `evv.geofence-policy` | `/evv/geofence-policy` | `evv.policy.read` | ✅ |
| web | 18-evv | `evv.devices` | `/evv/devices/pending` | `evv.device.read` | ✅ |
| web | 18-evv | `evv.metrics` | `/admin/evv-metrics` | `evv.read_metrics` | ✅ |
| web | 18-evv | `evv.my-devices` | `/me/evv/devices` | `evv.device.read` | ✅ |
| web | 19-oncall | `triage.queue` | `/triage` | `triage.read` | ✅ |
| web | 19-oncall | `triage.intake` | `/triage/intake` | `triage.open` | ✅ |
| web | 19-oncall | `triage.call` | `/triage/calls/:triageCallId` | `triage.read` | ✅ |
| web | 19-oncall | `triage.call.history` | `/triage/calls/:triageCallId/history` | `triage.read` | ✅ |
| web | 19-oncall | `triage.call.transcript` | `/triage/calls/:triageCallId/transcript` | `triage.read_transcript` | ✅ |
| web | 19-oncall | `triage.escalations` | `/triage/escalations` | `triage.read_escalations` | ✅ |
| web | 19-oncall | `oncall.shifts` | `/triage/shifts` | `oncall.read_schedule` | ✅ |
| web | 19-oncall | `oncall.shift` | `/triage/shifts/:shiftId` | `oncall.read_schedule` | ✅ |
| web | 19-oncall | `oncall.me` | `/me/oncall` | `oncall.read_schedule` | ✅ |
| web | 19-oncall | `triage.protocols` | `/triage/protocols` | `triage.read` | ✅ |
| web | 19-oncall | `triage.protocol` | `/triage/protocols/:protocolId` | `triage.read` | ✅ |
| web | 19-oncall | `oncall.policy` | `/triage/policy` | `oncall.read_policy` | ✅ |
| web | 19-oncall | `oncall.vendors` | `/triage/vendors` | `oncall.read_policy` | ✅ |
| web | 19-oncall | `triage.paper_reentry` | `/triage/paper-reentry` | `triage.paper_reentry` | ✅ |
| web | 19-oncall | `triage.metrics` | `/triage/metrics` | `triage.read` | ✅ |
| web | 20-field-safety | `safety.dashboard` | `/safety` | `safety.dashboard.read` | ✅ |
| web | 20-field-safety | `safety.sos.active` | `/safety/sos` | `safety.sos.read` | ✅ |
| web | 20-field-safety | `safety.sos.detail` | `/safety/sos/:sosAlertId` | `safety.sos.read` | ✅ |
| web | 20-field-safety | `safety.incidents` | `/safety/incidents` | `safety_incident.read` | ✅ |
| web | 20-field-safety | `safety.incident.new` | `/safety/incidents/new` | `safety_incident.create` | ✅ |
| web | 20-field-safety | `safety.incident.detail` | `/safety/incidents/:incidentId` | `safety_incident.read` | ✅ |
| web | 20-field-safety | `safety.check_ins` | `/safety/check-ins` | `safety.dashboard.read` | ✅ |
| web | 20-field-safety | `safety.policy` | `/safety/policy` | `safety_policy.read` | ✅ |
| web | 20-field-safety | `safety.subscriptions` | `/safety/supervisor-subscriptions` | `safety_supervisor.read` | ✅ |
| web | 20-field-safety | `safety.high_risk_areas` | `/safety/high-risk-areas` | `safety.high_risk_area.read` | ✅ |
| web | 20-field-safety | `safety.metrics` | `/safety/metrics` | `safety.dashboard.read` | ✅ |
| web | 20-field-safety | `safety.me` | `/me/safety` | `safety.sos.raise` | ✅ |
| web | 20-field-safety | `safety.me.check_ins` | `/me/safety/check-ins` | `safety.check_in.read` | ✅ |
| web | 20-field-safety | `safety.me.consent` | `/me/safety/consent` | `safety.consent.read_self` | ✅ |
| web | 21-supplies | `supplies.dashboard` | `/supplies` | `supplies.request.read` | ✅ |
| web | 21-supplies | `supplies.request` | `/supplies/requests/:supplyRequestId` | `supplies.request.read` | ✅ |
| web | 21-supplies | `supplies.dispatch.new` | `/supplies/dispatches/new` | `comfort_kit.dispatch.create` | ✅ |
| web | 21-supplies | `supplies.dispatch` | `/supplies/dispatches/:dispatchId` | `comfort_kit.dispatch.read` | ✅ |
| web | 21-supplies | `supplies.dispatch.perpetual_log` | `/supplies/dispatches/:dispatchId/perpetual-log` | `comfort_kit.perpetual_log.read` | ✅ |
| web | 21-supplies | `supplies.return` | `/supplies/returns/:returnId` | `comfort_kit.return.read` | ✅ |
| web | 21-supplies | `supplies.par_stock` | `/supplies/par-stock` | `par_stock.read` | ✅ |
| web | 21-supplies | `supplies.vendor_routing` | `/supplies/vendor-routing` | `vendor_routing.read` | ✅ |
| web | 21-supplies | `supplies.comfort_kit_templates` | `/supplies/comfort-kit-templates` | `comfort_kit.template.read` | ✅ |
| web | 21-supplies | `supplies.items` | `/supplies/items` | `supplies.item.read` | ✅ |
| web | 22-documents | `documents.explorer` | `/documents` | `documents.read` | ✅ |
| web | 22-documents | `documents.patient-list` | `/patients/:patientId/documents` | `documents.read` | ✅ |
| web | 22-documents | `documents.version-history` | `/documents/:documentId/versions` | `documents.read_history` | ✅ |
| web | 22-documents | `documents.intake-batch` | `/intake/:batchId` | `intake.read` | ✅ |
| web | 22-documents | `documents.template-library` | `/admin/forms/templates` | `documents.read_templates` | ✅ |
| web | 23-billing-medicare | `billing.ar-dashboard` | `/billing` | `billing.claim.read_ar_dashboard` | ✅ |
| web | 23-billing-medicare | `billing.claims` | `/billing/claims` | `billing.claim.read` | ✅ |
| web | 23-billing-medicare | `billing.patient-claims` | `/patients/:patientId/claims` | `billing.claim.read` | ✅ |
| web | 23-billing-medicare | `billing.claim.new` | `/billing/claims/new` | `billing.claim.assemble` | ✅ |
| web | 23-billing-medicare | `billing.claim` | `/billing/claims/:claimId` | `billing.claim.read` | ✅ |
| web | 23-billing-medicare | `billing.claim.validation` | `/billing/claims/:claimId/validation` | `billing.validation.read_run` | ✅ |
| web | 23-billing-medicare | `billing.claim.submissions` | `/billing/claims/:claimId/submissions` | `billing.claim.read` | ✅ |
| web | 23-billing-medicare | `billing.claim.acknowledgments` | `/billing/claims/:claimId/acknowledgments` | `billing.claim.read` | ✅ |
| web | 23-billing-medicare | `billing.noe` | `/billing/noe` | `billing.noe.read` | ✅ |
| web | 23-billing-medicare | `billing.noe.detail` | `/billing/noe/:noeId` | `billing.noe.read` | ✅ |
| web | 23-billing-medicare | `billing.notr` | `/billing/notr` | `billing.notr.read` | ✅ |
| web | 23-billing-medicare | `billing.notr.detail` | `/billing/notr/:notrId` | `billing.notr.read` | ✅ |
| web | 23-billing-medicare | `billing.rule-config` | `/billing/rule-config` | `billing.rule_config.read` | ✅ |
| web | 23-billing-medicare | `billing.eligibility` | `/billing/eligibility` | `billing.eligibility.read` | ✅ |
| web | 23-billing-medicare | `billing.sequestration` | `/billing/sequestration-policy` | `billing.sequestration_policy.read` | ✅ |
| web | 23-billing-medicare | `billing.mac-credentials` | `/billing/mac-credentials` | `billing.mac_credential.read` | ✅ |
| web | 23-billing-medicare | `billing.overrides` | `/billing/overrides` | `billing.validation.read_override` | ✅ |
| web | 23-billing-medicare | `billing.metrics` | `/billing/metrics` | `billing.claim.read_metrics` | ✅ |
| web | 23-billing-medicare | `billing.surveyor-audit` | `/admin/billing-audit` | `billing.claim.read` | ✅ |
| web | 24-billing-medicaid | `medicaid.ar-dashboard` | `/medicaid/billing/ar-dashboard` | `medicaid.claim.read_ar_dashboard` | ✅ |
| web | 24-billing-medicaid | `medicaid.claims` | `/medicaid/billing/claims` | `medicaid.claim.read` | ✅ |
| web | 24-billing-medicaid | `medicaid.claim.new` | `/medicaid/billing/claims/new` | `medicaid.claim.assemble` | ✅ |
| web | 24-billing-medicaid | `medicaid.claim` | `/medicaid/billing/claims/:claimId` | `medicaid.claim.read` | ✅ |
| web | 24-billing-medicaid | `medicaid.claim.validation` | `/medicaid/billing/claims/:claimId/validation` | `medicaid.validation.read_run` | ✅ |
| web | 24-billing-medicaid | `medicaid.claim.submissions` | `/medicaid/billing/claims/:claimId/submissions` | `medicaid.claim.read` | ✅ |
| web | 24-billing-medicaid | `medicaid.claim.acknowledgments` | `/medicaid/billing/claims/:claimId/acknowledgments` | `medicaid.claim.read` | ✅ |
| web | 24-billing-medicaid | `medicaid.validation-worklist` | `/medicaid/billing/validation-worklist` | `medicaid.validation.read_run` | ✅ |
| web | 24-billing-medicaid | `medicaid.rb-arrangements` | `/medicaid/billing/rb-arrangements` | `medicaid.rb_arrangement.read` | ✅ |
| web | 24-billing-medicaid | `medicaid.rb-arrangement` | `/medicaid/billing/rb-arrangements/:arrangementId` | `medicaid.rb_arrangement.read` | ✅ |
| web | 24-billing-medicaid | `medicaid.rule-config` | `/medicaid/billing/rule-config` | `medicaid.rule_config.read` | ✅ |
| web | 24-billing-medicaid | `medicaid.eligibility` | `/medicaid/billing/eligibility` | `medicaid.eligibility.read` | ✅ |
| web | 24-billing-medicaid | `medicaid.trading-partners` | `/medicaid/billing/trading-partner-credentials` | `medicaid.trading_partner.read` | ✅ |
| web | 24-billing-medicaid | `medicaid.overrides` | `/medicaid/billing/override-audit` | `medicaid.validation.read_override` | ✅ |
| web | 24-billing-medicaid | `medicaid.metrics` | `/medicaid/billing/metrics` | `medicaid.claim.read_metrics` | ✅ |
| web | 24-billing-medicaid | `medicaid.surveyor-read` | `/admin/medicaid-billing-audit/:claimId` | `medicaid.claim.read` | ✅ |
| web | 25-remittance | `remittance.worklist` | `/remittance` | `remittance.read` | ✅ |
| web | 25-remittance | `remittance.denials` | `/remittance/denials` | `denial.worklist.read` | ✅ |
| web | 25-remittance | `remittance.appeals` | `/remittance/appeals` | `appeal.read` | ✅ |
| web | 25-remittance | `remittance.taxonomy` | `/remittance/taxonomy` | `taxonomy.read` | ✅ |
| web | 26-cap | `cap.dashboard` | `/cap` | `cap.projection.read` | ✅ |
| web | 26-cap | `cap.periods` | `/cap/periods` | `cap.period.read` | ✅ |
| web | 26-cap | `cap.events` | `/cap/events` | `cap.event.read` | ✅ |
| web | 26-cap | `cap.settlement` | `/cap/settlements` | `cap.settlement.read` | ✅ |
| web | 26-cap | `cap.psr` | `/cap/psr` | `cap.psr.read` | ✅ |
| web | 26-cap | `cap.platform_constants` | `/platform/cap/constants` | `cap.platform_constant.read` | ✅ |
| web | 27-cost-report | `cost_report.list` | `/cost-reports` | `cost_report.read` | ✅ |
| web | 27-cost-report | `cost_report.workspace` | `/cost-reports/workspace` | `cost_report.read` | ✅ |
| web | 27-cost-report | `cost_report.validation` | `/cost-reports/validation` | `cost_report.read` | ✅ |
| web | 27-cost-report | `cost_report.rules` | `/cost-reports/rules` | `cost_report.read_rules` | ✅ |
| web | 27-cost-report | `cost_report.bad_debt` | `/cost-reports/bad-debt` | `cost_report.read` | ✅ |
| web | 27-cost-report | `cost_report.snapshots` | `/cost-reports/snapshots` | `cost_report.read_snapshot_detail` | ✅ |
| web | 30-quality | `quality.hub` | `/quality` | `quality.measure.read` | ✅ |
| web | 30-quality | `quality.qapi-incidents` | `/quality/qapi` | `incident.read` | ✅ |
| web | 32-ai-platform | `ai.compliance` | `/compliance/ai` | `ai.invocation.read` | ✅ |
| web | 32-ai-platform | `ai.opt-in` | `/organization/ai/opt-in` | `ai.tenant_opt_in` | ✅ |
| web | 32-ai-platform | `ai.routing` | `/organization/ai/routing` | `ai.tenant_opt_in` | ✅ |
| web | 32-ai-platform | `ai.my-preferences` | `/me/ai-preferences` | `ai.clinician_opt_out.read` | ✅ |
| web | 33-reporting | `reporting.catalog` | `/reports` | `report.dashboard.list` | ✅ |
| web | 33-reporting | `reporting.dashboard` | `/reports/dashboards/:dashboardId` | `report.dashboard.read` | ✅ |
| web | 33-reporting | `reporting.role-dashboard` | `/reports/role/:roleKey` | `report.dashboard.read` | ✅ |
| web | 33-reporting | `reporting.schedules` | `/reports/schedules` | `report.schedule.list` | ✅ |
| web | 33-reporting | `reporting.admin` | `/reports/admin` | `report.admin.mv_list` | ✅ |
| web | 34-saas | `saas.account` | `/admin/account` | `tenant.read_own` | ✅ |
| web | 34-saas | `saas.onboarding` | `/admin/onboarding` | `onboarding.read_own` | ✅ |
| web | 34-saas | `saas.support-grants` | `/admin/support-grants` | `support_consent_grant.list_own` | ✅ |
| web | 35-subscription | `billing.overview` | `/subscription` | `subscription.read` | ✅ |
| web | 35-subscription | `billing.plan` | `/subscription/plan` | `subscription.read` | ✅ |
| web | 35-subscription | `billing.payment-methods` | `/subscription/payment_methods` | `payment_method.read` | ✅ |
| web | 35-subscription | `billing.invoices` | `/subscription/invoices` | `invoice.read` | ✅ |
| web | 35-subscription | `billing.invoice-detail` | `/subscription/invoices/:id` | `invoice.read` | ✅ |
| web | 35-subscription | `billing.usage` | `/subscription/usage` | `usage.read` | ✅ |
| web | 35-subscription | `billing.dunning` | `/subscription/dunning` | `subscription.read` | ✅ |
| web | 35-subscription | `billing.promos` | `/subscription/promos` | `subscription.read` | ✅ |
| web | 36-messaging | `messaging.staff` | `/messaging` | `messaging.read` | ✅ |
| web | 36-messaging | `messaging.notifications` | `/notifications` | `(none)` | ✅ |
| web | 37-ipu | `ipu.units` | `/ipu` | `m37.unit.read` | ✅ |
| web | 37-ipu | `ipu.admissions` | `/ipu/admissions` | `m37.ipu_admission.read` | ✅ |
| web | 37-ipu | `ipu.bedside` | `/ipu/admissions/:id` | `m37.ipu_admission.read` | ✅ |
| web | 37-ipu | `ipu.census` | `/ipu/census` | `m37.census.read` | ✅ |
| web | 37-ipu | `ipu.equipment` | `/ipu/equipment` | `m37.equipment.read` | ✅ |
| web | 38-terminology | `terminology.admin` | `/terminology` | `(none)` | ✅ |
| web | 39-consent | `consent.record-manager` | `/patients/:patientId/consents` | `consent.read` | ✅ |
| web | 39-consent | `consent.capture` | `/patients/:patientId/consents/new` | `consent.author` | ✅ |
| web | 39-consent | `consent.detail` | `/patients/:patientId/consents/:consentId` | `consent.read` | ✅ |
| web | 39-consent | `consent.expiration-renewal` | `/patients/:patientId/consents/expiring` | `consent.read` | ✅ |
| web | 39-consent | `consent.recipients-dpoa` | `/consents/:consentId/recipients` | `consent.read` | ✅ |
| web | 40-mdm | `mdm.console` | `/mdm` | `(none)` | ✅ |
| admin | 01-ops | `admin.ops.outbox` | `/admin/ops/outbox` | `member.manage` | ✅ |
| admin | 01-ops | `admin.ops.outbox-detail` | `/admin/ops/outbox/:id` | `member.manage` | ✅ |
| admin | 32-ai-platform | `admin.ai-capabilities` | `/admin/ai-platform/capabilities` | `ai.capability.read` | ✅ |
| admin | 32-ai-platform | `admin.ai-capability-detail` | `/admin/ai-platform/capabilities/:capabilityId` | `ai.capability.read` | ✅ |
| admin | 32-ai-platform | `admin.ai-kill-switches` | `/admin/ai-platform/kill-switches` | `ai.kill_switch.read` | ✅ |
| admin | 32-ai-platform | `admin.ai-invocations` | `/admin/ai-platform/invocations` | `ai.invocation.read` | ✅ |
| admin | 32-ai-platform | `admin.ai-hallucinations` | `/admin/ai-platform/hallucinations` | `ai.hallucination.triage` | ✅ |
| admin | 32-ai-platform | `admin.ai-tokens` | `/admin/ai-platform/tokens` | `ai.tokens.read` | ✅ |
| admin | 32-ai-platform | `admin.ai-evaluations` | `/admin/ai-platform/evaluations` | `ai.capability.read` | ✅ |
| admin | 32-ai-platform | `admin.ai-drift` | `/admin/ai-platform/drift` | `ai.capability.read` | ✅ |
| admin | 34-saas-platform | `saas.tenants` | `/tenants` | `tenant.list_platform` | ✅ |
| admin | 34-saas-platform | `saas.tenant-overview` | `/tenants/:orgSlug` | `tenant.read_platform` | ✅ |
| admin | 34-saas-platform | `saas.support-sessions` | `/support/sessions` | `support_session.list_platform` | ✅ |
| admin | 34-saas-platform | `saas.dsar-queue` | `/exports/dsar` | `dsar_export.list_own` | ✅ |
| admin | 34-saas-platform | `saas.tenant-export-queue` | `/exports/tenant` | `tenant_export.list_own` | ✅ |
| admin | 34-saas-platform | `saas.onboarding-templates` | `/onboarding/templates` | `onboarding_template.list` | ✅ |
| admin | 34-saas-platform | `saas.feature-flags` | `/feature-flags` | `feature_flag.read_platform` | ✅ |
| admin | 34-saas-platform | `saas.baa-register` | `/baa` | `platform_tenant_baa.read_platform` | ✅ |
| admin | 34-saas-platform | `saas.signups` | `/signups` | `signup_intent.list_platform` | ✅ |
| admin | 34-saas-platform | `saas.key-rings` | `/key-rings` | `tenant.read_platform` | ✅ |
| admin | 35-subscription-billing | `admin.plans` | `/admin/plans` | `plan.admin.read` | ✅ |
| admin | 35-subscription-billing | `admin.plan-edit` | `/admin/plans/:id/edit` | `plan.admin.write` | ✅ |
| admin | 35-subscription-billing | `admin.promos` | `/admin/promos` | `promo.admin.read` | ✅ |
| admin | 35-subscription-billing | `admin.subscriptions` | `/admin/subscriptions` | `subscription.admin.read` | ✅ |
| admin | 35-subscription-billing | `admin.subscription-detail` | `/admin/subscriptions/:id` | `subscription.admin.read` | ✅ |
| admin | 35-subscription-billing | `admin.subscription-pause` | `/admin/subscriptions/:id/pause` | `subscription.admin.write` | ✅ |
| admin | 35-subscription-billing | `admin.subscription-apply-promo` | `/admin/subscriptions/:id/apply_promo` | `promo.admin.apply` | ✅ |
| admin | 35-subscription-billing | `admin.refunds` | `/admin/refunds` | `refund.read` | ✅ |
| admin | 35-subscription-billing | `admin.refund-new` | `/admin/refunds/new` | `refund.request` | ✅ |
| admin | 35-subscription-billing | `admin.refund-approve` | `/admin/refunds/:id/approve` | `refund.approve` | ✅ |
| admin | 35-subscription-billing | `admin.dunning` | `/admin/dunning` | `dunning.admin.read` | ✅ |
| admin | 35-subscription-billing | `admin.revenue` | `/admin/revenue` | `revenue.admin.read` | ✅ |
| admin | 35-subscription-billing | `admin.usage` | `/admin/usage/:organizationId` | `usage.admin.read` | ✅ |
| admin | 35-subscription-billing | `admin.webhooks` | `/admin/webhooks/stripe` | `stripe.admin.read` | ✅ |
| portal | 31-portal | `portal.sign-in` | `/` | `(none)` | ✅ |
| portal | 31-portal | `portal.patient-picker` | `/patient-picker` | `portal.session.read_own` | ✅ |
| portal | 31-portal | `portal.dashboard` | `/p/:patientId` | `portal.care_summary.read` | ✅ |
| portal | 31-portal | `portal.care-plan` | `/p/:patientId/care-plan` | `portal.care_plan.read_summary` | ✅ |
| portal | 31-portal | `portal.visits` | `/p/:patientId/visits` | `portal.visits.read_upcoming` | ✅ |
| portal | 31-portal | `portal.telehealth` | `/p/:patientId/visits/:visitId/telehealth` | `telehealth.join_patient_or_caregiver` | ✅ |
| portal | 31-portal | `portal.medications` | `/p/:patientId/medications` | `portal.medications.read_summary` | ✅ |
| portal | 31-portal | `portal.documents` | `/p/:patientId/documents` | `portal.documents.read_list` | ✅ |
| portal | 31-portal | `portal.messages` | `/p/:patientId/messages` | `portal.messages.read_channel` | ✅ |
| portal | 31-portal | `portal.amendments` | `/p/:patientId/amendments` | `portal.amendment.read_own` | ✅ |
| portal | 31-portal | `portal.preferences` | `/p/:patientId/preferences` | `portal.preferences.read_own` | ✅ |
| portal | 31-portal | `portal.bereavement` | `/p/:patientId/bereavement` | `portal.bereavement.read_program` | ✅ |
| portal | 31-portal | `portal.account` | `/account` | `portal.session.read_own` | ✅ |

## Hard-fail consistency checks

- ✅ No duplicate screen ids/paths (per app), all `requiredPermission`s resolve, all module screen-sets are registered.
