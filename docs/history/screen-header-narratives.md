# Screen-header narratives moved out of source (CW-CLIN-009)

Historical narrative that used to sit in the `screens.ts` headers of the M8, M9 and M12 web modules. The headers now
describe current behavior and active constraints only; this is the record of how each gap was found. Quoted verbatim
(comment markers stripped), so statements such as "has no caller" or "DISCARDS it" were true when written and are
NOT true now.

## M8 encounters (`apps/web/src/modules/08-encounters/screens.ts`)

Status now: the composer, the new-encounter control and care-plan links are all built; `POST/GET/DELETE
.../care-plan-links` persist (F-064, `authoring/care-plan-link.ts`; DELETE is a soft invalidate) and the web client calls
them from `encounter-read.tsx`. Addenda authoring is built (GAP-027).

```text
#91 / F-063 — THE NOTE CAN NOW BE AUTHORED. `encounter-compose.tsx` is the §2.6 tap-to-document
surface: the template's sections, the vocabulary each accepts, per-entry `${slot}` params, verbatim
per-section free text, vitals capture, save (§7.7 `If-Match`) and finalize. This header used to say
the authoring surfaces would "fill in as their write paths harden" — `PATCH .../selections` had been
mounted since M8-T09 and persisting since #114. What was missing is the MENU: the route carries
`sectionId`/`code` as free strings and rejects an unknown one, and the template registry + vocabulary
corpus (`@chartwarden/hearthnote`, `@chartwarden/narrative-vocab`, both since M8-T05) were on nobody's wire.
`GET .../template` is that menu, served rather than shipped so the client cannot hold a second,
divergent copy of the rules `assembleSelections` enforces.

…AND IT CAN NOW BE STARTED (F-083). The paragraph above was written from inside the composer, which is
where the gap hid: `createDraft` has been exported from `encounters-api.ts` since that change with NO
CALLER, and no screen offered a control that produced an encounter. Everything downstream of an
encounter id worked and nothing produced one — every encounter in the product came from a seed script.
`new-encounter-modal.tsx` is that control, on the patient encounters list.

STILL DEFERRED, each for a reason:
  • Layer-2 (`hearthnote/enhance` + the modification decisions) — the §2.6 D5 AI ladder is its own
    ceremony with its own governance surface, not part of authoring the deterministic note.
  • Care-plan links — `POST .../care-plan-links` parses a body, DISCARDS it, persists nothing and
    returns the ENCOUNTER's id as `linkId`; `DELETE` is a documented no-op. A control over that would
    report a link that does not exist (the F-007 rule). Filed separately.
  • (Addenda authoring is NOT deferred any more — GAP-027: the encounter detail screen's addenda panel
    edits, finalizes and signs an addendum; see addendum-panel.tsx.)
```

## M9 assessments (`apps/web/src/modules/09-assessments/screens.ts`)

```text

#91 / F-067 — SCALES CAN BE RECORDED NOW, and a detected change can be acknowledged. Both were
blocked on the server rather than on the write routes:

  • The INSTRUMENT DEFINITION was on nobody's wire. `POST .../assessments` publishes `data` as a bare
    object, and which items a scale needs — how many, what kind, what range, which option values —
    existed only as TypeScript interfaces in `@chartwarden/assessments`, which a client cannot read.
    `SCALE_CATALOG`'s own header calls itself "the single source the record-modal scale picker (T07)
    ... read"; there was no record modal. `GET /api/v1/scales` is that definition, and
    `record-assessment-modal.tsx` is a RENDERER for it — nothing about PPS's five axes or ESAS-r's
    nine items is written in this module. A new scale's form appears when its module lands.
  • TEN OF THE FOURTEEN SCALES CANNOT BE CAPTURED. `scoring.ts` registers four scorers and raises
    `SCALE_SCORER_UNAVAILABLE` — a **500** — for the rest, all of which are in the route's own
    `scaleType` enum. `hasScorer` is documented as "the form-gating ... check" and nothing gated on
    it. The picker offers `recordable` scales only, which is the server's answer, not a list copied
    here.
  • `admissionId` had no patient-scoped lookup until F-065 (see #161). With no open admission the
    Record control is absent rather than present-and-certain-to-fail.

F-076 (#91 AC5) — `e2e/specs/assessments.spec.ts` drives the primary path in a real browser: capture a
PPS, let the SERVER score it, and watch the decline it causes reach the significant-change queue and be
acknowledged. Writing it found that the third step could never happen. `detectSignificantChanges` has
been pure, complete and unit-tested since M9-T08 — its own header describes "the pure evaluators THE
RECORDING TRANSACTION runs after scoring" — and NOTHING called it. No code path inserted a
`significant_change_event`: four consumers read that table (the worklist, the seam store, the escalation
cron and the eraser) and none wrote to it. So the queue was empty for every patient in every tenant, the
Acknowledge action added just above could never be pressed, the escalation cron had nothing to escalate,
and the catalogued `m9.assessment.significant_change` was never emitted. Same shape as
`hope_submission_item` (#150) and the F-029 step-up routes: a finished core with no caller, which every
unit test passes. The producer now runs inside the write transaction (§9.6), and
`m9-assessments-write.live.test.ts` pins both an absolute rule and a windowed drop against real rows.

```

