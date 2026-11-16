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
   remains an aspiration for those two (decision D-1).
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
6. **Nobody can sign in a fresh tenant.** No clinical role template grants any `care_plan.*` key (D-2).
7. **The audit is static plus unit tests.** No authenticated browser journey ran (section 2).

**Recommendation:** accept the defect track as applied; decide D-1 to D-6 (section 9) before anything
relies on the signature-integrity claim; then approve or reshape the workspace redesign. Because
`care-plan-view.tsx` grew from about 3.2k to 3.8k lines during the fixes, begin WP3 with extraction.

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

`administrator` and `org_admin` receive every non-platform key (all seven `care_plan.*`); `director_of_nursing`
receives `care_plan.finalize` only. **No clinical role template** (`rn`, `rn_case_manager`, `hospice_physician`,
`nurse_practitioner`, `msw`, `chaplain`, `clinical_supervisor`, `idg_coordinator`, `lpn`) grants any
`care_plan.*` key, and the sign path requires the caller to hold the signer role key. A freshly provisioned
tenant therefore cannot author or sign a care plan (D-2).

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
| B-15 | MED | No default clinical role grants (section 6) | **Decision D-2** |
| B-16 | LOW | `initial_overdue` emitted at warning-open (T-2d); nothing at real overdue | **Deferred**: needs a catalog event or a marker column (migration) and the spec contradicts itself; no live consumer subscribes |
| B-17 | LOW | `signatureMethod` hard-coded `password_step_up` | Fixed (resolved from the step-up factor, fallback unchanged) |
| B-18 | LOW | IDG `conflict` status rolled back with the throwing transaction | Fixed (persisted; 409 after commit) |
| B-19 | LOW | DST ±1h in grace; legacy plans with NULL `next_review_due_at` never gated | Fixed in gate, cron, seam reader and dossier summary (no migration) |
| B-20 | LOW | `overdue-status` ignored `:planId`; `targetAt`/`onsetAt` accepted but dropped | Fixed |
| B-21 | LOW | Return-to-draft needs `care_plan.author`, lifecycle comment says any signer | **Decision D-10** |
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

## 9. Decisions requested

- **D-1 Signature integrity.** Enforce "no element writes while a version is `in_review`" (409, return to
  draft first), or compare a live-state hash with the snapshot at sign time, or accept the hybrid model and
  say so on the sign dialog. *Recommendation:* the 409 guard; it is small and matches D8's intent.
- **D-2 Default clinical grants.** Add `care_plan.*` to the clinical role templates (and a
  `compliance/controls.yaml` row, which needs your approval) or document manual provisioning.
- **D-3 Measurable goals.** Make `measurableOutcome` a finalize blocker? CMS-VERIFY (42 CFR 418.56(c)).
- **D-4 Permanently refused IDG decisions are terminal.** Conditions that clear by themselves (a draft plan, an
  open or in-review revision) no longer end here: they wait and apply (R-14). What remains is a decision refused
  for a permanent reason (a discharged plan, an element that is gone or resolved, an invalid payload) or one that
  waited past 14 days: it is a durable refusal row plus audit, but M14 still shows it as `emitted`. Either
  accept re-recording by hand, or publish a catalog event (for example `m7.care_plan.idg_proposal_refused`, with an
  M15 twin) so M14 can surface it, which needs a migration on `idg_decision_application_ack`, an M14 consumer and a
  coordinator-facing display. *Recommendation:* accept it for now; it is rare and already visible in M7/M15.
- **D-5 M15 IDG application timing.** Move to the M7 proposal model (apply at quorum) or ack only when signed.
- **D-6 M15 final PDF.** The system-signed discharge version emits no `m15.plan.version_signed`, so M22
  renders no final PDF. Emit it?
- **D-7 `initial_overdue` timing** (B-16): pick the spec's intent and add the catalog event/marker.
- **D-8 Redesign.** Approve, reshape or drop WP1–WP6 given section 1, item 1.
- **D-9 Workflow numbering.** Two documents are numbered 04.
- **D-10 Return-to-draft** by a sign-only signer: allow?
- **D-11 M14 contract.** Add `admissionId` to `idg.decision_recorded` and `resolutionNote` to `problem_update`.
  The same contract has no SUD flag on `problem_add`, so a Part 2 problem added through an IDG decision is stored
  as not SUD-related and is never redacted (the IDG packet cover also reads the terminal problem's text without
  the filter).
- **D-12 An IDG version whose application went `conflict` is stuck.** `returnVersionToDraft` only flips
  `in_review` applications back to `proposed`, and capture refuses any application that is not `proposed`, so
  after a baseline conflict (any edit to the plan while the `idg_review` sits open, the D-1 hybrid case) the
  version holds the plan's single open-version slot for good: new revisions return `OPEN_VERSION_EXISTS` and
  later IDG decisions wait 14 days and are then refused. It predates this work (the plan was already wedged at
  HEAD), and B-18 only made the conflict durable. Needs a rebase or an abandon path; D-1's 409 guard removes most
  of the ways in. *Recommendation:* D-1 first, then an explicit "discard IDG review" action.
