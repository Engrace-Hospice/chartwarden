# Workflow 05 — HOPE Assessments Current-State Audit

**Audit date:** 2026-11-15

**Audited revision:** `abdcf710e` (`develop`; 31 commits ahead of `main`, tracked tree clean)

**Scope:** WP0 / Stop Gate A evidence only; no product implementation is authorized by this document

**Parent plan:**
[`ChartWarden_Workflow_05_HOPE_Assessments.md`](./ChartWarden_Workflow_05_HOPE_Assessments.md)

**Path note:** the plan names `docs/implementation/evidence/05-hope-current-state.md`; this file follows
the repo convention of the Workflow 03/04 audits (`NN-…-current-state-audit.md` beside the plan).

Path prefixes: `B/` = `apps/backend/src/modules/10-hope/`, `W/` = `apps/web/src/modules/10-hope/`,
`H/` = `packages/hope/src/`.
Tags: **[O]** observed in code, **[I]** inferred from code, **[NV]** not verifiable statically,
**CMS-VERIFY** a regulatory statement that must be checked against CMS primary material and approved
compliance policy before anyone relies on it. This audit asserts no CMS deadline.

## 1. Executive finding

The HOPE engine is substantially built and mostly sound; the plan's central premise needs correcting in
three places, and the audit found defects that are independent of any redesign.

1. **Transport is manual, and always has been in the live path.** Nothing transmits to iQIES. An operator
   downloads a ZIP, uploads it in the iQIES portal, clicks "Mark uploaded", and later keys the CMS result
   back by hand. The automated three-stage pipeline is unscheduled and bound to a deny-stub adapter. The
   plan's "require an integration proof" has nothing to prove; WP4 is about **labelling the manual flow
   honestly**. "Transmitted" and "Accepted at" are operator assertions, not CMS evidence (section 9).
2. **A guided capture workspace already exists.** `W/hope-assessment-detail.tsx` is 5,442 lines and already
   does section capture, autosave with `ifVersion`, readiness-gated sign, correction, inactivation and
   in-workspace SFV. WP2 is a decomposition and gap-closing job, not a build (section 4.2).
3. **There are two "patient HOPE home" screens that do not link to each other.** The admission overview has
   windows and SFV obligations; the patient timeline has history. Neither has submission state. This is
   the real navigation defect the redesign should fix (section 4.3).
4. **The SFV clock has four definitions** (ADR-0018 visit date, live J2050B+2 days in UTC, BUSINESS_LOGIC
   signed timestamp, a stale code comment). WP3 cannot be specified until compliance names the authority
   (section 7.2, R-02).
5. **Two security-relevant defects exist today.** SFV completion is not bound to the URL admission or the
   caller's caseload (R-01), and "sign" has no attestation, step-up or credential check although the
   request schema carries an unused `attestationConfirmed` field (R-05).
6. **Server state supports about half the plan's status taxonomy.** "Needs review" and "Ready to package"
   have no persisted source; "Transmitted" means "an operator says they uploaded"; "Corrected" is a lineage
   state (section 6).
7. **No default role can do HOPE work in a fresh tenant.** Only `administrator` and `org_admin` receive any
   HOPE key; clinician roles (`rn`, `np`, `md`, `clinical_supervisor`) and both `hope.admin.*` keys must be
   created by hand (section 5).
8. **The audit is static-only.** No authenticated browser journey, live suite or deployed flag was
   exercised (section 2).

**Recommendation:** approve a **presentation-and-honest-labelling first slice** (one patient workspace over
the existing read APIs, status relabelling, accessible dialogs, sign-failure feedback) and run the
**defect track** (R-01, R-05, R-11, R-21) as separate PRs, never combined with the visual refactor. Hold
WP3 until the SFV anchor decision. Details and decisions requested are in sections 15 and 16.

## 2. Method, limits and evidence status

- **Method:** four independent read-only slices (web UI, backend routes/states/authz, timepoints/SFV/spec,
  submission/transport), each anchored `path:line`, then spot-verified by the lead against the code.
  Verified directly by the lead are listed in Appendix A; everything else is slice-reported with anchors and
  should be re-checked by whoever acts on it.
- **Baseline tests (run):** `bunx vitest run packages/hope apps/web/src/modules/10-hope apps/backend/src/modules/10-hope apps/backend/__tests__/hope- apps/backend/__tests__/m30-hope` →
  **41 files passed, 1 skipped; 510 tests passed, 3 skipped**. Non-live only. The `m10-*.live.test.ts` suites
  were **not** run (they need a private `chartwarden-postgres:dev` container; section 13).
- **Not run:** `bun run typecheck`, `arch:fitness`, build, accessibility tooling, any browser. Only Postgres,
  Redis and RustFS containers are up locally; there is no API or web container, so **item 11
  (click-through screenshots, keyboard, mobile viewport) is static-only**.
- **Deployment flags:** not inspected (production env files are out of reach by policy). Whether
  `CHARTWARDEN_SOFTWARE_VENDOR_*` is set in production is **[NV]** (packaging 422s without it).
- **Workflow 04 (Initial Assessments):** not executed. `ChartWarden_Workflow_04_Initial_Assessments.md` is an
  untracked proposal with no audit or implementation. The Workflow 04 that landed is Visit & Encounter
  (`bb71a8baf`..`abdcf710e`). The plan's "after Workflow 04" sequencing is therefore unmet; HOPE and initial
  assessments must stay independent (plan section 4.2).
- **CMS primary sources were not consulted.** The repo's own copy of the V1.00.1 data-spec CSVs was read.

## 3. Authority and ownership

| Concern                                                     | Current authority                                                                               | Evidence                                                                                         | Conclusion                                                                                                                             |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| Timepoint obligations (Admission/HUV1/HUV2/Discharge)       | M10 live consumer `m10.m6-admission-workflow` on `m6.admission.activated` / `.discharged` | `B/outbox-consumers/m6-admission-workflow.ts:29-32`; bound `apps/backend/src/index.ts:15397` | Preserve; a second consumer (`m6-admission-scheduling.ts`) is exported but unwired (only one may be bound, `index.ts:15779-15781`) |
| Window arithmetic                                           | `H/scheduling/window-calculator.ts`, `time.ts`                                              | `window-calculator.ts:35-43,56-101`                                                            | Preserve; one-day divergence vs edit -3110 is CMS-VERIFY (R-14)                                                                        |
| Assessment content, applicability, validation               | M10 answer engine + versioned spec                                                              | `B/hope-answer-service.ts`, `B/spec/`, `B/hope-validation-service.ts`                      | Render, never re-implement                                                                                                             |
| Readiness / sign gate                                       | M10 readiness service                                                                           | `B/hope-readiness-service.ts:46-101,325-382`                                                   | Server-authoritative; already returns a UI-ready review model                                                                          |
| Sign, correct, inactivate                                   | `createDbHopeBackend`                                                                         | `B/hope-route-service-db.ts:1639-1953`                                                         | Preserve semantics; fix gaps in a defect PR                                                                                            |
| SFV lifecycle                                               | `B/hope-sfv-service.ts` (trigger/due), `H/sfv/sfv.ts` (watchdog planner), `recordSfv`     | `hope-sfv-service.ts:41-170`; `route-service-db.ts:1432-1524`                                | Authority is split and inconsistent (R-02, R-03)                                                                                       |
| Submission packaging, upload attestation, CMS result import | **Live manual path in `route-service-db.ts:1973-2369`**                                 | `B/hope-zip.ts`, `hope-submission-header.ts`, `hope-submission-result.ts`                  | The plan's `jobs/submission.ts` row is the dormant path (section 14)                                                                 |
| Authorization                                               | `requirePermission` + `hope.scope` ABAC; no step-up anywhere in M10                         | `B/routes/hope-routes.ts:122-254`; `B/abac-predicates.ts`                                    | Preserve; tighten per R-01/R-05                                                                                                        |
| Tenant isolation                                            | `withOrgContext` + org-level RLS (ENABLE+FORCE)                                               | migrations `0118`, `0233`, `0482`                                                          | Org-level only; caseload/PE scoping is app-level                                                                                       |
| Cross-module reads                                          | M5 caseload/patient, M6 admission status, M9 latest assessment, M38 terminology via seams       | `B/abac-predicates.ts:142,169`; `B/hope-admission-prefill-service.ts:410-414`                | Preserve                                                                                                                               |

