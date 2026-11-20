# Workflow 09 — Clinical Visits & Documentation Current-State Evidence

**Audit date:** 2026-11-17
**Branch:** `feat/visit-scheduling-workflow`
**Commit:** `adcc752b43c383bce757210678f4ed98590f944e`
**Working tree:** no tracked-file modifications at audit time (`git status --short` shows untracked entries only)
**Scope:** WP0 only: **static audit, non-live unit/DOM tests, and one private-stack runtime pass (§14)**.
No application code, schema, API, auth policy, clinical rule or signature behavior was changed. The only
files touched are e2e test code (§14.6).
**Parent plan:** [`ChartWarden_Workflow_09_Clinical_Visits_Documentation.md`](../ChartWarden_Workflow_09_Clinical_Visits_Documentation.md)
**Prior evidence reused (not re-derived):** [`04-visit-encounter-current-state-audit.md`](../04-visit-encounter-current-state-audit.md)
(audited `bb71a8baf`, 2026-11-14). Every claim below that cites "04 §N" was **not** re-verified here.

> **Refreshed 2026-11-20 at `e7588e836`: read §15 first.** §1-§14 were measured at `adcc752b4`; the gate register is now 13
> checks, `check` is no longer carried in the 422 `details`, step-up at sign is a 403, and the record screen has a verified
> patient-identity defect. §15 also records which work packages are approved.

## 1. Decision summary

1. **Workflow 09 largely overlaps a slice that already shipped.** Workflow 04 was approved on 2026-11-14 as a
   presentation-focused slice, and four commits after that audit landed it in part (§3). The composer now has the
   patient banner, a route blocker and a `beforeunload` guard, and in-flight/interrupted-write handling. WP1–WP3 of
   Workflow 09 must be re-scoped against what is already on this branch, not against the 2026-11 zip baseline.
2. **The server contracts the plan says to preserve are intact and tested.** The encounter state machine, the
   12-check gate register, step-up, late-entry, cosign routing and signed-record rules match the plan's description.
3. **One real safety gap remains (attestation provenance, §5).** The sign body must contain `attestationConfirmed:
   true` and the web client gates that on a ticked checkbox, but the server discards the value, never records it,
   and the gate's check 9 is still registered as *deferred*. The register text is also stale (§5). This needs a
   **separate, explicitly approved** fix; it is not part of any UX work package.
4. **Three gate checks are not enforced and must never render as green:** check 4 `required_hope_items`, check 7
   `layer2_decisions`, check 9 `attestation_confirmed` (§4).
5. **AI/Layer 2 is off platform-wide.** The UI must not advertise enhancement (§6).
6. **Offline documentation is not a supported behavior** (04 §9, re-confirmed by grep in §3). Keep it out of scope.
7. **Runtime pass done (§14).** The committed journey spec failed against the current scheduling UI; after a
   local repair the RN journey (schedule → start → compose → finalize → sign → visit Completed) passes. The
   layout clipping 04 reported is **not reproduced** at 375/768/1440. A serious composer contrast violation
   and a WF08 wizard defect (the review step skipped) were found and then **fixed and re-verified (§14.7)**.
   A second wizard issue, a placeholder signer in the sign ceremony, and a stale visit page remain open.

## 2. What this WP0 did and did not do

| Plan WP0 item | Status |
|---|---|
| Git/branch/SHA, scripts, conventions | Done |
| Entry-point and navigation map | **Reused from 04 §3**; composer/record return links re-checked only for blocker/banner (§3) |
| Screen → API → domain matrix, full request/response schemas | **Partial** — sign body and gate shape read; full route contract table not rebuilt (04 §5 is the current inventory) |
| Visit vs encounter state tables | Encounter graph read (`lifecycle/encounter.ts:51-61`); visit machine reused from 04 §4.1 |
| Template inventory by discipline | Done (§7) |
| Gate evidence matrix with file:line | Done (§4) |
| Signature / step-up / cosign / late-entry / EVV-at-sign | Done from source (§8); not exercised live |
| Hands-on fictional-patient walkthroughs | **Partial (§14.2)**: one RN, telephonic routine-visit path via Playwright. LPN/aide cosign, correction/addendum, canceled/rescheduled visit, interrupted edit **not run** |
| Desktop/tablet/mobile screenshots, axe, a11y observations | **Done for 7 screens × 3 widths (§14.4)**; keyboard-only and screen-reader walkthroughs **not run** |
| Existing tests: inventory and results | Non-live unit/DOM **run and passed** (§9); `encounters.spec.ts` **run on a private stack, failed as committed, passes after repair** (§14.2); live-DB suites, `bun run typecheck`, `arch:fitness` **not run** |
| Privacy review (storage, logs, notifications, exports) | **Partial** — browser-storage grep only (§3) |
| Scope matrix | Done (§10) |

Items marked *not run* are blockers for claiming any UX before/after, not for deciding scope.

## 3. Delta from the Workflow 04 audit and the 09 plan's anchors

Commits touching the encounter module since `bb71a8baf`: `43132a4e9` refine authoring, `396dcad90` refine
completion, `abdcf710e` protect writes in flight, `5e53dc0f4` reconcile interrupted clinical writes,
`e42ca62b2`/`4d0925732`/`a4b590818` care-plan read seam and Part 2 checks (backend, not UX).

| Plan §1 anchor | Plan said | Now | Note |
|---|---|---|---|
| `encounter-compose.tsx` | ~1,468 lines | 1,688 lines | Rewritten in `43132a4e9` (+855/−462) |
| `encounter-read.tsx` | ~3,505 lines | 3,521 lines | Signing ceremonies still live here |
| `patient-encounters.tsx` | ~830 | 830 | Unchanged |
| `my-drafts.tsx` | ~439 | 439 | Unchanged |

Re-checked on this branch (grep, not run):

- Composer renders `PatientBanner` (`encounter-compose.tsx:420,426`), registers `useBlocker` (`:225`) and a
  `beforeunload` handler (`:230-231`). This closes 04 §13 item 2 (banner) and part of item 3 (dirty protection).
- No `localStorage`, `sessionStorage` or `indexedDB` in the composer or record screens. PHI is not persisted in the
  browser by these screens.
- `navigate(-1)` no longer appears in either screen (04 §3.1 flagged it in the composer).

Runtime status of the 04 §13 items (§14): responsive layout at 375/768 px is **not reproduced** as broken;
the composer contrast violation persisted at first and was then fixed (§14.7); the Playwright journey **failed as committed** (stale against the
WF08 wizard) and passes after a local repair. Deterministic M17→M8 return context is not re-verified.

## 4. Compliance-gate evidence matrix

Source: `apps/backend/src/modules/08-encounters/gate/checks.ts:47-159` (register) and `gate/gate.ts:103-167`
(evaluation). The gate runs as a **preview at finalize** and is **enforced at sign**
(`lifecycle/encounter.ts:94-139`); it is wired in the in-memory service (`routes/service.ts:1020,1029,1038`) and the
Drizzle service (`encounters-route-service-db.ts:603,612`). `encounter-compliance-gate.test.ts` passed (§9).

| # | Check | State | Evidence | UI may show |
|---|---|---|---|---|
| 1 | `required_sections` | **Evaluated** | `gate.ts:107-127` | Pass/fail with `field` = section id |
| 2 | `required_vitals` | **Evaluated** | `gate.ts:130-139`; roster derived from the template (`requirements.ts` `requiredVitalsFor`); `clinicallyNotIndicated` escape | Pass/fail per vital |
| 3 | `required_scales` | **Evaluated** | `gate.ts:143-151`; only `recert_visit` requires scales (PPS, ESAS-r) | Pass/fail per scale |
| 4 | `required_hope_items` | **Deferred** | `checks.ts:68-77`: no encounter→HOPE-timepoint mapping | *Not evaluated* — never "passed" |
| 5 | `late_entry_ceiling` | Elsewhere | `checks.ts:78-86`; `encounters-route-service-db.ts:1986-1999` (`resolveLateEntry`, `requireOverride: true`) | Tier + required override from server |
| 6 | `care_plan_review` | **Evaluated** | `gate.ts:154-164`; `null` care plan is not a failure | Pass/fail; link to `/patients/:id/care-plan` (04 §7) |
| 7 | `layer2_decisions` | **Deferred (vacuous)** | `checks.ts:92-101`; Layer 2 unbuilt | *Not applicable* |
| 8 | `step_up_fresh` | Elsewhere | `encounter.ts:107` (`STEP_UP_AUTH_REQUIRED`), checked **before** the gate verdict | Re-auth prompt, not a checklist row |
| 9 | `attestation_confirmed` | **Deferred** | `checks.ts:111-121`; see §5 | *Not evaluated by the gate* |
| 10 | `eligible_cosigner` | Elsewhere | `encounter.ts:118-123` (`NO_ELIGIBLE_COSIGNER`) | Shown at sign for LPN/CHHA |
| 11 | `f2f_attested` | Elsewhere | `encounter.ts:109-115` (`F2F_DUAL_WRITE_REQUIRED`) | Shown at sign for F2F |
| 12 | `vocab_version_pin` | Elsewhere | DB CHECK + `checkVocabVersion` (`routes/service.ts:1298`) | 409 `VOCAB_VERSION_MISMATCH` copy |

Count: 4 evaluated, 5 enforced elsewhere in the same transition, 3 deferred. The gate returns remediation
`{ check, code, field?, message }` (`gate.ts:81-88`) carried in the standard error envelope `details`
(`gate.ts:202-215`), which is the only authoritative source a blocker panel may render.

**UI rule that follows:** a "ready to sign" state may be derived only from a server preview that passed. Checks 4,
7 and 9 are never evaluated, so the panel must say so rather than imply they passed.

## 5. Attestation provenance — verified gap (separate approval required)

What exists today:

- `SignEncounterSchema` requires `attestationConfirmed: Type.Literal(true)` plus optional `lateEntryReason`
  (`routes/encounters-typebox.ts:205-209`). A missing or `false` value is rejected at the boundary.
- The web client sends `attestationConfirmed: true` for primary sign and cosign-sign
  (`encounter-read.tsx:613-617`). The shared `CeremonyModal` computes `commitReady` from a checkbox when `legalText`
  is set (`packages/ui/src/web/system/guardrail.tsx:476,482-483,518-532`), so in the UI the clinician must tick the
  statement before committing.
- The sign handler reads **only** `body.lateEntryReason` and passes `{ at, lateEntryReason }` to `service.sign`
  (`encounters-routes.ts:636-640`). The cosign and addendum-sign handlers call `parse(SignEncounterSchema, …)` and
  discard the result (`:734`, `:900`).
- The persisted record is `encounter_signature.attestation_text`, which is a server constant
  (`PRIMARY_ATTESTATION_TEXT` etc., `encounters-route-service-db.ts:192-202`; written at `:2056,2117,2362,2591`).

What that means:

- **Enforcement is client-asserted.** Any authenticated, step-up-fresh caller can post the literal `true`; the server
  cannot distinguish a ticked box from a script. Nothing records that an acknowledgment was presented or given.
- **`checks.ts:111-121` is stale.** It says the sign body needs an attestation-acknowledged input "distinct from the
  text the server stamps"; that input now exists. What remains missing is *recording or evaluating* it. The register
  and `gate.test.ts` pin this as *deferred*, so changing it is a deliberate edit.
- This is a clinical-record integrity and CoP 418.104(c)-adjacent control. **No UX work package may change it.**

Proposal (needs explicit approval, own PR, own tests, own `compliance/controls.yaml` row): record the acknowledgment
and the presented text version on the signature row, bind it to the server-stamped text, and move check 9 from
*deferred* to *enforced*. A migration is likely; classify it `-- compat: expand`.

## 6. AI / Layer 2 status

Layer 2 is off: `DEFAULT_HEARTHNOTE_FLAGS.layer2` is false platform-wide and the tenant facts are bound fail-closed
(`layer2.ts:39-50`). Route 12 answers `enhanced: false` only (`layer2.ts:52-60`). `hearthnote_llm_modification` is not
written by anything (`checks.ts:96-100`). The UI may offer **no** summarization, enhancement or AI-edit affordance.
Test T34 reduces to "the manual path is the only path".

## 7. Template and discipline inventory

Source: `packages/types/src/encounter.ts:150-170` (legal pairs) and `packages/hearthnote/src/templates/registry.ts:90-160`
(sections). A pair outside this table is rejected by the server service guard, with a DB CHECK beneath it.

| Encounter type | Legal disciplines | Extra required sections |
|---|---|---|
| routine_visit | rn, lpn | — |
| admission_visit | rn | med_reconciliation, advance_directive, caregiver_overview, baseline_symptoms |
| recert_visit | rn | pps, esas, prognosis, recert_summary (+ scales PPS, ESAS-r) |
| face_to_face | md, np | med_reconciliation, prognosis, f2f_attestation |
| telephonic | rn, lpn, msw, chaplain, md, np | — (vitals section stripped) |
| lpn_visit | lpn | — |
| chha_visit | chha | — |
| msw_assessment / msw_followup | msw | family_dynamics (assessment only) |
| chaplain_assessment / chaplain_visit | chaplain | — |
| volunteer_visit | volunteer | — |
| bereavement_contact | msw, chaplain, volunteer | — |
| idg_followup | rn, lpn, msw, chaplain, md, np | idg_followup |
| pt_visit / ot_visit / slp_visit | pt / ot / slp | — |

