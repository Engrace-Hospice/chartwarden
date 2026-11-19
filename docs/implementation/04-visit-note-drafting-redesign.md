# ChartWarden — Workflow 04: Visit-Note Drafting — Redesign

**Repository destination:** `docs/implementation/04-visit-note-drafting-redesign.md`
**Status:** PROPOSED. The owner locked the decisions below in a design session on 2026-11-18. Nothing here is built, and this change ships no code.
**Decision record:** [ADR-0114](../adr/ADR-0114-deterministic-visit-note-drafting.md) (Proposed).
**Vocabulary:** [`CONTEXT.md`](../../CONTEXT.md). Terms in **bold** below are defined there.
**Parent workflow:** [Workflow 04](./ChartWarden_Workflow_04_Visit_Encounter_Documentation.md), current state in [04-visit-encounter-current-state-audit.md](./04-visit-encounter-current-state-audit.md).
**Decision IDs:** `VN-D1`…`VN-D30`. The prefix keeps them apart from the M8 spec's own D1-D13, which code comments cite.

## 1. Problem

A competitor's headline feature is that the visit note writes itself. A nurse in a public hospice-documentation group said of FireNote: "it pulls everything from your assessment and Careplan and inputs it into your note." (LinkedIn thread, not retrievable by our research; the wording is unconfirmed against FireNote's own material.) Our visit note is thin by comparison: the clinician taps phrases and nothing from the patient's record reaches the note.

Evidence labels used in this document:

| Label | Meaning |
|---|---|
| **VERIFIED** | Read in code or a doc on `main` at `f3b8558c3`, by the author or by an independent review pass, on 2026-11-18 |
| **RECON** | Reported by a code-reading pass on 2026-11-18, not re-verified here; re-verify at slice start |
| **VENDOR** | A vendor's own claim, not independently confirmed |
| **INDEP** | An independent or primary source (CMS, MAC, peer-reviewed) |
| **DECIDED** | Owner decision, 2026-11-18 |

### 1.1 What our note does today

- **VERIFIED** The pure decision core of the visit seed carries ids only: patient, admission, encounter type, discipline, service date, author, visit (`apps/backend/src/modules/08-encounters/consumers/seed-visit-encounter.ts:93-103`). The live seed (`outbox-consumers/m17-visit-scheduled.ts`) also writes provider, location and visit-modality fields. No care-plan, **scale reading**, vitals, medication or prior-visit content reaches the draft.
- **VERIFIED** The phrase vocabulary is 23 entries at the time of writing (`packages/narrative-vocab/src/vocabulary.ts`).
- **VERIFIED** Eleven template sections have no phrase category (`allowedCategories`): `chief_concern`, `vitals_review`, `plan`, `family_dynamics`, `advance_directive`, `caregiver_overview`, `pps`, `esas`, `prognosis`, `recert_summary`, `idg_followup` (`packages/hearthnote/src/templates/registry.ts`). A section without one accepts any eligible entry. The RN routine visit template (`routine_visit`, discipline `rn`) carries three of them (`chief_concern`, `vitals_review`, `plan`); `pps`, `esas`, `prognosis` and `recert_summary` exist only in the recertification template, and `prognosis` also in the face-to-face template.
- **VERIFIED** The M8 spec (§2.6) promises that vitals and scale references are interpolated into the Layer 1 narrative; the code passes none. The M8 spec (§5.2) places a care-plan picker in the composer; today the picker lives on Encounter Read (`apps/web/src/modules/08-encounters/encounter-read.tsx`, `addCarePlanLink`), not the composer. The visit-documentation screen design (`docs/design/screens/clinical/CHARTWARDEN_UI_ENCOUNTER_VISIT_DOCUMENTATION.md`, Right Panel) promises "Latest assessment scores + trend"; no score trend exists.
- **VERIFIED** Layer 2 (LLM enhancement) is a deny-stub that returns the Layer 1 narrative unchanged (`packages/hearthnote/src/layer2/enhance.ts`).
- **VERIFIED** Gate checks 4 (HOPE items), 7 (Layer 2 decisions) and 9 (attestation confirmed) are `deferred` (`apps/backend/src/modules/08-encounters/gate/checks.ts`). Check 9's stated blocker ("nothing carries the clinician's confirmation") is stale: the sign body already requires `attestationConfirmed: true` (`AttestationSchema` in `routes/encounters-typebox.ts`), enforced by the route schema.
- **VERIFIED** The seams a draft needs exist, but they are now-reads: they return current state and accept no as-of instant (`CarePlanReader.relevantElementsForEncounter`, `LatestAssessmentProvider.latestBatch`, `MedicationOrderProvider.getActiveMedications`). **RECON** Also `ScaleSeriesProvider.series`/`delta`, `MedicationAdministrationProvider`, `PatientAllergyReader`. **VERIFIED** The events exist: `m17.visit.published`, `m9.assessment.recorded`, `m7.care_plan.version_signed`, `m11.order.signed`, `m13.administration.recorded`.
- **VERIFIED** Nothing in M8 or `packages/hearthnote` seeds admission selections from document extractions, although architecture §10.5 and its §11 row describe that as a feature.

