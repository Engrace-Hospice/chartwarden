# WardenX — UI Implementation-Parity Report

> **Generated, advisory report** (`bun run ui:parity`). `docs:ui` proves the screen-spec
> corpus is consistent; this shows how much of it is BUILT in `apps/web`. Do not hand-edit —
> the `ui:parity --check` gate (in `arch:fitness`) keeps it in sync with source.

**Coverage:** 113 documented screen specs · 33 module screen-sets registered · 226 screens wired in `apps/web`.

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

| Module | Screen id | Route path | Required permission | Permission resolves |
|---|---|---|---|:--:|
| 02-identity | `identity.sign-in` | `/login` | `(none)` | ✅ |
| 02-identity | `identity.mfa-challenge` | `/login/2fa` | `(none)` | ✅ |
| 02-identity | `identity.forgot-password` | `/forgot` | `(none)` | ✅ |
| 02-identity | `identity.reset-password` | `/reset-password` | `(none)` | ✅ |
| 02-identity | `identity.step-up` | `/step-up` | `(none)` | ✅ |
| 02-identity | `identity.organization-select` | `/login/organization` | `(none)` | ✅ |
| 02-identity | `identity.accept-invitation` | `/invite/:token` | `(none)` | ✅ |
| 02-identity | `identity.security-passkeys` | `/security/passkeys` | `(none)` | ✅ |
| 02-identity | `identity.staff-management` | `/admin/staff` | `(none)` | ✅ |
| 03-authorization | `authz.roles-permissions` | `/roles` | `role.read` | ✅ |
| 04-audit | `audit.log-viewer` | `/audit` | `audit.read` | ✅ |
| 05-patient | `patient.census` | `/patients` | `patient.read` | ✅ |
| 05-patient | `search.global` | `/search` | `patient.read` | ✅ |
| 05-patient | `patient.chart` | `/patients/:id` | `patient.read` | ✅ |
| 06-admission | `admission.referrals` | `/referrals` | `referral.read` | ✅ |
| 06-admission | `admission.census` | `/admissions` | `admission.read` | ✅ |
| 06-admission | `admission.compliance` | `/compliance/admissions` | `compliance.read` | ✅ |
| 06-admission | `admission.detail` | `/admissions/:id` | `admission.read` | ✅ |
| 07-care-plan | `care-plan.view` | `/patients/:patientId/care-plan` | `care_plan.read` | ✅ |
| 07-care-plan | `care-plan.versions` | `/care-plans/:planId/versions` | `care_plan.read` | ✅ |
| 07-care-plan | `care-plan.summary` | `/care-plans/:planId/summary` | `care_plan.read_summary` | ✅ |
| 08-encounters | `encounter.read` | `/patients/:patientId/encounters/:encounterId` | `encounter.read` | ✅ |
| 08-encounters | `encounter.cosignature-queue` | `/work/cosignatures` | `encounter.cosign` | ✅ |
| 08-encounters | `encounter.my-drafts` | `/work/drafts` | `encounter.author` | ✅ |
| 09-assessments | `assessment.timeline` | `/patients/:patientId/assessments` | `assessment.read` | ✅ |
| 09-assessments | `assessment.scale-trend` | `/patients/:patientId/scales/:scaleType` | `assessment.read_trend` | ✅ |
| 09-assessments | `assessment.changes` | `/patients/:patientId/assessments/changes` | `assessment.read` | ✅ |
| 09-assessments | `assessment.summary` | `/patients/:patientId/assessments/summary` | `assessment.read_summary` | ✅ |
| 09-assessments | `assessment.scale-licenses` | `/admin/scales/licenses` | `assessment.license_read` | ✅ |
| 09-assessments | `assessment.scale-policies` | `/admin/scales/policies` | `assessment.policy_read` | ✅ |
| 10-hope | `hope.dashboard` | `/hope` | `hope.schedule.read` | ✅ |
| 10-hope | `hope.patient-timeline` | `/patients/:patientId/hope` | `hope.timepoint.read` | ✅ |
| 10-hope | `hope.sfv-worklist` | `/hope/sfv` | `hope.sfv.read` | ✅ |
| 10-hope | `hope.assessment-detail` | `/hope/assessments/:id` | `hope.timepoint.read` | ✅ |
| 10-hope | `hope.submission-worklist` | `/hope/submissions` | `hope.submission.read` | ✅ |
| 10-hope | `hope.submission-detail` | `/hope/submissions/:id` | `hope.submission.read` | ✅ |
| 10-hope | `hope.compliance` | `/hope/compliance` | `hope.dashboard.read` | ✅ |
| 11-orders | `orders.sign-inbox` | `/orders` | `orders.read` | ✅ |
| 11-orders | `orders.patient-list` | `/patients/:patientId/orders` | `orders.read` | ✅ |
| 11-orders | `orders.detail` | `/orders/:id` | `orders.read` | ✅ |
| 11-orders | `orders.verbal-expiring` | `/orders/verbal-expiring` | `orders.read` | ✅ |
| 11-orders | `orders.cosign-pending` | `/orders/cosign-pending` | `orders.read` | ✅ |
| 11-orders | `orders.results-review` | `/orders/results-pending-review` | `orders.read` | ✅ |
| 11-orders | `orders.standing` | `/standing-orders` | `orders.read` | ✅ |
| 12-dosespot | `prescribing.patient-medications` | `/patients/:patientId/medications` | `prescribing.read` | ✅ |
| 12-dosespot | `prescribing.medication-detail` | `/medication-orders/:id` | `prescribing.read` | ✅ |
| 12-dosespot | `prescribing.sign-inbox` | `/prescribing/sign-inbox` | `prescribing.read` | ✅ |
| 12-dosespot | `prescribing.verbal-orders` | `/prescribing/verbal-orders` | `prescribing.read` | ✅ |
| 12-dosespot | `prescribing.refill-inbox` | `/refills` | `prescribing.read` | ✅ |
| 12-dosespot | `prescribing.refill-detail` | `/refills/:id` | `prescribing.read` | ✅ |
| 12-dosespot | `prescribing.reconciliation` | `/patients/:patientId/medications/reconciliation` | `prescribing.history.read` | ✅ |
| 12-dosespot | `prescribing.prescriber-roster` | `/admin/prescribers` | `prescribing.admin.roster` | ✅ |
| 12-dosespot | `prescribing.policy` | `/admin/prescribing-policy` | `prescribing.admin.policy` | ✅ |
| 13-emar | `emar.patient-emar` | `/patients/:patientId/emar` | `administration.read` | ✅ |
| 13-emar | `emar.administration-detail` | `/patients/:patientId/administrations/:id` | `administration.read` | ✅ |
| 13-emar | `emar.iv-session` | `/patients/:patientId/iv-sessions/:sessionId` | `administration.read` | ✅ |
| 13-emar | `emar.missed-doses` | `/patients/:patientId/missed-doses` | `administration.read_missed` | ✅ |
| 13-emar | `emar.reconciliation-worksheet` | `/patients/:patientId/reconciliation/:worksheetId` | `reconciliation.read` | ✅ |
| 13-emar | `emar.comfort-kit` | `/patients/:patientId/comfort-kit/:deploymentId` | `comfort_kit.read` | ✅ |
| 13-emar | `emar.administration-policy` | `/admin/administration-policy` | `administration.admin.policy` | ✅ |
| 14-idg | `idg.schedule` | `/idg/schedule` | `idg.read` | ✅ |
| 14-idg | `idg.meeting-detail` | `/idg/meetings/:id` | `idg.read` | ✅ |
| 14-idg | `idg.meeting-live` | `/idg/meetings/:id/live` | `idg.read` | ✅ |
| 14-idg | `idg.packet` | `/idg/meetings/:meetingId/packets/:patientId` | `idg.read` | ✅ |
| 14-idg | `idg.action-items` | `/idg/action-items` | `idg.read` | ✅ |
| 14-idg | `idg.minutes` | `/idg/meetings/:id/minutes` | `idg.read` | ✅ |
| 15-discipline-care-plans | `discipline-plan.index` | `/patients/:patientId/discipline-plans` | `discipline_plan.read` | ✅ |
| 15-discipline-care-plans | `discipline-plan.aide-poc` | `/patients/:patientId/discipline-plans/aide-poc` | `discipline_plan.read` | ✅ |
| 15-discipline-care-plans | `discipline-plan.aide-poc.edit` | `/patients/:patientId/discipline-plans/aide-poc/:versionId/edit` | `discipline_plan.author` | ✅ |
| 15-discipline-care-plans | `discipline-plan.msw` | `/patients/:patientId/discipline-plans/msw-plan` | `discipline_plan.read` | ✅ |
| 15-discipline-care-plans | `discipline-plan.assessment` | `/patients/:patientId/discipline-plans/msw-plan/:planId/assessments/:assessmentId` | `discipline_assessment.author` | ✅ |
| 15-discipline-care-plans | `discipline-plan.spiritual` | `/patients/:patientId/discipline-plans/spiritual-plan` | `discipline_plan.read` | ✅ |
| 15-discipline-care-plans | `discipline-plan.volunteer` | `/patients/:patientId/discipline-plans/volunteer-plan` | `discipline_plan.read` | ✅ |
| 15-discipline-care-plans | `discipline-plan.summary` | `/patients/:patientId/discipline-plans/summary` | `discipline_plan.read_summary` | ✅ |
| 15-discipline-care-plans | `discipline-plan.versions` | `/patients/:patientId/discipline-plans/:kind/versions` | `discipline_plan.read` | ✅ |
| 15-discipline-care-plans | `discipline-plan.idg-revision` | `/patients/:patientId/discipline-plans/:kind/idg-revisions/:versionId` | `discipline_plan.idg_revise` | ✅ |
| 15-discipline-care-plans | `volunteer.compliance` | `/admin/volunteer-compliance` | `volunteer_compliance.read` | ✅ |
| 15-discipline-care-plans | `volunteer.ratio` | `/admin/volunteer-ratio` | `volunteer_compliance.read_ratio` | ✅ |
| 16-bereavement | `bereavement.caseload` | `/bereavement` | `bereavement.dashboard.counselor` | ✅ |
| 16-bereavement | `bereavement.supervisor` | `/bereavement/supervisor` | `bereavement.dashboard.supervisor` | ✅ |
| 16-bereavement | `bereavement.intake` | `/bereavement/eligible` | `bereavement.plan.assign_counselor` | ✅ |
| 16-bereavement | `bereavement.plan` | `/bereavement/plans/:planId` | `bereavement.plan.read` | ✅ |
| 16-bereavement | `bereavement.plan.seed` | `/bereavement/plans/:planId/seed` | `bereavement.plan.activate` | ✅ |
| 16-bereavement | `bereavement.plan.closeout` | `/bereavement/plans/:planId/closeout` | `bereavement.plan.read` | ✅ |
| 16-bereavement | `bereavement.plan.outreach` | `/bereavement/plans/:planId/outreach` | `bereavement.outreach.read` | ✅ |
| 16-bereavement | `bereavement.plan.risk` | `/bereavement/plans/:planId/risk` | `bereavement.risk.read` | ✅ |
| 16-bereavement | `bereavement.contact` | `/bereavement/plans/:planId/contacts/:contactId` | `bereavement.plan.read` | ✅ |
| 16-bereavement | `bereavement.contact.screen` | `/bereavement/plans/:planId/contacts/:contactId/screen` | `bereavement.contact.flag_complicated_grief` | ✅ |
| 16-bereavement | `bereavement.plan.history` | `/bereavement/plans/:planId/history` | `bereavement.plan.read` | ✅ |
| 17-scheduling | `scheduling.day` | `/scheduling/day` | `visit.read_team` | ✅ |
| 17-scheduling | `scheduling.week` | `/scheduling/week` | `visit.read_team` | ✅ |
| 17-scheduling | `scheduling.proposals` | `/scheduling/proposals` | `visit.proposal.read` | ✅ |
| 17-scheduling | `scheduling.recurring` | `/scheduling/recurring` | `recurring_visit.read` | ✅ |
| 17-scheduling | `scheduling.time-off` | `/scheduling/time-off` | `time_off.read_team` | ✅ |
| 17-scheduling | `scheduling.visit-detail` | `/scheduling/visits/:visitId` | `visit.read` | ✅ |
| 17-scheduling | `scheduling.my-visits` | `/me/visits` | `visit.read` | ✅ |
| 17-scheduling | `scheduling.metrics` | `/admin/scheduling-metrics` | `visit.read_metrics` | ✅ |
| 18-evv | `evv.dashboard` | `/evv/dashboard` | `evv.read_metrics` | ✅ |
| 18-evv | `evv.events` | `/evv/events` | `evv.read` | ✅ |
| 18-evv | `evv.event-detail` | `/evv/events/:eventId` | `evv.read` | ✅ |
| 18-evv | `evv.missing-resolutions` | `/evv/missing-resolutions` | `evv.missing_resolution.read` | ✅ |
| 18-evv | `evv.aggregator-submissions` | `/evv/aggregator-submissions` | `evv.aggregator.read` | ✅ |
| 18-evv | `evv.geofence-policy` | `/evv/geofence-policy` | `evv.policy.read` | ✅ |
| 18-evv | `evv.devices` | `/evv/devices/pending` | `evv.device.read` | ✅ |
| 18-evv | `evv.metrics` | `/admin/evv-metrics` | `evv.read_metrics` | ✅ |
| 18-evv | `evv.my-devices` | `/me/evv/devices` | `evv.device.read` | ✅ |
| 19-oncall | `triage.queue` | `/triage` | `triage.read` | ✅ |
| 19-oncall | `triage.intake` | `/triage/intake` | `triage.open` | ✅ |
| 19-oncall | `triage.call` | `/triage/calls/:triageCallId` | `triage.read` | ✅ |
| 19-oncall | `triage.call.history` | `/triage/calls/:triageCallId/history` | `triage.read` | ✅ |
| 19-oncall | `triage.call.transcript` | `/triage/calls/:triageCallId/transcript` | `triage.read_transcript` | ✅ |
| 19-oncall | `triage.escalations` | `/triage/escalations` | `triage.read_escalations` | ✅ |
| 19-oncall | `oncall.shifts` | `/triage/shifts` | `oncall.read_schedule` | ✅ |
| 19-oncall | `oncall.shift` | `/triage/shifts/:shiftId` | `oncall.read_schedule` | ✅ |
| 19-oncall | `oncall.me` | `/me/oncall` | `oncall.read_schedule` | ✅ |
| 19-oncall | `triage.protocols` | `/triage/protocols` | `triage.read` | ✅ |
| 19-oncall | `triage.protocol` | `/triage/protocols/:protocolId` | `triage.read` | ✅ |
| 19-oncall | `oncall.policy` | `/triage/policy` | `oncall.read_policy` | ✅ |
| 19-oncall | `oncall.vendors` | `/triage/vendors` | `oncall.read_policy` | ✅ |
| 19-oncall | `triage.paper_reentry` | `/triage/paper-reentry` | `triage.paper_reentry` | ✅ |
| 19-oncall | `triage.metrics` | `/triage/metrics` | `triage.read` | ✅ |
| 20-field-safety | `safety.dashboard` | `/safety` | `safety.dashboard.read` | ✅ |
| 20-field-safety | `safety.sos.active` | `/safety/sos` | `safety.sos.read` | ✅ |
| 20-field-safety | `safety.sos.detail` | `/safety/sos/:sosAlertId` | `safety.sos.read` | ✅ |
| 20-field-safety | `safety.incidents` | `/safety/incidents` | `safety_incident.read` | ✅ |
| 20-field-safety | `safety.incident.new` | `/safety/incidents/new` | `safety_incident.create` | ✅ |
| 20-field-safety | `safety.incident.detail` | `/safety/incidents/:incidentId` | `safety_incident.read` | ✅ |
| 20-field-safety | `safety.check_ins` | `/safety/check-ins` | `safety.dashboard.read` | ✅ |
| 20-field-safety | `safety.policy` | `/safety/policy` | `safety_policy.read` | ✅ |
| 20-field-safety | `safety.subscriptions` | `/safety/supervisor-subscriptions` | `safety_supervisor.read` | ✅ |
| 20-field-safety | `safety.high_risk_areas` | `/safety/high-risk-areas` | `safety.high_risk_area.read` | ✅ |
| 20-field-safety | `safety.metrics` | `/safety/metrics` | `safety.dashboard.read` | ✅ |
| 20-field-safety | `safety.me` | `/me/safety` | `safety.sos.raise` | ✅ |
| 20-field-safety | `safety.me.check_ins` | `/me/safety/check-ins` | `safety.check_in.read` | ✅ |
| 20-field-safety | `safety.me.consent` | `/me/safety/consent` | `safety.consent.read_self` | ✅ |
| 21-supplies | `supplies.dashboard` | `/supplies` | `supplies.request.read` | ✅ |
| 21-supplies | `supplies.request` | `/supplies/requests/:supplyRequestId` | `supplies.request.read` | ✅ |
| 21-supplies | `supplies.dispatch.new` | `/supplies/dispatches/new` | `comfort_kit.dispatch.create` | ✅ |
| 21-supplies | `supplies.dispatch` | `/supplies/dispatches/:dispatchId` | `comfort_kit.dispatch.read` | ✅ |
| 21-supplies | `supplies.dispatch.perpetual_log` | `/supplies/dispatches/:dispatchId/perpetual-log` | `comfort_kit.perpetual_log.read` | ✅ |
| 21-supplies | `supplies.return` | `/supplies/returns/:returnId` | `comfort_kit.return.read` | ✅ |
| 21-supplies | `supplies.par_stock` | `/supplies/par-stock` | `par_stock.read` | ✅ |
| 21-supplies | `supplies.vendor_routing` | `/supplies/vendor-routing` | `vendor_routing.read` | ✅ |
| 21-supplies | `supplies.comfort_kit_templates` | `/supplies/comfort-kit-templates` | `comfort_kit.template.read` | ✅ |
| 21-supplies | `supplies.items` | `/supplies/items` | `supplies.item.read` | ✅ |
| 22-documents | `documents.explorer` | `/documents` | `documents.read` | ✅ |
| 22-documents | `documents.version-history` | `/documents/:documentId/versions` | `documents.read_history` | ✅ |
| 22-documents | `documents.intake-batch` | `/intake/:batchId` | `intake.read` | ✅ |
| 22-documents | `documents.template-library` | `/admin/forms/templates` | `documents.read_templates` | ✅ |
| 23-billing-medicare | `billing.ar-dashboard` | `/billing` | `billing.claim.read_ar_dashboard` | ✅ |
| 23-billing-medicare | `billing.claims` | `/billing/claims` | `billing.claim.read` | ✅ |
| 23-billing-medicare | `billing.claim.new` | `/billing/claims/new` | `billing.claim.assemble` | ✅ |
| 23-billing-medicare | `billing.claim` | `/billing/claims/:claimId` | `billing.claim.read` | ✅ |
| 23-billing-medicare | `billing.claim.validation` | `/billing/claims/:claimId/validation` | `billing.validation.read_run` | ✅ |
| 23-billing-medicare | `billing.claim.submissions` | `/billing/claims/:claimId/submissions` | `billing.claim.read` | ✅ |
| 23-billing-medicare | `billing.claim.acknowledgments` | `/billing/claims/:claimId/acknowledgments` | `billing.claim.read` | ✅ |
| 23-billing-medicare | `billing.noe` | `/billing/noe` | `billing.noe.read` | ✅ |
| 23-billing-medicare | `billing.noe.detail` | `/billing/noe/:noeId` | `billing.noe.read` | ✅ |
| 23-billing-medicare | `billing.notr` | `/billing/notr` | `billing.notr.read` | ✅ |
| 23-billing-medicare | `billing.notr.detail` | `/billing/notr/:notrId` | `billing.notr.read` | ✅ |
| 23-billing-medicare | `billing.rule-config` | `/billing/rule-config` | `billing.rule_config.read` | ✅ |
| 23-billing-medicare | `billing.eligibility` | `/billing/eligibility` | `billing.eligibility.read` | ✅ |
| 23-billing-medicare | `billing.sequestration` | `/billing/sequestration-policy` | `billing.sequestration_policy.read` | ✅ |
| 23-billing-medicare | `billing.mac-credentials` | `/billing/mac-credentials` | `billing.mac_credential.read` | ✅ |
| 23-billing-medicare | `billing.overrides` | `/billing/overrides` | `billing.validation.read_override` | ✅ |
| 23-billing-medicare | `billing.metrics` | `/billing/metrics` | `billing.claim.read_metrics` | ✅ |
| 23-billing-medicare | `billing.surveyor-audit` | `/admin/billing-audit` | `billing.claim.read` | ✅ |
| 24-billing-medicaid | `medicaid.ar-dashboard` | `/medicaid/billing/ar-dashboard` | `medicaid.claim.read_ar_dashboard` | ✅ |
| 24-billing-medicaid | `medicaid.claims` | `/medicaid/billing/claims` | `medicaid.claim.read` | ✅ |
| 24-billing-medicaid | `medicaid.claim.new` | `/medicaid/billing/claims/new` | `medicaid.claim.assemble` | ✅ |
| 24-billing-medicaid | `medicaid.claim` | `/medicaid/billing/claims/:claimId` | `medicaid.claim.read` | ✅ |
| 24-billing-medicaid | `medicaid.claim.validation` | `/medicaid/billing/claims/:claimId/validation` | `medicaid.validation.read_run` | ✅ |
| 24-billing-medicaid | `medicaid.claim.submissions` | `/medicaid/billing/claims/:claimId/submissions` | `medicaid.claim.read` | ✅ |
| 24-billing-medicaid | `medicaid.claim.acknowledgments` | `/medicaid/billing/claims/:claimId/acknowledgments` | `medicaid.claim.read` | ✅ |
| 24-billing-medicaid | `medicaid.validation-worklist` | `/medicaid/billing/validation-worklist` | `medicaid.validation.read_run` | ✅ |
| 24-billing-medicaid | `medicaid.rb-arrangements` | `/medicaid/billing/rb-arrangements` | `medicaid.rb_arrangement.read` | ✅ |
| 24-billing-medicaid | `medicaid.rb-arrangement` | `/medicaid/billing/rb-arrangements/:arrangementId` | `medicaid.rb_arrangement.read` | ✅ |
| 24-billing-medicaid | `medicaid.rule-config` | `/medicaid/billing/rule-config` | `medicaid.rule_config.read` | ✅ |
| 24-billing-medicaid | `medicaid.eligibility` | `/medicaid/billing/eligibility` | `medicaid.eligibility.read` | ✅ |
| 24-billing-medicaid | `medicaid.trading-partners` | `/medicaid/billing/trading-partner-credentials` | `medicaid.trading_partner.read` | ✅ |
| 24-billing-medicaid | `medicaid.overrides` | `/medicaid/billing/override-audit` | `medicaid.validation.read_override` | ✅ |
| 24-billing-medicaid | `medicaid.metrics` | `/medicaid/billing/metrics` | `medicaid.claim.read_metrics` | ✅ |
| 24-billing-medicaid | `medicaid.surveyor-read` | `/admin/medicaid-billing-audit/:claimId` | `medicaid.claim.read` | ✅ |
| 25-remittance | `remittance.worklist` | `/remittance` | `remittance.read` | ✅ |
| 25-remittance | `remittance.denials` | `/remittance/denials` | `denial.worklist.read` | ✅ |
| 25-remittance | `remittance.appeals` | `/remittance/appeals` | `appeal.read` | ✅ |
| 25-remittance | `remittance.taxonomy` | `/remittance/taxonomy` | `taxonomy.read` | ✅ |
| 26-cap | `cap.dashboard` | `/cap` | `cap.projection.read` | ✅ |
| 26-cap | `cap.periods` | `/cap/periods` | `cap.period.read` | ✅ |
| 26-cap | `cap.events` | `/cap/events` | `cap.event.read` | ✅ |
| 26-cap | `cap.settlement` | `/cap/settlements` | `cap.settlement.read` | ✅ |
| 26-cap | `cap.psr` | `/cap/psr` | `cap.psr.read` | ✅ |
| 26-cap | `cap.platform_constants` | `/platform/cap/constants` | `cap.platform_constant.read` | ✅ |
| 27-cost-report | `cost_report.list` | `/cost-reports` | `cost_report.read` | ✅ |
| 27-cost-report | `cost_report.workspace` | `/cost-reports/workspace` | `cost_report.read` | ✅ |
| 27-cost-report | `cost_report.validation` | `/cost-reports/validation` | `cost_report.read` | ✅ |
| 27-cost-report | `cost_report.rules` | `/cost-reports/rules` | `cost_report.read_rules` | ✅ |
| 27-cost-report | `cost_report.bad_debt` | `/cost-reports/bad-debt` | `cost_report.read` | ✅ |
| 27-cost-report | `cost_report.snapshots` | `/cost-reports/snapshots` | `cost_report.read_snapshot_detail` | ✅ |
| 30-quality | `quality.hub` | `/quality` | `quality.measure.read` | ✅ |
| 30-quality | `quality.qapi-incidents` | `/quality/qapi` | `incident.read` | ✅ |
| 33-reporting | `reporting.catalog` | `/reports` | `report.dashboard.list` | ✅ |
| 33-reporting | `reporting.dashboard` | `/reports/dashboards/:dashboardId` | `report.dashboard.read` | ✅ |
| 33-reporting | `reporting.role-dashboard` | `/reports/role/:roleKey` | `report.dashboard.read` | ✅ |
| 33-reporting | `reporting.schedules` | `/reports/schedules` | `report.schedule.list` | ✅ |
| 33-reporting | `reporting.admin` | `/reports/admin` | `report.admin.mv_list` | ✅ |
| 34-saas | `saas.tenants` | `/tenants` | `tenant.list_platform` | ✅ |
| 34-saas | `saas.tenant-overview` | `/tenants/:orgSlug` | `tenant.read_platform` | ✅ |
| 34-saas | `saas.support-sessions` | `/support/sessions` | `support_session.list_platform` | ✅ |
| 34-saas | `saas.dsar-queue` | `/exports/dsar` | `dsar_export.list_own` | ✅ |
| 34-saas | `saas.tenant-export-queue` | `/exports/tenant` | `tenant_export.list_own` | ✅ |
| 34-saas | `saas.onboarding-templates` | `/onboarding/templates` | `onboarding_template.list` | ✅ |
| 34-saas | `saas.feature-flags` | `/feature-flags` | `feature_flag.read_platform` | ✅ |
| 34-saas | `saas.baa-register` | `/baa` | `platform_tenant_baa.read_platform` | ✅ |
| 34-saas | `saas.signups` | `/signups` | `signup_intent.list_platform` | ✅ |
| 34-saas | `saas.key-rings` | `/key-rings` | `tenant.read_platform` | ✅ |
| 34-saas | `saas.account` | `/admin/account` | `tenant.read_own` | ✅ |
| 34-saas | `saas.onboarding` | `/admin/onboarding` | `onboarding.read_own` | ✅ |
| 34-saas | `saas.support-grants` | `/admin/support-grants` | `support_consent_grant.list_own` | ✅ |
| 36-messaging | `messaging.staff` | `/messaging` | `messaging.read` | ✅ |
| 36-messaging | `messaging.notifications` | `/notifications` | `(none)` | ✅ |
| 38-terminology | `terminology.admin` | `/terminology` | `(none)` | ✅ |
| 39-consent | `consent.record-manager` | `/patients/:patientId/consents` | `consent.read` | ✅ |
| 39-consent | `consent.expiration-renewal` | `/patients/:patientId/consents/expiring` | `consent.read` | ✅ |
| 39-consent | `consent.recipients-dpoa` | `/consents/:consentId/recipients` | `consent.read` | ✅ |
| 40-mdm | `mdm.console` | `/mdm` | `(none)` | ✅ |

## Hard-fail consistency checks

- ✅ No duplicate screen ids/paths, all `requiredPermission`s resolve, all module screen-sets are registered.