Base sections by discipline: rn/lpn/md/np = chief_concern, vitals_review, assessment, symptom_management,
interventions, plan; chha = chief_concern, adl, plan; msw = chief_concern, psychosocial, interventions, plan;
chaplain = chief_concern, spiritual, plan; pt/ot/slp = chief_concern, assessment, interventions, plan;
volunteer = chief_concern, plan.

Facts the UI must honor:

- **Required vitals** are the six-item roster (BP, HR, RR, T, SpO2, pain) only where the resolved template carries a
  required `vitals_review` section: rn/lpn/md/np, except telephonic. CHHA, MSW, chaplain, volunteer and therapy visits
  require **no vitals**. `bp` needs both systolic and diastolic.
- **Required scales** exist only for `recert_visit`. Every other type is a deliberate empty list.
- **The plan's discipline list is incomplete:** the registry also covers **np, pt, ot and slp**.
- **Cosign is required only for lpn and chha** (`lifecycle/validation.ts:43`), not for therapists.
- Volunteer encounters also need an active volunteer assignment (`validation.ts`, deny-stub in Phase 1; not verified
  end to end here).

## 8. Signing, cosign, late entry, EVV at sign (from source)

- **Encounter graph:** `draft → finalized → signed`, or `draft → finalized → cosign_pending → cosigned`; `void` only
  from draft and admin-only with a ≥ 40-char reason (`encounter.ts:51-61,148-166`). Addenda are a separate machine
  (`lifecycle/addendum.ts`). No `in_progress`/`completed` encounter status exists; do not add one.
- **Sign preconditions, in order:** fresh step-up → gate → F2F dual-write → eligible cosigner for LPN/CHHA
  (`encounter.ts:105-123`). Author-only (`encounters-route-service-db.ts:1971-1974`).
- **Late entry:** tier is recomputed at sign; the reason must be on the row and a significant/administrative tier must
  already carry its recorded override (`encounters-route-service-db.ts:1983-1999`). Reason minimum 40 characters
  (`validation.ts:24-26`). Overrides are separate permissioned, step-up-gated routes (04 §5).
- **EVV at sign:** a stored state wins; otherwise a complete M18 bracket persists as `evv_present`, anything else is
  `evv_missing_documented`; clinician-entered times never override EVV (`evv-at-sign.ts:1-40`). The UI shows EVV times
  read-only.
- **Cosign timing, eligibility and SLA:** 04 §4.2 (12/24/48 h). Not re-read.

## 9. Tests: what ran and what did not

Command (non-live; no database; no browser):

```
bunx vitest run apps/backend/__tests__/encounter-compliance-gate.test.ts \
  apps/backend/__tests__/encounter-lifecycle.test.ts apps/backend/__tests__/encounter-cosignature.test.ts \
  apps/backend/__tests__/encounter-late-entry.test.ts apps/backend/__tests__/encounter-routes.test.ts \
  apps/web/src/modules/08-encounters packages/hearthnote
```

Result: **14 test files passed, 238 tests passed, 0 failed, 0 skipped**, 2.81 s.
Playwright (`encounters.spec.ts`, plus a measurement probe) **was run later on a private stack: see §14**.
Not run: all `*.live.test.ts` suites (they need the private `chartwarden-postgres:dev` container with the
app role, which §14 did not use), `bun run typecheck` (only `tsc -p e2e/tsconfig.json`, 0 errors),
`bun run arch:fitness`, `check:boot:platform`.
Inventory only (not run): `encounter-workflow-acceptance`, `encounter-drizzle-store`, `encounter-outbox`,
`encounter-vocab-pin`, `encounter-seam`, `encounter-store-ops`, `encounter-eraser`, `m8-encounters-write.live`,
`m8-encounters-read-service.live`, `m8-encounter-addenda-read.live`, `m16-encounter-signed.live`, `m19-encounter-signed-consumer`.

The 36 plan scenarios (T01–T36) are **requirements, not coverage claims**. Mapping them to tests is the first task
after approval; 04 §11 is the starting point.

## 10. Scope matrix

| Decision | Items |
|---|---|
| **Reuse** | Encounter lifecycle, gate register and remediation envelope, HearthNote templates and `resolveTemplate`, `If-Match` versioning, step-up/ABAC/RLS, cosign queue, addendum panel, `PatientBanner`, `CeremonyModal`, M17→M8 seed consumer, `evv-at-sign` |
| **Consolidate** (frontend only) | Document / Review / Complete navigation over the existing composer and record; one shared patient/visit header; deterministic return context from My Visits, Visit Detail and Patient Chart |
| **Modify** (frontend only) | Split `encounter-compose.tsx` (1,688) and `encounter-read.tsx` (3,521) into focused components; blocker panel with *evaluated / enforced elsewhere / not evaluated* states; responsive layout needs no rework per §14.4 (composer contrast D4 already fixed, §14.7) |
| **Modify — backend, separate approval** | Attestation provenance and check 9 (§5); stale `checks.ts` text |
| **Defer** | Offline authoring, Layer 2/AI, HOPE-timepoint mapping (check 4), mobile/Capacitor capture, new statuses, EVV/scheduling/billing state-machine changes |

## 11. Risk register

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| R1 | Attestation is client-asserted and unrecorded (§5) | High | Separate approved fix before any "attested" wording in the UI |
| R2 | Blocker panel shows green while checks 4, 7, 9 are unevaluated | High | Three-state rendering driven by the register; never derive "ready" client-side |
| R3 | Re-doing work Workflow 04 already shipped | Medium | Re-baseline WP1–WP3 against §3 before estimating |
| R4 | Splitting 3,521- and 1,688-line components regresses signing or addenda | Medium | Characterization DOM tests first; one component extracted per PR |
| R5 | Responsive layout and contrast: 04 §10's clipping is not reproduced (§14.4); the composer contrast violation (D4) was fixed (§14.7). Keyboard-only and screen-reader passes not run | Low | Run the keyboard/screen-reader pass in PR5 |
| R6 | Plan lists 7 disciplines; registry has 11 | Low | Drive the UI from `resolveTemplate`, never a hardcoded list |
| R7 | Visit marked complete read as note signed | Medium | Keep visit and encounter status separate (04 §2) |

## 12. Proposed PR breakdown (re-scoped)

| PR | Scope | Gate |
|---|---|---|
| PR0 | This audit plus the decisions below | **Stop for approval** |
| PR-A | Attestation provenance and check 9 (backend, own migration if approved) | Sign-route tests, live RLS/append-only, `controls.yaml` row |
| PR1 | Review/Complete blocker panel on existing data (three-state, links to remedies) | DOM tests for T07, T10, T13, T33; `bun run typecheck` |
| PR2 | Workspace shell (Document/Review/Complete, shared header, return context) | Route parity, deep links T01–T02, T36 |
| PR3 | Component extraction from compose/read with characterization tests | No behavior change; DOM + `arch:fitness` |
| PR4 | Visit/EVV/care-plan read-only context and cancel/reschedule messaging | Cross-module contract tests, one joined Playwright journey |
| PR5 | Responsive, a11y, rollout, cleanup | axe, 375/768/1440, request inventory |

Batch pushes: CI minutes are metered. Nothing here has been pushed.

## 13. Unresolved questions for approval

1. **Approve PR-A** (attestation provenance) as separate backend work, or defer and ship the UX with check 9 shown as
   *not evaluated*?
2. **Re-baseline:** accept that Workflow 04's shipped slice is the new starting point and trim 09's WP1–WP2 to the gaps
   in §3, or keep 09 as written?
3. ~~Runtime evidence~~ **Done (§14).** Remaining unrun: keyboard-only and screen-reader passes, LPN/aide cosign,
   addendum, canceled/rescheduled-visit journeys, and anything needing the NOBYPASSRLS app role.
4. Are PT/OT/SLP and NP in scope for the redesign's role-specific content?
5. Is a feature flag available for staged rollout? Not verified.

## 14. Runtime pass on a private stack (2026-11-17)

**Authorized scope:** one Playwright journey plus axe at three widths, before PR2.

### 14.1 Stack and its limits

Private containers: production's Postgres image (`chartwarden-postgres:dev`, `max_locks_per_transaction=4096`),
Valkey 8, RustFS 1.0.4 on ports 56830/56831/59090; backend on :3998, Vite **dev** server on :5998. Env values
are the throwaway test constants committed in `ci.yml`'s `e2e` job. `db:migrate` reported "0 already applied,
766 pending" (so it hit the private DB, not a dev one), and `lsof` showed the backend connected only to the
private ports. Torn down afterwards by recorded pid; `CREDENTIALS.local.md` was backed up before the seed and
restored (hash verified); ports 3000/5173 were not listening before or after.

Limits that bound every claim below: the DB role is the `postgres` superuser, as in CI's e2e job, so **RLS and
ABAC are not proven by this pass**; a Vite dev server, not a production build; one RN account; one patient
(Whitfield); default page states plus the sign dialog only.

**Seed:** `db:seed:all` exited 1 at `db:seed:scenario-clinical` (M10 HOPE draft "not sign-ready": required
Sections A–Z missing for RFA 01_admission). The steps after it (`orders-idg` … `messaging-flags`) did not run;
the encounter, assessment and care-plan parts of that step did (one finalized and one draft encounter). Not a
Workflow 09 matter and not investigated; whether it reproduces on a dev database or in CI is unknown. The
private backend log also shows unrelated outbox dead-letters (`m2.session.created`: `M35_PSEUDONYM_KEY_KEK`
unset in this env; `m6.admission.activated` for a seeded deceased patient).

### 14.2 Journey (`e2e/specs/encounters.spec.ts`)

- **As committed it fails at step 1** (admin creating the visit): the spec was last edited 2026-11-14 and
  drives a single-form dialog; the guided 4-step wizard landed 2026-11-17 (`0342bcf46`).
- **After a local repair it passes (2/2, journey 8.1 s):** admin schedules → RN starts and checks in
  (self-attestation + passkey step-up; no EVV bracket) → M8 seeds the draft → compose all required sections and
  vitals → finalize → sign (attestation checkbox) → visit shows **Completed** → the "Signed" link returns to the
  same encounter.
- **Handoff timing:** `signed_at` 03:04:52.534 → outbox event dispatched in 0.6 s on attempt 1 → M17 receipt
  03:04:53.134. At least seven consumers (m14, m17, m18, m19, m22, m24, m36) recorded receipts for that event.
  The spec's single-load "Completed" assertion raced this by ~0.4 s (the visit page fetched at 03:04:52.77 and
  never re-fetched), so the repair polls with a reload.
- **Scenarios with runtime evidence:** T01 (entry from My Visits), T04, T10, T14 (RN, telephonic routine visit),
  T32 (downstream receipts), T36 in part. **Not covered:** T05–T09, T11–T13, T15–T29, T31, T33–T35; the journey
  used the EVV-absent self-attestation path, so T24/T25 are not evidenced.

### 14.3 New findings

| # | Finding | Evidence | Owner / scope |
|---|---|---|---|
| D1 | **"Continue to review" creates the visit; the review step is skipped.** | A run against a booked clinician made two `POST /api/v1/visits` calls (409, 409) about 5 s apart, the first at the Continue click before any "Create Visit" click; a clean run created the visit from that click. Source: the footer renders `{step < 4 ? <Button onClick={advance}> : <Button type="submit">}` (`scheduling-workflow.tsx:560-616`), one reconciled DOM node whose `type` flips to submit during the click (`Button` defaults to `type="button"`, `packages/ui/src/web/components/button.tsx:45`); `submit()`'s `step !== 4` guard passes because `setStep(4)` has flushed (`:370-410`). The inference from source is not isolated in a unit test. | WF08. **Fixed (§14.7)** with distinct `key`s. |
| D2 | "Who is available" lists a clinician who already has a visit in that window; the conflict appears only on submit (409 copy is clear). May be by design (the dialog says final checks happen on schedule). | Rita offered at 07:00 with a booked visit. | WF08 UX decision. |
| D3 | **The sign ceremony never names the signer**: it shows the literal "Signing clinician · This session", and the discipline as "Rn". | Screenshot `record-finalized-sign-dialog-375.png`; `encounter-read.tsx:2051-2054`. | WF09 (sign/Complete step, with the §5 attestation work). |
| D4 | The composer's step-button "Required" caption fails WCAG 2A/AA contrast (serious), at all three widths (04 saw it at 768/1440). | axe: `color-contrast` on `button[aria-current="step"] > span:nth-child(2) > span:nth-child(2)`, 1 node. | WF09. **Fixed (§14.7).** |
| D5 | The visit page fetches once and has no refresh once an encounter exists, so after signing it can show "In Visit" until reload. | §14.2 timing. | WF09/WP5, minor. |

### 14.4 Layout, axe and network (7 screens × 3 widths = 21 loads)

Screens: My Visits, My Drafts, draft composer, draft record, finalized record, finalized record with the sign
dialog open, signed record. Widths 375×812, 768×1024, 1440×1000.

