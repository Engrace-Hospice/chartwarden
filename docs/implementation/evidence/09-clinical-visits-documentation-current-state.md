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