### 1.2 What the market does

| Claim | Label | Source |
|---|---|---|
| FireNote: "you enter key observations from your visit, and we'll write your narrative"; the care plan is "the center of every patient encounter"; its documentation is "non-generative" (homepage text and meta) | VENDOR | https://firenote.health/ |
| FireNote: the clinician can review, edit, deselect or bypass generated content; the engine avoids "silent copy-forward" | VENDOR | https://firenote.health/clinical-solutions , https://firenote.health/compliance-solutions |
| FireNote: routine RN visit 8 min vs "up to 40", admission 40 min vs "up to 4 hr" | VENDOR | https://firenote.health/ |
| FireNote markets "Ember AI" (ambient charting, comparative charting, documentation integrity), rolling out "one tool at a time" (vendor wording; which tools are live is not stated) | VENDOR | https://firenote.health/ember |
| FireNote independent reviews: six, all five-star, 2022-23; no Reddit, G2 or KLAS coverage found | INDEP (weak) | https://softwarefinder.com/emr-software/firenote/reviews |
| Axxess: a "Generate Narrative" button in four RN assessments pulls demographics, diagnoses, vitals, scales and changes to problems, goals and interventions (not the full plan) | VENDOR (primary doc) | https://www.axxess.com/help/axxesshospice/axxess-intelligence/auto-generated-narrative-notes/ |
| Ambient scribe RCT, 238 physicians: Nabla -9.5% note time, DAX not significant | INDEP | https://pmc.ncbi.nlm.nih.gov/articles/PMC12768499/ |
| Ambient scribe trial: 58% of output accepted unmodified; 47% of staff reported seeing hallucinations | INDEP (staff-reported) | https://link.springer.com/article/10.1186/s12913-025-13954-5 |
| Template sprawl: 17% of 100,230 templates used by more than one person | INDEP | https://www.tandfonline.com/doi/full/10.1080/08998280.2024.2352993 |
| Certification narrative (physician): "Narratives must show the patient's individual clinical circumstances and not include check boxes or standard language used for all patients" | INDEP (CMS) | https://www.cms.gov/training-education/medicare-learning-networkr-mln/compliance/medicare-provider-compliance-tips/hospice-services |
| Top CGS hospice denial reason is "does not support a terminal prognosis": 53% of denied claims (1,061 claims) in one CGS quarter, page updated 2025-07-08 | INDEP (MAC) | https://www.cgsmedicare.com/hhh/medreview/HOS_DRC.html |
| Copy-forward may "facilitate attempts to inflate, duplicate, or create fraudulent" claims (OIG report of December 2013, quoted in an April 2014 law-firm article) | INDEP (secondary) | https://www.dwt.com/insights/2014/04/emerging-ehr-risks-when-documentation-may-not-be-e |

The Springer and tandfonline figures could not be re-fetched during review; treat them as unconfirmed until re-checked.

Reading (inference, not a finding): FireNote-style notes appear to be preferred because a deterministic narrative is built from structured input, with the care plan as the spine of the visit; nothing found suggests an LLM is the draw. Every FireNote time-saving figure above is vendor-claimed; we do not copy a number.

## 2. Decisions

All DECIDED, 2026-11-18. IDs are stable; later slices cite them.

### 2.1 Scope and bar

| ID | Decision |
|---|---|
| VN-D1 | This effort ends in this document and ADR-0114: a decision-complete spec and slice plan. It ships no code. |
| VN-D2 | The first note type is the RN routine visit. Every other discipline follows, in the order of §5. |
| VN-D3 | The bar: a clinician opens a visit and finds a **draft** already built from that visit's records, reviews it, and signs. It is measured by **time-to-sign**, not by longer notes. |
| VN-D4 | The draft is compiled deterministically from structured data. No LLM and no generated free text in v1. Layer 2 stays a stub; an AI slice comes later (VN-D9, §5). |

### 2.2 The draft