| Measure | Result |
|---|---|
| axe WCAG 2A/AA | 20 of 21 loads clean; the draft composer has 1 serious violation at each width (D4) |
| Document horizontal overflow | 0 px on every load |
| Elements past the viewport outside a scroll container | 0 |
| Content clipped by an `overflow:hidden` container | 0 (04 §10's 375/768 clipping is **not reproduced**) |
| Console errors / page errors / HTTP ≥ 400 | 0 / 0 / 0 |
| Requests per load | 348–368 total (dominated by Vite dev module fetches); `/api/` calls 16–29 |

Caveats: layout is measured geometrically, so an overlap that causes no overflow would not be caught; only the
composer and the sign dialog at 375 were also checked by eye. axe ran WCAG 2.0/2.1 A/AA tags only (not 2.2 AA
or best-practice rules), and only on default states, so the composer's section tabs and vitals panel were not
scanned open.

### 14.5 What this changes in the plan

- Drop layout and clipping rework from PR1/PR2 unless a later pass reproduces it. D4 is already fixed.
- Put D3 (signer identity, discipline label) with PR-A / the Complete step.
- D1 is fixed; D2 stays a WF08 UX decision.
- The journey repair, which now also guards D1, belongs in PR2's gate, since the spec is the only joined
  end-to-end check.

### 14.6 Working-tree changes (now committed, see §14.8)

- `e2e/specs/encounters.spec.ts` (modified): follows the 4-step wizard, asserts that reaching the review step
  creates nothing (it fails without the D1 fix), and polls the visit page for completion.
- `e2e/specs/wf09-runtime-probe.spec.ts` (one-off, **not committed**): the measurement probe. It recorded
  and asserted nothing about findings, and wrote to `/tmp`; it stays out of the repo because it is not a
  regression gate. Its results are in §14.3 and §14.4. Re-create it if PR5 needs the measurements again.
- Both pass Biome; `tsc -p e2e/tsconfig.json --noEmit` reports 0 errors.
- Raw artifacts (not in the repo): `/tmp/cw-wf09/evidence/` (`probe-results.json`, `shots/`, Playwright
  traces for each journey attempt, including the failure as committed), and logs in `/tmp/cw-wf09/logs/`.

### 14.7 Fixes for D1 and D4, and their verification

**Changes (committed in `61d5821fa`):**

- `scheduling-workflow.tsx` (D1): the footer's Continue and Create buttons now carry distinct `key`s
  (`advance`, `create`), so React mounts a new element for the review step instead of mutating the Continue
  button's `type` to `submit` mid-click. No prop, export or behavior change otherwise.
- `encounter-compose.tsx` (D4): the "Required" caption on a step button uses `--color-error-pill-fg` (an existing
  token) instead of `--color-error`. Computed contrast, light theme: active step 4.12:1 → 5.52:1 (needs 4.5);
  inactive step 4.54:1 → 6.09:1. Dark theme is unchanged (6.19:1 / 6.81:1; the two tokens are identical there).
- `scheduling-writes.dom.test.tsx`: a new test, and `fillValidVisit` takes an optional `advanceToReview`
  (default true, so its four existing callers are unchanged).
- `encounters.spec.ts`: the D1 tolerance is replaced by a strict check that reaching the review step sends no
  `POST /api/v1/visits`.

**Evidence:**

| Check | Result |
|---|---|
| New DOM test before the fix | **Failed** as intended: the "Create Visit" button was the same DOM node as "Continue to review", now `type="submit"`. jsdom cannot replay the browser's microtask-before-activation ordering, so the test asserts this cause, not the full behavior |
| Scheduling + encounters DOM suites after the fix | 12 files, 118 tests, all pass |
| Journey and probe on a rebuilt private stack, fixed code | 3 of 3 pass; the strict "no create on Continue" assertion holds |
| Probe, 21 loads | axe **0 violations** (was 1: composer, ×3 widths); document overflow, off-screen elements and clipped containers 0; console errors, page errors and HTTP ≥ 400 all 0; `/api/` calls 16–29 per load |
| Journey with only the D1 fix stashed | **Failed** at "Continue to review must not create the visit" after 2.5 s, then passed again with the fix restored, so the browser check does catch the regression |
| Biome on the 5 changed files | Clean |
| `tsc -p e2e/tsconfig.json` | 0 errors |
| DOM test program (the two DOM test files and their transitive imports, via the shard mechanism of `typecheck:tests`) | Exit 0, 0 errors |

**Not clean, and not caused by this change:**

- `bun run build` (so `bun run typecheck`) fails with 18 errors in three M23 billing files
  (`claimmd-synthetic-rehearsal.test.ts`, `m23-jobs.ts`, `claim-submission-binding.test.ts`), from commit
  `546d6b1f0` (2026-11-17), which is already at HEAD. None are in web, e2e or the files changed here.
- `bun run typecheck:tests` stops at its first failing shard (4 errors in `billing-medicare-inject.test.ts` and
  `m23-jobs.ts`) and never reaches the DOM program, which is why the DOM files were checked separately above.
- The private-stack seed (`db:seed:all`) failed again at the same HOPE step, so that failure is deterministic.

### 14.8 Follow-up round (pre-PR review, then a second review of the fix additions)

Commits, local and not pushed: `61d5821fa` (D1 keys, D4 contrast, journey), `dfc3cb2ad` (the same keys bug in the
M20 incident wizard), `bd1518e51` and `410ca3734` (focus handling and test/e2e hardening below).

**First review (react + code reviewers, no CRITICAL).** Fixed: the new keys unmount the focused "Continue to
review" button, so focus fell to `<body>` where the modal's Escape/Tab handling never sees it (HIGH/MEDIUM);
`incident-new.tsx` had the same reused-button bug (MEDIUM); the composer's "!" mark was ~3.7:1 (LOW); one
decorative assertion removed.

**Second review of the fix additions (react reviewer).** One HIGH, which I had introduced: `STEP_HEADING_IDS[step]`
fails `tsc` under `noUncheckedIndexedAccess` (vitest and Biome do not typecheck; I had run `tsc` before adding the
effect). Fixed with a guard. Also fixed: first-mount guard and two heading ids untested (a mutation that removed
the guard survived; now killed), a scheduling first-mount guard and comment, `memberIdByName` (`ok` checks, active
member, nullable `displayName`), the weak `:focus` count (now `li[aria-current="step"]` `toBeFocused`), the incident
spec writing a real draft if the bug regressed (the create POST is now aborted as well as recorded), and substring
locators (`exact: true`). That last fix delta was verified by `tsc`, tests, mutation and the browser, not by a third
review agent.

**Real-browser results (Chromium, rebuilt private stack, passwords from the seed).**

| Check | Result |
|---|---|
| Journey (admin schedules → RN visits → compose → finalize → sign → Completed) | pass, fresh stack, 8.1 s |
| Focus effect disabled (visit wizard) | **fails** at the focus assertion: 0 focused elements in the dialog after a real click |
| Keys removed (visit wizard), 750 ms wait removed | **fails** at "Create Visit" never appearing: the premature create closes the dialog. The fixed wait is gone; the assertions retry |
| New incident spec, final code | pass, 1.2 s |
| Keys removed (incident wizard) | **fails** both before and after the spec learned to abort the POST: "Continue" submits the form, so the review step's "Create draft" button never settles (in the first run the draft was created and the page navigated away). The bug is reproduced, not inferred |
| Focus effect disabled (incident wizard) | **fails** (`toBeFocused`) |

The journey no longer depends on D2: it takes the RN's id and first free hour from the API and picks the clinician
by id, so the Back-and-refill branch is gone. Whether "Who is available" should exclude a clinician who already has
a visit then (D2) is still undecided.

**Gates on the final tree.** `tsc -p apps/web` 0 errors; `tsc -p e2e` 0; DOM-test program for the two edited
files 0; Biome clean; 178 tests pass in the scheduling, encounters and field-safety modules. `arch:fitness`: 48 of 50
pass; the 2 failures are `arch:boundaries` (three M23 billing imports from `546d6b1f0`) and `arch:audit-exceptions`
(advisory GHSA-fc5q-39xc-vjpf not in the accepted list). Full non-live suite: 38,382 passed, 16 failed in 10 files,
none touched by these commits: `m23-clearinghouse-credential` (7), `m23-clearinghouse-stedi-route`,
`claims-billing-route-classes`, `billing-medicare-inject`, `idempotency-guard`, `stedi-conformance`,
`alert-code-seed-coverage` and `alert-rules-seed` (M23's new `m23.notice.operational_issue.warning` alert code),
`no-uppercase-labels` (`list-chrome.css`, last changed by the M23 readiness commit) and `fitness-gates` (the same
`boundaries` result). These were not re-run on a clean HEAD, so "pre-existing" rests on file ownership, not on a
before/after run. The seed failed at the same HOPE step again.

**Still open:** D2, D3, D5; the PR-A attestation provenance work; the HOPE seed failure; the red M23 build and its
test/gate failures. Teardown: both pids and the three containers removed, `CREDENTIALS.local.md` restored with its
hash verified, ports 3000/5173 never in use. Safari, Firefox and a screen reader were not tried.


## 15. Refresh at HEAD (2026-11-20) and approval record

**Branch:** `feat/wf09-wp1-wp3-visit-workspace`, stacked on `fix/wf09-note-slot-validation` (PR #1081). **Commit:** `e7588e836`.
**Why:** §1-§14 were measured at `adcc752b4` (2026-11-17). 92 commits touched the encounter backend since (drafting, note
closure, amendments, recorded findings, delivery at sign), and the composer and record screens changed shape.
**Method:** source read at HEAD for both halves; the backend half also ran 16 non-live test files (459 tests, 0 failed,
0 skipped; no live suite, no `typecheck`, no `arch:fitness`). The frontend half is **static only**: no browser, no stack,
no test was run for it. §14's runtime evidence is **not** re-measured here. A private stack was restored afterwards for
WP1 and WP3 verification; results go to those packages, not to this section.

### 15.1 What changed, and what the earlier sections now get wrong

| Earlier claim | At HEAD |
|---|---|
| §4: 12 checks, 4 evaluated, 5 elsewhere, 3 deferred | **13 checks: 5 evaluated, 6 elsewhere, 2 deferred.** Check 13 `draft_sections_resolved` is new; check 1 also counts saved ADL/nutrition records and confirmed drafted sections; check 9 moved from *deferred* to *elsewhere* (`f44b75867`, 2026-11-18) |
| §4: remediation `{check, code, field?, message}` is carried in `details` | **`check` is stripped** (`gate/gate.ts:283-288`). A panel must map by `code` and `field`; the generated client types `details` as `Record<string, never>[]` |
| §5: check 9's register text is stale | Rewritten, but **the substance is unchanged**: `attestationConfirmed: true` is a client-sent literal that no service reads and no table records. The register now says *elsewhere*, which reads as "enforced" when it is not |
| §8: step-up at sign is 412 `STEP_UP_AUTH_REQUIRED` | The route preHandler answers **403 `STEP_UP_REQUIRED`**; the 412 is a service backstop |
| §7: base sections for rn/lpn/md/np, pt/ot | Three optional free-text sections added: `functional_status`, `nutrition`, `skin_wounds`; `vitals_review` and `plan` are prose-only |
| §3: `encounter-compose.tsx` 1,688 lines, `encounter-read.tsx` 3,521 | 1,574 and 3,143 |

### 15.2 New findings at HEAD (separate from UX preferences)

| # | Finding | Owner |
|---|---|---|
| N1 | **No read-only gate preview exists.** `POST /encounters/:id/finalize` is the only server check and it mutates on pass (status, pinned narrative, vocab pin, event). A UI can only show what the last response said | WP3 designs around it |
| N2 | **Record screen identity (verified in source, not run):** the banner patient is fetched with the URL `:patientId`, not the encounter's patient, with no equality check; and the previous patient stays in state while the next loads | WP1 |
| N3 | A draft opens on two different screens depending on the entry point (record vs composer); no return context exists anywhere (no router state, no `from`); My Visits filters reset on return | WP1 |
| N4 | Visit lookup lists the newest 50 encounters of the admission and matches `visitId` in the browser; an older visit is reported "still being created" | WP1 (frontend part) / backend proposal |
| N5 | Late-entry/administrative override has no author-is-not-overrider guard (`service-db.ts:2926-2931`); whether an author can hold the key depends on role grants (not checked) | **Needs a separate approved backend proposal** |
| N6 | `COMPLIANCE_GATE_UNAVAILABLE` messages for care-plan, scales and cosigner embed upstream error text (`service-db.ts:765-770,794-799,886-891`); whether that can carry PHI is unverified | Backend proposal; WP3 never renders the raw 503 message |
| N7 | Cosign queue is tenant-wide (no caseload narrowing) and no response names the routed RN | WP4 |
| N8 | Duplicate-`visitId` `POST /encounters` would be a 500, not a 409 (`encounter_org_visit_unique` is not registered with `businessRule()`); unreachable from the UI today | Backend proposal |
| N9 | Check 1 does not count recorded vitals toward the prose-only required `vitals_review`: an RN routine visit needs typed text there even with all six vitals recorded | Observation; WP3 shows the real blocker |

### 15.3 Decisions applied in this pass (answers to §13)

The user's instruction of 2026-11-20, "correct the doc that still reads "PROPOSED". fix WP0 and lets work on WP1 and WP3
using subagents", is the approval for WP1 and WP3 and for nothing else.

1. **PR-A (attestation provenance): not approved here.** It stays open and needs the user's decision. WP3 ships with check 9
   shown as "the server does not record this acknowledgment"; no screen may say a note was attested or verified.
2. **Re-baseline: accepted.** WP1/WP3 start from §3 and this section, not from the 2026-11 zip.
3. **Runtime evidence:** §14 stands; this refresh did not re-measure it. Keyboard-only and screen-reader passes, LPN/aide
   cosign, addendum and canceled/rescheduled journeys are still **not run**.
4. **PT/OT/SLP/NP:** in scope; the UI is driven by `resolveTemplate`, never a hard-coded discipline list.
5. **Feature flag:** not verified. WP1 and WP3 use none; they change navigation and presentation only and keep every
   route, so rollback is a revert.
6. **Not approved, not started:** WP2, WP4, WP5, WP6 and any backend, schema, auth, clinical-rule or signature change.
   Backend ideas found by WP1/WP3 are written up as proposals, not implemented.

### 15.4 Backend facts at HEAD (audit report)

Worktree `.claude/worktrees/wf09-note-slot-validation`, branch `feat/wf09-wp1-wp3-visit-workspace`, HEAD `e7588e836` (2026-11-20). Old evidence: `adcc752b4`, 2026-11-17. Paths are relative to the worktree. All `file:line` are at HEAD. "Not run / not verified" is stated where it applies.

#### 0. Five decision-relevant findings

1. **There is no read-only gate preview.** `POST /encounters/:id/finalize` is the only preview; it mutates on pass (status to `finalized`, narrative pinned, vocab pin written, event emitted). Nothing returns a gate verdict without transitioning (§2.1).
2. **Check 9 was reclassified from `deferred` to `elsewhere` on 2026-11-18 (`f44b75867`) but the old §5 gap is unchanged.** The acknowledgment is still a client-sent literal `true` that nothing records. The register now reads as "enforced" (§1, §3).
3. **The old evidence's §4 claim that `details` carries `check` is wrong.** `assertGatePassed` drops `check` (`gate/gate.ts:283-288`). A blocker panel must map `code` to a check itself. The generated client types `details` as `Record<string, never>[]` (§2.3).
4. **Step-up at sign is a 403 `STEP_UP_REQUIRED` from the route preHandler, not the 412 `STEP_UP_AUTH_REQUIRED` the old evidence cites.** The 412 is a service backstop. The panel must handle both (§2.2).
5. **New gate check 13 plus a second sign-time refusal.** Draft sections are checked at finalize (422 inside the gate) and again at sign (409 `DRAFT_SECTION_STALE`, thrown before the gate). Today only RN `routine_visit` drafts at all (§1, §2.2).

Surprising: the late-entry override has no author-is-not-overrider guard (§7, D-D). The cosign queue is not caseload-narrowed and no response names the routed RN (§7, D-E).

#### 1. Gate register at HEAD

13 checks (old: 12): **5 evaluated, 6 enforced elsewhere, 2 deferred**. Old: 4 / 5 / 3. Register: `gate/checks.ts:48-174`. `EVALUATED_CHECKS`: `:177-179`. The register test pins it in both directions (`apps/backend/__tests__/encounter-compliance-gate.test.ts:457-528`).

| # | Check id | State | Where it is decided | Change vs old §4 |
|---|---|---|---|---|
| 1 | `required_sections` | **evaluated** | `gate/gate.ts:156-181`. Populated = selection or free text (`:145-147`), plus `findingSections` (`:115-127`, ADL and nutrition records only), plus `draftConfirmedSectionIds` (`drafting/note-draft.ts:91-93`) | **Changed.** Now also counts saved ADL/nutrition records and confirmed drafted sections. Recorded vitals and wounds do not populate a section |
| 2 | `required_vitals` | evaluated | `gate.ts:183-194`; roster `templates/requirements.ts:62-66` (six-item roster only when the template has a required `vitals_review`); facts `gate/vitals-facts.ts` | unchanged |
| 3 | `required_scales` | evaluated | `gate.ts:196-205`; `requirements.ts:75-93` (only `recert_visit`: `pps`, `esas_r`); M9 seam failure is 503 (`encounters-route-service-db.ts:781-801`) | unchanged |
| 4 | `required_hope_items` | **deferred** | `checks.ts:71-80` (no encounter-to-HOPE-timepoint mapping) | unchanged |
| 5 | `late_entry_ceiling` | elsewhere | override routes `routes/encounters-routes.ts:894-926`; tier recomputed at finalize (reason only, `service-db.ts:2464-2472`) and at sign (override required, `:2626-2635`) | unchanged |
| 6 | `care_plan_review` | evaluated | `gate.ts:207-218`; `null` care plan is a pass; seam failure is 503 (`service-db.ts:761-772`) | unchanged |
| 7 | `layer2_decisions` | **deferred (vacuous)** | `checks.ts:95-104`; enhance route answers `enhanced:false` (`service-db.ts:2563-2568`) | unchanged |
| 8 | `step_up_fresh` | elsewhere | route preHandler `STEP_UP` (`encounters-routes.ts:164`, used `:849-854`); service backstop `lifecycle/encounter.ts:107` | unchanged in the register. See §2.2 for the actual codes and ordering |
| 9 | `attestation_confirmed` | **elsewhere (was deferred)** | `checks.ts:114-127` points at the route schema literal `attestationConfirmed: true` (`routes/encounters-typebox.ts:208-212`). Test pins only the schema shape (`encounter-compliance-gate.test.ts:468-482`) | **Reclassified** in `f44b75867`. Gap persists, §3 |
| 10 | `eligible_cosigner` | elsewhere | `encounter.ts:116-123`; resolved at `service-db.ts:2748-2750` via M5 (`:874-894`); lookup failure is 503 | unchanged |
| 11 | `f2f_attested` | elsewhere | `encounter.ts:109-115`; F2F branch `service-db.ts:2671-2744` (`planF2fDualWrite`) | unchanged |
| 12 | `vocab_version_pin` | elsewhere | `checkVocabVersion` at finalize (`service-db.ts:2494-2505`, `lifecycle/validation.ts:142-151`); DB CHECK `encounter_vocab_pinned_when_finalized` | unchanged |
| 13 | `draft_sections_resolved` | **evaluated (new)** | `gate.ts:220-231` (`ACTION_CODE`, `drafting/section-state.ts:73-76`) | **New** (ADR-0114) |

Conditional vacuity, which the panel must not render as "passed": check 2 for templates without `vitals_review` (chha, msw, chaplain, volunteer, pt/ot/slp, every `telephonic`); check 3 for every type but `recert_visit`; check 6 with no active care plan; check 13 whenever the tenant draft switch is off or the template drafts nothing (`drafting/note-draft.ts:51-58`, `packages/hearthnote/src/draft/scope.ts:37-43`).

Check 13 facts:
- **Drafting scope.** Draft phrases are tagged for the RN routine visit alone (`scope.ts:6-8`), so only `routine_visit x rn` drafts. Drafted section ids come from `DRAFT_SECTION_PHRASES` (`packages/hearthnote/src/draft/sources.ts:291-300`): `vitals_review`, `assessment`, `symptom_management`, `interventions`, `plan`.
- **Finalize.** A failure is a 422 gate failure with codes `DRAFT_SECTION_UNRESOLVED` or `DRAFT_SECTION_STALE`.
- **Sign.** `assertResolved` throws first (`service-db.ts:2659`), so the gate never sees check 13 failing at sign.
- **Tenant switch.** A tenant with the switch off is judged by the other twelve checks (`checks.ts:168-172`).

The in-memory slice (`routes/service.ts:1022-1035`) does not pass findings or draft facts. It is not the production service: `modules/08-encounters/index.ts:59` wires `createDbEncounterRouteService`.

#### 2. Contracts a blocker panel can render

##### 2.1 Routes (`routes/encounters-routes.ts`)

| Route | Guards (in order) | Body | 200 |
|---|---|---|---|
| `POST /api/v1/encounters/{id}/finalize` (`:802-813`) | `encounter.finalize`; `encounter.scope` (404 on deny); `is_author` (403). **No step-up, no `If-Match`.** Closure-gate allowlisted | `{lateEntryReason?: string >= 40}` (`encounters-typebox.ts:187-189`) | `{status:"finalized", version:int}` (`:701-704`) |
| `POST .../{id}/sign` (`:845-866`) | `encounter.sign`; scope; `is_author`; `STEP_UP("encounter.sign")`. No `If-Match` | `{attestationConfirmed:true, lateEntryReason?, visitModality?, startedAt?, endedAt?}` (`:216-233`) | `{status:"signed"\|"cosign_pending", signedAt, cosignatureRequestId:string\|null}` (`:739-743`) |
| `POST .../{id}/cosignature/sign` (`:960-966`) | `encounter.cosign`; `m8.cosigner_role_match` (RN and not the author); scope; `STEP_UP("encounter.cosign")` (`:296-310`) | `{attestationConfirmed:true, lateEntryReason?}`; parsed and discarded | `{status, cosignedAt}` (`:766-770`) |
| `POST .../{id}/cosignature/acknowledge`, `.../supervisor-release` (`:254-342`, shared builder) | `encounter.cosign` + role/scope; release also `encounter.cosign_supervisor_release` + step-up | release `{reason >= 40}` | `{status}` |
| `GET .../{id}/cosignature` (`:264-277`) | `encounter.read` + scope | none | `{status: cosign status \| null}` only (`encounters-typebox.ts:758`) |
| `POST .../{id}/late-entry-override`, `.../administrative-override` (`:894-926`) | permission + scope (+ step-up); administrative has no scope guard | `{reason, stepUpAuthAt}`; `stepUpAuthAt` is required by the schema (`:241-244`) and ignored by the handler | `{status}` |
| `POST .../{id}/visit-modality` (`:871-891`) | same chain as sign | `{attestationConfirmed:true, visitModality}` | modality confirmation. **Not** closure-allowlisted |
| addendum `finalize` (`:1110-1126`) / `sign` (`:1130-1150`) | addendum author; sign adds step-up | sign body `AttestationSchema`, parsed and discarded | `{status}` / `{status:"signed", signedAt, amendedSectionIds?, cosignatureRequestId?}` |

**Read-only routes that feed a blocker view. None returns a verdict.**
- `GET .../{id}/template` (`:533`): sections with `required`, allowed categories and menu entries.
- `GET .../{id}/draft` (`routes/draft-section-routes.ts:95-135`): per-section `state` in `not_drafted | unresolved | confirmed | deselected | needs_reconfirmation`, plus `contentHash`, `corpusVersion`, `part2Derived`, `origins`. This is the check-13 input. It is 404 when the draft switch is off, and needs `care_plan.read`, `prescribing.read` and `assessment.read_trend` as well as `encounter.read`.
- `GET .../{id}/vitals`, `/adl`, `/nutrition`, `/weight-history` (`findings/findings-routes.ts:96-167`).
- `GET .../{id}` (`EncounterViewResponseSchema`, `encounters-typebox.ts:358-440`): `status`, `lateEntryTier`, `visitModality(Confirmed)`, `timeSource`, `evvBracketPresent`, `version`. **No gate, blocker or readiness field.**
- `GET /encounters/closure-status` and `GET /encounters/my-drafts` (closure clock per open note, `routes/closure-routes.ts:92-104`).

**Is there a pure GET preview? No.** A route-by-route grep of `encounters-routes.ts`, `draft-section-routes.ts`, `closure-routes.ts` and `findings-routes.ts` finds none, and no schema field in `encounters-typebox.ts` carries a verdict (only the `required` comment at `:631`). Deriving "ready" without calling finalize would mean re-implementing checks 1-3, 6 and 13 client-side, which the plan forbids (§3.3).

##### 2.2 Failure codes (status: `lifecycle/errors.ts:14-114`; envelope: §2.3)

`details` below is `{field?: string, code: string, message: string}[]` unless it says "none".

| Code | HTTP | Thrown at | `details` |
|---|---|---|---|
| `COMPLIANCE_GATE_FAILED` | 422 | finalize and sign: `gateEncounter` (`service-db.ts:807-856`, calls `:2480`, `:2672`, `:2754`) via `assertGatePassed` (`gate.ts:276-289`). Floor: `encounter.ts:96,108` | **One per failure, `check` removed.** `field` is the section id, a vital key (`bp\|heartRate\|respiratoryRate\|temperature\|spo2\|pain`), a scale (`pps`\|`esas_r`), `"carePlan"`, or absent. Codes: `MISSING_SECTION`, `NO_TEMPLATE_FOR_PAIR`, `MISSING_VITAL`, `MISSING_SCALE`, `CARE_PLAN_REVIEW_OVERDUE`, `DRAFT_SECTION_UNRESOLVED`/`DRAFT_SECTION_STALE` (finalize only). Message names the section heading and encounter type |
| `COMPLIANCE_GATE_UNAVAILABLE` | 503 | M7 care-plan (`:761-772`), M9 scales (`:781-801`), M5 cosigner (`:874-894`), the draft read (`note-draft.ts:34-40`, `:64`, `:74`) | none. Message of the first three embeds the upstream error text (D-C) |
| `DRAFT_SECTION_STALE` | 409 | **sign**: `assertResolved` (`note-draft.ts:82-84`, `section-state.ts:82-93`), before the gate. Also `PUT /draft/sections/:id` (`resolve-section.ts:46-49`) | sign: one per section, `code` `DRAFT_SECTION_UNRESOLVED`\|`DRAFT_SECTION_STALE`, `field`=section id. PUT: none |
| `DRAFT_UNAVAILABLE` | 503 | `GET /draft`, `PUT /draft/sections/:id` (`drafting/unavailable.ts:9-17`). At finalize/sign it is folded into `COMPLIANCE_GATE_UNAVAILABLE`, except `UNKNOWN_VOCAB_CODE`, `VOCAB_VERSION_MISMATCH`, `INVALID_ENCOUNTER_DISCIPLINE_PAIR` (`note-draft.ts:44-48,73`) | none |
| `DRAFT_OFF_AFTER_FINALIZE` | 409 | sign, pin carries Part 2 text and the draft is now off (`drafting/note-draft-flow.ts:79-85`) | none |
| `VOCAB_VERSION_MISMATCH` | 409 | finalize (`service-db.ts:2501`) | none |
| `INVALID_SELECTION` | 422 | finalize: `assertSelectionsValid(requireComplete:true)` inside `pinAssembledOutput` (`service-db.ts:973`); also on every save | one per problem: `field`=section id, `code`, `message` (`routes/selections.ts:282-299`) |
| `NARRATIVE_EDIT_STALE` | 409 | finalize (`routes/narrative-edit.ts:64-68`) | none |
| `STEP_UP_REQUIRED` | **403** | route preHandler on sign, cosign, addendum sign, overrides (`packages/auth/src/abac/require-abac.ts:246-257`; `packages/types/src/errors.ts:144-148`) | none |
| `STEP_UP_AUTH_REQUIRED` | **412** | service backstop (`encounter.ts:107`, `cosignature.ts:163-167`; sms factor `service-db.ts:241-245`) | none. Reachable only if the preHandler passed and the service re-resolution disagrees |
| `NO_ELIGIBLE_COSIGNER` | 422 | sign, lpn/chha (`encounter.ts:116-123`) | none |
| `F2F_DUAL_WRITE_REQUIRED` | 412 | sign, F2F | none |
| `LATE_ENTRY_REASON_REQUIRED` | 422 | finalize and sign (`lifecycle/validation.ts:115-122`) | none |
| `SIGNIFICANT_LATE_ENTRY_OVERRIDE_REQUIRED`, `ADMINISTRATIVE_LATE_OVERRIDE_REQUIRED` | 422 | sign only (`late-entry/override.ts:112-130`) | none |
| `LATE_ENTRY_TIER_MISMATCH`, `*_OVERRIDE_NOT_PERMITTED` (403), `*_REASON_TOO_SHORT` (422) | 409/403/422 | override routes | none |
| `MODALITY_CONFIRMATION_REQUIRED`, `MODALITY_CONFLICTS_WITH_VISIT_TYPE`, `VISIT_TIME_INVALID`, `VISIT_TIME_OVERLAP` | 422 | sign, `deliveryColumnsAtSign` (`service-db.ts:1165-1215`, `visit-delivery.ts:86,119,128`). **After** the gate (`:2762` vs `:2754`) | none |
| `EVV_BRACKET_UNAVAILABLE` | 503 | sign with typed times while M18 is down (`:1182-1188`) | none |
| `ILLEGAL_TRANSITION` | 409 | finalize/sign from the wrong status (`:1295-1302`); `firstOrThrow` lost race (`:361-368`) | none |
| `VALIDATION_FAILED` | 422 | schema parse; first error only (`packages/shared/src/route-kit/validation.ts:7-19`) | `[{field, code:"INVALID", message}]` |
| `NOTE_CLOSURE_REQUIRED` | 403 | authenticate hook, **not** for allowlisted routes. Finalize, sign, draft, selections, vitals, adl, nutrition, care-plan-links, cosign, addenda are allowlisted (`bootstrap/note-closure-allowlist.ts:52-83`); `visit-modality` and `void` are not | exactly `[{field:"encounterId",code:"OLDEST_OPEN_NOTE",message:<uuid>}, {field:"deadlineAt",code:"DEADLINE",message:<ISO>}, {field:"overdueCount",code:"OVERDUE_COUNT",message:"<n>"}]`; the first two optional (`note-closure-gate.ts:216-233`) |
| `NOTE_CLOSURE_UNAVAILABLE` | 503 | same hook, fails closed (`:236-243`); a burst is 429 `RATE_LIMITED` | none |

Other statuses on these routes: scope deny is 404; `is_author` deny is 403 `FORBIDDEN`; `STALE_VERSION` exists but is not raised by finalize or sign (no `If-Match`). `Idempotency-Key` is optional per request (`bootstrap/plugins/idempotency.ts:12`); a repeat finalize or sign otherwise meets `ILLEGAL_TRANSITION`.

**Sign evaluation order** (`service-db.ts:2594-2802`):
1. Preconditions: author check (`:2609`) -> `ILLEGAL_TRANSITION` (`:2612`) -> admission/service date -> late-entry reason/override (`:2626`).
2. Draft: read (`:2655`) -> `assertResolved` -> Part 2 withdrawn check.
3. Gate: F2F gate (`:2672`) or cosigner lookup + gate (`:2748-2754`).
4. State machine and step-up backstop (`encounter.ts:107`).
5. Delivery/modality (`:2762`).
6. Seal and write.

`gateEncounter` is an argument expression evaluated before `transitionEncounter` runs, so the register's "step-up is checked before the gate" (`checks.ts:111`) holds only through the route preHandler.

##### 2.3 Envelope and generated types
- **Runtime envelope.** `{error:{code, message, details?, correlationId, documentationUrl?}}`; `details` item `{field?, code, message}` (`packages/types/src/errors.ts:13-30`; rendered at `apps/backend/src/bootstrap/plugins/error-handler.ts:102-110`).
- **Client Error component** (`packages/ui/src/core/api/schema.ts:31910-31925`): `{error:{code:string; message:string; correlationId?:string; details?: Record<string, never>[]}}`.
  - `details` items are typed as an empty object, so `field`/`code`/`message` need a cast. `documentationUrl` is absent.
  - Every operation declares only `"4XX"`/`"5XX"` Error responses. Statuses and codes are not in the types; they are prose on the path docs (`schema.ts:12117-12130` finalize, `:12240-12255` sign).
- **Typed 200s.** Finalize `{status:"finalized"; version:number}` (`:68868-68895`). Sign `{status:"signed"|"cosign_pending"; signedAt; cosignatureRequestId:string|null}` (`:69305-69340`); its request body types `attestationConfirmed: true` as a constant. Draft GET sections (`:68740-68755`).
- **Freshness.** `schema.ts` was last regenerated at `6a96314e3` and contains the ADL/nutrition/weight/closure-status paths. `client:check` was not run.

#### 3. Attestation provenance: the old §5 gap is still true

- **Boundary check.** `SignEncounterSchema` and `AttestationSchema` require the literal `true` (`encounters-typebox.ts:208-233`). `lateEntryReason`, `visitModality`, `startedAt` and `endedAt` are read by the sign handler (`encounters-routes.ts:856-865`). `attestationConfirmed` is not read by any service. The cosign and addendum-sign handlers parse and discard (`:961-966`, `:985-990`, `:1139-1141`).
- **What is persisted.** The signature row takes the server constant `PRIMARY_ATTESTATION_TEXT` ("...pending final legal copy", `service-db.ts:255-258`; insert `:2789-2802`; addendum `:3323`; cosign `cosignature/db-cosignature.ts:231`). `encounter_signature` has no column for an acknowledgment or text version (`packages/db/src/schema/encounter/encounter-signatures.ts:40-80`). `git log adcc752b4..HEAD` on that file is empty.
- **Provenance that does exist.** Server-resolved method, session id and `step_up_auth_at` (`service-db.ts:267-285`; DB CHECK within 5 minutes).
- **Since `adcc752b4`.** Only `f44b75867` (2026-11-18) touched this: the register text was rewritten to call check 9 `elsewhere` via the schema literal. The "register text is stale" part of old §5 is therefore fixed. The substance (client-asserted, unrecorded, the gate cannot distinguish a ticked box from a script) is not.
- **Tests.** The only test is shape-level (`encounter-compliance-gate.test.ts:468-482`). None asserts that an acknowledgment is recorded.

#### 4. Behaviour deltas since `adcc752b4` (`git log --oneline adcc752b4..HEAD -- apps/backend/src/modules/08-encounters` = 92 commits)

| Area | What changed | Anchor |
|---|---|---|
| Visit-note draft (ADR-0114) | Per-tenant switch routes (`GET/PUT /encounters/draft-policy`, step-up on PUT). `GET /draft`, `PUT /draft/sections/:id` (author only; AI refused). Finalize pins the confirmed draft text. Sign recomputes the signer's own draft, refuses unresolved sections, seals per-section rows (migration 1521 freezes the pinned narrative). Check 13; check 1 counts confirmed sections | `drafting/*`, `routes/draft-section-routes.ts`, `routes/drafting-routes.ts`; commits `f44b75867`, `fd9e73299`, `157029834`, `da36a68c2` |
| Sign locking | Encounter row locked in sign, finalize, section PUT, selections | `6f9872804`; `service-db.ts:2456,2607` |
| Delivery at sign | `visitModality` required for rn/lpn/chha/msw/pt/ot/slp unless already confirmed; optional documented times; EVV bracket still wins; overlap rule per author | `816fb6647`; `packages/types/src/encounter.ts:88-100`; `visit-delivery.ts`; `service-db.ts:1165-1255` |
| EVV at sign | `evv-at-sign.ts` unchanged since the old audit | `git log` empty for the file |
| Closure clock (ADR-0113) | 24h visit-note clock stamped from the visit start; policy and override routes; request-time gate 403 `NOTE_CLOSURE_REQUIRED` for staff with an overdue open note when mode is `block`; "My notes" returns the clock | `closure/*`, `bootstrap/note-closure-gate.ts`, `note-closure-allowlist.ts`; `066a55c6f` |
| Late entry | Tier logic, override routes and codes unchanged. Only `director_of_nursing` now counts as supervisor | `d5498c0ab`; `late-entry/*` has no commits in the range |
| Cosign | Same RN-cosigns-LPN/CHHA machine. Added: cosign requests for amending addenda (same four routes under `/addenda/:id`, queue entry `cosign.subject`), SLA sweep and alerts; cosigner cannot be the addendum's author | `4f9adc3e0`, `de21d5c2a`; `routes/encounters-routes.ts:974-1000`; `cosignature/db-cosignature.ts:100-120` |
| Addenda | Amending a signed drafted note: addendum names sections, resolves them via the draft routes, sign seals `encounter_amendment` rows; finalize and sign judge emptiness by the same sealable count; Part 2 refusals (`AMENDMENT_PART2_NOT_ENTITLED`); per-viewer note view and history on `GET /encounters/:id` | `264b391f9`, `abe5ee396`, `c11d6b6e5`, `63d85709d`; `EncounterViewResponseSchema` `noteHistory`/`finalDocumentationView` |
| Recorded findings (WF09) | `PUT/GET /adl`, `/nutrition`, `GET /weight-history` (optional `If-Match` -> 409 `STALE_VERSION`); wounds read from M9; writes only while draft (409 `NOTE_PINNED_AT_FINALIZE`); 422 `FINDING_NOT_IN_NOTE` when the template has no section for the record | `findings/*`; `08b628772`, `e7588e836` |
| Authoring validation (WF09) | Slot validation on save and finalize (`INVALID_SELECTION`), structured Reason for Visit, fall link, editable note text (`INVALID_NARRATIVE_EDIT`, `NARRATIVE_EDIT_STALE`) | `18b05cef5`, `344dd6e7c`; `routes/selections.ts:282-299`, `routes/narrative-edit.ts` |
| Eraser | Tombstone/shred work, docs only for this audit | `0424f7e03` and the eraser commits |

Unchanged: `lifecycle/encounter.ts` (graph and guards, `:51-61`, `:94-139`), `lifecycle/addendum.ts`, `late-entry/*`, `evv-at-sign.ts`, `encounter-signatures.ts`.

#### 5. Template and section inventory delta (old §7)

Pair matrix unchanged (`packages/types/src/encounter.ts:171-191`). Registry now `packages/hearthnote/src/templates/registry.ts:35-133` (sections), `:156-214` (bases and extras), `:217-244` (build). The old evidence cited `:90-160`.

| Discipline | Base sections at HEAD (R = required) |
|---|---|
| rn, lpn, md, np | `chief_concern` R (category `visit_reason`, `fallSummary`), `vitals_review` R (prose only, `vitalsSummary`), `assessment` R, **`functional_status`**, **`nutrition`**, **`skin_wounds`** (all three optional, free text only, recorded-finding flags `adlSummary`/`nutritionSummary`/`woundSummary`), `symptom_management`, `interventions`, `plan` R (prose) |
| chha | `chief_concern` R, `adl` R (`adlSummary`; populated by a saved ADL record with an item level), `plan` R |
| msw | `chief_concern`, `psychosocial`, `interventions`, `plan` |
| chaplain | `chief_concern`, `spiritual`, `plan` |
| pt, ot | `chief_concern`, `assessment`, **`functional_status`**, `interventions`, `plan` |
| slp | `chief_concern`, `assessment`, **`nutrition`**, `interventions`, `plan` |
| volunteer | `chief_concern`, `plan` |

- **Type extras**, unchanged and all required: admission (`med_reconciliation`, `advance_directive`, `caregiver_overview`, `baseline_symptoms`); recert (`pps`, `esas`, `prognosis`, `recert_summary`); face_to_face (`med_reconciliation`, `prognosis`, `f2f_attestation`); `msw_assessment` (`family_dynamics`); `idg_followup` (`idg_followup`).
- **Telephonic** drops `vitals_review` and `skin_wounds` (`registry.ts:217`).
- **Required flags** are unchanged. What changed is that the formerly bare required sections (`vitals_review`, `plan`, `family_dynamics`, `advance_directive`, `caregiver_overview`, `pps`, `esas`, `prognosis`, `recert_summary`, `idg_followup`) are now `prose()`: `allowedCategories: []`, so only the clinician's text (or a confirmed draft section) populates them (`registry.ts:27-33`).
- **Required vitals.** The six-item roster applies only where a required `vitals_review` exists (`requirements.ts:62-66`). Unchanged.
- **Required scales.** `pps` and `esas_r` for `recert_visit` only (`requirements.ts:75-93`). Unchanged.
- **Cosign disciplines** lpn and chha only (`lifecycle/validation.ts:43`).
- **Layer 2** off; routes 12/13 are stubs (`service-db.ts:2563-2591`).
- **Observation, not verified as a defect.** Check 1 does not count recorded vitals toward the required prose section `vitals_review` (`gate.ts:168-172`; `sectionsPopulatedByFindings` handles only ADL and nutrition). An RN `routine_visit` therefore needs the clinician's text (or a confirmed draft section) in "Vital Signs Review" even with all six vitals recorded. Whether the web composer fills it was not read.

#### 6. Non-live tests at HEAD

Command (exactly as requested, no live suite):
`bunx vitest run apps/backend/__tests__/encounter-compliance-gate.test.ts apps/backend/__tests__/encounter-lifecycle.test.ts apps/backend/__tests__/encounter-cosignature.test.ts apps/backend/__tests__/encounter-late-entry.test.ts apps/backend/__tests__/encounter-routes.test.ts apps/backend/__tests__/note-closure-gate-routes.test.ts packages/hearthnote`

**Result: 16 test files passed (16), 459 tests passed (459), 0 failed, 0 skipped, 0 todo**, 3.5 s, exit 0. A JSON-reporter rerun gave the same totals. The logs are `/tmp/wf09-wp0/vitest-backend.log` and `.json`.

| File | Tests |
|---|---|
| `encounter-compliance-gate.test.ts` | 41 |
| `encounter-lifecycle.test.ts` | 26 |
| `encounter-cosignature.test.ts` | 17 |
| `encounter-late-entry.test.ts` | 14 |
| `encounter-routes.test.ts` | 96 |
| `note-closure-gate-routes.test.ts` | 63 |
| `packages/hearthnote/__tests__`: assembly 38, draft-golden 14, draft-scope 9, draft 58, layer2 6, legacy-corpus-regression 2, recorded-findings 25, templates-draft-wiring 9, templates 23, vitals 18 | 202 |

- **Not comparable to the old evidence.** The old count (14 files, 238 tests) included `apps/web/src/modules/08-encounters`. This command does not.
- **Not run.** `*.live.test.ts`: nine `m8-*.live.test.ts` suites (addenda-read, eraser, read-service, write, findings, note-closure, post-discharge-authoring, visit-note-draft-routes, visit-note-drafting) plus related `m16`/`m18`/`f166` live suites. Also the other non-live M8 files (`encounter-draft-*`, `encounter-amendment-*`, `findings-*`, `note-closure-*`, etc.), `bun run typecheck`, `arch:fitness`.
- **What these tests pin.**
  - Gate register and the 422 details contract (`encounter-compliance-gate.test.ts:429-452`, `:457-528`).
  - Check 13 (`:530-579`).
  - The attestation schema shape (`:468-482`).
  - They do not exercise the Drizzle sign path, so ordering and 503/409 behaviour above is from source reading, not a run.

#### 7. Verified defects vs preferences vs unimplemented aspirations

**Verified at HEAD (source read; not reproduced live)**
- **D-A. Attestation unrecorded and client-asserted.** Not a UX item. Needs its own approved fix, tests and `compliance/controls.yaml` row (old R1). The register entry now says `elsewhere`, which a panel could read as "enforced" (§3).
- **D-B. `check` stripped from `details`** (`gate.ts:283-288`). The old §4 sentence "remediation `{check, code, field?, message}` carried in `details`" is false. Not a safety defect; the panel keys off `code` and `field`. A one-line backend change would add `check`, but that is a contract change.
- **D-C. 503 message leaks upstream error text.** `COMPLIANCE_GATE_UNAVAILABLE` for care-plan, scales and cosigner embeds `cause.message` in the response (`service-db.ts:765-770,794-799,886-891`). The draft path keeps `cause` off the response by design (`lifecycle/errors.ts:147-150`). Whether that text can carry PHI is unverified.
- **D-D. No author-is-not-overrider guard on the late-entry/administrative override.** The route chain is permission + scope + step-up (`encounters-routes.ts:894-926`). The service hard-codes `isSupervisor:true, stepUpFresh:true` (`service-db.ts:2926-2931`). Nothing compares the overrider with the note's author. Plan §3.3/T19 asks that users not self-authorize. Whether an author can hold the key depends on role grants (not checked).
- **D-E. Cosign queue and routed-RN visibility.** `GET /encounters/cosignature-queue` carries only `encounter.cosign` (`routes/encounters-routes.ts:432-442`) and the service takes only the org id (`service-db.ts:1715-1760`), so it is tenant-wide with no caseload narrowing. No response names `routedToMembershipId` (`CosignatureReadResponseSchema` is `{status}`, queue `cosign` object is subject/addendumId/requestId/status/routedAt). Plan §3.3 "show the RN destination" needs a new read. Cosign eligibility is RN role + scope + not-author; `signCosignature` does not compare the signer with the routed RN (`cosignature/db-cosignature.ts:176-228`).
- **D-F. Stale header comment** at `encounters-routes.ts:13-15` ("STEP_UP_AUTH_REQUIRED -> 412 when stale"); the route returns 403 `STEP_UP_REQUIRED`. Docs only.
- **D-G. Vestigial field.** `LateEntryOverrideSchema.stepUpAuthAt` is required but ignored (`encounters-typebox.ts:241-244`); the generated client requires it too.
- **D-H. Gate runs before the step-up backstop in the service** (`service-db.ts:2754` vs `encounter.ts:107`). Mitigated by the route preHandler; low.

**Preferences or design choices (not defects)**
- A read-only `GET .../gate` preview route.
- `check` in `details`.
- `If-Match` on finalize/sign, so the reviewed version can be bound. Today finalize binds to whatever is current under the row lock (`service-db.ts:2456`).
- Typed `details` in OpenAPI.
- Showing the routed RN.
- Surfacing deferred checks 4/7 and the `elsewhere` checks as distinct panel states. The register already carries the `kind`, but no route exposes it (the register is in code only).

**Unimplemented spec aspirations (do not advertise)**
- Layer-2 enhancement, per-passage decisions (`service-db.ts:2563-2591`).
- HOPE-timepoint check 4.
- Attestation provenance recording.
- Offline authoring (no backend support was read).
- Any aggregated "ready to sign" signal.

#### 8. Corrections to the old evidence's backend claims

| Old claim | At HEAD |
|---|---|
| 12 checks: 4 evaluated, 5 elsewhere, 3 deferred | 13: 5 / 6 / 2. Check 9 moved to elsewhere, check 13 added |
| `details` carries `{check, code, field?, message}` | `check` is dropped (`gate.ts:283-288`) |
| Step-up at sign is 412 `STEP_UP_AUTH_REQUIRED` | The route returns 403 `STEP_UP_REQUIRED`; 412 is the backstop |
| `checks.ts:111-121` says the acknowledgment input does not exist | Rewritten; the input exists but is unrecorded |
| Gate wired at `routes/service.ts:1020-1038` and `service-db.ts:603,612` | Production `gateEncounter` at `service-db.ts:807-856`; calls `:2480`, `:2672`, `:2754`. In-memory slice at `routes/service.ts:1022-1035` |
| Sign handler reads only `lateEntryReason` (`:636-640`) | Also `visitModality`, `startedAt`, `endedAt` (`:856-865`) |
| `SignEncounterSchema` at `:205-209` | `:216-233` (composite with modality/times) |
| Template registry `:90-160`; base sections for rn/lpn/md/np and pt/ot/slp | `:156-214`; three optional finding sections added (§5) |
| Sign preconditions "step-up -> gate -> F2F -> cosigner" | Plus draft resolution, late entry and delivery/modality, in the order in §2.2 |

### 15.5 Frontend facts at HEAD (audit report)

Worktree `.claude/worktrees/wf09-note-slot-validation`, branch `feat/wf09-wp1-wp3-visit-workspace`, HEAD `e7588e836`.
Method: static reading only. No test, browser or stack was run. Paths below are relative to `apps/web/src/modules/` unless
they start with `apps/`, `packages/`, `e2e/`. "Op id" = generated operation id in `packages/ui/src/core/api/schema.ts`
(the typed client is path-keyed, `client.GET("/api/v1/...")`, so op ids are looked up there, not written in screens).
Sizes now: `08-encounters/encounter-compose.tsx` 1574 lines, `encounter-read.tsx` 3143, `patient-encounters.tsx` 868,
`my-drafts.tsx` 496, `cosignature-queue.tsx` 535, `17-scheduling/visit-detail.tsx` 300, `my-visits.tsx` 682.

#### 1. Route table (everything that reaches an encounter)

Registrations: `08-encounters/screens.ts`, `17-scheduling/screens.ts`. Param paths (`:`) are NOT permission-gated client-side:
`shell/app.tsx:302` passes `enforce={!s.path.includes(":")}`; the server is the only gate (`shell/app.tsx:114-130`).

| Path | Component | Perm (screens.ts) | API calls (method path, op id, file:line) |
|---|---|---|---|
| `/me/visits` | `MyVisits` (`17/my-visits.tsx`) | visit.read (`17/screens.ts:168-175`) | GET `/visits` getApiV1Visits :84; GET `/encounters?patientId&admissionId&limit=50` getApiV1Encounters, on click only, `scheduling-workflow.tsx:1452-1467` via :156; POST `/visits/{id}/start`, `/arrive` postApiV1VisitsByVisitIdStart/Arrive :181-188; patient names hook :108 |
| `/scheduling/visits/:visitId` | `VisitDetail` | visit.read (`17/screens.ts:160-166`) | GET `/visits/{id}` getApiV1VisitsByVisitId :58; GET `/patients/{id}` :70; `findLinkedEncounter` :73; GET `/scheduling/staff` getApiV1SchedulingStaff :82; GET `/patients/{id}/addresses` :83; GET `/patients/{patientId}/admissions` :86; `VisitActionPanel` POST start/arrive/reassign/reschedule/cancel/no-show `scheduling-workflow.tsx:1133-1166` |
| `/calendar` (side panel) | `calendar-page.tsx` | visit.read | `findLinkedEncounter` :1204; link "Open Documentation" to the record :1278-1285; link to visit detail :1274 |
| `/patients/:patientId/encounters` | `PatientEncounters` | encounter.read (`08/screens.ts:50-55`) | GET `/encounters?patientId` :202 (no limit, all rows); `ChartPatientBanner` (:231) GET patients/{id}, demographics, identifiers (`shell/patient-context.tsx:110-125`); "New Encounter" modal: GET `/encounters/visit-reasons` getApiV1EncountersVisitreasons (`encounters-api.ts:222`), GET `/patients/{patientId}/admissions` (:314), POST `/encounters` postApiV1Encounters :535 |
| `/patients/:patientId/encounters/:encounterId` | `EncounterRead` | encounter.read (`08/screens.ts:58-63`) | read: GET `/encounters/{id}` getApiV1EncountersByEncounterId (`encounter-read-load.ts:151`), `/cosignature` :232, `/patients/{id}` with the URL patient :240, internal care-plan relevant-elements :248, `/patients/{pid}/assessments` :262, `/hope/assessments` :270, `/selections` getApiV1EncountersByEncounterIdSelections :280, `/draft` (`draft-api.ts:81`). writes: POST finalize (read.tsx:618), sign (:356), void (:651), vitals (:489), mileage (:530), care-plan-links (:558), addenda and cosign (`addenda-api.ts`, `use-cosign-ceremony.ts:25-26`) |
| `/patients/:patientId/encounters/:encounterId/compose` | `EncounterCompose` | encounter.author (`08/screens.ts:67-72`) | GET `/encounters/{id}` (`encounter-compose.tsx:319`); template (`encounters-api.ts:206`), selections (:293), patients/{id} (compose:341); PATCH selections with `If-Match` (`encounters-api.ts:348`), POST vitals (:365), POST finalize (:398), GET `/visits/{visitId}` for the reason suggestion (:234, called compose:407), GET fall-incidents (:279), draft GET/PUT (`draft-api.ts:81,99`), care-plan links (`draft-api.ts:187-220`) |
| `/work/drafts` ("My Notes") | `MyDrafts` | encounter.author (`08/screens.ts:85-91`) | GET `/encounters/my-drafts` getApiV1EncountersMydrafts (`use-my-notes.ts:59-62`); patient names |
| `/work/cosignatures` | `CosignatureQueue` | encounter.cosign (`08/screens.ts:75-81`) | GET `/encounters/cosignature-queue` getApiV1EncountersCosignaturequeue :75 |
| `/work/overdue-notes` | `OverdueBoard` | encounter.closure_override (`08/screens.ts:94-100`) | GET `/encounters/overdue-notes` getApiV1EncountersOverduenotes (`closure-api.ts:105`), POST closure-overrides :131 and revoke :151, GET `/orgs/{id}/care-team-staff` :178. No link to a note. |
| `/admin/closure-policy`, `/admin/draft-policy` | `ClosurePolicy`, `DraftPolicy` | admin keys | GET/PUT `/encounters/closure-policy` (`closure-api.ts:158,166`), `/encounters/draft-policy` (`draft-api.ts:144,151`). Not an entry point. |
| (no route) proposed-from-message | `ProposedFromMessage` | n/a | Rendered inside `AddendumPanel` (`addendum-panel.tsx:203`), in the record's Addenda rail (`encounter-read.tsx:1583-1595`); GET `.../chart-promotions` getApiV1EncountersByEncounterIdChartpromotions (`addenda-api.ts:199`), POST `.../reject` (:228) |

Other inbound links to the record route (no state): `shell/chart-module-rail.tsx:130` ("Visits" tab, to the list),
`05-patient/patient-overview.tsx:1380`, `05-patient/patient-clinical.tsx:910,1075`,
`07-care-plan/change-proposals/pending-change-proposals.tsx:112`, `23-billing-medicare/sia-card.tsx:48`,
and to the shared note helper `shell/note-href.ts:16-19` from `shell/role-home.tsx:518-530` and
`shell/note-closure-banner-model.ts:40`. `shell/role-home.tsx:552` links to `/scheduling/visits/:id`.

#### 2. Entry-point matrix

| From | Link target | State / params carried | Resume vs create |
|---|---|---|---|
| My Visits, "Encounter" button | `/patients/:p/encounters/:e` (the RECORD, even for a draft) `my-visits.tsx:158` | none | Never creates. `findLinkedEncounter` (list + client match on `visitId`); no match: notice "Encounter draft is still being created" :159. Button shown only for published/en_route/in_visit/completed :426 |
| My Visits, row click | `/scheduling/visits/:id` :354 | none | n/a |
| Visit Detail | record route: "Linked Encounter" button (label = status) `visit-detail.tsx:206-219`; "Open Encounter"/"Refresh Encounter" `scheduling-workflow.tsx:1226-1236` | none | Never creates. Resolved on load :73. None found: shows "Processing" :218 and "Draft Encounter is created asynchronously after publish" :1240 |
| Calendar visit panel | record route `calendar-page.tsx:1278-1285` | none | Same helper, never creates |
| Patient Chart "Visits" tab | list; row click only selects (`patient-encounters.tsx:316-318`); detail panel "Open encounter" to record :366-368; "Compose note" to `/compose` only if `status==="draft"` and session has `encounter.author` :372-383 | none | Lists every encounter (no limit). Rows carry no `visitId`/clinician/visit time (`EncounterRow` :60-80; columns :812-868). "New Encounter" (author perm :292-296) POSTs an ad-hoc encounter, no `visitId` :535-544, then navigates to the RECORD :399-404 |
| My Notes | `noteHref`: draft to `/compose`, anything else to the record (`shell/note-href.ts:16-19`; `my-drafts.tsx:351,392`) | none | Never creates. Opens the composer directly |
| Cosign queue | `queueEntryHref`: record, plus `#addendum-cosign-<id>` for an amendment (`cosign-model.ts:171-176`; `cosignature-queue.tsx:417`) | URL hash only | Never creates |

Verified server rule, encounters per visit:
- At most ONE encounter per `(organization_id, visit_id)` when `visit_id` is not null: partial unique index
  `encounter_org_visit_unique` (`packages/db/migrations/0167_encounter_visit_seed_idempotency.sql:14-16`;
  `packages/db/src/schema/encounter/encounters.ts:144-146`; read seam doc `apps/backend/src/modules/08-encounters/seams/drizzle-store.ts:569-575`).
  `visit_id IS NULL` encounters have no uniqueness at all.
- Creation is server-side on `m17.visit.published`: consumer `m8.seed-visit-encounter` inserts a draft authored by the assigned
  clinician with `.onConflictDoNothing()` (`outbox-consumers/m17-visit-scheduled.ts:182-194`); it THROWS (event retried, then parked
  `failed`) on an illegal type x discipline pair (:154-160) or an inactive admission (:163-167). So a visit can have no encounter
  for good; the UI cannot tell "not yet" from "never" (it only says Processing / still being created).
- `POST /api/v1/encounters` accepts an optional `visitId` (`routes/encounters-typebox.ts:94`; handler `routes/encounters-routes.ts:351-374`)
  but it is not validated as a real visit; it only steers the note-closure clock (`encounters-route-service-db.ts:519-555`, comment
  "just a uuid the clinician typed (no FK)"). The web never sends it (`patient-encounters.tsx:535-544`).
- No route resolves visit to encounter: `EncounterListQuerySchema` has no `visitId` filter (`encounters-typebox.ts:303-312`);
  `listEncounters` orders `serviceDate desc, id desc` and slices to `limit` (`encounters-route-service-db.ts:1691-1712`); visit views carry no
  `encounterId` (`schema.ts` getApiV1VisitsByVisitId response). The web asks for `limit: 50` (`scheduling-workflow.tsx:1456-1462`)
  and matches client-side, so a visit whose encounter is outside the 50 newest for that admission is reported "still being created".
  The backend seam `encounterIdsForVisitsForOrg` (`drizzle-store.ts:576-`) is not exposed over HTTP.
- A `POST` with a `visitId` that already has an encounter hits `encounter_org_visit_unique`, which is not registered with `businessRule()`
  (only `face-to-face-encounters.ts:39` uses it for encounters), so the error handler returns 500 INTERNAL_ERROR, not 409
  (`apps/backend/src/bootstrap/plugins/error-handler.ts:6-9,113-122`). Not reachable from the current UI.

Can the UI create a duplicate?
- Double click: "Create Encounter" is `<Button loading={busy}>` and `loading` disables it (`packages/ui/src/web/components/button.tsx:48`;
  `patient-encounters.tsx:702`); `busy` is set before the await. A lost-reply retry reuses the Idempotency-Key and the server replays
  (`packages/ui/src/core/api/idempotency-middleware.ts:1-22`, `apps/backend/src/bootstrap/plugins/idempotency.ts:11-20`); an answered request
  renews the key, so a second deliberate submit is a new intent.
- Two tabs: two PRN creates give two rows (no uniqueness for null `visit_id`).
- Browser back: success calls `navigate` (push, no `replace`) to the record :403; back returns to the list, modal closed (component state). No resubmit.
- Real duplicate vector: PRN "New Encounter" for a patient whose scheduled-visit draft is not seeded yet (or never will be) yields a second,
  unlinked encounter for the same visit day. No pre-check (the modal reads only admissions and reasons: `patient-encounters.tsx:482`, `encounters-api.ts:314`). At sign an unlinked
  note raises `m8.encounter.orphan_recorded` (`encounters-route-service-db.ts:1108-1116`).
- Visit-linked encounters cannot be duplicated from the UI (My Visits, Visit Detail, Calendar never POST an encounter).

#### 3. Return context

| Screen | What it offers | Where context is lost |
|---|---|---|
| Composer | "Back to encounter" :919 and "Open record" :927 (both `navigate(recordPath)`, the same target, disabled while busy); dirty guard `useBlocker` :504 plus `beforeunload` :535 ("Leave without saving?" :1552-1568); no `navigate(-1)` | No link to the visit, chart, My Notes or My Visits. Banner (name/MRN/DOB, :902-908) is not a link. After finalize it stays and says "Sign it from the encounter record." :840 (no button) |
| Record | Banner actions "Back to encounters" (patient list) and "Open chart" :817,:825; rail: "Open visit" :1708, "Back to patient chart" :1735, "Open cosignature queue" :1743 | No "Back to My Visits" / "My Notes". "Open visit" and "Open cosignature queue" fixed targets. Error/loading shows `PatientChartBail` with the URL patient (:677-703) |
| Visit Detail | "← Back to schedule" `/calendar?view=&date=&patient=&visit=` built :131-133,:157; "Back to <patient>" `/patients/:id` :162-166 | Nothing sets `view`/`patient` on entry (all callers link bare `/scheduling/visits/:id`: `calendar-page.tsx:1274`, `day-view.tsx:89,100`, `week-view.tsx:87,98`, `my-visits.tsx:354,502`), so the back link always lands on the day view at the visit date, never on My Visits |
| My Visits | filters/page are `useState` (:61-66), not URL | Returning from any encounter/visit page (history back or link) remounts and resets filters, date filter, page |
| My Notes / Cosign queue | rows push the target | No state passed either way |

- Router state / `from` query: none anywhere in `08-encounters`, `17-scheduling`, `shell` (grep). The only return mechanism is step-up
  `returnTo` (`write-workflow.ts:37`, `use-cosign-ceremony.ts:199`, `addendum-panel.tsx:101`, `my-visits.tsx:191-194`).
- Deep link, user lacking access: server is the gate. `GET /encounters/:id` = `READ` + `SCOPE_FOR("encounter.read")` (non-leaking 404 outside
  caseload) + read audit (`routes/encounters-routes.ts:459-472`). Composer and record collapse every failure into one generic message
  ("Could not load this encounter." compose:322-333, "Could not load the encounter." `encounter-read-load.ts:157-168`), except a 503
  note-view-unavailable with Retry. No 403/404 distinction, no redirect, no back link in the composer error state (`EmptyState`
  `encounter-compose.tsx:877-883`); the record error state keeps the chart rail (`PatientChartBail`).
- Wrong `:patientId` in the path. Composer ignores it (reads only `encounterId`, :224) and shows the encounter's own patient (:341, banner :902).
  Record does NOT: `readEncounter(..., patientId)` fetches the banner patient with `pid = patientId ?? data.patientId`
  (`encounter-read-load.ts:230-247`; call `encounter-read.tsx:235`) while the note, rail (`ChartModuleRail patientId={e.patientId}`
  :838) and links use the encounter's patient. No equality check exists in either screen (grep). Result: encounter of patient B under
  the banner of patient A if the caller may read A. If A is unreadable the banner falls back to "Encounter" (:685).
- Record `patient` state is never reset between loads: `if (read.patient) setPatient(read.patient)` (:248); the loading branch renders
  `bailBanner` from the previous `patient` (:677-703). The composer resets everything per load (compose:300-318) and has a test for it
  (`encounter-authoring.dom.test.tsx:359-371`); the record has none.
- Signed (or any non-draft) encounter at `/compose`: composer loads, `editable = status==="draft"` is false (:458), every control disabled via
  `frozen` (:461), hint "This note is read-only because the encounter is signed." :1188-1192; no redirect to the record. Pinned by
  `encounter-authoring.dom.test.tsx:644`.
- Neither screen reads `session.permissions` (grep). A user with `encounter.read` but not `encounter.author` gets an editable-looking
  composer on a draft (template/selections routes are `READ`, `encounters-routes.ts:507,532-535`); writes fail at the server. The record offers
  "Sign encounter" on any finalized note (`canSign = status === "finalized"` :714). ADR-0030 design (server enforces); UX consequence only.
- Note-closure gate: while a clinician is blocked the shell sends refusals to `/work/drafts` unless the screen is in
  `shell/note-closure-screens.ts:17-30`, which lists `/patients` (so all encounter routes) but not `/me/visits` or `/scheduling`. Server mirror:
  `apps/backend/src/bootstrap/note-closure-allowlist.ts:38-39,368-369` (GET visits and M8 encounter routes allowed; visit start/arrive deliberately not).

#### 4. Header / chrome inventory

| Piece | Composer (`encounter-compose.tsx`) | Record (`encounter-read.tsx`) |
|---|---|---|
| Patient banner | `PatientBanner` name, MRN, DOB (:902-908); fallback "Encounter documentation" | `PatientBanner` name, DOB+age, MRN chip, patient-status pill, actions (:795-833); fallback "Encounter" |
| Chart-wide banner (`ChartPatientBanner`, sex, Medicare tail, extras, `shell/patient-context.tsx:455`) | not used | not used (used only by `PatientEncounters` list :231) |
| Encounter type / discipline / service date | not shown (type and discipline only in an empty-template message :1261-1262; no `serviceDate` anywhere) | h1 type + status pill, line "discipline . serviceDate . F2F . v<version>" (:847-868) |
| Visit date/time, clinician, EVV, late-entry | none | service date + source + "Open visit" in the Visit rail card (:1675-1712); late-entry tier in Sign-off rail; clinician and scheduled window not shown; `evvBracketPresent` is loaded (`encounter-read-load.ts`) but not rendered |
| Status | `StatusPill` in header actions :922-925 | pill in title line and Sign-off rail |
| Link to chart / back | none / "Back to encounter" + "Open record" (duplicates) | "Open chart" :825, "Back to encounters" :817, rail "Back to patient chart" :1735 |
| Save | header "Save draft" :942, preview footer "Save & refresh preview", per-panel Save buttons (vitals, recorded panels, plan); state line `<output class=wx-encounter-save-state>` "Unsaved changes / Saving / All changes saved" :999-1011 | no note save; "Save vitals" :1015, care-plan link add, mileage save |
| Finalize | header "Finalize note" :946 (saves first, then POST finalize, :787-835) | rail "Review & finalize" :1542 (POSTs finalize at once, no preview) |
| Sign / cosign / void / addendum | none | rail: "Sign encounter" :1527 (CeremonyModal :1756, attestation checkbox, delivery step, "Sign & commit"), cosign acknowledge/sign/supervisor release (`cosign-ceremony-modals.tsx:86,102,125`), "Void draft" :1553, "Add addendum" :1570 (modal :1834-1911), assessment modal :1913 |
| Step navigation | "Note sections" rail `aria-current="step"` (:1105-1175); progress card; "needs attention" card (:1044-1066); narrative preview card with Edit / Save & refresh (:1408-1530, sticky only the preview card, `encounter-compose-styles.ts:571-575`); vitals toggle; `PlanOfCareStep` (:1541) | "Visit workflow" card with 5 steps Documentation, Vitals, Care Plan, Assessments, Mileage (:871-930, status draft only, "navigation only" disclaimer); sections 1-5 (:944-1280) |
| Ceremonies | none | sign, cosign x3, void, addendum open + `AddendaPanel` (sign/cosign/amend), assessment |

Duplicated between the two screens (candidates for one shared "visit context header"): patient banner (two different `PatientBanner` builds),
status pill, "back/open" actions, finalize button (2 places), vitals entry (composer `VitalsPanel`; record Section 2 `saveVitals`), care-plan links
(composer picker/`PlanOfCareStep`; record Section 3 `LinkedRows`), note preview (composer preview card; record Documentation panel).
Available data for a shared header without new APIs: encounter (`type, discipline, serviceDate, status, lateEntryTier, isF2f, version, visitId, authoredByUserId,
visitModality, evvBracketPresent`) from the GET already made by both screens; scheduled window, assigned membership id and visit status from
`GET /visits/{visitId}` (already called for the composer reason hint, `encounters-api.ts:232-240`); clinician display name needs the staff list
(`use-staff-names.ts` / `GET /scheduling/staff`). The visit view has NO actual start/end and NO EVV bracket (`schema.ts` getApiV1VisitsByVisitId).
Reusable layout slot: `PatientWorkspaceLayout` already takes `banner` and `contextHeader` (`packages/ui/src/web/layouts/patterns.tsx:308-313`);
both screens only fill `banner`.
Layout/behaviour constraints: responsive rules for `wx-encounter-compose-*` / `wx-encounter-record-*` live in `apps/web/src/index.css`;
state machine untouched by any of the above (status values come straight from the server: `encounter-status.ts`).

#### 5. Tests that pin current behavior (must stay green or be updated)

Vitest DOM (non-live):
- `08/encounter-authoring.dom.test.tsx`: banner name and MRN visible, "Back to encounter" returns to the record :349-357; stale previous chart not shown :359-371;
  dirty/route/unload guard :404-427; "Open care plan" lands on `/patients/:p/care-plan` :429-453; "Finalize note" saves first :532-545; signed note shows no authoring controls :644; draft row opens composer :701-715.
- `08/encounter-compose-panels.dom.test.tsx`: mounts the route `/patients/:patientId/encounters/:encounterId/compose` (:20,:286-291).
- `08/__tests__/encounter-workspace.dom.test.tsx`: record route; "Review & finalize" :151; "Sign encounter" and "Sign & commit" :186-191; "Compose note" button :337; "Save vitals" :341; "New Encounter" flow, no M17 visit invented :404-470, admission links :472-500; list heading "Encounters / Visits" :443.
- `08/__tests__/my-notes.dom.test.tsx:227,243`: finalized row to record, draft row to `/compose`. `my-notes-model.test.ts`, `shell/note-href.test.ts`, `shell/role-home.dom.test.tsx`, `shell/note-closure.dom.test.tsx`: `noteHref` contract.
- `08/__tests__/cosignature-queue.dom.test.tsx:78,113`: path and `#addendum-cosign-...` hash.
- `08/__tests__/sign-draft.dom.test.tsx:185-186,218`: "Review them in the note editor" link to `/compose`. Also `signed-note-read`, `sign-delivery`, `note-cosign`, `addendum-*`, `composer-draft`, `proposed-from-message`, `closure-screens` mount these screens.
- `08/new-encounter-reason.dom.test.tsx`: PRN modal create body.
- `17/__tests__/visit-workflow.dom.test.tsx:178-214` "opens the linked Encounter without creating a duplicate": a DRAFT encounter must navigate to the RECORD path (:209-211) and POST nothing. A change to "draft goes to compose" breaks this on purpose.
- `17/scheduling-writes.dom.test.tsx:252` mounts `VisitDetail` (:613,:681 only action-panel assertions); no test pins "Linked Encounter", "Open Encounter", "Processing" or the back links (grep). `17/workspace-nav.dom.test.tsx`, `17/my-visits.dom.test.tsx` (filters/copy; no encounter links).
Playwright:
- `e2e/specs/encounters.spec.ts`: "Open encounter for visit <id>" button then `waitForURL(/\/encounters\/[^/]+$/)` (record) :262-263, then "Compose note" button then `/compose$` :266-267; headings "Compose visit note" :270, "Save draft", "Finalize note", "Note finalized" :292-325; `page.goto(record)` then "Sign encounter"/"Sign & commit" :330-337; visit page "Completed" then button "Signed" returns to the record :353-359; list a11y "Encounters / Visits" :362-367.
- `e2e/specs/scheduling.spec.ts:153` visit detail URL regex.
Gates keyed on screen ids/paths: `audit/ui-parity` and `audit/e2e-coverage/E2E_COVERAGE.md:106-107` (encounter.read/compose listed "needs another seeded resource id"), `scripts/frame-fidelity/registry.ts:127-150` (frame `AohyV` for `encounter.read`, status partial), CSS contract `08/__tests__/draft-chrome-css.test.ts` (reads `packages/ui/src/web/styles/list-chrome.css`).

#### 6. Gaps vs WP1 acceptance, and the smallest frontend-only change set

Classification.
Verified defects (read from source, not run):
- D-A Record screen takes the banner patient from the URL, not from the encounter (`encounter-read-load.ts:230-247`). Cross-patient identity mismatch on a wrong/forged `:patientId`.
- D-B Record screen keeps the previous `patient` while the next encounter loads and when its patient read fails (`encounter-read.tsx:248,677-703`).
- D-C Visit lookup misses an encounter outside the 50 newest of the admission (`scheduling-workflow.tsx:1456-1462` + no `visitId` filter), then tells the user it is "still being created".
- D-D Same draft, two landing screens: My Visits / Visit Detail / Calendar / Chart "Open" go to the record (an extra "Compose note" click, pinned by e2e), My Notes / banner / role-home go straight to the composer (`note-href.ts:16-19`).
- D-E After "Finalize note" the composer offers no direct route to signing, only text (:840); both screens finalize (composer :946, record :1542); record's "Review & finalize" finalizes with no review (:1542, :612-640).
- D-F Sign ceremony still shows "Signing clinician / This session" (`encounter-read.tsx:1808-1809`; same as prior finding D3).
- D-G Composer shows no encounter type, discipline, service date, visit link or clinician; the record shows no clinician, scheduled window or EVV state.
Preferences / UX (not defects): collapsing the two "Back" buttons; client-side permission-aware controls (ADR-0030 says no frontend authz); My Visits filters in the URL; distinguishing 403/404 on deep links (non-leaking by design).
Design-spec aspirations not implemented: header with time in/out, EVV bracket, linked visit (`CHARTWARDEN_UI_ENCOUNTER_VISIT_DOCUMENTATION.md:38-50`); sticky footer Save/Finalize/Sign (:33; only the preview card is sticky); right panel with scales and HOPE items; offline drafts and biometric sign (:367-373, no `localStorage`/IndexedDB in either screen); Document/Review/Complete navigation (plan only; neither the spec nor the code has it).

WP1 acceptance, per clause:
1. "Reaches a scheduled visit's correct encounter from My Visits, Visit Detail and Patient Chart". My Visits, Visit Detail, Calendar: yes via client match, subject to D-C/D-D. Patient Chart: reaches encounters by date/type only; rows do not say which came from a visit (no `visitId` in `EncounterRow`) and nothing links back to the visit.
2. "Return without losing context": not met (section 3): no state anywhere, My Visits filters reset, Visit Detail never returns to My Visits, composer and record have no way back to the originating list.
3. "Permissions unchanged": nothing in WP1 needs to touch them. Keep new routes under `/patients/:patientId/encounters/...` so the note-closure allowlist (web `shell/note-closure-screens.ts:17-30`, server `note-closure-allowlist.ts`) keeps working; a route outside `/patients` needs both lists edited (server change).
4. "No duplicate encounter creation": the UI creates no visit-linked encounters today, and the DB index blocks them; do not add a "start documentation for this visit" POST without a backend `visitId` lookup/409 mapping (see section 2).

Smallest frontend-only change set (ordered; each is independent):
1. Fix D-A and D-B in `encounter-read-load.ts` / `encounter-read.tsx`: use `data.patientId` for the banner fetch; if it differs from the route `:patientId`, `navigate(canonicalPath, { replace: true })`; reset `patient`/`encounter` at the start of a non-in-place load as the composer does. Adds DOM tests next to `encounter-workspace.dom.test.tsx`.
2. One entry helper `encounterEntryHref(encounter)` (new, in `shell/note-href.ts` or `08/`): `draft` to `/compose`, every other status to the record. Do not reuse `noteHref` as is: it sends any non-finalized status, including signed and voided, to `/compose` (`note-href.ts:18`). Use it in `my-visits.tsx:158`, `visit-detail.tsx:212`, `scheduling-workflow.tsx:1230`, `calendar-page.tsx:1280`, `patient-encounters.tsx:366-383`. Update `visit-workflow.dom.test.tsx:209-211` and `encounters.spec.ts:262-267` (drop the "Compose note" click).
3. Return context as a validated `?from=` query (survives refresh and new tab, unlike router state; precedent: `/step-up?returnTo=`). Writers: My Visits, Visit Detail, Calendar, My Notes, cosign queue, Chart. Readers: composer and record render one "Back to <My Visits | visit | My Notes | cosign queue | encounters>" link. Accept only a fixed allowlist of internal path prefixes (open-redirect guard). Move My Visits filters/page into search params so Back restores them.
4. Shared `VisitContextHeader` in a new small file under `08-encounters/` (both screens are far over the 800-line ceiling): patient banner (one build, link to chart), type, discipline, service date, status, late-entry tier, visit link with scheduled window and clinician (extra `GET /visits/{visitId}` plus staff names, best effort, never blocking), back link from item 3. Plug it into the existing `contextHeader` slot (`patterns.tsx:308-313`). No EVV or actual-time fields (no API; WP5).
5. Document / Review / Complete as a three-link strip in that header, same routes, no new statuses: Document = `/compose` (shown for draft), Review = the assembled note (composer preview card / record Documentation panel, anchor), Complete = record Sign-off rail (anchor). After composer finalize, replace the text at :840 with a button to the record. Keep the server-driven button states.
6. Optional, backend (not frontend-only): `visitId` filter on `GET /encounters` and a registered `businessRule()` for `encounter_org_visit_unique` (removes D-C, makes a linked POST a clean 409).

Risks:
- Tests to update with change 2: `17/__tests__/visit-workflow.dom.test.tsx:178-214`, `e2e/specs/encounters.spec.ts:262-267`; with change 4/5 any test that finds the duplicate "Back to encounter"/"Open record" buttons (`encounter-authoring.dom.test.tsx:355`), "Review & finalize" (`encounter-workspace.dom.test.tsx:151`) or "Compose note" (:337).
- `frame:fidelity` entry `encounter.read` (`scripts/frame-fidelity/registry.ts:127-150`) and `ui:parity` may need a re-run if the record layout changes; `arch:e2e-coverage` lists compose/read as undiscoverable.
- A header that shows clinician/time adds reads on two PHI screens; use existing audited routes only, no new client-side authz.
- `from` links must never reveal a patient or visit id the viewer cannot open; the target page re-checks via the server.
- Component size: both screens exceed the 800-line soft ceiling; put new code in new files and extract nothing in the same PR (characterization tests first, per prior R4).
- The note-closure web allowlist mirrors a server list by test (`apps/backend/__tests__/note-closure-allowlist-mirror.test.ts`, named in `note-closure-screens.ts:8-10`); do not add a top-level route.