- **D-13 `m15.plan.version_signed` carries Part 2 goals.** The payload embeds the full sealed snapshot, so its
  consumers (M22 PDF, M28 FHIR CarePlan, M14, M30, M33) receive `sud_related` goals. Changing it is a catalog
  change plus a consumer-side decision on who may see Part 2 text in a rendered document. Not changed here.
- **D-14 No age alert for a deferred outbox event.** The only alerts are the dead-letter hook and the pending
  depth threshold (500), so a decision waiting on a draft plan (D-2 leaves fresh tenants in that state) is silent
  for up to 14 days and then becomes an audited refusal with no alert. `compliance/controls.yaml` CW-MON-01 is
  already `gap`; extend its reason, or add a gauge for the oldest deferred row. controls.yaml needs your approval.

## 10. Verification

Run on `develop` (HEAD `5e53dc0f4` plus the uncommitted work), 2026-11-15.

| Check | Result |
|---|---|
| `bun run typecheck` (build + sharded test typecheck) | 0 errors |
| `bun run arch:fitness` | 50 of 50 gates pass |
| `bun run test` (all non-live suites), final code | 2950 files: 2413 passed, 536 skipped, 1 failed; 35721 tests passed, 1 failed. The failure is `10-hope/__tests__/hope-admission-workspace.dom.test.tsx` ("steps through the SFV reassessment one question at a time"), a module this work does not touch: a timing-sensitive DOM test that passed 3 of 3 alone. The previous full run had a different single failure, `12-dosespot/.../secret-cipher.test.ts`, whose test swaps the last two ciphertext characters for `AA` and so flakes when that swap leaves the envelope valid (likely cause, not proven). Neither is fixed here: outside Workflow 06 |
| Web care-plan and discipline-plan folders | 11 files, 151 tests, all passed (the care-plan folder alone: 139) |
| `bun run check:boot:platform` | ran on the code before the review fixes: boots with `DATABASE_PLATFORM_URL`, `/health` 200, outbox relay polling (fresh migrated DB, provisioned roles). **Not re-run on the final code**: it needs a `DATABASE_PLATFORM_URL` that was not available in the last session |
| OpenAPI, typed client, inject-coverage report | regenerated (the inject-coverage report again after the last test files were added) |
| Live suites (private `chartwarden-postgres:dev`, `max_locks_per_transaction=1024`, `valkey/valkey:8-alpine`, `chartwarden_app` NOBYPASSRLS), re-run after the review fixes | all pass: `m7-care-plan-write` 46 (incl. the lock-order and IDG-wait tests), `m15-idg-decision-apply` 15 (incl. the discharge block and the IDG wait/horizon tests through the real relay), `care-plan-conformance` 8, `m7-care-plan-read-service` 4, `gap-013-care-plan-consent-wiring` 5, `m14-s05-careplan-to-idg` 16, `gap-044-m15-crons` 6, `m15-plan-bootstrap` 7, `outbox-dispatcher` 9 (incl. the relay's own 14-day horizon). `m7-care-plan-write` is 48 and `m15-idg-decision-apply` 15 after the last review round (two-decision wait/refusal, the draft-plan wait, the M15 audit rows) |

**Not verified, by design or limit**

- **e2e.** `e2e/specs/care-plan.spec.ts` was rewritten against the real labels but is env-gated
  (`E2E_CARE_PLAN_*`) and was **not run**. No browser journey was walked.
- **Migration blocker, not part of this work.** On `develop`, migrations 1489 and 1490 reference
  `m23_mac_jurisdiction`, which no migration creates, so every from-scratch live run fails. The unmerged
  `fix/m23-mac-jurisdiction-enum` branch carries the fix. For the live and boot runs I copied that branch's two
  migration files in temporarily and restored them afterwards (`git status` shows both untouched). CI stays red
  on this until that branch merges.
- **`compliance/controls.yaml`:** one row is drafted, `CW-AC-43` (Part 2 redaction of care-plan reads, status
  `partial` with the D-11 and D-13 gaps), in its own commit; it needs your approval before any push. D-2 needs its
  own row and your decision first.
- **No CMS rule was checked.** Clock constants and the measurable-goal rule stay CMS-VERIFY (D-3, D-7).
- **Review before a PR.** Three fresh read-only reviewers (backend code, web, compliance) ran on the diff, and
  their findings are R-18 to R-24 and D-11 to D-14. **Not run:** `/ecc:security-scan` and the `compliance-pr`
  skill (the auth-and-audit path rule wants the scan first, then the compliance reviewer again after the last
  changes), because no PR was requested. Nothing is pushed.