The UI must not collapse timepoint state, assessment state, SFV state, submission state and CMS-result state
into one status. They are five separate persisted vocabularies (section 6).

## 4. Current navigation, screens and journeys

### 4.1 Registered browser routes (`W/screens.ts`, mounted `apps/web/src/main.tsx:99`)

| Path                                               | Component               | Permission               | Line          |
| -------------------------------------------------- | ----------------------- | ------------------------ | ------------- |
| `/hope`                                          | HopeDashboard           | `hope.schedule.read`   | screens.ts:90 |
| `/hope/sfv`                                      | SfvWorklist             | `hope.sfv.read`        | :132          |
| `/hope/submissions`                              | SubmissionWorklist      | `hope.submission.read` | :148          |
| `/hope/compliance`                               | HqrpComplianceDashboard | `hope.dashboard.read`  | :165          |
| `/admissions/:admissionId/hope`                  | AdmissionHopeOverview   | `hope.timepoint.read`  | :98           |
| `/admissions/:admissionId/hope/timepoints/:kind` | HopeTimepointCapture    | `hope.timepoint.write` | :107          |
| `/admissions/:admissionId/hope/sfv/:sfvId`       | HopeSfvCapture          | `hope.timepoint.write` | :115          |
| `/patients/:patientId/hope`                      | PatientHopeTimeline     | `hope.timepoint.read`  | :123          |
| `/hope/assessments/:id`                          | HopeAssessmentDetail    | `hope.timepoint.read`  | :140          |
| `/hope/submissions/:id`                          | SubmissionDetail        | `hope.submission.read` | :157          |

- Only the four static paths are gated client-side; the six param routes rely on the server alone
  (`apps/web/src/shell/app.tsx:292`, `enforce={!s.path.includes(":")}`, verified) **[O]**. Acceptable only because
  the server enforces; the plan's "permission-denied paths remain denied" must be tested per param route.
- Sidebar has one "Assessments" entry landing on `/hope` (`primary-nav.ts:104-110`); the module sub-nav
  interleaves HOPE with unrelated items (Cosignatures, My visit drafts, Scale Licenses…)
  (`module-navigation.ts:50-59`).

### 4.2 Screen inventory (responsibilities that matter to the redesign)

| Component                                                  | Lines           | Role                                                                                                       | Note                                                                               |
| ---------------------------------------------------------- | --------------- | ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `hope-assessment-detail.tsx`                             | **5,442** | Guided workspace: sections A/F/I/J/M/N + Review, autosave, sign, correct, inactivate, in-workspace SFV     | Largest file, far over the 800-line ceiling; plan lists it as just "detail screen" |
| `admission-hope-overview.tsx`                            | 770             | Windows per RFA, SFV list, per-RFA next-action CTA                                                         | The only screen with obligations and deadlines                                     |
| `patient-hope-timeline.tsx`                              | 284             | Flat list of assessments, record-timepoint modal, recompute                                                | No windows, no SFV obligations, no submission state                                |
| `hope-capture-workspace.tsx`                             | 528             | **Admission-scoped** page that creates an *empty draft* and redirects; two routes (timepoint, SFV) | Not a draft editor, contrary to the plan row                                       |
| `hope-dashboard.tsx`                                     | 509             | Org schedule worklist; Record/Skip modals                                                                  | Unfiltered `/hope/schedules` read                                                |
| `sfv-worklist.tsx`                                       | 441             | Org SFV list, Record modal                                                                                 | 8-char patient-id prefixes, no names, no row link                                  |
| `submission-worklist.tsx` / `submission-detail.tsx`    | 675 / 541       | Generate, download, mark uploaded, record result                                                           | See section 9                                                                      |
| `record-cms-result-modal.tsx` / `cms-result-parser.ts` | 425 / —        | Manual result entry; parser for pasted JSON/delimited rows                                                 | Not a native FVR parser                                                            |
| `hqrp-compliance-dashboard.tsx`                          | 381             | Agency KPIs, targets 0.9/0.95/0.1 hard-coded client-side                                                   |                                                                                    |

Also present and unlisted by the plan: `hope-api.ts`, `hope-status.ts`, `hope-workspace-ui.tsx`,
`hope-read-state.tsx`, `submission-log.ts`, `index.ts`, and a dev-only mock harness
(`hope-preview.tsx`, `apps/web/hope-preview.html`). `updateDraft` in `hope-api.ts:154` and the action
modal's `summary-pdf` branch are dead code **[O]**.

### 4.3 Entry points and as-is journey

**Into HOPE:** chart rail "HOPE assessments" → `/patients/:id/hope` (`chart-module-rail.tsx:118`; no
active-admission gate); patient overview → `/admissions/:id/hope` and `/patients/:id/hope`, disabled when
the admission is inactive (`patient-overview.tsx:714-758`); admission detail `HopeEntry` card
(`admission-detail.tsx:2391-2490`; buttons not permission-gated); role-home "Assessments Due" → `/hope`;
encounter read → timeline; IDG packet read-only panel. **The discharge workflow screens have no link to the
Discharge HOPE timepoint** **[O]** (`06-admission/discharge-*.tsx`).

```
Role home / Admission / Patient overview ─► Admission overview (windows, SFV)
                                              ├─ "Complete X"  ─► Capture page ─► (empty draft) ─► Assessment detail
                                              ├─ draft / signed ─► Assessment detail
                                              └─ "Complete Follow-Up" ─► SFV capture page ─► back to overview
Sidebar /hope dashboard ─► row ─► Patient timeline ─┬─ "Record timepoint" modal (raw RFA picker)
Chart rail ─────────────────────► Patient timeline ─┘            └─ row ─► Assessment detail
Assessment detail (draft): autosave ─► Review ─► Sign dialog ─► signed ─► Create correction (window.prompt),
                                                                   Inactivate, Request summary, iQIES panel link
Submissions worklist ─► Generate package ─► batch detail ─► Download ZIP ─► Mark uploaded ─► Record CMS result
                                              └─► item rows ─► "Correct this assessment" ─► Assessment detail
```

Duplicated paths **[O]**: timepoint creation has three entry points (dashboard modal, timeline modal,
capture page); SFV completion has four (worklist modal, capture page, in-workspace dialog, "Complete SFV"
card) and **three different payload shapes hit one endpoint** (J2030/J2050/J2051 + N from the record modal;
empty `J2051.entries` from the capture page; `J.J2053` from the in-workspace dialog). The record modal's J/N
inputs are legacy; the e2e spec says the CMS workspace does not read them.

## 5. Roles and permissions as implemented

Twelve keys (`packages/auth/src/permissions/contributed.ts:1499-1578`): clinical `schedule.read|skip`,
`timepoint.read|write|sign|correct`, `sfv.read`; compliance `submission.read|manage`, `dashboard.read`;
platform `admin.regenerate_schedules`, `admin.late_deadline_override`.

