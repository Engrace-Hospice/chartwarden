# WardenX — UI Implementation-Parity Report

> **Generated, advisory report** (`bun run ui:parity`). `docs:ui` proves the screen-spec
> corpus is consistent; this shows how much of it is BUILT in `apps/web`. Do not hand-edit —
> the `ui:parity --check` gate (in `arch:fitness`) keeps it in sync with source.

**Coverage:** 69 documented screen specs · 12 module screen-sets registered · 41 screens wired in `apps/web`.

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
| 36-messaging | `messaging.staff` | `/messaging` | `messaging.read` | ✅ |
| 36-messaging | `messaging.notifications` | `/notifications` | `(none)` | ✅ |
| 38-terminology | `terminology.admin` | `/terminology` | `(none)` | ✅ |
| 40-mdm | `mdm.console` | `/mdm` | `(none)` | ✅ |

## Hard-fail consistency checks

- ✅ No duplicate screen ids/paths, all `requiredPermission`s resolve, all module screen-sets are registered.