## M12 DoseSpot (`apps/web/src/modules/12-dosespot/screens.ts`)

Status now: the ordering-physician control is the M40 directory lookup, not free text; the server rejects an
unknown, deactivated or provisional physician id at draft creation (CW-CLIN-008). The last paragraph of the quote
below ("KNOWN, NOT FIXED HERE") is therefore resolved.

```text
#91 / F-065 — PRESCRIBING WORKS NOW. The prescribe modal (drug identity from M38's RxNorm search and
the concept's own published NDCs, never typed), the §2.2 lifecycle ceremonies (request-signature,
sign, cosign, discontinue, complete), the §2.3 verbal order, and the §2.7 refill approve/deny are all
built and DOM-covered (`medication-writes.dom.test.tsx`).

Two things had to be true on the server first, and only one of them was:
  • The lifecycle had to REACH a state the eMAR can administer against. Until #136 `signed` had one
    exit — through a DoseSpot transmission worker that does not exist — so every signed order was
    frozen: never completable, never discontinuable, never `active`.
  • `POST /medication-orders` requires `admissionId`, and NOTHING could resolve one for a patient. The
    org-wide census takes no patient filter and its items carry no `patientId`; the patient read
    carries no admission. This change adds `GET /api/v1/patients/:patientId/admissions` (F-065) —
    the read M07 declined to build a create without, and the one M24's claim wizard works around by
    asking a clerk to type the uuid.

F-075 (#91 AC5) — `e2e/specs/prescribing.spec.ts` drives the primary path in a real browser: search
M38 for the drug, resolve its NDC, create the draft, send it for signature, sign it, and assert the
order reaches the patient's ACTIVE list — the state M13's eMAR administers against. Writing it found
that "PRESCRIBING WORKS NOW" was not true on any seeded stack, for a reason outside M12: `code_system`,
`code_system_version` and `concept_rxnorm` were EMPTY, because those tables say "writes only via
`terminology_loader`" — an external loader that is not in this repository — and no seed wrote a row.
The drug search returned nothing, so no concept could be selected, so no NDC could be resolved, so the
modal's submit stayed disabled. `scripts/db/seed-terminology.ts` (new, in `db:seed:all`) seeds the
hospice comfort-kit concepts, including the morphine RxCUI the scenario seed already hard-codes.

The screen was HONEST about it the whole time ("If this deployment's terminology has not been
loaded…"), which is exactly why it went unnoticed: the failure read as a deployment fact rather than a
missing seed. Verified in both directions — the spec fails with the concepts deleted and passes with
them present.

KNOWN, NOT FIXED HERE: "Ordering physician (MDM id)" is a free-text control asking a prescriber to
type a UUID — the exact pattern this header rejects two paragraphs up for RxCUI and NDC, and the one
CLAUDE.md records M24's claim wizard working around by asking a clerk to type it. M40 holds the
directory read a picker would bind to.

```
