# Workflow 06 — Care Plan Management Current-State Audit

**Audit date:** 2026-11-15

**Audited revision:** `5e53dc0f4` (`develop`)

**Scope:** WP0 evidence **plus** the defect track it found, applied in the working tree (uncommitted). The
Unified Care Plan Workspace redesign (WP1–WP6) is **not** started and is not authorized by this document.

**Parent plan:**
[`ChartWarden_Workflow_06_Care_Plan_Management.md`](./ChartWarden_Workflow_06_Care_Plan_Management.md)

**Path note:** the plan names `docs/implementation/evidence/06-care-plan-current-state.md`; this file follows
the repo convention of the Workflow 03/04/05 audits (`NN-…-current-state-audit.md` beside the plan).

Tags: **[O]** observed in code by the lead, **[A]** reported by a read-only audit slice and re-confirmed by
the fixer that changed it (read the code, and where feasible wrote a failing test first), **[NV]** not
verifiable statically, **CMS-VERIFY** a regulatory statement that must be checked against CMS primary
material and approved compliance policy before anyone relies on it. This audit asserts no CMS deadline; the
5-day and 15-day clocks below are repo constants, not a statement of what 42 CFR 418.56 requires.

## 1. Executive finding

Module 07 is substantially built and the plan's premise needs correcting in four places; the audit also
found defects that are independent of any redesign.

1. **A guided, tabbed workspace already exists.** `care-plan-view.tsx` already has Goals / Interventions /
   Problems / Review & Sign / Revisions tabs, a workflow stepper, next-step card, authoring modals and a
   sign dialog. The plan's proposed Overview | Problems & Goals | Interventions | Team & Signatures |
   History structure is a re-slicing of that, not a build from nothing (§3.1 of the plan).
2. **The lifecycle graphs were not enforced by production code.** `transitionCarePlan`, `transitionCarePlanVersion`
   and the element machines were called only from tests **[O]**; the live rules were ad-hoc status checks
   in the DB service. The element machines (problem/goal/intervention) are now enforced by the route
   service; the root and version machines are still not called, so "backend graph is authoritative"
   remains an aspiration for those two (decision D-1: element edits are now refused while a version is in review, which removes the main way the hybrid model diverged from what was signed).
3. **The model is hybrid, not "signed records are immutable".** The signed `state_snapshot` is frozen by a
   database trigger, but the plan's live problem/goal/intervention rows stay editable on an `active` plan;
   a signed revision is a new version. D8 (edit after first signature returns the version to draft) is
   coded in `version.ts` and never invoked. The plan's CP-16 and §3.6 were reworded accordingly.
4. **"Pending signature" and "revision pending" are not states.** Root plan: `draft`, `active`,
   `discharged`. Version: `draft`, `in_review`, `signed`, `superseded`. There is no signing order.
5. **Six HIGH defects existed today** (all fixed, section 8): a concurrent-signature race that stranded a
   plan in `in_review`; 42 CFR Part 2 (SUD) text leaking through version snapshots; the patient care-plan
   read returning the *discharged* plan after readmission; a problem-source dropdown that sent three
   values the server rejects; a network failure that locked the whole workspace; and the M15 discipline
   plans never being discharged.
6. **Nobody could sign in a fresh tenant.** No clinical role template granted any `care_plan.*` key. Fixed by D-2 for
   the roles a tenant already has (migration 1494, R-66) and for the Director of Nursing and Medical Director
   templates on a new tenant (R-68). The other signer roles are not templates, so a new tenant's administrator
   still creates them; a role created later receives nothing. Review of D-2 also found that granting
   `care_plan.read` made the internal element-picker read reachable by default and it showed Part 2 content to a
   nurse the release does not name: fixed (R-67).
7. **The audit is static plus unit tests.** No authenticated browser journey ran (section 2).

**Recommendation:** accept the defect track as applied. Every decision in section 9 is closed. D-2 (default
`care_plan.*` grants) is implemented as the approved control `CW-AC-44`. D-8 is decided as a full rebuild (WP1 to
WP6) and not started: the breakdown comes first and WP1 needs your approval. Two policy questions stay yours
(R-73, R-74) and one thing only you can confirm (R-81). The M8 and M15 residual risk (R-80) was closed at your
direction in the picker review (R-82). Two things the later reviews found were decided by you: a discipline
intervention that refines a Part 2 intervention is still created visible, because interventions have no Part 2
flag of their own (R-97), and that goes to a follow-up PR with a `sud_related` column; an M39 outage is logged
nowhere (R-103), and that is left for now. Because `care-plan-view.tsx` grew from about 3.2k to 3.8k lines
during the fixes, the rebuild should replace it rather than extend it.

## 2. Method, limits and evidence status

- **Method:** three independent read-only slices (web UI; backend routes/lifecycle/authz; cross-module and
  tests), each anchored `path:line`; six fixers with disjoint file sets (web view; web overview/summary/
  history; backend service/routes/seams; lifecycle and jobs; M7 consumers; M15), each told to confirm a
  finding in code before changing it and to sweep sibling instances; the lead spot-verified the headline
  findings and ran the central gates.
- **Not exercised:** an authenticated browser journey, the Docker app stack, a deployed flag, a clinician
  usability study, anything against real PHI. WP0 items 7 (screenshots), 13 (click/time baseline) and the
  non-synthetic parts of 8–9 are therefore **[NV]**. `e2e/specs/care-plan.spec.ts` was rewritten against the
  real UI labels but **was not run** (it needs a seeded patient and the `E2E_CARE_PLAN_*` env).
- **Verification results:** section 10.

## 3. Plan claims that were wrong (corrected in the plan)

| Plan claim | Reality |
| --- | --- |
| §1: tests at `07-care-plan/__tests__/care-plan-writes.dom.test.tsx` | The file is `07-care-plan/care-plan-writes.dom.test.tsx` (one level up). `care-plan-api.attempt-key.test.ts` was unlisted |
| §1: `apply-idg-decision.ts` "IDG decisions applied to care-plan domain" | Dead pure decider (no production caller, wrong payload shape); the live consumer is `outbox-consumers/m14-idg-decision-recorded.ts`. Removed; its tests asserted rules production did not implement |
| §1: `lifecycle/care-plan.ts` "treat backend graph as authoritative" | Not called by production code (section 1, item 2) |
| §1: `care-plan-overview.tsx` "care-plan summary" | Presentational pieces only; `summary.tsx` is a separate patient/family page |
| §1: `version-history.tsx` "make history/diff discoverable" | There is no diff anywhere in history; only the proposed-change diff in the view |
| §1: `care-plan-api.ts` "typed client … reuse APIs" | Twelve typed write helpers were dead code; the view used raw `client.POST(... as never)`, which is how the problem-source mismatch compiled |
| §1: `screens.ts` "permission visibility" | Route guards only; there are no navigation entries |
| §1: e2e "audit authenticated coverage" | Both functional scenarios skip unless `E2E_CARE_PLAN_*` is set (no CI job sets it) and their selectors predated the UI |
| §3.2: statuses "pending signature … revision pending" | Not states (section 1, item 4) |
| §3.5: "signer set, ordering" | No ordering exists |
| §3.6 / CP-16: "signed records immutable; revision/addendum required" | Hybrid model (section 1, item 3) |
| §1: problem-proposal row implies a UI path | There is no web UI for problem proposals |
| §3.7: "Workflow 04 Initial Assessments" | Two documents carry number 04: `…_04_Initial_Assessments.md` (untracked) and `…_04_Visit_Encounter_Documentation.md` (the one with commits). Naming is the owner's call (D-9) |

## 4. State tables

Root plan (`lifecycle/care-plan.ts`; `care_plan` has **one row per admission**, not per patient):

| From | Event | Driver in production | Guard | Effects |
| --- | --- | --- | --- | --- |
| — | open | `m6.admission.activated` consumer, or `POST /patients/:id/care-plan` | one non-discharged plan per admission | audit, `m7.care_plan.created`, seeds initial version |
| `draft` | activate | last required signature of the initial version | an active terminal problem | `initial_signed_at`, active version pinned |
| `active` | reviseSigned | last signature of a later version | none | active version pinned |
| `draft`/`active` | discharge | `m6.admission.discharged` consumer (no human route) | reason | `m7.care_plan.discharged` |
| `discharged` | — | terminal; writes refuse with `CARE_PLAN_CLOSED` | | |

Version (`lifecycle/version.ts`): `draft → in_review` (finalize, snapshots the signer set) → `signed`
(quorum) → `superseded` (by the next signed version); `in_review → draft` on return-to-draft. Element
graphs (`lifecycle/elements.ts`): goal `not_started → in_progress → {met, not_met, revised, discontinued}`,
`revised → in_progress`, `met`/`not_met`/`discontinued` terminal; problem `resolved` and intervention
`discontinued` terminal. Element graphs are now enforced (B-05).

## 5. Endpoint inventory

Every route carries `caseload_or_scope`; the DB service runs under `withOrgContext`. After this change
**every POST write route requires `Idempotency-Key`** (bootstrap, versions, finalize, signatures,
return-to-draft, problems, resolve, goals, interventions, discontinue); the three PATCH routes also take
`If-Match`; the problem-proposal accept/dismiss routes keep body `ifVersion` and no key.