| ID | Decision |
|---|---|
| VN-D5 | Beyond the clinician's own selections, the draft pulls four sources, each shown with its origin and individually deselectable: (1) care-plan goals and interventions linked to the visit, auto-selected; (2) the latest **scale readings** with the change since the last visit; (3) vitals; (4) medication and order changes since the last visit. |
| VN-D6 | No text copy-forward. "Changes since last visit" is computed from structured data. Anything carried over needs per-item re-attestation. |
| VN-D7 | A **section** is the unit of **confirmation**. The clinician confirms, edits or deselects each drafted section. Signing is blocked until every drafted section is resolved. Each section's source ids are kept in the audit trail only; the signed text reads as the clinician's narrative with no inline labels. The word "block" is retired for this (it collides with the note-closure "blocked" state). |
| VN-D8 | Deselecting a care-plan goal or intervention means it is not linked to this visit, through the same links the signed event already carries. A note never changes the care plan. The audit trail records the deselection. |
| VN-D9 | A section with no source stays empty with a visible "nothing to draft from" state. It is never filled with a default phrase. In the later AI slice an AI suggestion may offer text for an empty section: clearly labelled, never auto-inserted, accepted per passage, behind the AI-governance gates. |
| VN-D10 | The draft is computed per author when the author opens the visit, so 42 CFR Part 2 redaction holds. A refresh shows "inputs changed since drafted" and never overwrites a section the clinician has touched. It is not computed once at seed time. |
| VN-D11 | The draft is computed as of the visit time: the care-plan version in effect then, readings recorded up to then, medications as of then. A late entry never describes today's patient state. The visit time is the end of the visit's service date in the organization's time zone, capped at now (§3.2), so a clinician documenting after checkout, or later that day, still gets the visit's own data. The current seams are now-reads, so this needs as-of variants (§4.1). |
| VN-D12 | A confirmation binds to the draft snapshot version, the phrase-corpus version and a hash of the section's rendered content. If a source or the corpus changed by sync or signing, the server returns that section as "needs re-confirmation" and signing stays blocked until it is re-confirmed. An offline confirmation is never silently accepted against newer data. |
| VN-D13 | A cosigner without Part 2 access sees source-derived sections redacted for them, never the author's unredacted text. |
| VN-D14 | The phrase corpus is platform-curated and versioned, approved by a named platform-side reviewer: ADA (named by the owner, 2026-11-18). No per-tenant or per-user phrase editing in v1. |

### 2.3 Slice 1, gates, rollout, measurement

| ID | Decision |
|---|---|
| VN-D15 | Slice 1 finishes what the M8 spec and the screen design already promised for the RN routine visit but the code never built: vitals and scale readings in the narrative (PPS and ESAS phrase slots), the care-plan picker in the composer (it lives on Encounter Read today), the latest scale readings with their trend in the composer's right panel, and phrase categories for the routine template's uncategorized sections (`chief_concern`, `vitals_review`, `plan`). Sections that exist only in other templates (`pps`, `esas`, `prognosis`, `recert_summary`, the admission and IDG sections) belong to the slice that owns that template. New capability comes after. |
| VN-D16 | Slice 1 makes gate check 9 (attestation acknowledged) real, not `deferred`: the sign body already requires `attestationConfirmed: true`, so the check is reclassified to the schema that enforces it and pinned by a test. It also adds a gate check that every drafted section is resolved (VN-D7). Check 4 (HOPE) stays with M10; check 7 (Layer 2) stays `deferred` until the AI slice. |
| VN-D17 | The draft and the new sign-gate sit behind a per-tenant switch, default off at merge because `main` auto-deploys. A tenant is switched on only after the phrase corpus has had its clinical review (VN-D14) and a minimum mobile build is out (VN-D19). |
| VN-D18 | Success is median **time-to-sign** per note type against a pre-ship baseline, from arrival (`encounter.clock_started_at`, ADR-0113) to signed; a note with no clock is measured from draft creation. The numeric target is set only after two weeks of baseline data. Guards that must not worsen: addendum rate and QA-return rate. The share of drafted sections confirmed unedited is reported as a rubber-stamp indicator. |

### 2.4 Mobile (repo `chartwarden-mobile`, separate from this monorepo)

