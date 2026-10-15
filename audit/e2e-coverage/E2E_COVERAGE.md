# WardenX — E2E / Axe Coverage Report

> **Generated, advisory report** (`bun run e2e:coverage`). Static analysis over `e2e/specs/` source text against the built `web`-app screen registry — see the script header for what "reached" means and its known heuristic limits. Do not hand-edit — the `arch:e2e-coverage --check` gate (in `arch:fitness`) keeps it in sync with source.

**Coverage:** 179 statically-routable `web` screen(s) — 19/179 E2E-reached, 170/179 axe-reached.

## Zero E2E coverage

| Screen id | Module | Path | Permission |
|---|---|---|---|
| `saas.account` | 34-saas | `/admin/account` | tenant.read_own |
| `emar.administration-policy` | 13-emar | `/admin/administration-policy` | administration.admin.policy |
| `billing.surveyor-audit` | 23-billing-medicare | `/admin/billing-audit` | billing.claim.read |
| `evv.metrics` | 18-evv | `/admin/evv-metrics` | evv.read_metrics |
| `documents.template-library` | 22-documents | `/admin/forms/templates` | documents.read_templates |
| `saas.onboarding` | 34-saas | `/admin/onboarding` | onboarding.read_own |
| `portal.admin` | 31-portal | `/admin/portal` | portal.account.read_list |
| `prescribing.prescriber-roster` | 12-dosespot | `/admin/prescribers` | prescribing.admin.roster |
| `prescribing.policy` | 12-dosespot | `/admin/prescribing-policy` | prescribing.admin.policy |
| `assessment.scale-licenses` | 09-assessments | `/admin/scales/licenses` | assessment.license_read |
| `assessment.scale-policies` | 09-assessments | `/admin/scales/policies` | assessment.policy_read |
| `scheduling.metrics` | 17-scheduling | `/admin/scheduling-metrics` | visit.read_metrics |
| `saas.agency-setup` | 34-saas | `/admin/setup` | org.manage |
| `saas.support-grants` | 34-saas | `/admin/support-grants` | support_consent_grant.list_own |
| `volunteer.compliance` | 15-discipline-care-plans | `/admin/volunteer-compliance` | volunteer_compliance.read |
| `volunteer.ratio` | 15-discipline-care-plans | `/admin/volunteer-ratio` | volunteer_compliance.read_ratio |
| `admission.census` | 06-admission | `/admissions` | admission.read |
| `admission.discharges` | 06-admission | `/admissions/discharges` | discharge.create |
| `admission.readmit-list` | 06-admission | `/admissions/readmit` | admission.create |
| `audit.log-viewer` | 04-audit | `/audit` | audit.read |
| `identity.auditor-enrolment` | 02-identity | `/auditor/enrol` | (none) |
| `identity.auditor-redeem` | 02-identity | `/auditor/redeem` | (none) |
| `bereavement.caseload` | 16-bereavement | `/bereavement` | bereavement.dashboard.counselor |
| `bereavement.intake` | 16-bereavement | `/bereavement/eligible` | bereavement.plan.assign_counselor |
| `bereavement.supervisor` | 16-bereavement | `/bereavement/supervisor` | bereavement.dashboard.supervisor |
| `billing.claim.new` | 23-billing-medicare | `/billing/claims/new` | billing.claim.assemble |
| `billing.dde-queue` | 23-billing-medicare | `/billing/dde` | billing.dde.read |
| `billing.eligibility` | 23-billing-medicare | `/billing/eligibility` | billing.eligibility.read |
| `billing.mac-credentials` | 23-billing-medicare | `/billing/mac-credentials` | billing.mac_credential.read |
| `billing.metrics` | 23-billing-medicare | `/billing/metrics` | billing.claim.read_metrics |
| `billing.noe` | 23-billing-medicare | `/billing/noe` | billing.noe.read |
| `billing.notr` | 23-billing-medicare | `/billing/notr` | billing.notr.read |
| `billing.overrides` | 23-billing-medicare | `/billing/overrides` | billing.validation.read_override |
| `billing.rate-tables` | 23-billing-medicare | `/billing/rate-tables` | billing.rate_table.read |
| `billing.rule-config` | 23-billing-medicare | `/billing/rule-config` | billing.rule_config.read |
| `billing.sequestration` | 23-billing-medicare | `/billing/sequestration-policy` | billing.sequestration_policy.read |
| `billing.transfer-notices` | 23-billing-medicare | `/billing/transfer-notices` | billing.noe.read |
| `billing.wage-indexes` | 23-billing-medicare | `/billing/wage-indexes` | billing.wage_index.read |
| `scheduling.calendar` | 17-scheduling | `/calendar` | (none) |
| `cap.dashboard` | 26-cap | `/cap` | cap.projection.read |
| `cap.events` | 26-cap | `/cap/events` | cap.event.read |
| `cap.periods` | 26-cap | `/cap/periods` | cap.period.read |
| `cap.psr` | 26-cap | `/cap/psr` | cap.psr.read |
| `cap.settlement` | 26-cap | `/cap/settlements` | cap.settlement.read |
| `admission.compliance` | 06-admission | `/compliance/admissions` | compliance.read |
| `ai.compliance` | 32-ai-platform | `/compliance/ai` | ai.invocation.read |
| `audit.exports` | 04-audit | `/compliance/audit/exports` | audit.export |
| `audit.integrity-report` | 04-audit | `/compliance/audit/integrity` | audit.integrity |
| `audit.legal-holds` | 04-audit | `/compliance/legal-holds` | legalhold.read |
| `privacy.restricted-patients` | 05-patient | `/compliance/privacy` | privacy.admin |
| `audit.privacy-requests` | 04-audit | `/compliance/privacy-requests` | audit.disclosure_report |
| `cost_report.list` | 27-cost-report | `/cost-reports` | cost_report.read |
| `cost_report.bad_debt` | 27-cost-report | `/cost-reports/bad-debt` | cost_report.read |
| `cost_report.rules` | 27-cost-report | `/cost-reports/rules` | cost_report.read_rules |
| `cost_report.snapshots` | 27-cost-report | `/cost-reports/snapshots` | cost_report.read_snapshot_detail |
| `cost_report.validation` | 27-cost-report | `/cost-reports/validation` | cost_report.read |
| `cost_report.workspace` | 27-cost-report | `/cost-reports/workspace` | cost_report.read |
| `evv.aggregator-submissions` | 18-evv | `/evv/aggregator-submissions` | evv.aggregator.read |
| `evv.dashboard` | 18-evv | `/evv/dashboard` | evv.read_metrics |
| `evv.events` | 18-evv | `/evv/events` | evv.read |
| `evv.geofence-policy` | 18-evv | `/evv/geofence-policy` | evv.policy.read |
| `evv.missing-resolutions` | 18-evv | `/evv/missing-resolutions` | evv.missing_resolution.read |
| `identity.forgot-password` | 02-identity | `/forgot` | (none) |
| `hope.dashboard` | 10-hope | `/hope` | hope.schedule.read |
| `hope.compliance` | 10-hope | `/hope/compliance` | hope.dashboard.read |
| `hope.sfv-worklist` | 10-hope | `/hope/sfv` | hope.sfv.read |
| `hope.submission-worklist` | 10-hope | `/hope/submissions` | hope.submission.read |
| `idg.action-items` | 14-idg | `/idg/action-items` | idg.read |
| `intake.review-queue` | 22-documents | `/intake` | intake.read |
| `ipu.units` | 37-ipu | `/ipu` | m37.unit.read |
| `ipu.census` | 37-ipu | `/ipu/census` | m37.census.read |
| `ipu.equipment` | 37-ipu | `/ipu/equipment` | m37.equipment.read |
| `identity.mfa-challenge` | 02-identity | `/login/2fa` | (none) |
| `identity.required-password-change` | 02-identity | `/login/change-password` | (none) |
| `identity.organization-select` | 02-identity | `/login/organization` | (none) |
| `identity.passkey-enrolment` | 02-identity | `/login/passkey` | (none) |
| `mdm.console` | 40-mdm | `/mdm` | mdm.physician.read |
| `ai.my-preferences` | 32-ai-platform | `/me/ai-preferences` | ai.clinician_opt_out.read |
| `oncall.me` | 19-oncall | `/me/oncall` | oncall.read_schedule |
| `safety.me` | 20-field-safety | `/me/safety` | safety.sos.raise |
| `safety.me.check_ins` | 20-field-safety | `/me/safety/check-ins` | safety.check_in.read |
| `safety.me.consent` | 20-field-safety | `/me/safety/consent` | safety.consent.read_self |
| `scheduling.my-visits` | 17-scheduling | `/me/visits` | visit.read |
| `medicaid.ar-dashboard` | 24-billing-medicaid | `/medicaid/billing/ar-dashboard` | medicaid.claim.read_ar_dashboard |
| `medicaid.claim.new` | 24-billing-medicaid | `/medicaid/billing/claims/new` | medicaid.claim.assemble |
| `medicaid.eligibility` | 24-billing-medicaid | `/medicaid/billing/eligibility` | medicaid.eligibility.read |
| `medicaid.metrics` | 24-billing-medicaid | `/medicaid/billing/metrics` | medicaid.claim.read_metrics |
| `medicaid.overrides` | 24-billing-medicaid | `/medicaid/billing/override-audit` | medicaid.validation.read_override |
| `medicaid.rb-arrangements` | 24-billing-medicaid | `/medicaid/billing/rb-arrangements` | medicaid.rb_arrangement.read |
| `medicaid.rule-config` | 24-billing-medicaid | `/medicaid/billing/rule-config` | medicaid.rule_config.read |
| `medicaid.trading-partners` | 24-billing-medicaid | `/medicaid/billing/trading-partner-credentials` | medicaid.trading_partner.read |
| `medicaid.validation-worklist` | 24-billing-medicaid | `/medicaid/billing/validation-worklist` | medicaid.validation.read_run |
| `messaging.staff` | 36-messaging | `/messaging` | messaging.read |
| `messaging.saved-replies` | 36-messaging | `/messaging/saved-replies` | messaging.send |
| `messaging.global-search-settings` | 36-messaging | `/messaging/search-settings` | messaging.global_search.manage |
| `messaging.notifications` | 36-messaging | `/notifications` | (none) |
| `orders.held-transmissions` | 11-orders | `/orders/held-transmissions` | orders.transmission.view_held |
| `orders.results-review` | 11-orders | `/orders/results-pending-review` | orders.read |
| `orders.verbal-expiring` | 11-orders | `/orders/verbal-expiring` | orders.read |
| `ai.opt-in` | 32-ai-platform | `/organization/ai/opt-in` | ai.tenant_opt_in |
| `ai.routing` | 32-ai-platform | `/organization/ai/routing` | ai.tenant_opt_in |
| `cap.platform_constants` | 26-cap | `/platform/cap/constants` | cap.platform_constant.read |
| `prescribing.sign-inbox` | 12-dosespot | `/prescribing/sign-inbox` | prescribing.read |
| `prescribing.verbal-orders` | 12-dosespot | `/prescribing/verbal-orders` | prescribing.read |
| `quality.hub` | 30-quality | `/quality` | quality.measure.read |
| `quality.mortality` | 30-quality | `/quality/mortality` | mortality.read |
| `quality.qapi-incidents` | 30-quality | `/quality/qapi` | incident.read |
| `admission.referral-new` | 06-admission | `/referrals/new` | referral.create |
| `prescribing.refill-inbox` | 12-dosespot | `/refills` | prescribing.read |
| `remittance.worklist` | 25-remittance | `/remittance` | remittance.read |
| `remittance.adrs` | 25-remittance | `/remittance/adrs` | adr.read |
| `remittance.appeals` | 25-remittance | `/remittance/appeals` | appeal.read |
| `remittance.denials` | 25-remittance | `/remittance/denials` | denial.worklist.read |
| `remittance.taxonomy` | 25-remittance | `/remittance/taxonomy` | taxonomy.read |
| `reporting.admin` | 33-reporting | `/reports/admin` | report.admin.mv_list |
| `reporting.schedules` | 33-reporting | `/reports/schedules` | report.schedule.list |
| `identity.reset-password` | 02-identity | `/reset-password` | (none) |
| `authz.roles-permissions` | 03-authorization | `/roles` | role.read |
| `safety.dashboard` | 20-field-safety | `/safety` | safety.dashboard.read |
| `safety.check_ins` | 20-field-safety | `/safety/check-ins` | safety.dashboard.read |
| `safety.high_risk_areas` | 20-field-safety | `/safety/high-risk-areas` | safety.high_risk_area.read |
| `safety.incidents` | 20-field-safety | `/safety/incidents` | safety_incident.read |
| `safety.incident.new` | 20-field-safety | `/safety/incidents/new` | safety_incident.create |
| `safety.metrics` | 20-field-safety | `/safety/metrics` | safety.dashboard.read |
| `safety.policy` | 20-field-safety | `/safety/policy` | safety_policy.read |
| `safety.sos.active` | 20-field-safety | `/safety/sos` | safety.sos.read |
| `safety.subscriptions` | 20-field-safety | `/safety/supervisor-subscriptions` | safety_supervisor.read |
| `scheduling.clinician-credentials` | 17-scheduling | `/scheduling/clinician-credentials` | membership_credential.read |
| `scheduling.proposals` | 17-scheduling | `/scheduling/proposals` | visit.proposal.read |
| `scheduling.recurring` | 17-scheduling | `/scheduling/recurring` | recurring_visit.read |
| `scheduling.time-off` | 17-scheduling | `/scheduling/time-off` | time_off.read_team |
| `scheduling.week` | 17-scheduling | `/scheduling/week` | visit.read_team |
| `search.global` | 05-patient | `/search` | patient.read |
| `orders.standing` | 11-orders | `/standing-orders` | orders.read |
| `billing.overview` | 35-subscription | `/subscription` | subscription.read |
| `billing.dunning` | 35-subscription | `/subscription/dunning` | subscription.read |
| `billing.invoices` | 35-subscription | `/subscription/invoices` | invoice.read |
| `billing.payment-methods` | 35-subscription | `/subscription/payment_methods` | payment_method.read |
| `billing.plan` | 35-subscription | `/subscription/plan` | subscription.read |
| `billing.promos` | 35-subscription | `/subscription/promos` | subscription.read |
| `billing.usage` | 35-subscription | `/subscription/usage` | usage.read |
| `supplies.dashboard` | 21-supplies | `/supplies` | supplies.request.read |
| `supplies.comfort_kit_templates` | 21-supplies | `/supplies/comfort-kit-templates` | comfort_kit.template.read |
| `supplies.dispatch.new` | 21-supplies | `/supplies/dispatches/new` | comfort_kit.dispatch.create |
| `supplies.items` | 21-supplies | `/supplies/items` | supplies.item.read |
| `supplies.par_stock` | 21-supplies | `/supplies/par-stock` | par_stock.read |
| `supplies.vendor_routing` | 21-supplies | `/supplies/vendor-routing` | vendor_routing.read |
| `portal.telehealth` | 31-portal | `/telehealth` | telehealth.read_list |
| `terminology.admin` | 38-terminology | `/terminology` | terminology.read |
| `triage.queue` | 19-oncall | `/triage` | triage.read |
| `triage.escalations` | 19-oncall | `/triage/escalations` | triage.read_escalations |
| `triage.intake` | 19-oncall | `/triage/intake` | triage.open |
| `triage.metrics` | 19-oncall | `/triage/metrics` | triage.read |
| `triage.paper_reentry` | 19-oncall | `/triage/paper-reentry` | triage.paper_reentry |
| `oncall.policy` | 19-oncall | `/triage/policy` | oncall.read_policy |
| `triage.protocols` | 19-oncall | `/triage/protocols` | triage.read |
| `oncall.shifts` | 19-oncall | `/triage/shifts` | oncall.read_schedule |
| `oncall.vendors` | 19-oncall | `/triage/vendors` | oncall.read_policy |
| `encounter.cosignature-queue` | 08-encounters | `/work/cosignatures` | encounter.cosign |
| `encounter.my-drafts` | 08-encounters | `/work/drafts` | encounter.author |