- **No `ROLE_TEMPLATES` entry grants any HOPE key.** `administrator` and `org_admin` receive every
  non-platform key by materialisation (`template-materialization.ts:29-71`): all ten clinical and compliance
  keys, **not** the two `hope.admin.*` keys, which no default role holds **[O]**.
- **Discipline comes from role keys** (`rn`, `np`, `md`, `lpn`, `lvn`, uppercased; `abac-predicates.ts:72-74`,
  `discipline.ts:37-76`). No template defines them, and `medical_director` uppercases to `MEDICAL_DIRECTOR`,
  which does **not** confer MD.
- Timepoint author/signer: RN, NP, MD; SFV author: RN, NP, LPN, LVN. On an existing row the actor must hold
  the row's frozen `author_discipline`; legacy NULL rows fail closed.
- **Correction authority:** the original signer's membership, or a role key `clinical_lead` /
  `clinical_supervisor`. No template defines either (`abac-predicates.ts:56,205-218`).
- **Org-wide scope** (skip caseload checks, still need a grant): `administrator`, `org_admin`,
  `compliance_officer`, `medical_director`, `survey_coordinator`, `director_of_nursing`.
- **Dev seed only:** persona roles receive every clinical **and compliance** key, so in dev an RN can
  assemble packages and record CMS results. `M10_DR_INT_INVENTORY.md:107` says `submission.manage` is
  Compliance Officer / Platform Admin only; code and seed do not enforce that.
- External auditors hold only `portal.engagement.read_auditor` (no HOPE reach). Portal sessions use a separate
  `portal.hope.read_summary` surface. Platform roles hold no HOPE keys.
- **[NV]** Production grants for RN, supervisor, QA, submission operator and medical director depend on
  tenant-created roles. The plan's role-by-role journey cannot be completed statically.

## 6. Persisted states versus the plan's taxonomy

