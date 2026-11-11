# ChartWarden — E2E / Axe Coverage Report

> **Generated, advisory report** (`bun run e2e:coverage`). Static analysis over `e2e/specs/` source text against the built `web`-app screen registry — see the script header for what "reached" means and its known heuristic limits. Do not hand-edit — the `arch:e2e-coverage --check` gate (in `arch:fitness`) keeps it in sync with source.

**Coverage:** 217 statically-routable `web` screen(s) — 205/217 E2E-reached, 205/217 axe-reached.

## Zero E2E coverage

| Screen id | Module | Path | Permission |
|---|---|---|---|
| `identity.auditor-enrolment` | 02-identity | `/auditor/enrol` | (none) |
| `identity.auditor-redeem` | 02-identity | `/auditor/redeem` | (none) |
| `scheduling.calendar` | 17-scheduling | `/calendar` | (none) |
| `messaging.family-contact` | 36-messaging | `/family/open` | (none) |
| `identity.forgot-password` | 02-identity | `/forgot` | (none) |
| `identity.mfa-challenge` | 02-identity | `/login/2fa` | (none) |
| `identity.required-password-change` | 02-identity | `/login/change-password` | (none) |
| `identity.passkey-enrolment` | 02-identity | `/login/passkey` | (none) |
| `messaging.devices` | 36-messaging | `/messaging/devices` | (none) |
| `messaging.notifications` | 36-messaging | `/notifications` | (none) |
| `messaging.partner-share` | 36-messaging | `/partner/share` | (none) |
| `identity.reset-password` | 02-identity | `/reset-password` | (none) |

## Zero axe coverage

| Screen id | Module | Path | Permission |
|---|---|---|---|
| `identity.auditor-enrolment` | 02-identity | `/auditor/enrol` | (none) |
| `identity.auditor-redeem` | 02-identity | `/auditor/redeem` | (none) |
| `scheduling.calendar` | 17-scheduling | `/calendar` | (none) |
| `messaging.family-contact` | 36-messaging | `/family/open` | (none) |
| `identity.forgot-password` | 02-identity | `/forgot` | (none) |
| `identity.mfa-challenge` | 02-identity | `/login/2fa` | (none) |
| `identity.required-password-change` | 02-identity | `/login/change-password` | (none) |
| `identity.passkey-enrolment` | 02-identity | `/login/passkey` | (none) |
| `messaging.devices` | 36-messaging | `/messaging/devices` | (none) |
| `messaging.notifications` | 36-messaging | `/notifications` | (none) |
| `messaging.partner-share` | 36-messaging | `/partner/share` | (none) |
| `identity.reset-password` | 02-identity | `/reset-password` | (none) |

## Dynamic web screens (#852)

42/118 registered `web` screens carrying a `:param` segment are axe-walked in `axe-route-walk.spec.ts`: patient-only paths plus seeded admission, Medicaid-claim and medication-order paths. Every id is resolved at run time through the signed-in app; none is copied from a seed constant. The rest are excluded, each with its reason:

| Screen id | Path | Permission | Why not walked |
|---|---|---|---|
| `medicaid.surveyor-read` | `/admin/medicaid-billing-audit/:claimId` | medicaid.claim.read | needs another seeded resource id (plan, meeting, consent, event, ...) with no run-time discovery helper yet |
| `hope.sfv-capture` | `/admissions/:admissionId/hope/sfv/:sfvId` | hope.timepoint.write | needs another seeded resource id (plan, meeting, consent, event, ...) with no run-time discovery helper yet |
| `hope.timepoint-capture` | `/admissions/:admissionId/hope/timepoints/:kind` | hope.timepoint.write | needs another seeded resource id (plan, meeting, consent, event, ...) with no run-time discovery helper yet |
| `bereavement.groups.detail` | `/bereavement/groups/:groupId` | bereavement.group.read | needs another seeded resource id (plan, meeting, consent, event, ...) with no run-time discovery helper yet |
| `bereavement.mailings.run` | `/bereavement/mailings/runs/:runId` | bereavement.mailing.read | needs another seeded resource id (plan, meeting, consent, event, ...) with no run-time discovery helper yet |
| `bereavement.memorials.detail` | `/bereavement/memorials/:serviceId` | bereavement.memorial.rsvp | needs another seeded resource id (plan, meeting, consent, event, ...) with no run-time discovery helper yet |
| `bereavement.plan` | `/bereavement/plans/:planId` | bereavement.plan.read | needs another seeded resource id (plan, meeting, consent, event, ...) with no run-time discovery helper yet |
| `bereavement.plan.closeout` | `/bereavement/plans/:planId/closeout` | bereavement.plan.read | needs another seeded resource id (plan, meeting, consent, event, ...) with no run-time discovery helper yet |
| `bereavement.contact` | `/bereavement/plans/:planId/contacts/:contactId` | bereavement.plan.read | needs another seeded resource id (plan, meeting, consent, event, ...) with no run-time discovery helper yet |
| `bereavement.contact.screen` | `/bereavement/plans/:planId/contacts/:contactId/screen` | bereavement.contact.flag_complicated_grief | needs another seeded resource id (plan, meeting, consent, event, ...) with no run-time discovery helper yet |
| `bereavement.plan.history` | `/bereavement/plans/:planId/history` | bereavement.plan.read | needs another seeded resource id (plan, meeting, consent, event, ...) with no run-time discovery helper yet |
| `bereavement.plan.outreach` | `/bereavement/plans/:planId/outreach` | bereavement.outreach.read | needs another seeded resource id (plan, meeting, consent, event, ...) with no run-time discovery helper yet |
| `bereavement.plan.risk` | `/bereavement/plans/:planId/risk` | bereavement.risk.read | needs another seeded resource id (plan, meeting, consent, event, ...) with no run-time discovery helper yet |
| `bereavement.plan.seed` | `/bereavement/plans/:planId/seed` | bereavement.plan.activate | needs another seeded resource id (plan, meeting, consent, event, ...) with no run-time discovery helper yet |
| `bereavement.predeath` | `/bereavement/pre-death/:admissionId` | bereavement.assessment_draft.read | needs another seeded resource id (plan, meeting, consent, event, ...) with no run-time discovery helper yet |
| `billing.claim` | `/billing/claims/:claimId` | billing.claim.read | needs another seeded resource id (plan, meeting, consent, event, ...) with no run-time discovery helper yet |
| `billing.claim.acknowledgments` | `/billing/claims/:claimId/acknowledgments` | billing.claim.read | needs another seeded resource id (plan, meeting, consent, event, ...) with no run-time discovery helper yet |
| `billing.claim.submissions` | `/billing/claims/:claimId/submissions` | billing.claim.read | needs another seeded resource id (plan, meeting, consent, event, ...) with no run-time discovery helper yet |
| `billing.claim.validation` | `/billing/claims/:claimId/validation` | billing.validation.read_run | needs another seeded resource id (plan, meeting, consent, event, ...) with no run-time discovery helper yet |
| `billing.noe.detail` | `/billing/noe/:noeId` | billing.noe.read | needs another seeded resource id (plan, meeting, consent, event, ...) with no run-time discovery helper yet |
| `billing.notr.detail` | `/billing/notr/:notrId` | billing.notr.read | needs another seeded resource id (plan, meeting, consent, event, ...) with no run-time discovery helper yet |
| `care-plan.summary` | `/care-plans/:planId/summary` | care_plan.read_summary | needs another seeded resource id (plan, meeting, consent, event, ...) with no run-time discovery helper yet |
| `care-plan.versions` | `/care-plans/:planId/versions` | care_plan.read | needs another seeded resource id (plan, meeting, consent, event, ...) with no run-time discovery helper yet |
| `care-plan.version-detail` | `/care-plans/:planId/versions/:versionId` | care_plan.read | needs another seeded resource id (plan, meeting, consent, event, ...) with no run-time discovery helper yet |
| `commercial.claim` | `/commercial/billing/claims/:claimId` | commercial_billing.read | needs another seeded resource id (plan, meeting, consent, event, ...) with no run-time discovery helper yet |
| `commercial.claim-send-gate` | `/commercial/billing/claims/:claimId/send-gate` | commercial_billing.read | needs another seeded resource id (plan, meeting, consent, event, ...) with no run-time discovery helper yet |
| `commercial.claim-timeline` | `/commercial/billing/claims/:claimId/timeline` | commercial_billing.read | needs another seeded resource id (plan, meeting, consent, event, ...) with no run-time discovery helper yet |
| `consent.recipients-dpoa` | `/consents/:consentId/recipients` | consent.read | needs another seeded resource id (plan, meeting, consent, event, ...) with no run-time discovery helper yet |
| `admission.discharge-cosign` | `/discharges/:id/cosign` | discharge.cosign_for_cause | needs another seeded resource id (plan, meeting, consent, event, ...) with no run-time discovery helper yet |
| `documents.version-history` | `/documents/:documentId/versions` | documents.read_history | needs another seeded resource id (plan, meeting, consent, event, ...) with no run-time discovery helper yet |
| `evv.event-detail` | `/evv/events/:eventId` | evv.read | needs another seeded resource id (plan, meeting, consent, event, ...) with no run-time discovery helper yet |
| `hope.assessment-detail` | `/hope/assessments/:id` | hope.timepoint.read | needs another seeded resource id (plan, meeting, consent, event, ...) with no run-time discovery helper yet |
| `hope.submission-detail` | `/hope/submissions/:id` | hope.submission.read | needs another seeded resource id (plan, meeting, consent, event, ...) with no run-time discovery helper yet |
| `idg.meeting-detail` | `/idg/meetings/:id` | idg.read | needs another seeded resource id (plan, meeting, consent, event, ...) with no run-time discovery helper yet |
| `idg.meeting-live` | `/idg/meetings/:id/live` | idg.read | needs another seeded resource id (plan, meeting, consent, event, ...) with no run-time discovery helper yet |
| `idg.minutes` | `/idg/meetings/:id/minutes` | idg.read | needs another seeded resource id (plan, meeting, consent, event, ...) with no run-time discovery helper yet |
| `idg.packet` | `/idg/meetings/:meetingId/packets/:patientId` | idg.read | needs another seeded resource id (plan, meeting, consent, event, ...) with no run-time discovery helper yet |
| `documents.intake-batch` | `/intake/:batchId` | intake.read | needs another seeded resource id (plan, meeting, consent, event, ...) with no run-time discovery helper yet |
| `intake.review-workspace` | `/intake/:batchId/review` | intake.review | needs another seeded resource id (plan, meeting, consent, event, ...) with no run-time discovery helper yet |
| `identity.accept-invitation` | `/invite/:token` | (none) | pre-auth token route: needs a live single-use invite/link token and a signed-out context |
| `ipu.bedside` | `/ipu/admissions/:id` | m37.ipu_admission.read | needs another seeded resource id (plan, meeting, consent, event, ...) with no run-time discovery helper yet |
| `medicaid.rb-arrangement` | `/medicaid/billing/rb-arrangements/:arrangementId` | medicaid.rb_arrangement.read | needs another seeded resource id (plan, meeting, consent, event, ...) with no run-time discovery helper yet |
| `messaging.offboarding` | `/messaging/governance/offboarding/:userId` | messaging.offboarding.manage | needs another seeded resource id (plan, meeting, consent, event, ...) with no run-time discovery helper yet |
| `messaging.notification-landing` | `/n/:id` | (none) | pre-auth token route: needs a live single-use invite/link token and a signed-out context |
| `orders.detail` | `/orders/:id` | orders.read | needs another seeded resource id (plan, meeting, consent, event, ...) with no run-time discovery helper yet |
| `emar.administration-detail` | `/patients/:patientId/administrations/:id` | administration.read | needs another seeded resource id (plan, meeting, consent, event, ...) with no run-time discovery helper yet |
| `assessment.detail` | `/patients/:patientId/assessments/:assessmentId` | assessment.read | needs another seeded resource id (plan, meeting, consent, event, ...) with no run-time discovery helper yet |
| `emar.comfort-kit` | `/patients/:patientId/comfort-kit/:deploymentId` | comfort_kit.read | needs another seeded resource id (plan, meeting, consent, event, ...) with no run-time discovery helper yet |
| `consent.detail` | `/patients/:patientId/consents/:consentId` | consent.read | needs another seeded resource id (plan, meeting, consent, event, ...) with no run-time discovery helper yet |
| `discipline-plan.idg-revision` | `/patients/:patientId/discipline-plans/:kind/idg-revisions/:versionId` | discipline_plan.idg_revise | needs another seeded resource id (plan, meeting, consent, event, ...) with no run-time discovery helper yet |
| `discipline-plan.versions` | `/patients/:patientId/discipline-plans/:kind/versions` | discipline_plan.read | needs another seeded resource id (plan, meeting, consent, event, ...) with no run-time discovery helper yet |
| `discipline-plan.aide-poc.edit` | `/patients/:patientId/discipline-plans/aide-poc/:versionId/edit` | discipline_plan.author | needs another seeded resource id (plan, meeting, consent, event, ...) with no run-time discovery helper yet |
| `discipline-plan.assessment` | `/patients/:patientId/discipline-plans/msw-plan/:planId/assessments/:assessmentId` | discipline_assessment.author | needs another seeded resource id (plan, meeting, consent, event, ...) with no run-time discovery helper yet |
| `encounter.read` | `/patients/:patientId/encounters/:encounterId` | encounter.read | needs another seeded resource id (plan, meeting, consent, event, ...) with no run-time discovery helper yet |
| `encounter.compose` | `/patients/:patientId/encounters/:encounterId/compose` | encounter.author | needs another seeded resource id (plan, meeting, consent, event, ...) with no run-time discovery helper yet |
| `emar.iv-session` | `/patients/:patientId/iv-sessions/:sessionId` | administration.read | needs another seeded resource id (plan, meeting, consent, event, ...) with no run-time discovery helper yet |
| `emar.reconciliation-worksheet` | `/patients/:patientId/reconciliation/:worksheetId` | reconciliation.read | needs another seeded resource id (plan, meeting, consent, event, ...) with no run-time discovery helper yet |
| `assessment.scale-trend` | `/patients/:patientId/scales/:scaleType` | assessment.read_trend | needs another seeded resource id (plan, meeting, consent, event, ...) with no run-time discovery helper yet |
| `admission.referral-detail` | `/referrals/:id` | referral.read | needs another seeded resource id (plan, meeting, consent, event, ...) with no run-time discovery helper yet |
| `prescribing.refill-detail` | `/refills/:id` | prescribing.read | needs another seeded resource id (plan, meeting, consent, event, ...) with no run-time discovery helper yet |
| `reporting.dashboard` | `/reports/dashboards/:dashboardId` | report.dashboard.read | needs another seeded resource id (plan, meeting, consent, event, ...) with no run-time discovery helper yet |
| `reporting.role-dashboard` | `/reports/role/:roleKey` | report.dashboard.read | needs another seeded resource id (plan, meeting, consent, event, ...) with no run-time discovery helper yet |
| `safety.incident.detail` | `/safety/incidents/:incidentId` | safety_incident.read | needs another seeded resource id (plan, meeting, consent, event, ...) with no run-time discovery helper yet |
| `safety.sos.detail` | `/safety/sos/:sosAlertId` | safety.sos.read | needs another seeded resource id (plan, meeting, consent, event, ...) with no run-time discovery helper yet |
| `scheduling.visit-detail` | `/scheduling/visits/:visitId` | visit.read | needs another seeded resource id (plan, meeting, consent, event, ...) with no run-time discovery helper yet |
| `billing.invoice-detail` | `/subscription/invoices/:id` | invoice.read | needs another seeded resource id (plan, meeting, consent, event, ...) with no run-time discovery helper yet |
| `supplies.dispatch` | `/supplies/dispatches/:dispatchId` | comfort_kit.dispatch.read | needs another seeded resource id (plan, meeting, consent, event, ...) with no run-time discovery helper yet |
| `supplies.dispatch.perpetual_log` | `/supplies/dispatches/:dispatchId/perpetual-log` | comfort_kit.perpetual_log.read | needs another seeded resource id (plan, meeting, consent, event, ...) with no run-time discovery helper yet |
| `supplies.request` | `/supplies/requests/:supplyRequestId` | supplies.request.read | needs another seeded resource id (plan, meeting, consent, event, ...) with no run-time discovery helper yet |
| `supplies.return` | `/supplies/returns/:returnId` | comfort_kit.return.read | needs another seeded resource id (plan, meeting, consent, event, ...) with no run-time discovery helper yet |
| `identity.accept-tenant-invitation` | `/tenant-invite/:token` | (none) | pre-auth token route: needs a live single-use invite/link token and a signed-out context |
| `triage.call` | `/triage/calls/:triageCallId` | triage.read | needs another seeded resource id (plan, meeting, consent, event, ...) with no run-time discovery helper yet |
| `triage.call.history` | `/triage/calls/:triageCallId/history` | triage.read | needs another seeded resource id (plan, meeting, consent, event, ...) with no run-time discovery helper yet |
| `triage.call.transcript` | `/triage/calls/:triageCallId/transcript` | triage.read_transcript | needs another seeded resource id (plan, meeting, consent, event, ...) with no run-time discovery helper yet |
| `triage.protocol` | `/triage/protocols/:protocolId` | triage.read | needs another seeded resource id (plan, meeting, consent, event, ...) with no run-time discovery helper yet |
| `oncall.shift` | `/triage/shifts/:shiftId` | oncall.read_schedule | needs another seeded resource id (plan, meeting, consent, event, ...) with no run-time discovery helper yet |

