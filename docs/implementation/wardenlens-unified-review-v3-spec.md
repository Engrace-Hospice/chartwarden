# WardenLens Unified Review V3

Status: V3.2 unified inline review workspace

## Purpose

WardenLens Unified Review presents the existing M22 extraction review as a patient-centered,
exception-first workflow. It changes how observations are projected and navigated; it does not change
candidate decisions, clinical writeback, review ownership, authorization, or completion semantics.

The approved desktop and mobile mockups are design direction. The server remains authoritative for
clinical review completion.

## Current-state audit

The implementation already has the safety primitives V3 needs:

- `apps/web/src/modules/22-documents/doclens-api.ts` derives its `Workspace`, `Candidate`, and write
  shapes from the generated OpenAPI client. V3 reuses that contract without a parallel DTO.
- `apps/web/src/modules/22-documents/doclens-model.ts` contains the existing display labels and mirrors
  server eligibility rules. V3 imports those labels rather than creating a second clinical vocabulary.
- `apps/web/src/modules/22-documents/doclens-review-workspace.tsx` is the authoritative detailed
  reviewer. It requires a candidate-specific source-view confirmation before a decision and retains
  the existing accept/edit/reject, vision-reason, identity, Part 2, and completion interactions.
- `apps/backend/src/modules/22-documents/extraction/review-workspace.ts` returns stable candidate IDs,
  page and bounding-box provenance, document segments, risk, confidence, vision state, coding checks,
  SUD/redaction state, review ownership, and candidate decisions. It redacts Part 2 values before the
  response when the viewer lacks access.
- `apps/backend/src/modules/22-documents/documents-route-service-db.ts` remains the authority for
  candidate ownership, patient-identity exclusion, decision rules, and completion.
- The page image endpoint renders a source page through the tenant-scoped M22 route. The workspace
  payload does not report image availability; that condition can only be known after an authorized
  image request.

No backend, OpenAPI, database, permission, RLS, or M6 referral-state change is required for V3.2.

## Target information architecture

The entry route displays six stable sections:

1. Patient identity and demographics
2. Diagnoses and clinical history
3. Medications and allergies
4. Care needs and functional status
5. Coverage and referral information
6. Documents and safeguards

Each section summarizes original candidates; it is not a new clinical aggregate. Unknown paths remain
visible in an `Other / unmapped` category under Documents and safeguards. Empty sections remain visible
so the information architecture does not change with extraction output.

Desktop uses three coordinated columns: consolidated clinical information, the active source-and-decision
task, and grouped review priorities. Mobile retains the same workflow in one column, with priorities and
the active task before the longer clinical summary. The detailed reviewer remains available as an
advanced fallback, not the ordinary decision path.

## Projection algorithm

`projectUnifiedReview(workspace, runtime)` is deterministic and side-effect free:

1. Map every candidate to one of the six sections using its canonical field path.
2. Derive a conservative semantic key.
   - Scalar patient fields group by exact canonical field path.
   - Phone values compare after removing display punctuation and an optional North American `1`
     prefix.
   - Other scalar values compare after Unicode normalization, trimming, case folding, and whitespace
     folding only.
   - Medication, allergy, and diagnosis list observations group only when both the canonical path and
     the complete normalized value match. A different strength, dose, route, frequency, reaction,
     diagnosis wording, or code therefore remains a separate group.
   - Unsupported paths retain their exact path (including list index) and cannot be accidentally merged
     by a similar display label.
3. Sort candidate IDs inside each group. The presentation ID is derived from section, semantic key, and
   those IDs, never from array position or display order.
4. Retain each original `Candidate` object and expose its ID explicitly. No observation is discarded and
   no decision is copied to another candidate.
5. Derive group state from candidate decisions: all decided, partially decided, or undecided. A mixed
   group never inherits the decided candidate's state.
6. Resolve source labels from page-to-document ranges while retaining the candidate's own page, bounding
   box, document type, and job ID.

The projection is recomputed from the latest workspace response. It never mutates response objects.

## Conflict and exception algorithm

Demographic candidates sharing a field are a conflict only when their conservatively normalized values
differ. Clinically indexed lists are not declared equivalent from a shared label or medication name.
They remain independent high-risk review tasks unless the complete value is equivalent.

Exceptions are sorted by a fixed priority, then section order, then stable ID:

1. Unavailable/forbidden source evidence, unresolved patient identity, unresolved Part 2, or redacted
   evidence.
2. Review ownership held by another reviewer, wrong-patient exclusions, demographic conflicts,
   vision disagreements, and undecided high-risk observations.
3. Low-confidence observations, failed extraction jobs, and other undecided candidates.

An exception is never removed because its section appears reviewed. Source-image failures are supplied
to the pure projection as runtime page state. A workspace read or image error never counts as source
inspection.

`projectExceptionSummary(exceptions)` then consolidates presentation without changing the underlying
exception projection. Stable tasks are keyed by candidate ID, document page, or safeguard identity. One
candidate can therefore show conflict, vision, high-risk, and confidence reasons as one task while every
reason remains present in its `reasons` collection. The six fixed categories report task, underlying
requirement, actionable, and blocked counts separately. No count is inferred from the number of visible
rows.

## Review progress

V3 reports two distinct facts:

- candidate decision progress: original candidates with decisions divided by original candidates;
- section summaries: derived display state for navigation.

It does not call a section complete because it was opened, does not use grouped-card counts for progress,
and does not claim that all server completion requirements are satisfied. Identity, Part 2, source
availability, ownership, and document-only review remain separate safeguards. The existing detailed
reviewer and backend completion operation remain authoritative.

## Component hierarchy and interaction contracts

- `UnifiedReviewWorkspace` loads the existing workspace, owns the coordinated clinical/task/priority
  selection, refreshes server state after writes, and offers the next undecided candidate.
- `ReviewSectionList` renders six keyboard-operable disclosure controls and section status summaries.
- `ReviewExceptionPanel` renders six collapsible categories. Selecting a candidate task opens that
  candidate inline; selecting identity or Part 2 opens the safeguard task.
- `ReviewFieldGroup` lists all original observations, provenance, risk, confidence, and independent
  decision state. Each source observation has one Review button, named "Review <value>, page <n>",
  that opens its review task without route navigation.
- `ReviewSourcePanel` is the inline review task. It requests the authorized page image, overlays the
  candidate bounding box, reports loading/loaded/forbidden/unavailable/retry states, and owns a
  candidate-specific comparison checkbox. Accept, edit, and reject call the existing M22 decision API.
- `ReviewSafeguardPanel` invokes the existing document-identity and Part 2/SUD operations. It does not
  duplicate their backend behavior or expose redacted content.

The detailed route remains available with the validated referral `returnTo` context. It accepts a
candidate query hint only to choose the initial candidate and page and never treats navigation as source
confirmation.

## Clinical safety invariants

- Candidate IDs, candidate decisions, document/page references, bounding boxes, risk, vision state,
  coding flags, SUD flags, and redaction remain candidate-specific.
- Grouping never creates, updates, approves, rejects, or edits a decision.
- A group cannot acquire a decision from one of its members.
- Other-patient resolutions and unresolved identity remain visible and continue to block through the
  server.
- Part 2 redaction is rendered as withheld; no client fallback attempts to reconstruct the value.
- Source failure is an exception and never a successful confirmation.
- The source comparison checkbox is disabled until the authorized image has emitted a successful load;
  changing candidate, retrying, receiving 403, or receiving an image error clears confirmation.
- Each Accept/Edit/Reject write carries exactly one original candidate ID. Selecting a conflicting value
  never decides its sibling candidates.
- Duplicate submissions are disabled while a write is pending. The UI uses the refreshed workspace,
  rather than an optimistic clinical decision, for progress and the next task.
- The existing review lock, reviewer licensing, vision reason, source confirmation, audit, writeback,
  tenant isolation, and completion controls are unchanged.

## Responsive behavior

At wide desktop widths the CSS grid areas are `clinical | task | exceptions`, matching the approved
mockup while using Lantern tokens and existing `wx-*` controls. A medium breakpoint uses two columns and
moves priorities below them. Mobile becomes one column in the order `exceptions`, `task`, `clinical`;
decision controls become full-width, long values wrap, and source images remain bounded by the viewport.
No component introduces a fixed content width or horizontal workflow scroll.

## Accessibility requirements

- Section controls expose `aria-expanded` and `aria-controls`.
- The exception panel and review task are named regions; category controls expose `aria-expanded` and
  `aria-controls`; source and write failures use alerts; saved decisions use a visible status output.
- Status never relies on color alone.
- Source images have page-specific alternative text and the visual bounding box is marked decorative
  because the field, value, document, and page are already named in text.
- Keyboard users can traverse sections, exceptions, observations, source actions, and the detailed
  workflow in DOM order with visible focus.
- Motion is not required to understand or operate the workspace.

## V3.2 test matrix

Pure projection tests cover the V3.1 grouping matrix plus multi-reason task consolidation, category
counts, and one-to-one accounting of raw exceptions. DOM tests cover six-section navigation, inline task
selection, source loading/failure/retry/restriction, explicit source comparison, edited decisions,
server refresh, next-task offering, ownership changes, referral return navigation, category disclosure,
accessible names, and keyboard operation. Existing detailed-review DOM and backend service suites remain
regression coverage for licensing, vision reasons, ownership, identity exclusions, duplicate decision
updates, Part 2, audit, and completion semantics.

## Roadmap

- V3.3: refine conflict reconciliation and clinical comparison after observing V3.2 task analytics. Any
  batch decision contract remains a separate backend proposal; the UI must not simulate one.
- V3.4: add document-purpose grouping and a unified final completion summary while preserving server
  gates.

## Known limitations and deferred requirements

- The current payload has no referral reason, referral received date, patient DOB/MRN summary, or
  candidate-level eligibility flag. V3-1 does not invent them.
- Source availability is known only after the image request and is local to the current browser session.
  Server observability or a structured image-capability status would require a later contract change.
- The current extraction registry primarily supplies demographics, medications/allergies, and diagnoses;
  care-needs and coverage sections may be empty until those fields exist in the authoritative schema.
- V3.2 provides no grouped approval, server-side reconciliation aggregate, or new completion endpoint.
- Image loading remains a browser-observed state. The current backend does not issue a durable
  source-view receipt, so confirmation remains an explicit candidate-specific UI gate immediately before
  the existing decision request.