| Entity                               | Values                                                                      | Where enforced                                                                                                                                      |
| ------------------------------------ | --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hope_timepoint_schedule.status`   | `open, completed, expired, skipped`                                       | `open→completed` DB trigger on sign (`0035:122-139`); `→expired` by `hope-window-watchdog`; `→skipped` by an **unguarded** route |
| `hope_assessment.status`           | `draft, signed, superseded`                                               | `draft→signed` code only; `signed→superseded` DB trigger (`0225`); **no DB guard on other updates**                                   |
| `symptom_follow_up_visit.status`   | `open, completed, overdue, missed, withdrawn`                             | Pure planner + watchdog; no DB constraint                                                                                                           |
| `hope_submission.status`           | 11 values (`enums.ts:1500-1512`)                                          | Code + `FOR UPDATE`; no DB constraint                                                                                                             |
| `hope_submission_item.item_status` | `pending, accepted, accepted_with_warnings, rejected, blocked, unmatched` | Code; a CMS verdict on an item is final                                                                                                             |
| CMS result                           | no automated state; append-only `hope_submission_result_event`            | Report hash + unique index                                                                                                                          |

**Derived, not persisted [O]:** `HopeWorkflowItemStatus` (`upcoming | open | late | completed | expired | skipped | not_applicable | workflow_not_initialized`, `B/routes/service.ts:233-241`); review `readyToSign` and
section state; rejected-item resolution (`needs_correction | correction_in_progress | resubmitted | resolved`, `hope-submission-result.ts:143-166`).

**Dead enum values:** batch `ready`, `file_error` and item `blocked`, `unmatched` have **no writer**;
`in_flight` and `queued` are reachable only by the dormant job path or the deprecated retry route.

| Plan label (section 3.2)   | Backend source                                                                                     | Verdict                                                                     |
| -------------------------- | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Not started                | Open schedule with no assessment (derived)                                                         | Derivable                                                                   |
| In progress                | `hope_assessment.status = draft`                                                                 | Real                                                                        |
| **Needs review**     | None persisted: derived from `readyToSign=false`/blockers; no reviewer, no prefill-reviewed flag | **No source; do not invent**                                          |
| Signed                     | `status = signed`, `signed_at`, `signed_by_membership_id`                                    | Real                                                                        |
| **Ready to package** | Derived from the eligibility test inside `assembleSubmission`; batch `ready` has no writer     | **Derivable only by duplicating server logic; needs a read endpoint** |
| Packaged                   | Batch `packaged` + item `pending` (join via item)                                              | Real, not on the assessment row                                             |
| **Transmitted**      | `submitted_pending_result` = operator clicked "Mark uploaded" (client-supplied time)             | **Operator assertion, relabel**                                       |
| Accepted / Rejected        | Item and batch status from an operator-keyed result                                                | Real, but "as keyed by an operator"                                         |
| Corrected                  | Lineage (`superseded` + `corrects_assessment_id`) plus derived resolution                      | Lineage state, not a submission state                                       |
| Unknown                    | None; nearest is item `pending`                                                                  | **No source**                                                         |

Plan section 3.2's rule stands: show only states with a real or trustworthy derived source.

## 7. Timepoints, SFV and spec versions

### 7.1 Timepoints (all derived dates **[O]**, regulatory correctness **CMS-VERIFY**)

| Timepoint | Source event                | Anchor                                                                                                                   | Window (inclusive org-local days) |
| --------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------ | --------------------------------- |
| Admission | `m6.admission.activated`  | org-local day of `activatedAt` (= server `now()` at activation, `06-admission/admission-route-service-db.ts:4382`) | +0 … +4, then 7 grace days       |
| HUV1      | same                        | same                                                                                                                     | +5 … +14                         |
| HUV2      | same                        | same                                                                                                                     | +15 … +29                        |
| Discharge | `m6.admission.discharged` | `dischargeDate`                                                                                                        | +0 … +6, then 7 grace days       |

Functions: `H/scheduling/schedule-plan.ts:54-95`, `window-calculator.ts:56-125`, `time.ts:21-71` (Intl-based
DST handling; boundaries stored as UTC instants). Persisted schedule status has no "late" or "missed";
"late" is derived at read time (`B/routes/service.ts:605-620`). `getWorkflowState` already returns per-timepoint
`status`, `windowStart/End`, `lateDeadline` and an `attention` object, server-derived and renderable.

**Gaps the UI cannot paper over:** the schedule and SFV views omit the **source event, anchor date, grace and
skip reason** (`B/routes/service.ts:98-109`), so the plan's header ("source event date, due date, why") needs
new server fields (a genuine contract gap, section 12).

### 7.2 SFV

- **Trigger:** J2051A-H any value "2" or "3" fires; a complete set in {0,1,9} is false; else pending
  (`hope-sfv-service.ts:41-69`). Source is draft answers, not symptom events (CMS-VERIFY the "2"/"3" meaning).
- **Created only for the Admission HOPE:** `isc === "HA" && rfaKind === "01_admission"`
  (`hope-sfv-service.ts:109`) **[O, verified]**. The M10 spec says "any HOPE timepoint" (line 69) and the
  repo's CMS CSV copy marks J2051 active for HA and HUV.
- **Four definitions of the clock:**
  1. ADR-0018 D1 and the M10 spec: 2 calendar days from the **visit/assessment date, never the signature
     timestamp** (`docs/adr/ADR-0018-hope-idg-ipu-clocks.md:16-25`).
  2. **Live code:** `due_at = J2050B + 2 days, 23:59:59.999 UTC` (`hope-sfv-service.ts:71-77`), where J2050B is
     a clinician-entered screening date. Matches the CMS CSV's J2050B and edit -3105 [I].
  3. `docs/BUSINESS_LOGIC.md:176-178`: "signed timestamp (org-TZ)", which contradicts ADR-0018.
  4. `H/scheduling/window-calculator.ts:33` comment: "signed-at-anchored (D3)". Stale.
     The pure planner `H/sfv/sfv.ts:58-69` follows ADR-0018 but is called only by the in-memory backend. No doc
     records J2050B as the live anchor. UTC end-of-day is roughly 7-8 hours earlier than org-local for a Pacific
     clinic.
- **Blocking effects [I]:** readiness raises `SFV_REQUIRED_OPEN` while the SFV is not completed
  (`hope-readiness-service.ts:347-382`), so (a) a HUV with a J2051 trigger can never be signed because no SFV
  row is ever created for it (needs live proof), and (b) an overdue or missed SFV blocks signing the
  Admission until an admin override, whose key no default role holds. `J2052A="0"` with a J2052C reason is
  not signable (CMS-VERIFY).
- **Completion bypasses draft→sign:** `recordSfv` inserts the RFA-04 row directly as `signed`
  (`route-service-db.ts:1450-1472`), with no readiness gate or `ifVersion`.
- **Decay:** `open → overdue` past `due_at`; `overdue → missed` after 7 org-local days (`H/sfv/sfv.ts:28,125-143`).
  Alerts are one critical event per transition; the 24/48/72h escalating cadence in the spec is **not wired**
  (`hope-alert-dispatcher` has no Worker; new SFV rows get `alertCadence: {}`).

### 7.3 Timezone, late and missed handling

- **Effectively hard-coded to America/Los_Angeles** **[O]**: the consumer uses
  `summary.locationTimeZone ?? DEFAULT_ORG_TIME_ZONE` (`m6-admission-workflow.ts:87`, **verified**);
  `locationTimeZone` is declared in `packages/types/src/admission.ts:336` but has no producer, and
  `locations.timezone` is unused by HOPE. Z0500B, A0220/A0270 prefill and spec-version resolution use UTC date
  slices.
- **Late:** a typed `lateCompletionReasonCode` (8 internal codes, `H/recording/timepoint-gate.ts:43-52`) is
  checked **only when the draft is created**; **sign does not re-gate** (`route-service-db.ts:1639-1787`,
  verified: no gate call), contradicting spec §7.13. If no schedule row exists, capture is ungated. The code
  list is described as "CMS-aligned" but is absent from the repo's CSV copy (CMS-VERIFY).
- **Expired:** `hope-window-watchdog` (15-minute cron) flips `open → expired` past the late deadline and
  alerts. An admin override past the deadline writes a critical audit event and a row with `scheduleId: null`.
- **Exceptions:** the discharge consumer validates `reason` but ignores it (`m6-admission-workflow.ts:117-118`),
  so death, transfer, revocation and live discharge create the same Discharge window; the HOPE discharge
  reason is client-supplied. Open HUV rows whose window opens after the discharge day are skipped
  (`discharged_before_huv_window`, untested). No consumer exists for admission cancel, correction, hold or
  revocation; `POST /hope/admin/regenerate-schedules` only **adds missing** rows, contrary to spec §7.13.
  The DB backend omits `assertAdmissionActiveAtTarget` and `assertSectionQForDischarge`, which the in-memory
  backend calls (spec §2.3).
- **Duplicates [I]:** the live consumer's only row-level guard is a partial unique index on `status='open'`,
  so a second event with a new event id after a row completed, expired or was skipped would insert a
  duplicate open row. `writeSchedules` (route 20) pre-checks all statuses; the live consumer does not.

### 7.4 Spec version

One version bundled: `1.00.1`, item set `1.00`, effective from `2025-10-01`, no end date
(`scripts/db/import-hope-spec.ts:11-16`). Selection is by the **UTC date slice of the client-supplied
`targetDate`**, frozen on the row at draft creation (`hope-spec-registry.ts:95-112`;
`route-service-db.ts:1255`). There is no "current version" accessor. Adding a version needs a new spec
directory and branches in both registries, which throw on any other code; the serializer's
`HOPE-1.00.1-ERRATA-1.00.3` literal appears in two places; and the importer's idempotency check requires
`effective_to === null`, so closing 1.00.1 breaks its re-run **[I]**. **CMS-VERIFY:** whether 1.00.1 is
current, whether later versions or errata exist (`INTEGRATIONS:429` cites Errata V1.00.3 but no artifact is
in the repo), and which date governs a record.

### 7.5 Validation, prefill, overrides

- Severities are only `error | warning`; errors block signing, warnings never do (including the timing edits
  -3063, -3105, -3110, -3034). **No reviewer acknowledge/override exists**; the only override is the admin
  deadline override.
- **Edit coverage is unproven:** the repo's CMS copy lists 93 edit ids; 52 never appear as a string in
  `apps/backend/src`, `packages/types/src` or `H/` (some may be covered generically). A crosswalk test is
  needed.
- Prefill provenance is `source` (`user, patient_prefill, admission_prefill, derived, imported, correction_copy`) plus a `reason` in `sourceReference`; there is **no source record id, no as-of date and no
  "reviewed" flag**, and discharge prefill reuses `admission_prefill`. User-typed answers are never overwritten.
- Readiness read model (`hope-readiness-service.ts:60-101`) carries sections (counts + `complete | needs_attention | blocked`), validation findings, SFV state and `readyToSign` with eight blocker codes. It
  carries **no window, lateness, owner or submission data**; those come from `getWorkflowState`.

## 8. API inventory (30 operations; `B/routes/hope-routes.ts`, header comment saying "22" is stale)

All use `requirePermission` (`P(key)`) and, unless noted, `requireAbac("hope.scope", notFoundOnDeny)`;
**none require step-up or `Idempotency-Key`**.

| Group                | Operations                                                                                                                                       | Permission                                                    | Notes                                                                                                |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Workflow / schedules | `GET /admissions/:id/hope`, `GET /hope/schedules[/:id]`, `POST /hope/schedules/:id/skip`                                                   | `timepoint.read`, `schedule.read`, `schedule.skip`      | Unfiltered list reads all org rows and filters in JS; skip has no status guard                       |
| Create               | `POST /admissions/:id/hope/timepoints`, `POST …/hope/sfv`                                                                                   | `timepoint.write` (+ override gate)                         | Non-SFV returns the existing draft with 201; **SFV not bound to the admission (R-01)**         |
| Draft edit           | `PUT /hope/assessments/:id`, `PATCH …/answers`, `PATCH …/huv/completion-date`                                                            | `timepoint.write`                                           | **PUT has no `ifVersion` (last-write-wins)**; PATCH uses compare-and-set                     |
| Reads                | `GET …/:id`, `…/workspace`, `…/review`, `…/validation`, `…/submissions`, `GET /patients/:id/hope/assessments`                   | `timepoint.read`                                            | **workspace, review, validation write on read** (prefill refresh, SFV reconcile, finding rows) |
| Sign / amend         | `POST …/sign`, `…/correct`, `…/inactivations`, `…/summary-pdf`                                                                       | `timepoint.sign`, `timepoint.correct`, `timepoint.read` | sign needs `ifVersion`; correct/inactivate optional; summary-pdf emits an event per call           |
| SFV reads            | `GET /hope/sfv[/:id]`                                                                                                                          | `sfv.read`                                                  | list uses caseload narrowing, no `hope.scope`                                                      |
| Submissions          | `GET /hope/submissions[/:id]`, `POST …/assemble`, `GET …/:id/package`, `POST …/mark-uploaded`, `POST …/results`, `POST …/retry` | `submission.read` / `submission.manage`                   | **GET package changes state** (`packaged→exported`); retry deprecated                       |
| Dashboard / admin    | `GET /hope/dashboard/compliance`, `POST /hope/admin/regenerate-schedules`                                                                    | `dashboard.read`, `admin.regenerate_schedules`            |                                                                                                      |

**Contract drift:** `docs/api/openapi.json` documents `…/inactivations` and `…/assemble` as 200 but the routes
send 201; `GET …/package` is an untyped 200. The generated client is `packages/ui/src/core/api/schema.ts`;
the workspace, submission detail and chart-reconcile cast it to untyped shapes
(`W/hope-assessment-detail.tsx:68-70,509`), defeating the stated contract rule in `W/hope-api.ts:12-14`.
The stale-version error is a generic `CONFLICT` on the DB path; `M10_VERSION_CONFLICT` and
`M10_ASSESSMENT_IMMUTABLE` exist only in the in-memory backend, so the UI detects conflicts by regexing the
message (`/version|conflict|stale/i`, `W/hope-assessment-detail.tsx:865`).

## 9. Submission lifecycle and transport truth

**Classification: MANUAL (live), AUTOMATED-UNWIRED (dormant), real transport NOT FOUND.**

- `packages/iqies-client/src/adapter.ts:5-9,88-103` states there is no live transport (CMS FAQ Q30 is quoted,
  not independently checked) and ships a `retryable:false` deny-stub bound at `apps/backend/src/index.ts:12959`
  **[verified]**. `jobs/cron-workers.ts:8-16,493-500` states the three submission stages are **not registered
  or scheduled** **[verified]**. `docs/audit--for-prod/10-hope-cms-compliance.md` lists end-to-end iQIES
  submission as "Not verified".
- **Live path** (`route-service-db.ts:1973-2369`): `POST /assemble` → batch `packaged` (ZIP stored as base64 in
  `acceptance_report`, XML per item in `iqies_validation_result`, items `pending`) → `GET /package` →
  `exported` → `POST /mark-uploaded` → `submitted_pending_result` (**`transmitted_at` = client-supplied
  `submittedAt`, no bounds check**) → `POST /results` → derived batch outcome.
- **Evidence of "transmission"** is an operator-asserted time, an optional free-text reference and the package
  SHA-256. There are no CMS acknowledgements in the system. The 10-year retention clock keys on that
  operator-supplied `transmitted_at` (`jobs/retention.ts:16`).
- **Result parser** (`W/cms-result-parser.ts`) takes pasted JSON or delimited rows with a ChartWarden
  `assessmentId` per row; it does **not** parse a native iQIES validation report, and the original report is
  not stored. Classification is negation-safe and never guesses "accepted" from unrecognised text. Replay is
  protected by a canonical report hash; a settled item cannot be flipped; **there is no undo or void**.
- **Rejection and correction:** a correction is a new linked draft (`corrects_assessment_id`); a rejected
  original is never re-sent unchanged; the signed correction is packaged in a **new** batch with `CRCTN_NUM`
  from chain depth. Nothing auto-resubmits. **[I, CMS-VERIFY]** every correction is `modify` (A0050=2) even
  when CMS rejected the original and never accepted it; the dormant planner has the opposite rule.
- **Duplicate protection:** per-assessment existence check plus partial unique index
  `uniq_hope_sub_item_assessment_active`; `FOR UPDATE` on mark-uploaded and results. Two concurrent generates
  would raise a unique violation with no handler mapping it to 409 **[I]**. The client sends a fresh
  `Idempotency-Key` per click (`W/hope-api.ts:213`), so the server store cannot dedupe real double clicks;
  a `useRef` guard covers the UI only.
- **A lost or never-uploaded package locks its records:** pending items are excluded from every later
  generate and there is no cancel or regenerate route. Recovery is a database operation, contradicting
  `INTEGRATIONS:430` ("a package is regenerated, never re-sent").
- **One bad record aborts the whole package** with a 422 naming at most an item code
  (`hope-cms-xml-serializer.ts:31-61`), while validation-failing records are **silently skipped** with no
  "N of M packaged" feedback (`route-service-db.ts:2022,2041,2047`). The period label is wall-clock `YYYY-MM`,
  not the quarter-based, target-date-anchored `submissionPeriodFor` (dormant).
- **Misleading labels [O]:** "Transmitted" (`submission-detail.tsx:338-341`, blank in the manual flow in
  practice) and "Accepted at" (`:358-361`, the server time the operator recorded the result);
  "In Flight" / "Queued" filters are unreachable in the live path; a result can be recorded straight from
  `exported`, skipping "Mark uploaded"; `submitted_pending_result` renders as "Submitted Pending Result"
  while the filter says "Awaiting result". The honest ones to keep: the worklist banner
  (`submission-worklist.tsx:253-256`), the "Transport: manual_iqies_upload" row, "Awaiting confirmation".
- **Metrics:** the dashboard acceptance rate is a batch ratio over {accepted, rejected, partially_accepted}
  (excludes `accepted_with_warnings`); M30's is an item ratio anchored on `transmitted_at`, so a batch
  recorded from `exported` drops out; `queuedSubmissionCount` counts only `status='queued'`, which manual
  batches never are, so the "unavailable vs low-N" distinction never triggers for the live flow. The
  "on-time" rate counts every `completed` schedule and SFV as on time regardless of lateness.
- **Alerts:** none exists for "signed but not packaged", "packaged but not uploaded" or "CMS rejected"; the
  builders have no callers outside `packages/hope`.
- **Events:** the catalog describes `submission_transmitted` as "`iqies-submit-worker` POSTed a batch to
  iQIES"; the only real emitter is the Mark-uploaded click. `correction_submitted` is emitted at draft
  creation though described as "signed". M33 consumers for accepted/rejected are handler-unbound exceptions.

## 10. Signature, amendment, audit and PHI

- **Sign** (`route-service-db.ts:1639-1787`): draft-only, `ifVersion` compare-and-set, frozen spec/ISC,
  substantive-change check on corrections, readiness gate (`HopeAssessmentNotReadyToSignError`), Z0500B from
  the server clock, status/`signed_at`/`signed_by_membership_id`, D8 clinical context snapshot.
  **Missing [O]:** attestation (`SignTimepointSchema.attestationConfirmed`, `hope-typebox.ts:232`, is
  accepted and **read nowhere in HOPE**, verified), step-up, signer≠author or credential checks. Plan section
  3.1's "explicit final attestation" has no backend behind it.
- **Immutability is code-only.** No `BEFORE UPDATE` trigger exists on `hope_assessment` or
  `hope_assessment_answer` (grep verified); the app role has UPDATE on assessments and DELETE on answers.
  `M10_DR_INT_INVENTORY.md:95` ("never UPDATE-d") is overstated: the supersede trigger and
  `importSubmissionResult` update signed rows.
- **Correction/inactivation:** `/correct` copies active answers as `correction_copy` into a new draft; the
  original stays `signed` until the correction signs, then a trigger sets `superseded`. One pending draft per
  source is checked in code, with no unique index **[I]**.
- **Audit:** DB write-audit triggers scrub PHI columns but record `actor_user_id = NULL` (every write runs
  `withOrgContext(…, userId:"")`); there is no "signed" event type, a reader must diff `status`. The only
  explicit `audit()` is `hope.late_deadline_override`, whose free-text justification is unscrubbed **[I]**.
  `skipSchedule` records no actor and emits no event. Outbox payloads carry ids and enums only (PHI-free).
- **Read audit:** only the patient timeline route sets `patientIdParam`; assessment, workspace, review,
  validation, schedule, SFV and package reads set only `resourceIdParam` (`hope-routes.ts:533`;
  `bootstrap/plugins/read-audit.ts:96-115` has no fallback), so those events likely miss the §164.528
  accounting join. Binary package reads cannot be patient-attributed (`read-audit.ts:205`).
- **PHI at rest:** the ZIP and per-record XML (which can carry SSN/MBI items, e.g. A0600A/B) sit as base64 in
  Postgres JSONB with `db://` labels; no application-level encryption; the "encrypted per tenant" claim
  (`INTEGRATIONS:428`) and the ≤5 MB limit (`:426`) are not enforced in code. Package download has no
  step-up, rate limit or restricted-export flow, and `exported_by_membership_id` is **never written**
  (verified), so the downloader is not recorded.