| ID | Decision |
|---|---|
| VN-D19 | Mobile online parity comes first: draft sections, confirmation and online signing. A minimum mobile build (sends a contract-version header, supports per-section confirmation) is a precondition to switching any tenant on; the server answers an older build with a clear "update required" instead of a failed sign. |
| VN-D20 | The new draft and confirmation endpoints reach the app through the generated, pinned OpenAPI contract, not hand-written like encounters today. The mobile repo gets minimal CI (typecheck, vitest, generated-contract drift check; pull requests only) before the mobile slice merges. |
| VN-D21 | Offline v1: the clinician opens a pre-fetched visit, edits and confirms sections and dictates while offline; everything queues and syncs on reconnect. **Signing stays online-only**; TOTP step-up is not weakened. |
| VN-D22 | Offline draft source: while online the server builds a per-author draft snapshot (Part 2 redaction applied then) and the app pre-fetches it for the day's visits. A pinned, version-stamped copy of the pure assembler (`hearthnote`, `narrative-vocab`) runs on the device so selection edits re-render offline. The server stays authoritative at sync. |
| VN-D23 | Offline unlock: biometric or PIN with a device-bound key, for a tenant-set window after the last online check (default 24 hours, hard cap 72), covering only pre-fetched visits, fetching no new PHI, revoked by the server on the next contact. |
| VN-D24 | Cached snapshots are encrypted per user, org and patient. Unsynced clinical writing is never silently discarded: logout keeps it encrypted and locked until the same user signs back in. Synced content is purged on logout, role or org change, and expiry. |
| VN-D25 | Dictation v1 is on-device speech-to-text only, into a section's free text as an unsent draft the clinician reviews. No audio is kept and nothing leaves the device before review. A spike first confirms on-device recognition on the supported iOS and Android versions. Server-side or ambient dictation stays a later decision needing an ADR that supersedes ADR-0094 for native. |
| VN-D26 | Mobile slice order: online parity, then on-device dictation, then offline authoring. Offline is gated on the EVV offline device QA passing, its backend route being proven deployed (§4.3), and the security owner's sign-off on ADR-0072 decisions 8-12. |

### 2.5 Signed notes, and where the decisions live

| ID | Decision |
|---|---|
| VN-D30 | A signed visit note stays modifiable only through an **amendment** on the existing addendum path. The signed text is preserved and never overwritten in place. Each amendment is attributed, dated, step-up authenticated and re-confirmed per changed section, and it re-triggers cosign when the author needed one. |
| VN-D27 | One workflow-redesign doc (this) plus one ADR. ADR-0114 records VN-D4, VN-D6, VN-D7 (with the binding clause of VN-D12) and VN-D30 as its Decisions 1-4. It follows ADR-0113 (the note-closure clock) in the contiguous numbering the ADR gate requires. |
| VN-D28 | The FireNote, WellSky/Axxess and DocLens claims in the architecture, M8 spec and M32 spec that the corpus check found wrong or unsupported are corrected in this change (§7). |
| VN-D29 | The vocabulary lives in `CONTEXT.md`. |

## 3. How a draft works

1. The visit is published (`m17.visit.published`) and seeds an encounter as today.
2. The author opens it. The server builds the draft for that author, as of the visit time (VN-D10, VN-D11): linked care-plan goals and interventions, scale readings with deltas, vitals, medication and order changes (VN-D5), each section carrying its source ids.
3. A section with no source renders as empty with a visible state (VN-D9). The clinician's own selections work as they do today.
4. The clinician resolves every drafted section: confirm, edit or deselect (VN-D7, VN-D8). Each confirmation binds to the snapshot version, corpus version and content hash (VN-D12).
5. Sign: step-up (existing, online), attestation acknowledged (check 9), every drafted section resolved (new check). A stale confirmation returns that section for re-confirmation.
6. Source ids stay in the audit trail only (VN-D7). After signing, the note changes only by amendment (VN-D30).

### 3.1 Frozen text, per-viewer view and amendments (S1 step 0 design)

PROPOSED within the decisions above; no decision changes. The M8 spec makes a signed encounter immutable with changes through addenda (M8 spec D2); VN-D30 extends that addendum path to carry section-level amendments.

- **Frozen text.** `hearthnote_assembled_outputs.final_cipher` stays the legal text of a signed note. At sign, S1 also writes one sealed row per section (`hearthnote_signed_sections`): section id, position, sealed rendered text, a SHA-256 of the canonical text, a `part2_derived` flag and the source ids. The ordered rows must equal `final_cipher`; a test pins that invariant.
- **Per-viewer view (VN-D13).** A viewer with Part 2 disclosure, or a note with no `part2_derived` section, gets `final_cipher`. Any other viewer gets the section rows with each `part2_derived` section replaced by a withheld marker. A section is `part2_derived` unless every source behind it is proven not SUD-related, failing closed as `redactStateSnapshot` does in M7. A clinician's own free text is not classified.
- **Amendment (VN-D30).** An addendum (its own draft, finalized, signed lifecycle; the parent stays signed) that names the sections it amends. Its section rows reference the amended section, so the current view shows the latest signed text per section and the history shows every version. Original rows are never updated. Each amended section is confirmed like a drafted one (VN-D12), signing needs step-up, and a cosign request is created for the addendum when the parent needed cosign.
- **As-of inputs (VN-D11).** Care plan: the `care_plan_version` in effect at the visit time (`signed_at` at or before it, `superseded_at` null or after it), read from its frozen `state_snapshot` with the existing per-viewer Part 2 redaction. Scale readings: the existing `ScaleSeriesProvider.series(from, to)` with `to` set to the visit time, so no new M9 seam. Medications: a new changes-between and active-as-of read on `MedicationOrderProvider`.
- **Open until built:** the exact `amends_section_id` shape, the addendum cosign link, and how M22 renders amended sections.

