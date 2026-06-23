# WardenX — UI Implementation-Parity Report

> **Generated, advisory report** (`bun run ui:parity`). `docs:ui` proves the screen-spec
> corpus is consistent; this shows how much of it is BUILT in `apps/web`. Do not hand-edit —
> the `ui:parity --check` gate (in `arch:fitness`) keeps it in sync with source.

**Coverage:** 69 documented screen specs · 18 module screen-sets registered · 87 screens wired in `apps/web`.

> The documented vs implemented counts are a deliberate gap *summary*, not a per-screen join: UI specs are feature-named docs with no shared key to a registered screen, and screen `path`s are frontend routes (not API paths). The per-screen table below is the precise, checkable surface.

## Documented surface (by category)

- **admin**: 14 spec(s)
- **clinical**: 29 spec(s)
- **core**: 10 spec(s)
- **platform**: 4 spec(s)
- **portal**: 5 spec(s)
- **revenue**: 7 spec(s)

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
| 36-messaging | `messaging.staff` | `/messaging` | `messaging.read` | ✅ |
| 36-messaging | `messaging.notifications` | `/notifications` | `(none)` | ✅ |
| 38-terminology | `terminology.admin` | `/terminology` | `(none)` | ✅ |
| 40-mdm | `mdm.console` | `/mdm` | `(none)` | ✅ |

## Hard-fail consistency checks

- ✅ No duplicate screen ids/paths, all `requiredPermission`s resolve, all module screen-sets are registered.