- **Tenant isolation:** org binding from the session; every service call uses `withOrgContext`; out-of-scope
  ids return 404; RLS enabled **and forced** on all M10 PHI tables (`0118`, `0233`, `0482`). Caseload and
  provider-entity scoping is application-level only. No consent or privacy-flag handling exists in M10
  **[NV elsewhere]**; `rejectAiActor` is not used on any M10 route.
- **Eraser** omits `hope_assessment_answer`, `hope_submission_result_event` and `hope_retention_review`
  (no FK from answers to assessments), so certified destruction likely orphans PHI **[I]**.
- **Error envelope:** typed (`HopeStateError extends ChartWardenError`); no flat `{error}` replies observed.

## 11. UX and accessibility friction inventory

**Navigation / next action [O]:** two unlinked patient homes; dashboard row opens the timeline, not the due
task; the iQIES panel on a signed record links to the worklist ("Open submissions") and cannot trigger
packaging; no pointer back to re-package after "Correct this assessment"; the assessment header shows
identity and target date but **not window, due date, anchor event or owner**; the overview patient link shows
"Loading patient…" forever on failure and links to `/patients/null` when `patientId` is null.

**Labels:** one signed record is "Signed" (timeline), "Completed" (workspace, "Ready to complete") and
schedule "completed" (overview). Dashboard `bucketOf` maps every non-open status to "open"
(`hope-dashboard.tsx:60`, verified) and the unfiltered fetch can return terminal rows, so completed or skipped
windows may inflate the "Open" KPI **[I, confirm backend default]**; "Late" is client-derived from
`windowClosesAt` and ignores the late grace deadline; the SFV worklist re-derives `overdue` client-side but
shows Record only for raw `open`, so a server-`overdue` row gets no Record button; capture-page pill
"Action required" is used when a window merely opens.