### 3.2 Backend design for PR C (S1)

PROPOSED within the decisions above; no decision changes.

- **No stored draft.** The draft is recomputed from the sources on every read, for the reading author, as of the visit time. Nothing PHI-derived is cached, so Part 2 redaction is applied per request (VN-D10). The section's content hash (which covers its text and source ids) plays the part of the draft snapshot version in VN-D12; a stored per-author snapshot arrives with the offline slice (VN-D22).
- **Visit time (`asOf`).** The earlier of now and the last millisecond of the encounter's service date in the organization's time zone. `started_at` and `clock_started_at` do not matter: a note written after checkout, or later that day, still gets the visit's own vitals, scores and medication changes, while one written days late does not pull in the days since, and a service date still in progress is capped at now.
- **Resolution.** A drafted section is resolved by `confirmed` (bound to the content hash the clinician saw, which the request carries) or `deselected` (the drafted sentences stay out of the note; the clinician's own selections and free text stay). "Edit" is the existing selection and free-text save, which changes the hash; the clinician then confirms. A confirmation that no longer matches the recomputed hash, or whose corpus version is not current, reads as `needs re-confirmation` and blocks signing; this holds for `deselected` too. `edited` is recorded as whether the section carried the clinician's own text at confirmation (the rubber-stamp indicator, VN-D18).
- **Care-plan items.** The draft shows the elements `relevantElementsAsOf` returns, minus any with a removed link on this encounter. Confirming a section writes live `encounter_care_plan_link` rows for its care-plan source ids (idempotent). Deselecting one element soft-removes its link, or inserts an already-removed row when it was never linked, so a re-open does not bring it back. A note never changes the care plan (VN-D8). The deselect unit is the section, and for care-plan elements the link; scale readings, vitals and medication changes are deselected with their section.
  - **The deselect-hash trap, resolved (PR C2b1).** Removing a section's care-plan elements changes the section, so the hash the clinician saw is not the hash a later read computes. A `deselected` row bound to the hash SEEN would read `needs_reconfirmation` the moment the draft was reopened, and a deselected section could never stay deselected. So the deselect writes the link changes first, recomputes the draft for the same viewer inside the same transaction (the store port `removedCarePlanElementIds` reads the transaction's own writes), and binds the `deselected` row to the hash of the section AS RECOMPUTED. What remains in the section (the medication changes or other sentences of a mixed section such as `interventions`) is deselected with it. A section that is empty after the removal (a care-plan-only section such as `plan`) needs no row and reads `not_drafted`. The explicit audit event carries both hashes (`contentHash` seen, `boundContentHash` kept, null when no row was kept), so the trail shows what was seen and what the row covers.
  - **Retry.** A deselect that removed elements changed the section, so a retry carries the old hash. It is a no-op success while the section is already `deselected` and current (a mixed section), and `409 DRAFT_SECTION_STALE` when the removal left the section empty (nothing is drafted to match against); the client refetches and reads `not_drafted`.
  - An element is "removed" for the draft only while it has a removed link and no live one, so linking it again through the picker brings it back.
- **Gate.** A new check `draft_sections_resolved` (the 13th id in the register) runs when the tenant switch is on and the template has a drafted section. Unresolved sections give `DRAFT_SECTION_UNRESOLVED`; stale ones give `DRAFT_SECTION_STALE`. A draft that cannot be computed is `COMPLIANCE_GATE_UNAVAILABLE`, never a pass.
- **Sign.** The draft is recomputed for the signer and each confirmed section's hash must equal the stored one, else 409 `DRAFT_SECTION_STALE` naming the sections. The assembled narrative uses the confirmed draft text for `confirmed` sections and the clinician's selections only for `deselected` and undrafted sections. At sign one sealed `hearthnote_signed_sections` row per section is written in the same transaction as `final_cipher`, and the ordered rows must equal it (PR E adds the per-viewer view and amendments on top).
- **Tenant switch.** One row per organization, default off, written by a holder of a new permission with step-up, mirroring the ADR-0113 policy service. Enabling is refused while `CORPUS_CLINICAL_REVIEW.status` is not `approved`. A tenant with the switch off sees today's behaviour exactly, and every new route answers 404 for it.
- **Part 2.** Medication orders carry `isSudTreatment` unredacted from the M12 seam (PR A), so M8 drops SUD orders for an author without disclosure, using the same disclosure check the care-plan reader applies, and marks the rest `sudRelated` so a section's `part2Derived` fails closed.
- **Sealed rows** are encrypted with the same key path as `final_cipher`. **Source ids** reach the audit trail through the confirmation row's audit trigger and never the signed text.