| Method | Path | Permission |
| --- | --- | --- |
| GET | `/api/v1/patients/:patientId/care-plan` | `care_plan.read` |
| POST | `/api/v1/patients/:patientId/care-plan` | `care_plan.bootstrap` (body `admissionId` is now checked against M6) |
| GET | `/care-plans/:planId/versions`, `…/versions/:versionId`, `…/proposed-changes` | `care_plan.read` (SUD-redacted) |
| POST | `/care-plans/:planId/versions`, `…/return-to-draft`, problems, goals, interventions, resolve, discontinue | `care_plan.author` |
| POST | `…/versions/:versionId/finalize` | `care_plan.finalize` |
| POST | `…/versions/:versionId/signatures` | `care_plan.sign` + role match + step-up |
| PATCH | problems / goals / interventions `/:elementId` | `care_plan.author` (+ discipline scope on interventions) |
| GET | `…/readiness`, `…/review-status`, `…/overdue-status`, `…/summary` | `care_plan.read` / `read_summary` |
| GET/POST | `…/problem-proposals`, `/accept`, `/dismiss` | read / author |

## 6. Default role grants (as seeded) **[A]**

Before D-2: `administrator` and `org_admin` receive every non-platform key (all seven `care_plan.*`);
`director_of_nursing` received `care_plan.finalize` only. **No clinical role template** (`rn`, `rn_case_manager`,
`hospice_physician`, `nurse_practitioner`, `msw`, `chaplain`, `clinical_supervisor`, `idg_coordinator`, `lpn`)
granted any `care_plan.*` key, and the sign path requires the caller to hold the signer role key. A freshly
provisioned tenant therefore could not author or sign a care plan.

After D-2 (R-66, control `CW-AC-44`): read and read-summary for the clinical roles; author and finalize for the
nurse case manager, the clinical supervisor and the DON; sign for exactly the six signer roles; never bootstrap or
IDG revise. Source: `packages/auth/src/roles/care-plan-grants.ts`, backfill migration 1494, and the DON and Medical
Director templates for a fresh tenant (R-68).

**Coverage is narrower than that list reads.** Migration 1494 reaches the roles a tenant already has. On a new
tenant the template materializer creates only the Director of Nursing and the Medical Director; `rn_case_manager`,
`hospice_physician`, `nurse_practitioner`, `msw`, `chaplain` and the read-only clinical roles are not templates, so
an administrator creates them and grants the keys. A role created after the migration does not receive them (the
admitting-clinician and code-status grants behave the same way). Two narrowings are by design and fail closed:
`discipline_scope` reads discipline role keys, so a user who holds only `director_of_nursing`,
`clinical_supervisor` or `rn_case_manager` is still refused an intervention write; and `chha`, `volunteer`,
`pt`, `ot`, `st`, `dietitian`, `music_therapy` and `bereavement` get no read key, so their element picker answers
403 (R-73, R-74). Widening either is a policy decision for you.

## 7. Test coverage against CP-01…CP-32 (before this change) **[A]**

Covered: 03, 08, 11, 13, 14, 22, 23. Partial: 05, 06, 09, 10, 12, 16, 17, 18, 19, 31. **Not covered:** 04
(measurable goal is optional), 07 (network loss), 15 (stale-version sign). The IDG unit tests exercised the
dead decider, so CP-18's pure-core assurance was false. Added by this change: network-rejection, stale-409
recovery, double-submit, IDG conflict, SUD-redaction, readmission, concurrent-sign, terminal-element and
idempotency tests (section 10 lists counts).

## 8. Defect register

Dispositions: **Fixed** = changed and covered by a test; **Live-proof pending** = the behaviour needs the
Postgres suite (section 10); **Decision** = not changed, needs an owner call (section 9); **Deferred** = not
done, reason given.

### Backend and lifecycle

| ID | Sev | Defect | Disposition |
| --- | --- | --- | --- |
| B-01 | HIGH | `signVersion` unlocked read + UPDATE without version predicate: two concurrent last signers leave the version `in_review` with quorum signatures and no `version_signed` event **[O]** | Fixed: plan and version rows locked `FOR UPDATE`, version predicate on the UPDATE (loser gets 409). Live-proof pending |
| B-02 | HIGH | SUD (42 CFR Part 2) problem/goal/intervention text returned raw in `state_snapshot` via versions, patient aggregate and proposed-changes **[O]** | Fixed: fail-closed redaction on get/list/aggregate/finalize/sign/proposed-changes |
| B-03 | HIGH | Patient care-plan read returned the oldest plan, so after discharge + readmission the UI showed the discharged plan and the active one was unreachable **[O]** | Fixed: one rule (`plan-selection.ts`) used by the route service, reader store, M15 active-problem read and M14 packet read |
| B-04 | HIGH | Physician can sign snapshot S1 while live rows have since changed; D8 never invoked | **Decision D-1** (hybrid model; not changed) |
| B-05 | MED | Element lifecycle graphs never invoked: terminal rows reopenable, re-resolve overwrote note and re-emitted `m7.problem.resolved`; IDG apply bypassed them | Fixed (service guards, IDG candidate and apply paths) |
| B-06 | MED | Concurrent discharge could be overwritten back to `active` by a sign | Fixed (plan lock + `ne(status,'discharged')`) |
| B-07 | MED | Initial due date was activation + 5×24h, not org end-of-day; `computeInitialDueAt` unused | Fixed |
| B-08 | MED | Review clock used a hard-coded Pacific zone and re-armed on every sign incl. interim revisions | Fixed for the writers and the encounter-gate reader (org timezone; re-arm only `initial`/`idg_review`). The cron warning window still uses the Pacific default (hours of skew for a non-Pacific org); see B-22 |
| B-09 | MED | Bootstrap accepted any `admissionId`, binding patient X's plan to Y's admission | Fixed (M6 `AdmissionStatusReader` seam, non-leaking 404) |
| B-10 | MED | `problemId`/`goalRefs` plain strings: non-uuid → 500; foreign-plan/tenant ids accepted | Fixed (uuid format + plan-membership check) |
| B-11 | MED | Signer slot `count>1` deadlocks (unique index); greedy slot matching rejected valid signers | Fixed (cap at 1, lifecycle rejects, 23505 → 409, bipartite matching) |
| B-12 | MED | Intervention patch/discontinue skipped discipline scope (an MSW could edit an RN intervention) | Fixed |
| B-13 | MED | Only PATCH routes enforced `Idempotency-Key`; retried POSTs duplicated rows and events | Fixed (all POST write routes) |
| B-14 | MED | `added_by`/`drafted_by` membership never set (NULL authorship on domain rows) | Fixed |
| B-15 | MED | No default clinical role grants (section 6) | Fixed: D-2 (R-66) |
| B-16 | LOW | `initial_overdue` emitted at warning-open (T-2d); nothing at real overdue | Closed without code (D-7): the spec contradicts itself and no consumer subscribes, so a migration for a marker nobody reads is not justified |
| B-17 | LOW | `signatureMethod` hard-coded `password_step_up` | Fixed (resolved from the step-up factor, fallback unchanged) |
| B-18 | LOW | IDG `conflict` status rolled back with the throwing transaction | Fixed (persisted; 409 after commit) |
| B-19 | LOW | DST ±1h in grace; legacy plans with NULL `next_review_due_at` never gated | Fixed in gate, cron, seam reader and dossier summary (no migration) |
| B-20 | LOW | `overdue-status` ignored `:planId`; `targetAt`/`onsetAt` accepted but dropped | Fixed |
| B-21 | LOW | Return-to-draft needs `care_plan.author`, lifecycle comment says any signer | Closed (D-10): kept `care_plan.author`; the lifecycle comment now says so |
| B-22 | LOW | Part 2 evaluator receives a user id as `membershipId` (over-redacts, fail-closed); `:planId`/`:elementId` non-uuid → 500 on the other routes | **Deferred** (needs an ambient membership / reader signature change; a shared uuid guard on `PlanParamsSchema` is a small follow-up). The cron warning window and the overdue-status malformed id were fixed in the review round (R-06, R-15) |

### Web

| ID | Sev | Defect | Disposition |
| --- | --- | --- | --- |
| W-01 | HIGH | Problem-source options (3 of 4) rejected by the server; `as never` hid it **[O]** | Fixed (options derived from the contract; 5 real values) |
| W-02 | HIGH | `mutate`/`reload`/bootstrap without `try/finally`: one dropped request locked the workspace **[O]** | Fixed; every `await` guarded |
| W-03 | MED | Esc/scrim during an in-flight write lost the error and discarded typed text | Fixed |
| W-04 | MED | 409 STALE_VERSION had no recovery; modal retried the stale version forever | Fixed (reload and re-seed, keeps typed text) |
| W-05 | MED | Healthy plans always showed "needs attention" (`OPEN_VERSION_REQUIRED` counted as a blocker) | Fixed |
| W-06 | MED | Client demanded a terminal problem for every version kind; the server only for `initial` | Fixed (trust server blockers) |
| W-07 | MED | `targetAt` rendered a day early for US clinicians | Fixed (view, overview) |
| W-08 | MED | A failed proposed-changes read became "IDG decision required"; conflicts never explained | Fixed in UI; the server still does not treat a conflict as a blocker (finalize returns `IDG_PROPOSAL_CONFLICT`) |
| W-09 | MED | Discharged plan displayed as green "Active" | Fixed (server still leaves `activeVersionId` set on discharge) |
| W-10 | MED | Typed write helpers dead; wrong error-envelope read | Fixed (view routes through helpers; envelope read) |
| W-11 | MED | "Start the care plan" ungated; failure reason dropped; admissions error rendered as "no open admission" | Fixed |
| W-12 | MED | Sign dialog did not name the version; step-up lost the typed note | Fixed (shown; draft survives the step-up round trip, in memory only) |
| W-13 | MED | e2e specs skipped and stale | Rewritten against real labels; **not run** |
| W-14 | LOW | Cleared optional fields silently dropped while UI said "updated" | Fixed (visibly non-clearable) |
| W-15 | LOW | Start/finalize/sign buttons not disabled while busy; tab switched on failure; fabricated post-sign state | Fixed |
| W-16 | LOW | Physician wording shown for IDG/MSW/chaplain signer sets | Fixed (labels changed: "Send to IDG team" etc.) |
| W-17 | LOW | Summary page told patients "No active problems" when no signed version; raw discipline ids; no print control | Fixed |
| W-18 | LOW | Version history: bad id fell back silently, no URL on select, races, no `aria-current` | Fixed |
| W-19 | LOW | Status tone map missed `in_review` and other real enum values | Fixed (test asserts every enum value has a tone) |
| W-20 | LOW | Tabs/menus/field errors not accessible; every write unmounted the workspace | Fixed (tabs pattern, `aria-invalid`/`describedby`, in-place refresh) |
| W-21 | — | `care-plan-view.tsx` is now about 3.8k lines (800-line soft ceiling) | **Deferred**: extract forms/guide/modals as the first step of WP3 |
| W-22 | LOW | Goal status select offered graph-illegal moves (now 409) | Fixed (offers current + legal targets) |