## Zero axe coverage

| Screen id | Module | Path | Permission |
|---|---|---|---|
| `identity.auditor-enrolment` | 02-identity | `/auditor/enrol` | (none) |
| `identity.auditor-redeem` | 02-identity | `/auditor/redeem` | (none) |
| `scheduling.calendar` | 17-scheduling | `/calendar` | (none) |
| `identity.forgot-password` | 02-identity | `/forgot` | (none) |
| `identity.mfa-challenge` | 02-identity | `/login/2fa` | (none) |
| `identity.required-password-change` | 02-identity | `/login/change-password` | (none) |
| `identity.passkey-enrolment` | 02-identity | `/login/passkey` | (none) |
| `messaging.notifications` | 36-messaging | `/notifications` | (none) |
| `identity.reset-password` | 02-identity | `/reset-password` | (none) |

## Not measured here (by design)

- **Dynamic routes** (116 registered `web` screens carrying a `:param` segment) — opened by navigating from a list in their owning spec, the same way a real user reaches them; a per-screen static count would need a fabricated resource id this report will not invent.
- **`admin`/`portal` apps** (47 screens) — separate Vite dev servers this suite's single `baseURL` does not reach.
- **Keyboard operation, focus order, zoom, contrast on high-risk clinical forms, and screen-reader behavior** — not automatable by an axe scan; #106 names these as needing scheduled manual review.