**Dead or incorrect controls [O]:** `LegacyTimepointView` (used for `04_sfv` assessments) renders a Sign
button wired to `setSignOpen`, but `SignDialog` renders only in the main return
(`hope-assessment-detail.tsx:1014-1021` early return vs `:1565`; verified), so Sign does nothing; the record
modal's override control appears only for `span==="expired"` and never for SFV, though the capture page says
"An authorized override is required"; the capture page hard-codes discipline `RN`, silently remaps MD→RN for
SFV and ignores `authorDisciplinesForRoles`; corrections default to RN (`disciplineForCorrection`) and the
read projection returns `authorDiscipline: ""` **[I]**, so all corrections may be attributed RN.

**Errors, concurrency, interruption [O]:** the **sign failure path is silent**
(`hope-assessment-detail.tsx:898-903`, verified: close dialog, refresh, no message, even on a version
conflict); submission detail replaces every server reason with "Could not mark this package uploaded";
timeline and SFV worklist collapse all errors to one message; the iQIES panel fails to nothing; corrections
use `window.prompt` for the reason; there is **no `beforeunload`/`useBlocker` guard**, text inputs commit on
blur (last typed value can be lost on unmount **[I]**), and the record and action modals dismiss on scrim or
Escape, discarding a long form (only the CMS-result modal guards this). Four different error mappers exist.
Session expiry is shell-level (`/expired`); HOPE has no draft retention beyond server autosave. The in-workspace
SFV dialog defaults the date to the UTC date and sends `T12:00:00.000Z`, while other forms use local time.

**Accessibility [O]:** strong: shared `Modal` is focus-trapped with Escape; `aria-current` on steps;
fieldset/legend; `aria-live` save state; an axe check runs on the timeline in e2e. Weak: `SignDialog`,
`InactivationDialog`, `CompleteSfvDialog`, `ReviewSfvDialog` are hand-rolled `<dialog open aria-modal>` with
**no focus trap or Escape**, and the SFV dialog closes on backdrop mouse-down while saving; timeline table has
no `scope`/caption and `role=button` rows drop row semantics; the sign attestation is one sentence plus counts,
with no reviewer identity. **Mobile:** the workspace swaps its navigator for a `<select>` at ≤820px; the
dashboard and SFV worklist tables force 66-68rem with horizontal scroll. None of this was exercised in a
browser.

**PHI in the client [O]:** URLs carry only UUIDs; no `console.*` in the module; `localStorage` holds only a
nav-mode preference; `sessionStorage` holds visited-group keys per assessment id; the overview fetches the full
`GET /patients/{id}` for a name (more than the minimum needed **[I]**); the SFV worklist shows 8-char patient-id
prefixes.

**Stale in-source claims:** `W/screens.ts:20-33,51-52` and the record-modal banner say 13 sections have no
items and no section editor exists; `submission-worklist.tsx:15` says detail has "retry";
`submission-detail.tsx:12-13` says the lifecycle is read-only; source headers cite
`docs/design/screens/clinical/CHARTWARDEN_UI_HOPE_ENGINE.md`, which does not exist (the file is
`…HOPE_ASSESSMENT.md`); `hope-routes.ts:8` and the OpenAPI enrichment header say 22 routes (code has 30);
`M10_DR_INT_INVENTORY.md` still describes the automated worker pipeline and promises
`m10.hope.paper_origin_transcribed`, a `system_outage` late reason and a BCP panel that do not exist.

## 12. Source-of-truth map for the proposed workspace

| Proposed element                      | Existing server source                              | Gap                                                        |
| ------------------------------------- | --------------------------------------------------- | ---------------------------------------------------------- |
| Current timepoints, window, attention | `GET /admissions/:id/hope` (`getWorkflowState`) | Needs **source event, anchor date, grace** fields    |
| Last record, history                  | `GET /patients/:id/hope/assessments`              | Needs `authorDiscipline` populated; amendment chain read |
| Sections, blockers, readiness         | `GET …/:id/review` and `/workspace`            | Reads write; consider a pure read (contract change)        |
| SFV obligations on the patient        | `GET /hope/sfv` (org worklist)                    | No patient-scoped SFV read; patient name missing           |
| Submission state per record           | `GET …/:id/submissions`                          | No "ready to package" per record; needs eligibility read   |
| Sign attestation, reviewer            | none                                                | **Genuine gap; do not fake in the UI**               |
| Prefill review state                  | none                                                | **Genuine gap** (no reviewed flag, no source as-of)  |
| Owner / assignee                      | none observed                                       | **Genuine gap**                                      |

## 13. Test baseline and gaps

**Run:** 41 files / 510 tests passed (3 skipped, 1 file skipped), non-live. **Not run:** live suites
(`test:m10:{read,spec,answer-engine,write,retention,submission-result,s04-override}:live`), typecheck,
`arch:fitness`, e2e, a11y.

**e2e:** `hope.spec.ts` (424 lines) covers one RN admission journey (record via timeline modal → draft →
sections → in-workspace SFV → sign → correction button) plus an axe check on the timeline.
`hope-attention.spec.ts` `test.skip`s unless `E2E_HOPE_ATTENTION_ADMISSION_ID` is set, and the variable
appears **only in that spec** (verified), so it is **effectively never run**. No e2e covers package, download,
mark-uploaded, CMS result, rejection→correction→re-package, dashboard, SFV worklist, skip, HQRP, mobile,
session expiry or permission-denied on param routes.