### Cross-module

| ID | Sev | Defect | Disposition |
| --- | --- | --- | --- |
| X-01 | HIGH | M15 `discharge` never dispatched: discipline plans stay active forever, alerts continue, two active plans after readmission | Fixed: `m6-admission-discharged` consumer (wired in `index.ts`, catalog updated, `arch:outbox-bindings` clean). No live suite; see D-6 |
| X-02 | HIGH | M7/M15 IDG consumers threw on non-transient states and dead-lettered after ~10 min with no durable trace | Fixed: a permanent refusal is a durable row + audit and an ack (M7 `conflict`, M15 `refused`); a self-clearing one waits and then applies (R-14). Permanent refusals are terminal (D-4) |
| X-03 | MED | Dead decider `consumers/apply-idg-decision.ts` and tautological tests gave false CP-18 assurance | Removed; tests rewritten on the live consumer; the T4 "never resolve/deactivate the terminal problem" rule ported |
| X-04 | MED | M15 applies IDG mutations to live rows while the version is an unsigned draft and acks "applied" | **Decision D-5** (reported only) |
| X-05 | MED | M15 plan lookups picked an arbitrary plan after readmission | Fixed (prefer live, newest); M14 does not yet emit `admissionId` (D-11) |
| X-06 | MED | M15 aide editor and IDG revision screens had no inbound link | Fixed (permission-gated links) |
| X-07 | LOW | Goal `measurableOutcome` optional and unchecked (CP-04) | **Decision D-3** |
| X-08 | MED | M15 `signVersion` never supersedes the previous signed version, so "Current signed version" shows the oldest | **Deferred to Workflow 07** (M15 ownership) |
| X-09 | — | `gap-013` live suite broken by the new Idempotency-Key and admission-binding contract | Fixed (hook + seam stub) |

### Found by the post-fix review (one round, read-only reviewers on three lanes)