## Viewports, admin/portal, authorization (#852)

- **Six viewports** (320, 375, 768, 1024, 1440, 1920 wide) — `viewport-matrix.spec.ts`, run only by the `viewport-*` Playwright projects (`bun run test:e2e:viewports`): Home, census and a patient chart, axe plus a no-horizontal-document-scroll (WCAG 1.4.10) check. Not multiplied across the other specs.
- **`admin`/`portal` apps** (39 + 19 registered screens) — `admin-console-smoke.spec.ts` and `portal-smoke.spec.ts` (`bun run test:e2e:apps`): pre-auth plus authenticated platform-ops and patient-self surfaces. CI starts all three SPAs and supplies `E2E_ADMIN_URL` / `E2E_PORTAL_URL`; local runs skip unless those URLs point at running servers. Credentials come from the synthetic seed, and portal password sign-in avoids a mail sink.
- **Cross-role authorization** — `role-authorization-matrix.spec.ts`: the clinical-only Clinician is denied on billing, agency-setup, audit and staff reads; the Compliance Auditor is denied on billing and agency setup but allowed to read audit events; the Administrator is allowed across the matrix.

## Not measured here (by design)

- **Keyboard operation, focus order, zoom, contrast on high-risk clinical forms, and screen-reader behavior** — not automatable by an axe scan; follow the manual protocol in [`docs/testing/manual-a11y-protocol.md`](../../docs/testing/manual-a11y-protocol.md) and record results there.