#### Input rules (PR C2a, `08-encounters/drafting/inputs.ts`)

- **Care plan.** `relevantElementsAsOf(patient, type, discipline, admission, viewer, asOf)` with the session identity as the audience, so M7 redacts per viewer. Goals and interventions whose link was removed for this encounter (`removedCarePlanElementIds`, supplied by the store) are left out. A `null` plan is `carePlan: null`. A plan of another patient is refused. A goal or intervention takes its parent problem's SUD flag; a parent the reader did not return leaves the flag unset, which reads as Part 2. Encounter disciplines `md`/`np` map to `md_np` and `slp` to `st`.
- **Previous visit.** The patient's most recent SIGNED visit-type encounter on an earlier service date, supplied by the store port `previousSignedVisitAt` as that encounter's own visit time (`visitAsOf` of its service date, same zone and now), so the picture at the previous visit plus the changes since is exactly the picture now. One later than this visit time is refused.
- **Scale readings.** For `pps` and `esas_r`: the latest reading captured at or before `asOf` (`series` with `to = asOf`, cut again in code), `previous` the latest at or before the previous visit time, else null; no previous visit means `previous` is null. A latest reading without a score is not drafted and an older one does not stand in. The M9 series carries one score per ESAS-r capture, so it is drafted as the `total`. Dates are org-local.
- **Vitals.** The encounter's own latest row captured at or before `asOf`; no merging across rows. Vitals and PPS/ESAS-r readings carry `sudRelated: false` (M9 redacts only AIMS taken in a SUD context).
- **Medication changes.** `getMedicationChangesBetween(patient, previousVisitAt, asOf)`. With no previous signed visit there is no window and none are drafted (an honest empty section, VN-D9). A completed course is drafted as discontinued (the corpus has no "completed" phrase). A change's source id is `<orderId>:<kind>`, because one order can start and stop inside a window.
- **Part 2.** An order with `isSudTreatment !== false` (fail closed) is dropped unless the viewer has Part 2 disclosure; kept orders carry `sudRelated = (isSudTreatment !== false)`. The verdict is M7's per-actor decision (`sudDisclosureAllowedForActor`: M39 `evaluateForInternalAccess`, then the RN case manager carve-out where no release names others) and is asked only when an order could be withheld.
- **Failure.** A seam that throws, or returns something unusable (an instant that is not one, another patient's plan), is `DRAFT_UNAVAILABLE` (503), never a partial draft. The message names the read; the upstream cause stays on the error for the log.
- **Visit time.** `visitAsOf({ serviceDate, orgTimeZone, now })` is the earlier of `now` and the last millisecond of the service date in the organization's zone (DST-safe).

#### Store and routes (PR C2b1, `08-encounters/drafting/`, `08-encounters/routes/draft-section-routes.ts`)

- **Store ports** (`db-draft-store.ts`, one `withOrgContext` transaction per request, so RLS scopes every statement). `organizationTimeZone` is `organizationTimezone`. `previousSignedVisitAt` is the patient's most recent encounter with status `signed`, `cosign_pending` or `cosigned` on a strictly earlier service date (a later-signed one wins a tie on the date; a draft, a voided, a later, a same-day and another patient's encounter do not count), returned as that encounter's own `visitAsOf`. All seventeen encounter types are visit types (`packages/types/src/encounter.ts`), so every type counts. `latestVitals` is the encounter's own `vitals` row with the latest `captured_at` at or before the visit time (ties by `created_at`, then id), never merged; a temperature needs a unit of `f` or `c`, and a pain score counts only on the `nrs_0_10` scale (one on another scale, or with no scale, is not drafted). `removedCarePlanElementIds` reads `encounter_care_plan_link` (see "Care-plan items"). `loadSelection` is what the Layer-1 assembly reads: the stored tree with its prose opened through the tenant free-text cipher (the shared reader is `selection-tree.ts`), the patient slot `Patient` and the service date. Sealed prose with no cipher bound is refused (`DRAFT_UNAVAILABLE`), never drafted without the clinician's own text.
- **`GET /api/v1/encounters/:encounterId/draft`** (`encounter.read`, caseload scope). The draft for the SESSION viewer (roles and active membership from the server-assembled session, never the request), every template section with `state`, `text`, `contentHash`, `corpusVersion`, `part2Derived` and `origins`. VN-D7: source ids are NOT on the wire (the ids stay in the audit trail); `origins` carries only the kinds, which is what VN-D5's "shown with its origin" needs. The text is what the seams returned for this viewer (M7 and M12 redact per viewer), so no section is withheld a second time here; `part2Derived` is the compiler's fail-closed flag, for the signed-note view of PR E. A state is read against the VIEWER's recomputed draft, so a viewer whose redaction differs from the author's sees the author's confirmation as `needs_reconfirmation`. Read-audited as `encounter_draft.viewed` (`resourceIdParam` is the encounter; the patient is attributed from the response; field names only).
- **`PUT /api/v1/encounters/:encounterId/draft/sections/:sectionId`**, body `{ resolution: confirmed | deselected, contentHash, corpusVersion }` (one idempotent route for both resolutions). Same permission and ABAC as the selections save (`encounter.author`, `encounter.scope`, `is_author_or_supervisor`), without `If-Match` (the section hash is the lock) and with the AI-principal refusal. The encounter row is locked `FOR UPDATE`, so confirmations of one encounter, and a selection save (which bumps the same row), run one after the other. Allowed on any encounter that is not signed, cosigned or voided (the selections save's own rule, `checkMutableForEdit`): a `finalized` note can still be re-confirmed, since it can only go on to `sign`, which refuses a stale confirmation. `edited` is recorded as whether the stored selection tree holds the clinician's own text for the section (an entry, or the `hasFreeText` marker), read without opening the prose. Every write records `m8.encounter.draft_section_resolved` beside the confirmation row's trigger record; an idempotent repeat writes neither.
- **Per-tenant switch.** Both routes answer `404 NOT_FOUND` when `isVisitNoteDraftEnabled` is false, read inside the request's transaction before the encounter or any source (no cache), with the same body an absent encounter gets.
- **Errors.** `409 DRAFT_SECTION_STALE` (new, `M8_ERROR_STATUS`), `503 DRAFT_UNAVAILABLE`, `422 UNKNOWN_TEMPLATE_SECTION`, `409 IMMUTABLE_AFTER_SIGN`.

## 4. Constraints found

### 4.1 Backend and tenancy

- M8 reaches other modules by seam only (ADR-0007, ADR-0043). RECON: the M9 store throws outside a request context, so any worker-time computation needs org-explicit `...ForOrg` seams, as M14 does (`14-idg/jobs/packet-build.ts`). The per-author draft is computed in a request, which avoids that.
- VN-D11 needs as-of reads (§3.1): the care plan from the frozen version in effect at an instant (M7), medication orders as of an instant (M12, a new method), and scale readings through the existing `series(from, to)` (M9, no new seam). The other current seams return the present state.
- RECON: `CarePlanReader` already redacts Part 2 per actor. The draft inherits that and must never cache an unredacted result across authors.
- AI is blocked platform-wide (`ai.full` off, M32 inference seams are deny-stubs). A deterministic draft is not AI and does not meet that gate. The later AI slice is a separate decision.
- New tables follow the repo rules: three-column tenancy, RLS enabled and FORCEd, PHI audit triggers, `-- compat: expand`, manifest `ownedTables` (`.ts` and `.cjs`).

### 4.2 Compliance

- A new sign-blocking gate and any offline vault are security controls. Each needs its row in `compliance/controls.yaml` in the same change as the build, and `controls.yaml` edits need the owner's approval.
- Source ids per section go to the M4 audit trail; the read of a drafted section needs a read-audit config with a `resourceIdParam`.

### 4.3 Mobile

RECON, from `chartwarden-mobile` `main` at `77f450d` (2026-11-06):

- Expo SDK 57, React Native 0.86. The composer renders the server-built `layer1Preview`; it imports nothing from this monorepo. Contracts for several modules are generated from a pinned OpenAPI commit; encounters, EVV and orders are hand-written. The client sends no contract-version header, although ADR-0072 says it should.
- No offline clinical cache exists. The only persistent store is the EVV outbox (SQLCipher), behind a flag that defaults off, with its device QA matrix not yet run and its backend route not confirmed deployed.
- Encounter, signature, order and clinical-document mutations are explicitly not queued. Unsaved note text is memory-only, and the app cannot cold-start offline.
- No dictation exists and the microphone permission is off. ADR-0094 (Proposed) rejects browser speech and says a native app must extend or supersede it.
- The repo has no CI.
- ADR-0072 makes the mobile app a separate React Native/Expo repo and supersedes ADR-0035; the owner ratified that supersession on 2026-11-18. The security owner's sign-off on its decisions 8-12 as controls (push, SQLCipher store, app lock) and its device-evidence items are still unsigned, and the offline slice (M3) depends on them. ADR-0072 names the repo `wardenx-mobile`; the repo is now `chartwarden-mobile`.

## 5. Slice plan

Two tracks. Each slice is its own PR; pushes are batched (Actions minutes are metered).

| Slice | Track | Scope | Depends on | Exit |
|---|---|---|---|---|
| S1 | Docs | RN routine visit: draft from the four sources, per-section confirmation, the two gates, composer picker and trend, phrase slots and categories (VN-D15), amendments of signed drafted notes (VN-D30), per-tenant switch default off, as-of seam variants | VN-D1 to VN-D18, VN-D30; ADR-0114 | Live suite proves the draft per author, as of visit time, Part 2 redaction, stale-confirmation rejection, sign blocked until resolved, amendment preserving the signed text; baseline metric collecting |
| M1 | Mobile | Online parity: draft sections, confirmation, online signing, contract-version header, minimum build, generated contract, minimal CI | S1 contract | An old build gets "update required"; a current build signs a drafted note |
| S2 | Docs | RN admission, recertification and F2F narrative (the `pps`, `esas`, `prognosis` and `recert_summary` sections; decline and prognosis evidence, the top CGS denial reason) | S1 | Recert narrative draft ties F2F findings to the prognosis |
| M2 | Mobile | On-device dictation into a section's free text, after its spike | M1 | Spike report; no audio retained; transcript is an unsent draft |
| S3 | Docs | Aide and LPN notes, with cosign | S1 | Care-plan interventions drafted; cosigner sees per-viewer redaction (VN-D13) |
| S4 | Docs | Social work and chaplain notes | M15 goal link built | Discipline goals draft into the note |
| S5 | Docs | MD/NP notes and the IDG "no-prep" note (recent care-plan changes and coordination notes) | S1 | IDG packet imports changes since the last meeting |
| M3 | Mobile | Offline authoring: snapshot, vendored assembler, queue, unlock window, vault | M1, EVV offline device QA passed, its backend route proven deployed, security-owner sign-off on ADR-0072 decisions 8-12 | Device QA on the offline note path; unsynced writing survives logout |
| A1 | Later | AI suggestions for empty sections (VN-D9), behind AI governance | S1; M32 inference built; its own ADR | Not specified here |

## 6. Not yet specified

- **Amendment details** on the M8 addendum state machine (VN-D30), beyond the design in §3.1: the audit trail, whether an amendment restarts the cosign window, and billing impact. Settled before PR E.
- **The exact section list for S1.** The RN routine visit is `routine_visit` with discipline `rn` (sections `chief_concern`, `vitals_review`, `assessment`, `symptom_management`, `interventions`, `plan`); confirm against `packages/hearthnote/src/templates/registry.ts` at S1 start.
- **AI-content labelling.** The AI governance document says AI content is visibly labelled in the record and also that provenance is audit-only (two passages, RECON). The AI slice (A1) must resolve that conflict; VN-D7 settles it only for deterministic sections.
- **Per-discipline designs** for S3-S5, including which discipline-assessment goals link to the note.
- **The HOPE gate check** (check 4): needs an encounter-to-HOPE-timepoint correspondence M8 does not carry; owned by M10 work.
- **Server-side or ambient dictation:** an ADR superseding ADR-0094 for native, after a BAA path exists.
- **`controls.yaml` rows** for the sign gate, the offline vault, the unlock window and the version header. Drafted with each build, applied only with the owner's approval.
- **Performance budget** for computing a draft on open.
- **The numeric time-to-sign target** (VN-D18), set after two weeks of baseline.

## 7. Corrections made in this change

Checked against the corpus on 2026-11-18, then corrected in place (the M8 spec changelog and the architecture Document Control carry a dated entry):

1. Architecture §10.5 (trademark note), M8 spec §1.4 and M32 spec said FireNote runs no LLM, is "explicitly anti-LLM", or "explicitly does not offer" an enhancement layer. FireNote now markets AI tools ("Ember AI", rolling out one tool at a time; VENDOR, https://firenote.health/ember). The spec bullets now say so and attribute FireNote's "non-generative" description to its homepage.
2. M8 spec §1.4 said WellSky and Axxess "have added generative-AI assistants for visit notes". WellSky documents an ambient scribe for home health and Axxess announced an ambient agent with hospice availability unconfirmed; both are now stated as vendor-claimed.
3. Architecture §11 row (HearthNote integration) and the §10.5 DocLens flow described admission selections being seeded from extractions as a feature. Nothing in M8 or `packages/hearthnote` does this. Both are now marked "design target, not built as of 2026-11-18" and point here.

## 8. Verification at slice start

Re-verify every RECON line before building on it, and cite the commit. The research behind §1.2 is mostly VENDOR; before quoting a figure externally, confirm it against the vendor or a customer.