**Chain coverage:** sign → generate (`write` live) and mark/record (`submission-result` live) are covered in
pieces; the full capture → sign → package → download → mark → record → correct → re-package chain is not
covered as one chain. `m10-iqies-pipeline.test.ts` cites a live file that **does not exist**
(`m10-iqies-pipeline.live.test.ts`; verified absent).

**Untested boundaries:** DST weeks, month/year ends, zones other than UTC/LA, the `locationTimeZone`
fallback, HUV window off-by-one vs -3110 and -3034, duplicate event after a row is completed/expired/skipped,
the discharge HUV-skip branch, admission change/cancel, regenerate semantics, a HUV with a J2051 trigger,
`J2052A=0`, signing past the late deadline, a capture with no schedule row, the `skipSchedule` guard, the
on-time rate with late completions, J2050B back/forward-dating, a two-version spec scenario, concurrent
generate. Test stubs that 200 any non-GET once encoded a defect as the expectation (the e2e header says so).

## 14. Plan-document corrections (Section 1 table and Section 4)

- `hope-capture-workspace.tsx` is an admission-scoped draft *creator*, not a draft/validation workspace.
- `patient-hope-timeline.tsx` is a flat history list, not a "patient chronology covering timepoints with
  obligations"; obligations live in `admission-hope-overview.tsx`, which the plan treats as secondary.
- `hope-assessment-detail.tsx` is 5,442 lines and already the guided workspace (section 4.2).
- `hope-sfv-service.ts` is only J2051 trigger derivation; the SFV lifecycle lives in `H/sfv/sfv.ts`,
  `recordSfv` and `jobs/cron-workers.ts`.
- `jobs/submission.ts` is the **dormant** pure-planner path; the live path is `route-service-db.ts:1973-2369`,
  `hope-zip.ts`, `hope-submission-header.ts`, `hope-submission-result.ts`, `hope-submission-reads-db.ts`,
  `packages/iqies-client`, migrations `0226/0233/0234/0235`. Idempotency evidence is the package SHA, item
  rows and result events, not job idempotency.
