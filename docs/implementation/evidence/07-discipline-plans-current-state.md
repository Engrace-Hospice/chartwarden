# Workflow 07 — Discipline Plans Current-State Evidence

**Audit date:** 2026-11-17
**Branch:** `fix/m3-superadmin-migration-1501`
**Commit:** `cd1c1044439ee1838d2ed6663e2917e43cdf31bd`
**Scope:** WP0 only. No application code, migration, event contract, or production configuration was changed.

## Decision summary

Module 15 is implemented and mounted, with real server-side tenancy, caseload, permission, step-up,
idempotency, concurrency, redaction, audit, lifecycle, and event-consumer controls. The redesign should
reuse those controls and the existing patient workspace.

The current UI is not yet the target workflow:

- The patient overview is findable and responsive, but its cards do not expose owner/team, latest signed
  version, or a single authoritative next action (`plans-index.tsx:169-257`).
- Only the aide plan has a structured goal/intervention editor. MSW, spiritual, and volunteer screens are
  mostly read/review surfaces; the shared API supports writes, but those authoring journeys are not exposed.
- The generic assessment editor uses raw JSON because response/form schemas are not published, and every
  assessment deep link/back link is MSW-named regardless of discipline (`assessment-editor.tsx:18-25`,
  `assessment-editor.tsx:130-159`, `assessment-editor.tsx:239-240`, `plan-workspace.tsx:352-357`).
- Version history is outside the shared patient workspace and renders sealed snapshot JSON rather than a
  clinician-readable comparison (`version-history.tsx:56-68`, `version-history.tsx:275-292`).
- Admission activation creates three plan roots but no initial version. The consumer explicitly describes
  itself as a plan-stub bootstrap and publishes the future signer set; no public route opens an initial
  version (`consumers/m6-admission-activated.ts:157-199`, `consumers/index.ts:10-18`,
  `routes/plans.routes.ts:92-318`). This makes a complete first-version author/finalize/sign journey
  unreachable through the reviewed public contract unless another event (for example IDG revision) creates
  a version. Treat this as a backend contract blocker, not a frontend workaround.
- The frontend labels MSW and spiritual five-day clocks as direct 42 CFR deadlines. Current 42 CFR
  418.54(b) sets a five-calendar-day deadline for the interdisciplinary comprehensive assessment; it does
  not independently prescribe separate MSW and spiritual assessment deadlines. Those module clocks may be
  defensible agency policy, but the regulatory label is not verified by the cited rule.

**Recommendation:** approve a staged build only after the initial-version contract and the five-day policy
label are adjudicated. WP1 can improve navigation and presentation without changing clinical state. A
separately reviewed backend slice is required before claiming complete authoring.

## 1. Baseline, authorities, and rollout context

### Repository and architecture

- Module 15 owns its tables and code paths in `architecture/module-manifest.ts:690-718` (mirrored in the
  CJS manifest). Module 07 remains the interdisciplinary care-plan owner.
- Applicable accepted decisions include ADR-0010 (tenancy/RLS), ADR-0022 (DDL legality), ADR-0023
  (seam reconciliation), ADR-0030/ADR-0032 (web/API track referenced by the client), ADR-0064 (IDG decision
  seam), and ADR-0090 (administrator/org-admin org-wide patient scope). Architecture remains authoritative.
- Workflow 06 is not fully shipped: `docs/README.md:172-173` says its audit and defect track are complete,
  while the workspace redesign awaits approval. Workflow 07 must not assume that future redesign.
- No module-15 rollout feature flag was found in its web/backend trees or production compose. Screens are
  registered unconditionally. A rollback flag would therefore be a new design decision; signed/history
  reads must remain available if authoring is disabled.
- Production policy is defined by `deploy/production/compose.yml`; no deployment file was modified. The
  local authenticated check used the existing backend on port 3000 and a temporary Vite web process. It is
  not production validation.

### Regulatory verification (primary source, checked 2026-11-17)

The current eCFR displayed Title 42 as up to date through 2026-11-13:

- [42 CFR 418.54](https://www.ecfr.gov/current/title-42/chapter-IV/subchapter-B/part-418) requires the RN
  initial assessment within 48 hours and the interdisciplinary comprehensive assessment no later than five
  calendar days. It includes physical, psychosocial, emotional, and spiritual needs. It does not state that
  a separately signed MSW assessment and separately signed spiritual assessment are each due in five days.
- [42 CFR 418.76(h)](https://www.ecfr.gov/current/title-42/chapter-IV/subchapter-B/part-418/subpart-C/subject-group-ECFR74797288a614803/section-418.76)
  requires an RN on-site visit no less frequently than every 14 days to assess aide care and an annual
  on-site observation of each aide while performing care.
- [42 CFR 418.78(e)](https://www.ecfr.gov/current/title-42/chapter-IV/subchapter-B/part-418/subpart-C/subject-group-ECFR74797288a614803/section-418.78)
  requires volunteer service hours of at least 5% of total patient-care hours of paid employees and contract
  staff and requires records of volunteer services and time.

The code's 12-day warning, 14-day overdue, and 16-day block thresholds
(`lifecycle/supervisory.ts:191-224`) mix regulation and product policy. Only the 14-day maximum was verified
against the federal text. The five-business-day volunteer initial-assessment clock and separate MSW/spiritual
five-day clocks (`lifecycle/initial-clock.ts:83-113`) remain **unverified agency/product policy**. No cadence
or signer rule should change without compliance and clinical approval.

## 2. UI inventory and navigation

All entries originate in `apps/web/src/modules/15-discipline-care-plans/screens.ts:54-149`.

| Screen/deep link | Navigation permission | Current behavior |
|---|---|---|
| `/patients/:patientId/discipline-plans` | `discipline_plan.read` | Four-plan overview and link to printable summary |
| `/patients/:patientId/discipline-plans/aide-poc` | `discipline_plan.read` | Shared workspace plus aide supervision |
| `/patients/:patientId/discipline-plans/aide-poc/:versionId/edit` | `discipline_plan.author` | Structured aide goal/intervention editor |
| `/patients/:patientId/discipline-plans/msw-plan` | `discipline_plan.read` | Shared workspace plus five-day clock banner |
| `/patients/:patientId/discipline-plans/msw-plan/:planId/assessments/:assessmentId` | `discipline_assessment.author` | Raw-JSON assessment editor/sign/amend surface |
| `/patients/:patientId/discipline-plans/spiritual-plan` | `discipline_plan.read` | Shared workspace plus decline/clock context |
| `/patients/:patientId/discipline-plans/volunteer-plan` | `discipline_plan.read` | Shared workspace plus assignment ledger/modal |
| `/patients/:patientId/discipline-plans/summary` | `discipline_plan.read_summary` | Printable patient summary |
| `/patients/:patientId/discipline-plans/:kind/versions` | `discipline_plan.read` | History and top-level snapshot difference |
| `/patients/:patientId/discipline-plans/:kind/idg-revisions/:versionId` | `discipline_plan.idg_revise` | Review/finalize already-applied IDG revision |
| `/admin/volunteer-compliance` | `volunteer_compliance.read` | Tenant-level gates; intentionally outside patient workspace |
| `/admin/volunteer-ratio` | `volunteer_compliance.read_ratio` | Tenant-level hour ratio; intentionally outside patient workspace |

Patient-chart entry points exist in `shell/chart-module-rail.tsx:121-123` and
`modules/05-patient/patient-overview.tsx:764`. Module 07 links to the discipline overview from
`modules/07-care-plan/care-plan-overview.tsx:589-591`. These are links, not authorization boundaries.

The overview and shared plan screens use the patient banner/chart shell, preserving patient context on
refresh and deep link. Version history does not. The assessment editor always returns to MSW, even when the
assessment belongs to another kind. Back/refresh behavior therefore needs a discipline-aware route contract.

## 3. Authenticated usability evidence

An authenticated local check used a seeded synthetic patient and an administrator persona at 1440×900 and
375×667. Screenshots were kept only in `/private/tmp/wf07-desktop.png` and
`/private/tmp/wf07-mobile.png`; they were not committed because screenshots can contain PHI in non-synthetic
environments.

Observed journey:

1. Patient chart → **Discipline Plans** was a direct chart-tab navigation.
2. The overview showed Aide, MSW, Spiritual, Volunteer, and Patient Summary headings.
3. Aide/MSW/Spiritual cards showed Draft; volunteer showed neutral **Not started** with no false overdue link.
4. Existing plans exposed **Open plan** and **Version history**. The cards did not expose owner, signer
   blocker, latest signed version, or a derived next action.
5. The tested patient banner said **Discharged** while three plan cards remained **Draft**. This is an
   observed data/lifecycle inconsistency, not yet proven as a product defect; it requires live event/DB
   tracing before remediation.
6. At 375 px, the document `scrollWidth` equalled `clientWidth` (375 px); the overview had no page-level
   horizontal overflow. Chart tabs use their existing horizontal scroll behavior.

The initial attempt at `127.0.0.1:5173` was rejected by backend origin policy, but sign-in rendered the
generic “invalid username/email or password” message. `localhost:5173` succeeded. Origin/config failures
should not be misreported as bad credentials, although that shared-auth issue is outside M15 scope.

Limitations: no tablet screenshot was captured; only the overview received visual validation; role-specific
authoring, finalization, signing, overdue supervision, and IDG review could not be timed end to end because
the seeded patient did not provide a reachable initial-version authoring path. No clinician usability study
was performed. Consequently WP0 item 13 is partial, and no end-to-end success claim is made.

## 4. Server route and API contract inventory

The route group is mounted by `routes/mount.ts:25-30` and boot wiring is in
`apps/backend/src/index.ts:8649-8664`. Reads use cursor envelopes; writes use the generated typed client.
`discipline-api.ts:227-233` adds `If-Match`; the shared client owns stable idempotency keys per write intent.

| Method and path | Required control / semantics |
|---|---|
| `GET /api/v1/discipline-plans` | `discipline_plan.read`; patient/admission query; PHI list audit |
| `GET /api/v1/discipline-plans/:planId` | read; caseload/org-wide scope; non-leaking 404; PHI read audit |
| `GET .../:planId/summary` | `discipline_plan.read_summary`; always suppresses restricted categories |
| `GET .../:planId/versions` | read; cursor history |
| `GET .../:planId/versions/:versionId` | read; snapshot redaction before response |
| `POST .../:versionId/finalize` | `discipline_plan.finalize`; scope; idempotency; `If-Match` |
| `POST .../:versionId/sign` | `discipline_plan.sign`; signer-role ABAC; step-up; idempotency; `If-Match`; server actor |
| `POST/PATCH .../:planId/goals[/ :goalId]` | author; scope; disclosure-aware writes; version precondition on update |
| `POST/PATCH .../:planId/interventions[/ :interventionId]` | author; scope; version precondition on update |
| `POST .../:planId/assessments` | assessment author; scope; idempotency |
| `POST .../assessments/:assessmentId/sign` | assessment sign; step-up; idempotency; `If-Match` |
| `POST .../assessments/:assessmentId/amend` | assessment amend; step-up; idempotency; `If-Match` |
| `POST .../:planId/aide-supervisory-visits` | supervisor permission/ABAC; signed-encounter validation |
| `POST .../aide-supervisory-visits/:visitId/sign` | supervisor sign; step-up; idempotency; `If-Match` |
| `POST/PATCH .../:planId/volunteer-assignments[/ :assignmentId]` | coordinator permission/ABAC; active volunteer or explicit override |
| `GET/POST/PATCH .../volunteer-compliance-gates` and revoke | separately permissioned tenant administration |
| `GET /api/v1/volunteer-hour-ratio` / `POST .../volunteer-hour-entries` | separately permissioned tenant reporting/adjustment |
| Four `GET /internal/discipline-plans/*` routes | platform/system permissions only; relevant elements, MSW risk, volunteer status, cadence |

Route definitions: `routes/plans.routes.ts:92-318`, `routes/supervisory.routes.ts:40-80`,
`routes/volunteer.routes.ts:60-203`, and `routes/internal.routes.ts:40-99`.

No public endpoint opens a plan version. Goals/interventions are plan-root children, but finalize/sign require
a version id. A backend proposal must define who may open the initial/revision version, snapshot timing,
required signer capture, idempotency, concurrency, event emission, and behavior for existing stub plans.

### Error behavior

- The client maps `STALE_VERSION`/409 to reload guidance, 428 to a missing precondition, and 403 to a
  permission message (`discipline-api.ts:240-252`).
- Shared workspace renders loading, error, null-plan, action error, and post-write refetch states
  (`plan-workspace.tsx:100-160`). It does not provide an unsaved-navigation guard.
- Finalize/sign buttons avoid optimistic clinical state; success refetches the server. The stable shared
  idempotency key protects timeout retries.
- Several forms disable while pending, but there is no workflow-level recovery design for a timeout after a
  write. WP3 should always refetch authoritative state before offering retry.
- Unknown status strings fall back to a neutral humanized label (`discipline-status.ts:15-115`) rather than
  fabricating a lifecycle state.

## 5. Role/action matrix

Permissions are registered in `packages/auth/src/permissions/contributed.ts:4420-4542`. Actual access is
the intersection of the tenant role grant, patient scope, and action-specific ABAC. Hiding a button is never
authorization. Administrator and org-admin may receive org-wide patient scope under ADR-0090, but
discipline/signer/supervisor predicates still apply. Tenant roles are configurable, so this table does not
claim a universal production grant matrix.

| Persona | Typical readable/action surface | Server restriction that remains authoritative |
|---|---|---|
| Assigned clinician | Read assigned patients; author if granted | caseload or org-wide scope plus `discipline_scope` |
| RN supervisor | Aide plan and supervisory capture/sign | caseload, `aide_supervisor_eligible`, signed encounter, step-up |
| Physician/medical director | Read/sign if tenant role grants it | signer slot must match sealed required signer set |
| MSW | MSW author/assessment actions if granted | caseload + discipline scope; disclosure filtering |
| Chaplain | Spiritual author/assessment actions if granted | caseload + discipline scope; disclosure filtering |
| Volunteer coordinator | Assignment create/update | coordinator ABAC and active-volunteer gate unless approved override |
| Compliance/auditor | Tenant volunteer gates/ratio only when separately granted | no implied patient-plan access; external auditor enrolment rules remain separate |
| Administrator/org-admin | Full configured catalog and org-wide patient scope | tenancy, discipline/signature/step-up predicates still apply |

Demo persona seeds are broad convenience grants (`scripts/db/seed-staff-personas.ts:337-356`,
`:433-446`) and must not be treated as production least-privilege evidence.

## 6. Lifecycles, signers, and event traces

### Root plan state

```text
draft --first version signed--> active --open next version--> draft_revising
  |                              ^                              |
  |                              +-------version signed---------+
  +---------------- discharge -------------------------------→ discharged
```

The exact graph is `lifecycle/plan.ts:18-22,63-70,137-165`. Aide, MSW, and spiritual roots bootstrap on
admission; volunteer is lazy. One non-discharged root per admission/kind is enforced by the schema index
(`schema/discipline-plans/discipline-care-plans.ts:77-80`).

### Version state

```text
draft --finalize/seal snapshot+quorum--> in_review --all required signatures--> signed
                                             |--return/edit before completion--> draft
signed --open successor--> superseded (when successor becomes authoritative)
```

The graph and readiness checks are in `lifecycle/version.ts:26-27,73-118`. Finalization seals the snapshot
and signer quorum. Signatures are server-bound to the authenticated actor and a required role; signing does
not complete until the sealed quorum is met (`lifecycle/required-signer-set.ts:5-35`). Required sets come
from `packages/discipline-plans/src/kinds/index.ts:30-49`; discharge versions have an empty human quorum.
Signed history is not edited in place.

### Traces

- **Admission activation:** `m6.admission.activated` → siting must exist → create aide/MSW/spiritual root
  stubs with initial clock → publish `m15.plan.bootstrapped` with required initial signer set
  (`consumers/m6-admission-activated.ts:140-199`). It does not create the initial version.
- **Volunteer assignment:** coordinator write validates compliance/volunteer status and lazily creates the
  volunteer plan/assignment without duplicating the non-discharged root (`routes/volunteer.routes.ts:60-102`).
- **Signed encounters:** seam validation requires the referenced encounter to be signed and appropriate for
  assessment/supervision (`consumers/signed-encounters.ts:1-104`). A visit does not silently complete a plan.
- **IDG decision:** `m14.idg-decision-recorded` validates parent elements, opens/applies an IDG review
  version, and records an idempotent application row (`consumers/m14-idg-decision-recorded.ts`,
  `discipline-plan-idg-decision-applications.ts:16-53`). The UI does not receive that durable provenance and
  labels a “most recently authored” proxy (`idg-revision-review.tsx`).
- **Discharge:** `m6.admission.discharged` creates the system discharge history, supersedes prior signed
  versions, and seals the root while retaining historical/open-draft evidence
  (`consumers/m6-admission-discharged.ts`).
- Consumer factories and recurring compliance jobs are wired in `apps/backend/src/index.ts`; binding gates
  do not replace this boot-path check.

## 7. Data and source-of-truth map

| Visible concept | Authoritative source |
|---|---|
| Discipline kind/root status/patient/admission/siting | `discipline_care_plan` (`discipline-care-plans.ts:34-104`) |
| Current/historical version, kind, sequence, sealed snapshot, quorum | `discipline_care_plan_version` (`discipline-care-plan-versions.ts:20-68`) |
| Signer identity/role/time/acknowledgment | `discipline_care_plan_signature` plus membership trigger (`discipline-care-plan-signatures.ts:18-61`) |
| Goals and module-07 parent refs | `discipline_goal` (`discipline-goals.ts:24-76`) |
| Interventions, responsibility, scope, frequency | `discipline_intervention` (`discipline-interventions.ts:18-67`) |
| Assessment kind/status/evidence/restriction flags/data | `discipline_assessment` (`discipline-assessments.ts:38-100`) |
| Aide supervision evidence/due calculation | supervisory ledger plus pure server cadence (`aide-supervisory-visits.ts`, `lifecycle/supervisory.ts`) |
| Volunteer assignment | `discipline_volunteer_assignment` (`discipline-volunteer-assignments.ts:29-70`) |
| Volunteer tenant compliance and ratio | compliance-gate/hour-ledger tables; separate admin permissions |
| Initial due clock | root timestamps interpreted by `lifecycle/initial-clock.ts`; not a frontend calculation |
| IDG decision provenance | `discipline_plan_idg_decision_application`; currently absent from read DTO |
| Restricted-content marker | SQL-filtered read plus `redacted_categories` from `routes/disclosure.ts:138-205` |
| Module-07 relationship | logical parent refs and `CarePlanReader` seam; module 15 never writes module-07 tables |

The client DTO mirrors are in `discipline-api.ts:28-196`. Response TypeBox schemas are not yet published,
so the web layer casts each response centrally. The assessment form accepts an assessment kind, encounter
reference, capture time, initial flag, SUD/family-violence flags, and arbitrary JSON data. Raw JSON can
express the backend payload, but it cannot give field-level clinical validation and is a hardcoded vocabulary
surface (`assessment-editor.tsx:18-66`). No evidence was found that the current form silently drops submitted
fields; it does make schema errors difficult to prevent or explain.

## 8. Confidentiality, tenancy, and audit

- Full reads filter SUD and family-violence rows in SQL, then return category markers; the UI must not infer
  counts, identities, or content (`routes/disclosure.ts:7-15,138-205`).
- Summary reads always strip both restricted categories. Version snapshots redact SUD goals/interventions
  before response (`routes/snapshot-redaction.ts`). Current snapshots do not embed assessments.
- Patient reads/writes require caseload or org-wide scope and fail closed (`routes/disclosure.ts:237-248`).
  Cross-tenant isolation is also enforced by org context and forced RLS.
- Read routes declare resource identifiers for audit; write tables have PHI audit triggers. No sensitive
  payload should be added to logs, analytics, screenshots, or test output.
- This audit did not execute the M15 live RLS suite. Per repository policy, it must run only against a fresh
  private Postgres container as the NOBYPASSRLS application role, never the shared Docker cluster.

## 9. Test inventory and execution

### Executed

```text
bunx vitest run apps/web/src/modules/15-discipline-care-plans \
  apps/backend/__tests__/discipline-plans-authz.test.ts \
  apps/backend/__tests__/discipline-plans-caseload-scope.test.ts \
  apps/backend/__tests__/discipline-plans-inject.test.ts \
  apps/backend/__tests__/discipline-plans-lifecycle.test.ts \
  apps/backend/__tests__/discipline-plans-seams.test.ts \
  apps/backend/__tests__/discipline-plans-signer-binding.test.ts \
  apps/backend/__tests__/discipline-plans-snapshot-redaction.test.ts \
  apps/backend/__tests__/discipline-plans-volunteer.test.ts \
  apps/backend/__tests__/discipline-plans-write-service-caseload.test.ts \
  apps/backend/__tests__/m15-admission-discharge.test.ts \
  apps/backend/__tests__/m15-goal-source-parity.test.ts \
  apps/backend/__tests__/m15-idg-decision-decider.test.ts \
  apps/backend/__tests__/m15-patient-care-hours.test.ts
```

Result: **18 files passed, 309 tests passed, exit 0**. Test logs warned that local
`BETTER_AUTH_SECRET` was absent, so idempotency fingerprints were process-local; production refuses that
configuration. The focused run does not prove production behavior.

Existing web coverage includes API helpers and four DOM suites (overview header, workspace links, aide goal
source, printable summary). Existing backend coverage includes authz, caseload, injection, lifecycle,
seams, signer binding, snapshot redaction, volunteer flows, write scope, discharge, source parity, IDG
decisions, hour ratios, and cron tests.

### Not executed / gaps

- Live suites: `m15-plan-bootstrap.live.test.ts`, `m15-idg-decision-apply.live.test.ts`,
  `gap-044-m15-crons.live.test.ts`, and `packages/db/migrations/__tests__/m15-rls-isolation.live.test.ts`.
- No dedicated authenticated Workflow 07 E2E spec covers initial author → finalize → quorum sign → active,
  stale write recovery, timeout refetch, role journeys, cross-tenant denial, or discharge history.
- No automated accessibility suite covers M15. Keyboard, focus, screen-reader status, and touch target
  acceptance remain unverified.
- No tablet, deep-screen mobile, performance, or clinician-usability evidence exists.

## 10. Proposed information architecture

### Patient overview

```text
+ Patient banner / admission context ----------------------------------------+
| Discipline Plans                    [Interdisciplinary plan summary]        |
| Needs attention: 2                                                      |
+---------------------------+---------------------------+-------------------+
| Hospice Aide              | Medical Social Work       | Spiritual Care    |
| Active · signed v3        | Draft revision            | Not applicable    |
| Owner: RN team            | Owner: assigned MSW       | Declined <date>   |
| Next: supervision <date>  | Next: complete assessment | No action         |
| [Open plan]               | [Continue draft]          | [View record]     |
+---------------------------+---------------------------+-------------------+
| Volunteer Services: Not assigned / no plan yet          [View eligibility] |
+---------------------------------------------------------------------------+
```

Every label must be derived from server fields. Until owner, current signed version, signer blockers, and
IDG provenance are published, omit them or label the limitation; do not infer them in the browser.

### Discipline workspace

```text
Patient > Discipline Plans > Medical Social Work
+ Plan header: server status · version · owner · last signed · next action --+
| Overview | Goals & Interventions | Assessments | Reviews & Signatures | History |
+----------------------------------------------------------------------------+
| Attention / restricted-content notice                                      |
| Structured content or read-only signed snapshot                            |
|                                                        [Save draft] [Next] |
+----------------------------------------------------------------------------+
```

History should stay inside the patient workspace and render a typed clinical summary/diff. IDG review should
show durable decision provenance rather than “most recent author” heuristics.

## 11. Change classification, PR sequence, and gates

| Slice | Classification | Gate |
|---|---|---|
| WP0 audit (this document) | Documentation only | Human approval |
| Overview/navigation, discipline-aware links, loading/error/a11y polish | Frontend-only with existing reads | DOM + route + accessibility review |
| Initial-version opening and authoritative next-action/owner/signer-blocker DTO | Backend contract required | Architecture/security/clinical approval; tenant-safe data and rollback plan |
| Shared workspace and structured non-aide authoring | Mostly frontend; published schemas/validation may require backend/OpenAPI work | Four-role journey tests; no raw JSON as finished UX |
| IDG provenance and typed history/diff | Backend read-contract expansion plus frontend | IDG lifecycle and redaction tests |
| Signing/conflict/timeout recovery | Frontend over stable contract unless gaps emerge | step-up, idempotency, stale-version, audit regression |
| Rollout flag and rollback behavior | Cross-cutting design | signed/history access preserved; rollback drill |

Proposed reviewable PRs:

1. **PR-1 — overview and navigation:** shared shell, discipline-aware breadcrumbs/back links, neutral volunteer
   absence, exhaustive presentation mapping, overview tests. No clinical write changes.
2. **PR-2A — initial-version contract (separate approval):** explicit open/create route or approved event
   behavior, response schema, actor/ABAC, idempotency, concurrency, audit/outbox, existing-stub handling,
   Rust parity decision, live tests.
3. **PR-2B — shared authoring:** typed forms for each discipline using published validation; unsaved-change
   protection and authoritative refetch.
4. **PR-3 — history, IDG, and signing:** durable provenance, typed historical summary/diff, sealed signer
   blockers, stale/timeout recovery, step-up regressions.
5. **PR-4 — E2E and rollout:** private-DB suites, role/cross-tenant journeys, accessibility, desktop/tablet/mobile,
   clinical review, feature flag/rollback documentation.

Before any PR or merge, run the repository-required typecheck, architecture fitness, non-live tests, boot
check, and mandatory fresh-agent code review; add React review for web changes and security review for
auth/PHI/RLS changes. Live tests must use an isolated Postgres container.

## 12. Risk register and approval decisions

| Risk / blocker | Evidence | Required decision |
|---|---|---|
| First authorable version has no public creation path | bootstrap creates only root; route inventory has no open-version write | Approve backend contract investigation and design before WP2 |
| Five-day MSW/spiritual label overstates federal text | current eCFR 418.54 vs `initial-clock.ts`/wrappers | Identify approved agency policy or relabel without changing cadence |
| IDG provenance is durable but not exposed | application table/consumer vs UI proxy | Approve read DTO extension |
| Assessment routing is MSW-specific for all kinds | workspace/editor links | Approve discipline-aware route migration with redirects |
| Raw JSON assessment authoring | `assessment-editor.tsx:18-66` | Publish/formalize schemas; clinical review of fields/vocabulary |
| History raw JSON and top-level diff | `version-history.tsx:56-68,275-292` | Approve typed snapshot presentation contract |
| No rollout flag | no M15 flag found | Define authoring-disable semantics while preserving reads |
| Incomplete E2E/a11y/live evidence | test inventory above | Require before release; do not claim compliance now |

## Stop gate

WP0 is complete to the extent documented, with explicit limitations. No application implementation should
begin until a human approves the staged direction and separately authorizes backend contract work. Approval
should answer these two points:

1. May WP1 proceed as a frontend-only overview/navigation improvement?
2. May a backend contract design be prepared for initial-version creation and the missing presentation data
   (owner/next action/signer blockers/IDG provenance), without implementation until that contract is reviewed?