| ID | Sev | Defect | Disposition |
|---|---|---|---|
| R-01 | HIGH | Web: after a stale-409 re-seed the form still held the OLD values of fields the user never touched and PATCHed all of them, silently reverting the other editor's change | Fixed: updates send only the fields the user changed; an untouched field follows the re-read row; the Save button is disabled when nothing changed |
| R-02 | HIGH | Web: goal status state stayed at the old value while the options were rebuilt from the re-read row, so every retry 409'd and the dialog was stuck | Fixed (falls back to the row's status when the pick is no longer offered) |
| R-03 | HIGH | M7 IDG proposal builder ran its element guards only when a `status` was present, so an edit of a resolved problem or a met/not_met/discontinued goal became a proposal that `finalize` could never apply, wedging the plan's single open-version slot | Fixed: the builder reuses the exact apply-time guards (`guardProblemStatusChange`, `guardGoalStatusChange`, `assertProblemEditable`) |
| R-04 | MED | The same guards refused a status equal to the current one, which apply treats as a no-op (the web form re-sends it), turning a valid decision into a permanent conflict | Fixed (same change as R-03) |
| R-05 | MED | `returnVersionToDraft` and `finalizeVersion` took no row locks while `signVersion` locks plan then version: a concurrent sign and return-to-draft could deadlock (40P01 → 500) | Fixed (one lock order); live tests hold the row locks from a second connection |
| R-06 | MED | Due dates are written in the org timezone but the cron, the `warningOpensAt` lead check and the packet-context read still used the Pacific default | Fixed (org timezone threaded through the cron scans and the dossier summary) |
| R-07 | MED | `getReviewStatus` did not derive a due date for a legacy plan (NULL `next_review_due_at`), so the UI said "not due" about a plan the gate blocks | Fixed (live test) |
| R-08 | MED | Web offered Edit on met/not_met/discontinued goals and non-active interventions, which the server refuses | Fixed (`isGoalEditable`/`isInterventionEditable` in all four render sites) |
| R-09 | MED | Web: a write closed or reported into whatever dialog was open when the answer arrived (finalize success discarded a typed Edit dialog) | Fixed (the write remembers which dialog started it) |
| R-10 | MED | Web: navigating to another patient with a write or dialog open could land the old patient's plan under the new URL | Fixed (workspace keyed by patient) |
| R-11 | MED | Web: a stale 409 whose re-read also failed still said "the latest version is loaded" | Fixed (says it could not be loaded) |
| R-12 | MED | e2e authoring selectors did not match the UI (Add buttons live on the Problems tab; two "Review & sign" buttons; no start-draft step) | Fixed, **still not run** |
| R-13 | MED | The new M15 discharge consumer had only an in-memory test whose fake ignored predicates, so a wrong `WHERE` could not fail | Fixed: live block in `m15-idg-decision-apply.live.test.ts` (sibling admission and another tenant untouched, replay is a no-op) |
| R-14 | MED | M7/M15 refusals for conditions that clear on their own (a draft plan, an open revision or a version in review that is signed hours later) were acked as terminal, so the clinical decision was lost and someone had to re-record it | Fixed: the outbox relay gained `OutboxDeferral` (a consumer-requested wait: the row stays pending and is retried every 30 min without consuming an attempt, so it cannot dead-letter). M7 (`plan_not_active` for a draft plan, `version_already_open`) and M15 (`version_in_review`) wait while the event is under 14 days old and apply by themselves once the blocker clears; past 14 days they record the durable refusal as before. Permanent refusals are unchanged. Live-proved through the real dispatcher (M15) and the handler (M7) |
| R-15 | LOW | Linked goal not reset when the problem changes; stepper said "Physician signature" for a team review; IDG History banner link not permission-gated; a 5-digit year threw on submit; malformed `:planId` on `overdue-status` gave 500; two live/route tests passed on weaker conditions than they claimed | Fixed |
| R-16 | LOW | Reported: M6's `reason` on `m6.admission.discharged` is free text, so M15's exact match on `death`/`revocation`/`transfer` would record `discharge` for a noted revocation or transfer | **Not a defect (withdrawn).** Every `dischargeAdmissionTx` caller passes either nothing (revocation, transfer, so the event carries `dischargeType`) or the §4.2.7 enum (`death`, `moved_out_of_service_area`, `no_longer_terminal`, `for_cause`, `other`); the narrative lives on the discharge row, not the event. `m6-discharge-reason-matrix.live` already proves the emitted values. Fixed the misleading M15 comment and the unit test, which used an invented free-text value, to cover every value M6 emits |
| R-17 | LOW | The packet-context dossier read `plan.organizationId`, a column its select does not return, so the org-timezone lookup added for R-06 received `undefined` (caught by `bun run typecheck`, not by tests) | Fixed (uses the function's `organizationId` argument) |
| R-18 | HIGH | Introduced by the R-03 fix: the builder guarded each IDG mutation alone against the LIVE row, but finalize applies a version's changes in `(idgDecisionId, ordinal)` order through the same guards. Two accepted changes to one element (a goal edit and `met`, a problem edited after `inactive`, two discontinues) could apply in the wrong order and fail `finalizeVersion` for good, wedging the plan's single open-version slot | Fixed: an element is changed at most once per version. Two mutations of one decision on one element are refused (`element_targeted_twice`); a decision whose element the meeting's draft already changes WAITS (like R-14) and, past the horizon, is refused (`element_has_pending_change`). Live tests for both |
| R-19 | HIGH | M15 sealed every goal, `sud_related` ones included, into a version's `stateSnapshot`, and `GET /discipline-plans/:planId/versions/:versionId`, finalize and sign returned it unredacted to any `discipline_plan.read` caller, although `getPlan` already hides those goals (same defect class as B-02 in M7; the M15 discharge consumer seals one more such snapshot per plan) | Fixed in the route layer with the per-request disclosure verdict (fail closed; unit + route tests). The `m15.plan.version_signed` outbox payload still embeds the full snapshot: see D-13 |
| R-20 | MED | `OutboxDeferral` left the 14-day horizon to each consumer, so a consumer that forgot it would retry forever, and a parked decision raised no dead-letter alert | Fixed: the relay enforces the horizon itself; past it a deferral is an ordinary failure, so it dead-letters and alerts (live relay test). A parked decision still has no age alert while young: see D-14 |
| R-21 | MED | No live assertion that the M15 discharge and the refactored M15 refusal write their audit rows | Fixed (both asserted live); the discharge audit also carries the source outbox event id |
| R-22 | LOW | The service-level SUD redaction defaulted OPEN when no viewer was passed (`?? true`) although the interface says fail closed; every route passes a viewer, so no live bypass | Fixed: no viewer redacts; an internal reader passes `{ sudDisclosureAllowed: true }` explicitly. One test pinned the old default and was rewritten |
| R-23 | LOW | `m7.care_plan.idg_proposal_refused` was emitted but absent from the audit action registry | Fixed (registered, `compliance` retention, Part 2 eligible) |
| R-24 | LOW | M15 still refused a decision recorded before the discipline plan's first signature as permanent (`plan_not_yet_active`) while M7 waits on the same condition (R-14 listed only `version_in_review`) | Fixed: a draft plan WAITS like an in-review version and is refused durably past the 14-day horizon (live test) |

### Found by the pre-PR review (`/ecc:code-review` backend, `/ecc:react-review` web; none CRITICAL or HIGH)

| ID | Sev | Defect | Disposition |
|---|---|---|---|
| R-25 | LOW | The M7 IDG consumer took no lock: its draft-version read and the application and change inserts are check-then-insert, so a `finalizeVersion` committing between them left a `proposed` application inside an `in_review` version and the last signer got `IDG_PROPOSAL_CONFLICT` until someone returned the version to draft (recoverable, not a wedge) | Fixed: the plan row is read `FOR UPDATE`, the same plan-then-version order as finalize and sign |
| R-26 | LOW | The `element_targeted_twice` check compared raw strings; the payload's `uuid` format accepts upper case and Postgres compares uuids case-insensitively, so `ABC…` and `abc…` passed the check and could wedge finalize as R-18 describes | Fixed (compared lower-cased; live test with a mixed-case pair) |
| R-27 | LOW | The M7 service still defaulted OPEN for the versions it returns from finalize and sign (`versionDto`, `versionsForPlan`), relying on a route wrapper that was not failure-safe: a consent-lookup error after the write committed turned a recorded signature into a 500 | Fixed: both defaults are closed; finalize and sign take the viewer and the service redacts; the route resolves the viewer BEFORE the write and falls back to "no disclosure" on a lookup error, as M15 does (route test: lookup failure still answers, redacted; service test: no viewer redacts) |
| R-28 | MED | e2e signed as `admin@`, which holds every permission but no signer role, so the sign route refuses it (`signer_role_match`) and the spec would fail at its last assertion | Fixed: the admin authors and sends the version, then the RN case manager (`rita@`) signs the `rn_case_manager` slot after the passkey step-up. **Still not run** |
| R-29 | LOW | After `IDEMPOTENCY_KEY_STUCK` the dialog stayed on the old rows with Save enabled; the client renews the key after that refusal, so the next click was a new write and duplicated a row if the first attempt had committed late | Fixed: the workspace is re-read and the dialog re-seeded before the user decides (DOM test: the repeat quotes the re-read version) |
| R-30 | LOW | The legacy in-flight 409 (a plain `CONFLICT` carrying the old server sentence, sent during a deploy window) was matched on the error code alone, so the raw server sentence showed | Fixed: matched with the shared `isInFlightDuplicate` / `isKeyStuck` predicates, now exported from `@chartwarden/ui` |
| R-31 | LOW | "No snapshot was recorded for this version." is false for a snapshot the server withheld (a malformed shape redacts to `null`), and an emptied group under the restricted-content note still read "None recorded." | Fixed: "No snapshot is available for this version."; an empty group of a redacted snapshot reads "None shown to your role." |
| R-32 | LOW | After "saved, but the workspace could not be refreshed" every write control stayed live on the stale plan, so re-entering an entry that had saved created it twice under a new key | Fixed: authoring, finalize and sign stay off until a re-read succeeds, and the banner carries a Refresh button (DOM test) |
| R-33 | LOW | The summary's Print button printed on the handout | Fixed: it sits in a `.wx-print-hide` wrapper hidden under `@media print`. The rule is **not verified in a browser** |

### Found by the compliance review (`compliance-reviewer` on the whole branch diff: 1 HIGH, 4 MEDIUM, 4 LOW; each claim was checked against the code before acting)

| ID | Sev | Defect | Disposition |
|---|---|---|---|
| R-34 | HIGH | M15 write results returned confidential content to a caller without disclosure. `PATCH /discipline-plans/:planId/goals/:goalId` returned the goal row (its text) for a `sud_related` goal; assessment sign and amend returned the assessment `data` for a `sud_flag` (or family-violence) row; the 409 version message confirmed the row existed and gave its current version, so a guessed `If-Match` was free; and `interventions[].goalRefs` on the plan read listed the hidden goal's id. The M15 IDG consumer refuses SUD goals for exactly this reason | Fixed: the routes resolve the caller's SUD and family-violence verdict (fail closed, a client-supplied value cannot widen it) and the write service answers "not found", identical to a missing row, BEFORE the version check, for a hidden goal, an intervention serving a hidden goal, and a flagged assessment (each category unlocked only by its own verdict). Unit tests for the route gate and live tests against real rows (mutation-checked) |
| R-35 | MED | M15 interventions were never Part 2 redacted: no flag of their own and no goal anchor, so a `scopeText` naming the treatment reached the caller on the plan read, the patient-shareable summary, the internal read, the seam read and the version snapshot | Fixed: an intervention that serves a hidden goal is hidden with it, on all five surfaces (module 07 treats a problem's dependents the same way); the goal id no longer survives in a snapshot or a `goalRefs` list |
| R-36 | MED | The `CW-AC-43` gap text named the wrong consumers (M22, M28, M14, M30, M33; the catalog declares only M22, M14 and M33 read through seams, and M28 and M30 are explicitly not consumers) and missed the real sinks and one more path | Fixed (`controls.yaml` rewritten with the consumer set; every gap it named is now closed in code, see R-43 to R-52) |
| R-37 | MED | The cited evidence did not exercise the production chain: the M7 live tests passed a hand-built viewer and `gap-013` never called `/versions`, `/finalize` or `/proposed-changes` | Fixed for M7: `gap-013` finalizes and reads versions through the real routes, plan-to-patient resolver and M39 evaluator, once without and once with a Part 2 release. M15 too (round 3): `gap-013` now mounts the real M15 routes with no injected port and proves the route to seam to M39 chain live, with a release, without one, and with the evaluator unbound |
| R-38 | MED | Pre-existing: `GET /api/v1/ops/outbox/:id` returns the event's whole `payload` (which can carry PHI: D-13) and its `auditRead` had no `resourceIdParam`, so the emitter returned early and the read left no trail | Fixed: it declares `resourceIdParam: "id"`; a route test asserts the audit event lands and fails without it. What the payload contains is still D-13 |
| R-39 | LOW | `OutboxDeferral` trades the dead-letter alert for a silent wait of up to 14 days | Fixed (round 3, D-14): `chartwarden_outbox_oldest_pending_age_seconds` reports the wait. CW-MON-01 is about security-event review and is not the right control, so it is left alone |
| R-40 | LOW | M15 audit actions are not in the audit catalog (`m15.plan.discharged` follows the existing pattern; M15 has no slice at all). Retention resolves to the `compliance` default, which is right | Fixed (round 3, D-15): M15 has exactly three explicit audit actions (`m15.plan.discharged`, `m15.idg_decision.applied`, `m15.idg_decision.refused`), not about twenty (the rest is the M4 row-diff trigger); they now have a catalog slice |
| R-41 | LOW | The care-plan signature recorded `password_step_up` for a TOTP signer (only a WebAuthn ceremony was recognised) | Fixed: TOTP is recorded `totp_step_up` (the column is free text; nothing pins its two old values); unit test for the mapping |
| R-42 | LOW | Redaction fail-open edges: M15's redactor passed any object without a `goals` key; M7's treated a snapshot problem with no `sudRelated` key as visible; and a proposal made only of Part 2 changes still listed its id, status and reason | Fixed: only the exact draft shape passes in M15; a problem without the literal `sudRelated: false` is withheld in M7; a proposal whose changes are all hidden is not listed (a proposal with no changes stays). Live test for the proposal case |

### Closed in round 3 (the Part 2 gaps behind `CW-AC-43`, the open decisions, and the header)

| ID | Sev | What | Disposition |
|---|---|---|---|
| R-43 | MED | The Discipline plans tab showed a bare page title where every other chart tab shows the patient banner and the Patient Summary rail; the per-plan pages used a hand-rolled partial banner | Fixed: the index and the per-plan workspace use the shared `ChartPatientBanner` and `PatientSummaryPanel`; the title moved into the content; a DOM test pins it |
| R-44 | HIGH | D-13: `m15.plan.version_signed` carried the full sealed snapshot, Part 2 goals included, into the persisted `outbox_event.payload` (which the ops detail read returns) and the PDF M22 renders | Fixed: the event carries `redactDisciplineSnapshot(snapshot, false)`; the sealed row stays whole behind the disclosure-gated reads. Live test through the real catalog-validating publisher |
| R-45 | MED | D-16: the IDG packet cover read a SUD-related terminal problem's description and ICD-10 without a filter | Fixed: the seam names it by a fixed marker (`withheld` / `42 CFR Part 2`), so the packet still builds and the IDG team still sees a primary diagnosis exists. Live test |
| R-46 | MED | D-11: M14's `problem_add` had no SUD flag (a Part 2 problem added by an IDG decision was stored as not SUD-related, never redacted), and `problem_update` had no `resolutionNote`, so an IDG decision could never resolve a problem | Fixed: `sudRelated` (only the literal `true` counts) and `resolutionNote` are in the M14 contract, the shared type, the M7 consumer and the apply path; the IDG decision form has a Part 2 checkbox; the minutes name a flagged problem by its kind only, and a decision that flags one puts its patient in the release-needed set at once. Unit, DOM and live tests |
| R-47 | MED | D-1: element edits were allowed while a version was `in_review`, so the plan could differ from what the signers signed (and an IDG review was stranded as a conflict) | Fixed: the eight element writes answer 409 `VERSION_IN_REVIEW`; return the version to draft first |
| R-48 | MED | D-3: a plan could be finalized with goals that state no measurable outcome | Fixed: 42 CFR 418.56(c)(3) (checked on eCFR) lists "measurable outcomes anticipated from implementing and coordinating the plan of care"; an initial version now refuses finalize and sign, and reports a `GOAL_OUTCOME_REQUIRED` blocker in readiness, while any live goal has none |
| R-49 | MED | D-12: an IDG version whose proposal went `conflict` held the plan's only open-version slot for good | Fixed: the conflict discards the version (signatures invalidated, status `superseded`, the application's `conflict` row is the record) |
| R-50 | MED | D-6: the system-signed discharge version emitted no `m15.plan.version_signed`, so M22 never rendered the final PDF | Fixed: the discharge consumer emits it (redacted snapshot, no signers) |
| R-51 | LOW | D-14 and D-15 (see R-39, R-40) | Fixed: the oldest-pending-age gauge and the M15 audit slice |
| R-52 | MED | The M15 route to M39 chain had no live proof (CW-AC-43 gap 4) | Fixed: see R-37 |
| R-53 | HIGH | Found by the round-3 code review: an IDG decision that resolves a problem with a note (R-46) could never be signed. The post-apply snapshot check compared the live row's `resolved_at` (stamped at the SIGN instant) with the candidate sealed at finalize (null), so the quorum signature always rolled back and the version stayed `in_review` | Fixed: the comparison ignores `resolved_at` for the problems that review resolves, and nothing else. Live test: IDG resolve, finalize, sign to quorum, assert status, note and `resolved_at` |
| R-54 | MED | Accepting a problem proposal (`POST .../problem-proposals/:id/accept`) is a ninth element write that bypassed the in-review guard | Fixed: it takes the same guard. Live test |
| R-55 | MED | Discarding a conflicted IDG version (R-49) left the meeting's other decisions on that version `proposed` forever (the consumer never re-proposes them) | Fixed: every sibling application is marked `conflict` (`version_discarded`). Live test with two decisions in one version |
| R-56 | MED | The in-review guard was check-then-write with no lock, so an element write could commit after a concurrent finalize sealed the snapshot | Fixed: the guard locks the plan row first, the same plan-then-version order as finalize and sign |
| R-57 | MED | The ops outbox read withheld only a problem the decision flagged itself, not a `problem_update` on an existing Part 2 problem, nor goal and intervention text | Fixed: every mutation of a plan decision keeps its structure (operation, ids, enums, the flag) and loses all its text, codes and notes |
| R-58 | LOW | A newline or tab passed the measurable-outcome check; the discharge consumer published a blank PDF event for a plan with no goal or intervention; stale catalog text; the version machine comment said `superseded` is only reachable from `signed`; the age gauge reads org rows only | Fixed, except the gauge: it is documented as org-scoped (a deferral only exists for org-scoped bindings) |
| R-59 | MED | Found by the final compliance review: an upper-case `problemId` on an IDG `goal_add` or `intervention_add` evaded the Part 2 anchor match (the proposal and the sealed snapshot kept the author's casing) and, at the final signature, made the post-apply snapshot comparison fail, wedging the review | Fixed: the consumer stores the anchor and `goalRefs` lower-case. Live test: an upper-case anchor is hidden without disclosure and the review still signs |
| R-60 | MED | `CW-AC-43` evidence did not exercise several clauses of its own title (the ops read was proven only by a mocked unit test; the M15 version routes only by an injected port) | Fixed: `gap-013` now reads the M15 version detail and list and the ops outbox detail through the real evaluator, and asserts the read audit event lands with the patient named; the evidence list names what proves each clause and drops two entries that proved none |
| R-61 | LOW | The ops read named no patient in its audit event; non-mutation decisions (team note, referral, order request) were returned whole; `GET /internal/care-plan/relevant-elements` wrote no audit event at all (neither a resource id nor a patient) | Fixed: `patientIdPayloadPath` on the ops read, every decision field other than its kind withheld, `patientIdQueryParam` on the relevant-elements read |
| R-62 | LOW | The readiness blocker for a missing outcome named a count, which told a caller without disclosure how many hidden goals the plan holds | Fixed: the message names no count |
| R-63 | LOW | A redacted plan PDF read as complete; a snapshot of unrecognised shape rendered a blank PDF | Fixed: a redacted snapshot carries a notice sentence (printed as a field by the generic renderer) when anything was dropped, and an unrecognised snapshot is not rendered at all |
| R-64 | LOW | A goal added by an IDG decision under a Part 2 M7 problem was stored as not Part 2 in M15 | Fixed: the consumer reads the patient's Part 2 problem ids through a second org-explicit M7 port and the goal inherits the flag; the decider compares ids case-insensitively. Live test |
| R-65 | LOW | A signature recorded `password_step_up` when the session id was missing or the seam threw, so an unverified WebAuthn or TOTP signer read as a password signer | Fixed: `step_up_unverified` (and `sms_step_up` for SMS); the column is free text |
| R-66 | MED | D-2: no clinical role held any `care_plan.*` key by default, so a nurse case manager could not author or sign | Fixed for the roles a tenant already has: `CARE_PLAN_DEFAULT_GRANTS` (least privilege, sign only for the six signer roles), backfill migration 1494 (insert-only, idempotent), a pin test and a live proof that re-runs the migration over staged roles. New control `CW-AC-44`. New-tenant coverage: R-68 |
| R-67 | HIGH | Review of D-2: `GET /internal/care-plan/relevant-elements` was gated by `care_plan.read` and caseload only, and its reader asked the patient-level Part 2 question (any release with an active recipient). D-2 made the route reachable by default, so an `rn` the release does not name received the SUD problem and the interventions that serve it | Fixed: the route resolves the caller's per-ACTOR verdict through the same closure every other M7 read uses and hands it to the reader (`viewer`, a REQUIRED fifth argument on the `CarePlanReader` seam since the re-review, R-75); M8's link check and M15's parent check ask under the actor audience so they agree with the picker (R-80, R-82); only the scheduling worker and M15's system actor, which serve no human, pass `"patient_level"` explicitly and keep the patient-level check. Unit tests (seam and route) and a live test with the real evaluator and reader: a nurse the release names sees it, one it does not does not, no release redacts, the RN case manager carve-out applies only where no release names others. Mutation-checked live. Naming the picker in `CW-AC-43` is its own commit, awaiting approval |
| R-68 | MED | Review of D-2: only the DON template carried its keys; the Medical Director template did not, the constant, comments and register overstated new-tenant coverage, and the pin test checked only the DON | Fixed: the Medical Director template carries read, read-summary and sign; the pin test holds every templated grantee to the constant; the header comment, `CW-AC-44` and section 6 now state the real coverage (the other signer roles are not templates) |
| R-69 | LOW | The pin test compared the sign grant with a hand-copied signer list | Fixed: `SIGNER_ROLE_KEYS` is exported from the predicate and `care-plan-grants-pin.test.ts` pins the sign grants to it and it to the `care_plan_signer_role` enum |
| R-70 | LOW | The backfill's audit rows had no actor and no reference, and the live proof asserted neither them nor the organization on each row | Fixed: the migration stamps `app.correlation_id` (`migration-1494-care-plan-default-grants`, the 0340 precedent); the live test asserts every row carries its role's organization and that each insert was audited under that id |
| R-71 | LOW | The `CW-AC-44` scope read as covering Part 2 and caseload, and no request was sent as a granted role | Fixed: the row says it is the RBAC half only, adds 164.308(a)(4)(ii)(C), and cites a route test that sends requests with exactly the default keys (an LPN reads and is refused every write route M7 registers, 15 of them, derived by an `onRoute` hook rather than listed by hand (R-86); the DON authors and cannot sign) |
| R-72 | LOW | The backfill cannot tell "never granted" from "withheld on purpose", and does not filter `role.enabled` | Kept as designed, with the reason written into the migration: the grant is least-privilege, every effective-permission path joins `role.enabled` so a disabled role's keys are inert, and a role re-enabled later must not come back without them. A tenant that withheld a key on purpose removes it again; the batch is listable by its correlation id (R-70). Say so in the release notes |
| R-73 | LOW | Author and finalize are narrower than the policy implies: `discipline_scope` builds disciplines from role keys that exclude `director_of_nursing`, `clinical_supervisor` and `rn_case_manager`, and the IDG-coordinator exception is unreachable by default (read only) | Documented, not changed (fails closed); noted in `CW-AC-44` and section 6. The DON, as an org-wide role, authors on every patient in the organization |
| R-74 | LOW | Discipline roles (`chha`, `volunteer`, `pt`, `ot`, `st`, `dietitian`, `music_therapy`, `bereavement`) get no `care_plan.read`, so the encounter element picker answers 403 for them | Documented, not changed (fails closed, and the pin test asserts `chha` and `volunteer` are excluded). Granting read to them is your decision |

### Found by the compliance re-review of D-2 (`compliance-reviewer` on `f20db3e8f..704bf9f9e`: no CRITICAL, HIGH or MEDIUM, 7 LOW; it confirmed the HIGH and MEDIUM above are fixed)

| # | Sev | Finding | Resolution |
|---|---|---|---|
| R-75 | LOW | `viewer` was optional on the shared seam, so omitting it silently selected the weaker patient-level rule | Fixed: `viewer` is required and typed `CarePlanElementsAudience` (the per-actor verdict, or the literal `"patient_level"`); `admissionId` became `string \| undefined` to allow that. A caller that forgets it no longer compiles. M8, M15 and the scheduling worker passed `"patient_level"` with a comment saying why; M8 and M15 now pass the actor audience (R-82), so only the scheduling worker and M15's system actor still do. The same type is the store port's parameter |
| R-76 | LOW | The picker's read-audit event was never asserted to land (it falls back to the patient id as resource id) | Fixed: the live test asserts one `care_plan_element.viewed` row whose resource id is the patient and whose context names the patient; after the picker review it also asserts the reader and the organization on that row (R-87). The reader user is now a real uuid, because the emitter casts the acting user to uuid and swallows a failure, which would have made the assertion vacuous |
| R-77 | LOW | The `CW-AC-43` fail-closed clause now covers the picker but no picker test proved it for a missing membership id, an unbound evaluator, or no closure bound | Fixed: two live cases (no membership id against a release that names staff, answers redacted; evaluator unregistered after seeding, the named member is redacted) and one route test with no closure bound (a caller holding the cleared role is handed a denying verdict) |
| R-78 | LOW | `CW-AC-44` evidence overstated two tests: the template test checked containment, not "identical", and the LPN test hit one write route | Fixed in the tests, so the approved row's wording stays true and was not edited: each templated role's `care_plan.*` keys (grants plus floor) must EQUAL the constant's, and the LPN is refused every M7 write route (13 when this was written; the list covered only `care-plan-routes.ts` and missed the two problem-proposal POSTs, so it is now derived: R-86) |
| R-79 | LOW | The `drizzle-store.ts` header still said the consent fact is "never a caller-asserted scope", while `viewer` lets a caller's boolean replace the lookup | Fixed: both the Drizzle store and the port header now state the trust boundary: only a route that resolved the verdict from the M39 closure may pass a viewer, and a hand-built `{ sudDisclosureAllowed: true }` would bypass M39 |
| R-80 | LOW | M8 `addCarePlanLink` and M15 `assertParentElements` check element ids against the patient-level verdict, which is not the picker's per-actor rule. Two directions. (a) Looser: a clinician the release does not name who already holds a Part 2 element's uuid is told success rather than 422 (unchanged by this branch). (b) Stricter, and user-visible: an RN case manager on a chart with a Part 2 problem and no release on file sees it in the picker (the §7.6 carve-out, R-67) but the link answers 422 "problem is not valid for this encounter" (M15: `PARENT_ELEMENT_NOT_FOUND`). (b) arrived with the R-67 fix: before it the picker and the check both used the patient-level rule and agreed. Found by the picker review (R-82) | **Fixed (`a4b590818`), at your direction: both checks are now per-actor.** Details and proof in R-82. First accepted as a residual risk (ids only, a uuid is not guessable); the picker review showed the second direction was user-visible, so it was closed instead. The behaviour change to put in the release notes: a nurse the release does not name can no longer link a visit to, or parent a discipline goal onto, a Part 2 problem, and an RN case manager now can where no release names others |
| R-81 | LOW | Migration 1494 was edited after its first commit (the correlation-id statement), which changes its checksum; if the runner falls back to the NOBYPASSRLS app role it inserts nothing and is still recorded as applied | Not changed. The migration is on no remote branch and not on `main`, so the checksum only matters if an environment applied the earlier text: **confirm that none did** (the dev Docker stack is the one to check; I did not read it). The app-role fallback matches the 0340, 0379 and 1294 precedents, which have no guard either |

### Found by the picker review (round 4: `ecc:code-reviewer`, `ecc:typescript-reviewer` and `compliance-reviewer`, read-only, on the four picker areas; no CRITICAL or HIGH, three MEDIUM, the rest LOW, several found twice)

| # | Sev | Finding | Resolution |
|---|---|---|---|
| R-82 | MED | The picker is per-actor but M8 `addCarePlanLink` and M15 `assertParentElements`, which validate what the picker offered, are patient-level. For an RN case manager with no release on file the picker offers a Part 2 problem and the link answers 422; a nurse the release does not name is accepted when she holds the uuid (R-80, both directions) | **Fixed (`a4b590818`), at your direction.** `CarePlanElementsAudience` gained a third form, `{ actor: { roles, membershipId } }`, which the Drizzle store resolves itself through the same function the M7 routes' closure uses (M39 `evaluateForInternalAccess`, then the §7.6 RN-case-manager carve-out), only when the plan holds a Part 2 problem, failing closed on any throw. M8 `addCarePlanLink` takes a REQUIRED `actorRoles` (the route passes the session's) and M15 `createGoal` and `createIntervention` pass `elementsAudienceFor(actor)`, so the callers hand over identity and never a verdict they could assert. The scheduling worker and M15's system actor stay on `"patient_level"`: no human is served. Proven live with the real reader, store and evaluator, each ask paired with a `"patient_level"` control that gives the old answer: a nurse the release does not name is refused (patient-level admitted her); the named member passes; an RN case manager passes with no release (patient-level dropped it); no membership id against a staff-naming release, an unbound evaluator and a plain nurse with no release are refused; and through the real M15 goal route (422 `PARENT_ELEMENT_NOT_FOUND` or 201 by caller). **Limit:** the M8 live suite uses a stub reader, so M8 is proven by a test that its route hands the session's roles and membership to the service and a live test that the service asks the reader under the actor audience, with the behaviour itself proven at the reader and through the M15 route |
| R-83 | LOW | Four comments were false after the audience change: the `CarePlanReader` header ("SQL-side"; the release is resolved through M39), the in-memory store note ("when given"), the Drizzle header ("skips the consent round-trip" is true only on the `"patient_level"` path) and "the closure" for a function that the closure wraps | Fixed (`4d0925732`), comments only |
| R-84 | LOW | `CarePlanViewer` (route service) repeated `CarePlanElementsViewer` (seam) | Fixed (`5fccea228`): the first is an alias of the second. Not branded: a hand-built `{ sudDisclosureAllowed: true }` still compiles, so the trust boundary stays a convention, backed by R-85 |
| R-85 | LOW | `"patient_level"` was a free literal guarded only by comments | Fixed (`4c222fe32`): `care-plan-patient-level-pin.test.ts` fails unless exactly the reviewed files name it, and each passes it where it should. Narrowed in `a4b590818` when M8 and M15 moved to the actor audience: now the scheduling worker, M15's `elementsAudienceFor` (system actor only) and the three implementing files; M8 naming it again fails the test. A new `arch:` gate was not added: that would be a new control. Mutation-checked: a caller that stops naming it fails two tests, an unreviewed file that starts naming it fails one |
| R-86 | LOW | "Every M7 write route" was 13 of 15: the two problem-proposal POSTs, behind `care_plan.author`, were outside a hand-written list | Fixed (`093896c75`): the test records every non-read route both registrars register with an `onRoute` hook (15), asserts that count and both proposal URLs, and expects 403 for an LPN on each. Mutation-checked: giving the LPN `care_plan.author` fails on the proposal accept route |
| R-87 | MED | The audit assertion never checked who read, and matched the patient with a substring | Fixed (`387fbc648`): it asserts `actor_user_id` is the reader, `organization_id` is the tenant and the context matches `{ patientId }`. Mutation-checked: an audit row that loses its actor fails it |
| R-88 | MED | The unbound-evaluator test used a plain `rn`, which has no case manager carve-out, so it could not see the "restricted" half of the fail-closed rule | Fixed (`387fbc648`): the caller is `rn,rn_case_manager`. Mutation-checked: a consent outage that stops marking the verdict restricted fails it (it passed before) |
| R-89 | LOW | The picker's reader uuid was the same as an existing fixture user, shared through a global table with `ON CONFLICT DO NOTHING` | Fixed (`387fbc648`): its own uuid |
| R-90 | LOW | No live test covered the picker's goals, so a wrong parent-problem mapping would leak Part 2 goal text with every test green | Fixed (`387fbc648`): one goal per problem; the redacted nurse sees only the plain goal, the named member both. Mutation-checked: an unfiltered goal list fails it |
| R-91 | LOW | Test hygiene: `picker as never` hid a type mismatch, the `asked` type omitted two asserted keys, two titles claimed more than the stubbed reader proves, two variables in the seam test were named backwards, and the member ids were string literals repeated at every call | Fixed (`093896c75`, `387fbc648`): typed fixture, full `asked` type, titles say "hands the reader the closure's verdict", names say what they hold, `NAMED` and `OTHER` constants |
| R-92 | LOW | The `CW-AC-43` evidence comment understated the live picker cases (no membership id, unbound evaluator, the audit event) and omitted the two unit files that pin default-deny and the call sites | Fixed in its own commit `2a213a6a5`, which, like `1cdd3ef05`, **needs your approval before it is pushed** |
| R-93 | LOW | A test comment cited `CW-AU-01`, whose evidence does not list this suite | Citation dropped (`387fbc648`); the repo habit it rests on is named instead. The `CW-AU-01` row was not edited |
| R-94 | LOW | This document was stale: R-67 said the callers "serve no human", R-71 and R-78 said "all 13", R-80 named one direction and section 10 quoted 16 live tests | Fixed here |

### Found by the review of the per-actor change (round 5: `ecc:code-reviewer`, `compliance-reviewer`, `ecc:react-reviewer`, two rounds each on the new commits; no CRITICAL or HIGH)

| # | Sev | Finding | Resolution |
|---|---|---|---|
| R-95 | MED | A goal authored through the M15 route did not inherit Part 2 from its parent problem (`sudRelated` was whatever the author sent), and since R-82 an RN case manager with no release can parent onto one, so her unflagged goal was visible to M15 readers who cannot see the problem. The IDG-apply path already inherited | Fixed (`a1f33fe89`): `RelevantProblem` carries an in-process `sudRelated` (set by the reader from `containsSud`; the picker handler strips it, so the HTTP contract and OpenAPI are unchanged), `assertParentElements` returns `parentSudRelated`, and `createGoal` stores `(input.sudRelated ?? false) \|\| parentSudRelated`. Live: stored flagged and withheld from a plain read, a plain problem is not flagged (control). Mutation-checked. **Forward only:** goals stored before this are not backfilled; reseed (prod is demo data) |
| R-96 | MED | The inheritance looked only at `parentProblemId`, so a goal naming a plain problem and a `parentGoalId` under a Part 2 problem was stored unflagged (M15 never checks that the parent goal belongs to the named problem; M8 does) | Fixed (`c51e19ef1`): flagged when either the named problem or the parent goal's problem is Part 2. No new rejection. Unit and live test, mutation-checked |
| R-97 | MED | **Open until the follow-up PR.** A discipline intervention has no Part 2 flag column and is hidden only through the goal it is anchored to, so an intervention that refines a Part 2 IPOC intervention (`parentInterventionId`) without a Part 2 goal anchor is created visible. It predates this work (the old patient-level rule admitted it whenever a release existed); R-82 makes it newly reachable for an RN case manager with no release | **Decided: a follow-up PR, not this one.** The full fix is its own change: add `sud_related` to `discipline_intervention` with a migration, the code and manifest mirrors, inheritance from the parent problem and the parent intervention, and the reads. Until then the limit is stated in `CW-AC-43`'s evidence (`2e28e99a4`). The 422 rule (refuse when the parent intervention serves a Part 2 problem and `goalRefs` names no Part 2 goal) was considered and not chosen: it blocks that authoring path for cleared clinicians too |
| R-98 | LOW | One resolver built the synthesized access context twice (the M7 routes' closure and the reader store), and the shared code warns against a second copy | Fixed (`e4bd50a66`): `sudDisclosureAllowedForActor`, used by both; behaviour identical |
| R-99 | LOW | More false comments after the round-4 rewrite: the `CarePlanReader` header ("the one thing a caller supplies is the verdict"), "SQL-side" in five places, the system actor "has no membership", the `RelevantProblem` filter rule stated as the old patient-level one, the Drizzle header joining two claims with a colon, a stale `sudReadAllowed` doc | Fixed (`e4bd50a66`, `76a38e7f0`), comments only |
| R-100 | LOW | The `"patient_level"` and hand-built-viewer pins are tripwires, not guarantees: the viewer type is a plain boolean, so a computed value, a quoted key or a variable passes them | Tightened (`76a38e7f0`): the picker's and `viewerOf`'s viewers must both take the closure's verdict, the scan covers `packages/*/src` too, its own `describe`, and an honest comment. Branding the verdict type so only the closure can produce one was not done: a design change, and review stays the control |
| R-101 | LOW | M8 was proven only with a stub reader | Fixed (`a1f33fe89`): live tests drive the M8 link service through the real reader and the real in-memory evaluator (a nurse the release does not name is refused and no link row is written; the RN case manager with no release and the named member link); a route test proves the session's roles and membership reach the service. **Limit:** the service is driven directly, not over HTTP, and the consent store is the in-memory one |
| R-102 | LOW | The M8 live test restored the stub reader but left the real evaluator bound, and its stub problem hid the new required field | Fixed (`76a38e7f0`): the evaluator is restored (to the boot deny-stub, which fails closed; the registry has no unregister), the stub carries `sudRelated: false` |
| R-103 | LOW | **Open, deliberately.** An M39 outage is swallowed with no log or metric in the reader store and in `defaultInternalSudAccessChecker`, so M8 and M15 answer 422 as if the id did not exist (the picker at least answers `redacted: true`). Fail-closed, no PHI risk; `part2ReleaseAllowed` already behaved this way | **Left for now, at your direction.** No logger is reachable from those catch blocks (only `request.log` exists), so logging means a logger parameter on the store factory and the checker, a bigger signature change than an operability fix |
| R-104 | HIGH | Found while testing M15: the goal route schema accepted `clinician_authored` and `idg_directed` but not `clinical`, while the DB enum, the shared type and the module spec all say `clinical \| patient_stated \| family_stated \| agent_stated`. The aide plan-of-care editor defaulted to `clinician_authored`, so saving a goal with the default source failed with a 500 at the insert (the in-memory twin used by the inject test hid it). Pre-existing | Fixed (`b614ee538`, `1e5c78dc1`): the route union equals the enum (pinned by `m15-goal-source-parity.test.ts`), the editor offers the three real sources and defaults to `clinical`, "IDG directed" is gone (no such source exists; IDG-applied goals come from a consumer), the OpenAPI file and typed client are regenerated (only the enum changed), the goal tables label `clinical` as "Clinician authored" like the select, and a DOM test pins the default and the option list. Mutation-checked |
| R-105 | LOW | The M7 goal form offers `agent_stated` with no consent field (raised by the React review) | Checked, not a defect: the M7 route resolves the DPOA consent itself from M39 and needs no id from the client; `gap-013` proves 422 `DPOA_CONSENT_REQUIRED` without a consent on file and 201 with one |

## 9. Decisions (all closed)

Each decision below is closed: it says what was decided and what changed. D-2 is implemented. **D-8 is
decided (a full rebuild, WP1 to WP6) but not started**: it stops at WP1 for your approval.

- **D-1 Signature integrity.** *Closed: the 409 guard.* Element writes answer `VERSION_IN_REVIEW` while a
  version is `in_review` (R-47).
- **D-2 Default clinical grants.** *Closed: granted by default* (R-66). The repo's precedent
  (`CODE_STATUS_EDITOR_ROLE_KEYS`, migration 1294): a code list of role keys, a backfill migration pinned to it, a
  pin test, and a control row (`CW-AC-44`, approved by you). The grant is least-privilege: read for the clinical
  roles; author and finalize for the nurse case manager, clinical supervisor and DON; **sign for exactly the six
  roles `signer_role_match` accepts** (a grant to the DON would never pass that rule, so it is not given).
  Review found that the read grant exposed the element-picker route to a Part 2 leak (R-67, fixed) and that
  new-tenant coverage is only the DON and Medical Director templates (R-68, stated honestly in the row).
- **D-3 Measurable goals.** *Closed: a blocker on initial versions* (R-48), after checking 42 CFR 418.56(c)(3) on
  eCFR. IDG review versions keep their own rule (`goal_add` already requires an outcome); an old goal with none
  never blocks a review.
- **D-4 Permanently refused IDG decisions.** *Closed: accepted as is.* They are a durable refusal row plus audit,
  visible in M7 and M15; the coordinator re-records. M14 still shows the decision as `emitted`; a new catalog
  event and an M14 consumer for a rare case is not worth it.
- **D-5 M15 IDG application timing.** *Closed: accepted as is.* M15's model is working rows plus signed snapshot
  versions: the application writes the working rows and opens a draft revision, the `applied` row links decision
  to revision, and the signature is a separate step. Moving to M7's apply-at-quorum model would be a rewrite of the
  consumer and of M14's acknowledgement for no defect found.
- **D-6 M15 final PDF.** *Closed: emit it* (R-50).
- **D-7 `initial_overdue` timing.** *Closed without code.* The spec contradicts itself, nothing subscribes, and a
  migration for a marker nobody reads is not justified. The T-2d warning stays. Revisit when M36 subscribes.
- **D-8 Redesign (WP1 to WP6).** *Decided by you: rebuild everything (WP1 to WP6).* This replaces the earlier
  recommendation to reshape (the guided, tabbed workspace already exists, section 1, item 1). Not started: the
  work-package breakdown comes first, WP1 (design and contracts) is a stop gate that needs your approval, and every
  package is a small PR over the existing APIs, with no schema or backend change and the routes and permissions
  preserved. What this change did in the meantime is make the Discipline plans tab share the chart header (R-43).
- **D-9 Workflow numbering.** *Closed: not this workflow's.* The two files numbered 04
  (`Visit_Encounter_Documentation`, tracked; `Initial_Assessments`, untracked) belong to Workflow 04. Renumbering
  would break the README rows and links of work in flight. This workflow stays 06.
- **D-10 Return-to-draft by a sign-only signer.** *Closed: no.* It stays `care_plan.author`: someone who cannot
  author must not be able to invalidate everyone else's signatures. The lifecycle comment was wrong and now says so.
- **D-11 M14 contract.** *Closed:* `sudRelated` and `resolutionNote` added (R-46). `admissionId` on
  `idg.decision_recorded` is **not** added: the consumer applies a decision to the patient's active plan, which is
  correct across readmission, and a decision for a discharged plan is the documented permanent refusal.
- **D-12 A conflicted IDG version.** *Closed: it discards itself* (R-49), so no separate "discard" action or route
  is needed; D-1 removes the ways in.
- **D-13 `m15.plan.version_signed` and Part 2.** *Closed: redacted at emit* (R-44).
- **D-14 No age alert for a deferred outbox event.** *Closed: a gauge* (R-51). Suggested alert: above a day
  investigate, above a week the decision is about to become an audited refusal. `CW-MON-01` is security-event
  review, not this, so no control row changes.
- **D-15 M15 audit catalog.** *Closed* (R-51): three actions, not twenty.
- **D-16 IDG packet cover and a Part 2 terminal problem.** *Closed: withheld by a fixed marker* (R-45).

## 10. Verification

Run on `develop` after merging `origin/main` (which carries the migration 1489/1490 fix), 2026-11-15.

| Check | Result |
|---|---|
| `bun run typecheck` (build + sharded test typecheck) | 0 errors |
| `bun run arch:fitness` | 50 of 50 gates pass |
| `bun run arch:compliance` | OK (register evidence resolves, gaps are dated) |
| `bun run test` (all non-live suites) | 2954 files: 2418 passed, 536 skipped, 0 failed; 35773 tests passed. Two unrelated flakes seen in earlier runs did not fire: `10-hope/__tests__/hope-admission-workspace.dom.test.tsx` and `12-dosespot/.../secret-cipher.test.ts` |
| Web folders touched after that run (`07-care-plan`, `14-idg`, `15-discipline-care-plans`, `shell`) | 59 files, 1014 tests (before the last two small commits), then the `14-idg` and `15-discipline-care-plans` folders again: 17 files, 180 tests, all passed |
| `bun run harness:phi-scan` | clean on every commit (pre-commit hook) |
| Live suites (private `chartwarden-postgres:dev`, `max_locks_per_transaction=1024`, `valkey/valkey:8-alpine`, `chartwarden_app` NOBYPASSRLS) | all passed at the last full live run, before the D-2 commits (the suites that D-2 and its reviews touch were re-run on the final commits: see the rows below): `m7-care-plan-write` 58, `m15-idg-decision-apply` 21, `gap-013-care-plan-consent-wiring` 12 then (18 now), `care-plan-conformance` 8, `m7-care-plan-read-service` 4, `m14-s05-careplan-to-idg` 16, `m14-idg-write` 45, `m14-packet-build` 19, `f161-m7-m17-render-requests` 4, `outbox-dispatcher` 9 |
| **M15 route to M39 chain** (was unproven) | `gap-013` mounts the real M15 routes with no injected port: a caller with no release gets the read without Part 2 goals or the interventions that serve them, and a write on a hidden goal answers 404 identical to a missing one; with an active release it gets both; with the evaluator unbound it is redacted |
| **`bun run check:boot:platform`** (was not re-run) | passes on the merged final code: boots with `DATABASE_PLATFORM_URL`, `/health` 200, outbox relay polling (fresh migrated DB, provisioned roles) |
| **e2e** (was not run) | `e2e/specs/care-plan.spec.ts` in Chromium against a private full stack (own Postgres, Valkey, backend and Vite, seeded demo tenant): 2 passed (authoring, send for signatures and a recorded signature, run twice to cover the return-to-draft path; and the axe WCAG 2.1 A/AA scan of the care plan view), 1 skipped (the IDG proposal test needs `E2E_CARE_PLAN_IDG_PATIENT_ID`). **The run found the spec itself was wrong**: the admin account cannot author an intervention (`discipline_scope` denies it), so the RN now authors and signs |
| **Print CSS** (was not run in a browser) | probed in Chromium with print media emulated on both summary pages. The care plan summary was right (shell hidden, Print button hidden, content not clipped). **The discipline plans summary was not**: it printed its own Print button (66 by 40 px); it is now wrapped in `.wx-print-hide` and measures 0 by 0 in print |
| OpenAPI, typed client, inject-coverage report | regenerated |
| **D-2 and its review fixes** (R-66 to R-74): `bun run typecheck`, `arch:fitness`, `arch:compliance`, `arch:migration-numbering`, `arch:migration-compat` | all exit 0 |
| D-2: `bun run test` (all non-live suites) | 2956 files: 2420 passed, 536 skipped, 0 failed; 35786 tests passed |
| D-2: live suites on private containers (`cw-pg-wf06`, `cw-vk-wf06`) | `m3-role-catalog-floor` 15 of 15 (the migration re-run over staged roles, now also asserting each row's organization and the audit rows under the migration's correlation id); `gap-013-care-plan-consent-wiring` 16 of 16 |
| D-2: mutation checks (break the code, see the test fail, restore) | dropping the viewer from the element-picker route fails 2 live tests (a nurse the release does not name then sees the SUD problem) and both route unit tests; dropping the correlation-id statement fails the role-floor live test; dropping the Medical Director grants or adding a role to the signer list fails the pin tests; dropping `actor_unidentified` from the "restricted to named staff" flag fails the no-membership-id live test for the RN case manager |
| **Picker review fixes** (R-82 to R-94): `bun run typecheck`, `arch:fitness` (50 of 50), `arch:compliance`, `harness:phi-scan` on the 12 changed paths | all exit 0, on the tree that became the six commits `4d0925732` to `2a213a6a5` |
| Picker review: changed non-live tests (`care-plan-hardening-routes`, `care-plan-seam`, `care-plan-patient-level-pin`, `care-plan-grants-pin`, `care-plan-grants`) | 5 files, 54 of 54 |
| Picker review: `bun run test` (all non-live suites) and `arch:fitness` with this document in the tree | 2957 files: 2421 passed, 536 skipped, 0 failed; 35791 tests passed. `arch:fitness`: 50 of 50 gates |
| Picker review: live suites at the first six picker commits (superseded by the final-tree rows below) (private `cw-pg-wf06`, `cw-vk-wf06`) | `gap-013-care-plan-consent-wiring` 18 of 18 (12 plus six per-actor picker tests), `m7-care-plan-write` 58, `m3-role-catalog-floor` 15, `m3-role-templates` 7, `m8-encounters-write` 60, `m15-idg-decision-apply` 21, `m15-plan-bootstrap` 7, `m17-scheduling-write` 23, `m7-link-summary` 6 |
| **Picker review: mutation checks** (break the code, see the test fail, restore byte for byte) | a consent outage that stops marking the verdict restricted fails the unbound-evaluator live test (R-88; it passed before the test was changed); a reader that stops filtering goals fails the redacted-nurse live test (R-90); an audit row that loses its actor fails the same test (R-87); a caller that stops naming `"patient_level"` fails 2 pin tests and an unreviewed file that starts naming it fails 1 (R-85); giving the LPN `care_plan.author` fails the derived route test on the proposal accept route (R-86) |
| **Final tree** (HEAD `2e28e99a4` plus this document): `bun run typecheck`, `arch:compliance`, `client:check`, `arch:fitness` | all exit 0; `arch:fitness`: 50 of 50 gates |
| **Final tree: `bun run test`** (all non-live suites) | 2963 files: 2427 passed, 536 skipped, 0 failed; 35843 tests passed |
| **Final tree: live suites** (private `cw-pg-wf06`, `cw-vk-wf06`) | `gap-013-care-plan-consent-wiring` 31, `m8-encounters-write` 63, `m15-idg-decision-apply` 21, `m15-plan-bootstrap` 7, `m7-care-plan-write` 58, `m17-scheduling-write` 23, `m7-link-summary` 6, `m14-s05-careplan-to-idg` 16, `m3-role-catalog-floor` 15, `m3-role-templates` 7: all pass |
| **Final tree: mutation checks** (break the code, see the guarding test fail, restore byte for byte; those marked * I reproduced myself) | the reader store ignoring the actor's roles* fails the case-manager tests; M15 or M8 passing `"patient_level"` again* fails the route and live tests and the pin test; M15 ignoring the parent problem's flag* and the parent goal's problem* fails the inheritance tests; the carve-out ignoring "restricted to named staff" for an identified case manager fails its test; the picker's viewer becoming a variable fails the pin test; `clinician_authored` back in the route union fails the parity test; the aide editor's default changed fails the DOM test |
| Tree state during these runs | another session's uncommitted platform-role and superadmin edits (`packages/auth`, `packages/db/src/schema/roles.ts`, `scripts/`, a `CW-AC-45` row, migration 1495) were present in the working tree; every result above is green with them present, and none of those files is in these commits |

**Not verified, by design or limit**

- The IDG proposal e2e test (needs a seeded IDG patient). No physical printer or PDF pagination was checked; the
  print probe is Chromium's print media emulation plus a screenshot.
- The in-memory twin of the care plan service (`routes/service.ts`, used by slice tests) does not enforce the D-1
  and D-3 rules; production uses the database service, which does.
- `compliance/controls.yaml`: `CW-AC-43` is `implemented`, its four gaps closed (R-43 to R-52). It needs your
  approval, which you gave on condition that the gaps were fixed. `CW-AC-44` (D-2, the default clinical grants) is a
  new `implemented` row that you approved. The three extra edits to `CW-AC-43` since then are their own commits and
  **you approved all three**: `1cdd3ef05` names the internal element-picker read in its title and evidence comment;
  `2a213a6a5` widens that evidence to the cases and files that prove it (R-92); and `2e28e99a4` **extends the claim
  itself**: the M8 visit-to-problem link and the M15 goal and intervention parent checks refuse a Part 2 element the
  caller is not cleared to see, and a goal authored under a Part 2 problem or refining a Part 2 goal is stored
  flagged from then on. It adds `test:m8:write:live` and `encounter-routes.test.ts` as evidence and states what is
  not covered (R-97: interventions; no backfill of earlier goals).
- **D-2 limits.** Migration 1494 inserts nothing if the runner falls back to the NOBYPASSRLS app role (no
  `DATABASE_ADMIN_URL`); that case was not run. The element-picker fix is proven on the server (live, real
  evaluator and reader); the web encounter screen was not re-driven in a browser. Roles created after the
  migration, and the signer roles of a new tenant, still need an administrator (section 6).
- **Not re-run after the per-actor commits (R-82 to R-105):** the e2e Chromium spec, the print probe and
  `check:boot:platform`; nor was any web screen driven in a browser. The aide editor change (a select, a label, a
  default) is proven by a DOM test only, the M8 link flow by service-level and route-unit tests, and the M8 proof
  drives the link service directly with the in-memory consent store, not over HTTP against the Drizzle one.
- **No CMS rule beyond 42 CFR 418.56(c)(3) was checked** (D-3, on eCFR). The clock constants stay CMS-VERIFY.
- **Review before the PR.** `/ecc:security-scan` (AgentShield: D, 56/100, no finding in a file this branch
  changes), `/ecc:react-review` (one HIGH, the Part 2 box not clearing when the IDG form reopens, fixed with a
  mutation-checked test; the LOWs are fixed except that the chart banner refetches code status on each reload of a
  discipline plan page, the existing loading pattern of the other chart tabs), `/ecc:code-review` and
  `compliance-reviewer` on the whole branch.