- Row at plan line 35 ("automated, manual, or both") has an answer: **manual only**. Line 50 ("require
  integration proof") should read "document the manual flow; none exists to prove".
- `outbox-consumers/` and `scheduling/` hold two consumers (one unwired) plus a separate route-20 writer; the
  plan must name the single live consumer.
- Missing from the table: `B/hope-route-service-db.ts` (2,376 lines, the production service),
  `B/routes/service.ts` (2,133, interface + in-memory slice with diverging error codes),
  `B/routes/hope-typebox.ts`, `abac-predicates.ts`, `events-by-m10.ts`, `hope-record-initializer.ts`, both
  prefill services, `hope-spec-registry.ts`, `hope-submission-*.ts`, `hope-zip.ts`, `seams/`,
  `jobs/{cron-workers,index,cron-store}.ts`, `erasers/`, `packages/types/src/hope.ts`, `packages/iqies-client`,
  `packages/auth/src/permissions/contributed.ts`, `packages/db/src/schema/hope/*`, migrations
  `0034,0035,0118,0130,0217,0222-0226,0230,0233,0234,0482,1452`, ADR-0018, and the web files listed in
  section 4.2 plus the shell nav and the entry points in patient/admission/encounter modules.
- Plan section 3.2 states "Ready to package / Transmitted / Corrected" and section 4.6 an "assessment
  visit-date anchor": see sections 6 and 7.2 (no such states; the anchor is contested).
- Plan section 4.4 "approved reason workflow": only a typed internal reason code plus an admin override with
  justification exists; skip reasons are free text.
- The unfiltered `/hope/schedules` read is **not** a 404 for non-org-wide roles any more: the route narrows to
  the caseload (`hope-routes.ts:277-296`, GAP-182), though the code comments in `W/patient-hope-timeline.tsx`
  and `W/hope-read-state.tsx` still assume otherwise.

## 15. Risk register

Severity reflects the audit's static evidence; none was reproduced live. "Track" says where the fix belongs:
**D** = defect PR before/independent of the redesign, **R** = inside a redesign WP, **C** = compliance decision
first, **Doc** = documentation only.

| ID   | Sev  | Risk                                                                                                                                                                                                                                                                                                                                                                     | Evidence                                                                                  | Track   |
| ---- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- | ------- |
| R-01 | High | `recordSfv` finds the SFV by `triggeringAssessmentId` only and never compares it to the URL admission or caller caseload; `hope.scope` checks only the URL admission. A caseload clinician who knows another SFV's triggering-assessment UUID may complete it; the row is written with the SFV's patient and the URL's admission. Exploitability needs a live test | `route-service-db.ts:1432-1472`; `hope-routes.ts:355`; `abac-predicates.ts:203,224` | D       |
| R-02 | High | SFV clock has four definitions; live code anchors to J2050B in UTC, not the ADR visit date; BUSINESS_LOGIC contradicts ADR                                                                                                                                                                                                                                               | section 7.2                                                                               | C       |
| R-03 | High | SFV created only for Admission; a HUV with a J2051 trigger raises `SFV_REQUIRED_OPEN` with no SFV row, so it cannot be signed [I]                                                                                                                                                                                                                                      | `hope-sfv-service.ts:109`; `readiness:347-354`                                        | C, D    |
| R-04 | High | An overdue/missed SFV blocks signing the Admission until an admin override that no default role holds; J2052A=0 + reason unsignable                                                                                                                                                                                                                                      | `readiness:356-382`; `sfv.ts:108-113`                                                 | C, R    |
| R-05 | High | Sign has no attestation (field unused), step-up, signer/credential check                                                                                                                                                                                                                                                                                                 | `hope-typebox.ts:232`; `route-service-db.ts:1639-1787`                                | D       |
| R-06 | High | Signed-record immutability is code-only; no DB trigger on assessments or answers                                                                                                                                                                                                                                                                                         | grep of migrations; `0035:154,0230`                                                     | D       |
| R-07 | High | Transport is manual; "Transmitted"/"Accepted at" are operator assertions; client-supplied `submittedAt` feeds the retention anchor; docs still describe automation                                                                                                                                                                                                     | section 9                                                                                 | R (WP4) |
| R-08 | High | A lost/never-uploaded package locks its records forever; no cancel/regenerate route                                                                                                                                                                                                                                                                                      | `route-service-db.ts:2041`                                                              | D       |
| R-09 | Med  | One bad record aborts the package with an unidentifiable error; invalid records are silently skipped                                                                                                                                                                                                                                                                     | `serializer:31-61`; `:2022-2047`                                                      | D, R    |
| R-10 | Med  | Reads that write (`workspace`, `review`, `validation`, `GET package`) behind read-only permission; route comment says "never mutates"                                                                                                                                                                                                                            | `route-service-db.ts:1546-1562,2165-2170`                                               | D       |
| R-11 | Med  | `skipSchedule` has no status guard, no actor, no event, free-text reason; can skip `completed`/`expired` rows                                                                                                                                                                                                                                                      | `route-service-db.ts:1210-1231` (verified)                                              | D       |
| R-12 | Med  | Read-audit lacks patient attribution on id-addressed routes (§164.528 accounting)                                                                                                                                                                                                                                                                                       | `hope-routes.ts:533`; `read-audit.ts:96-115`                                          | D       |
| R-13 | Med  | Timezone hard-coded to America/Los_Angeles; `locationTimeZone` has no producer; UTC slices elsewhere                                                                                                                                                                                                                                                                   | `m6-admission-workflow.ts:87` (verified)                                                | C, D    |
| R-14 | Med  | Window calculator (+5..+14, +15..+29) and edit -3110 (+6..+15, +16..+30) disagree at the edges                                                                                                                                                                                                                                                                           | `window-calculator.ts:35-43`; `validation/index.ts:782-803`                           | C       |
| R-15 | Med  | Windows anchor on the activation instant; spec says `election_effective_date`; A0220 prefills from `admissionAt`                                                                                                                                                                                                                                                     | `admission-route-service-db.ts:4382`                                                    | C       |
| R-16 | Med  | Sign does not re-gate the late deadline; discharge reason ignored; no cancel/correction consumers; regenerate only adds                                                                                                                                                                                                                                                  | section 7.3                                                                               | C, D    |
| R-17 | Med  | Live consumer lacks an all-status duplicate pre-check [I]                                                                                                                                                                                                                                                                                                                | `hope-timepoint-schedules.ts:61-63`                                                     | D       |
| R-18 | Med  | Package PHI (SSN/MBI-bearing XML) in plain JSONB; claimed encryption not met; no step-up/rate limit on download; downloader not recorded                                                                                                                                                                                                                                 | section 10                                                                                | D       |
| R-19 | Med  | Eraser omits answers, result events, retention reviews [I]                                                                                                                                                                                                                                                                                                               | `erasers/hope-eraser.ts`                                                                | D       |
| R-20 | Med  | 52 of 93 CMS edit ids never referenced; coverage unproven                                                                                                                                                                                                                                                                                                                | section 7.5                                                                               | C       |
| R-21 | Med  | Silent sign failure; dead Sign button for SFV assessments; regex conflict detection; `PUT` last-write-wins                                                                                                                                                                                                                                                             | section 11, 8                                                                             | D, R    |
| R-22 | Med  | Hand-rolled dialogs without focus trap (including the sign dialog); scrim/Escape discards long forms; no unsaved-changes guard                                                                                                                                                                                                                                           | section 11                                                                                | R       |
| R-23 | Low  | Mislabels: Transmitted, In Flight/Queued, dashboard Open/Late buckets, SFV overdue without Record                                                                                                                                                                                                                                                                        | sections 9, 11                                                                            | R       |
| R-24 | Low  | Metrics blind to manual states; on-time rate counts late as on time                                                                                                                                                                                                                                                                                                      | section 9                                                                                 | C, D    |
| R-25 | Low  | Roles: clinician/supervisor role keys and `hope.admin.*` held by no default role; DR doc contradicts seed                                                                                                                                                                                                                                                              | section 5                                                                                 | Doc, C  |
| R-26 | Low  | e2e gaps; `hope-attention.spec.ts` never runs; test stubs that encode defects                                                                                                                                                                                                                                                                                          | section 13                                                                                | R       |
| R-27 | Low  | Documentation drift (section 11 list; `BUSINESS_LOGIC.md:176`; INTEGRATIONS 428-430 vs 654)                                                                                                                                                                                                                                                                            | section 11                                                                                | Doc     |

R-01 meets the repo's "authorization code" trigger: it needs `ecc:security-reviewer` before a fix is merged.

## 16. Recommended to-be journey and decisions requested (STOP GATE A)

### 16.1 Current versus proposed clinician journey

| Step                | Today                                                 | Proposed (presentation over existing APIs)                                                                                                                |
| ------------------- | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Find the due task   | Role home / admission / dashboard → one of two homes | Chart → **HOPE** tab: one patient-scoped workspace (Overview, Complete, Validate & sign, Submission, History)                                      |
| See what is due     | Overview only (windows); timeline has none            | Overview shows windows, attention, SFV obligation and last record together, from `getWorkflowState`                                                     |
| Start a timepoint   | Three entry points (modal, page, picker)              | One primary CTA derived from server state; capture page and raw RFA picker become redirects                                                               |
| Complete sections   | 5,442-line detail screen                              | Same engine, decomposed into focused components; no domain re-implementation                                                                              |
| Fix blockers        | Review tab, silent on failure                         | Blockers grouped by section with field links; explicit sign-failure messages                                                                              |
| Sign                | One-sentence dialog, no focus trap                    | Accessible dialog with review summary; attestation only if the backend gains one (R-05)                                                                   |
| SFV                 | Four places, three payloads                           | One SFV task inside the workspace, using the existing record route                                                                                        |
| Package / track     | Separate worklist                                     | Patient Submission tab reads `…/:id/submissions`; org worklist deep-links to it; labels say "Marked uploaded (operator)", "Result recorded (operator)" |
| Correct a rejection | Link from batch detail                                | Same controlled route, with a "re-package" pointer                                                                                                        |

Old routes stay as redirects or wrappers; no API behaviour changes in WP1.

### 16.2 Decisions requested

1. **Defect track.** Approve fixing R-01, R-05, R-06, R-08, R-10, R-11 (and R-12, R-17..R-19 as capacity
   allows) as separate PRs before or beside WP1, each through `ecc:tdd-guide`, `ecc:security-reviewer` and a
   live suite, never combined with the visual refactor. R-01 first.
2. **SFV and window authority (blocks WP3).** Compliance names the authoritative SFV anchor (R-02), whether a
   HUV can trigger an SFV (R-03), the window day convention (R-14/R-15) and the timezone source (R-13), against
   CMS primary material. No clinical-rule change before then.
3. **Status taxonomy.** Approve the section 6 mapping: drop "Needs review", "Ready to package" and "Unknown" as
   states unless a contract change is approved; relabel "Transmitted" and "Accepted at" as operator
   assertions.
4. **WP4 reframing.** Confirm the goal is an **honest manual-flow UX** plus the R-08 recovery path, not an
   iQIES integration.
5. **Contract gaps.** Approve a separate contract proposal (ADR if it adds persisted state) for the section 12
   gaps: anchor/source-event/grace fields, patient-scoped SFV read, per-record package eligibility read, pure
   (non-writing) review read, and sign attestation.
6. **Scope of WP2.** Treat it as decomposition of `hope-assessment-detail.tsx` plus gap-closing (sign
   feedback, dialogs, conflict codes), not a rebuild.
7. **Live evidence.** Authorise starting the API/web stack on a private database to capture the synthetic
   click-through, axe, keyboard and mobile evidence, and running the `m10-*.live` suites in a private
   `chartwarden-postgres:dev` container. Until then items 3, 11 and the role journeys stay **static-only**.
8. **Audit location.** Confirm this file's path over the plan's `evidence/` path.

## Appendix A. Evidence verification status

**Verified directly by the lead against the code:** deny-stub adapter and its binding
(`iqies-client/src/adapter.ts`, `index.ts:12959`); the unscheduled submission stages (`cron-workers.ts:8-16, 490-500`); no `requireStepUp` in `10-hope`; `exported_by_membership_id` defined but never written;
`recordSfv` lookup and insert, the SFV route guard, `hope.sfvAuthorAllowed` and `hope.scope` target handling;
`skipSchedule`; `attestationConfirmed` unused in HOPE; no `BEFORE UPDATE` migration for `hope_assessment`;
silent sign failure (`hope-assessment-detail.tsx:893-906`); `SignDialog` render site vs the legacy early
return; `bucketOf`; the e2e variable referenced only in its own spec; param-route client enforcement;
`hopeSfvDueAtFromJ2050B`; SFV creation gate; window offsets; timezone fallback; ADR-0018 D1;
`BUSINESS_LOGIC.md:176-178`; no gate call inside `signTimepoint`; absence of `m10-iqies-pipeline.live.test.ts`;
baseline test counts.

**Slice-reported with `path:line` anchors, not independently re-read:** everything else, including the 30-route
guard table, role-template analysis, enum/transition inventory, RLS/FORCE migration coverage, eraser coverage,
read-audit attribution, M30/dashboard rate definitions, edit-id coverage count, spec-importer behaviour, DST
and boundary test gaps, and the accessibility and responsive observations. Treat these as leads to confirm
before acting.
