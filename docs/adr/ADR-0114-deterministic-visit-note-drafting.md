# ADR-0114 — Visit notes are drafted deterministically from structured records, never copied forward, confirmed section by section, and amended rather than overwritten

- **Status:** **Proposed** (2026-11-18). The owner decided this in a design session after a competitor comparison; acceptance is the owner's.
- **Date:** 2026-11-18
- **Related:** [ADR-0007](ADR-0007-m8-m9-m10-read-direction.md) and [ADR-0043](ADR-0043-m8-completeness-seam-inversion.md) (M8 reaches other modules by seam), [ADR-0012](ADR-0012-ai-governance-contract.md) (AI governance), [ADR-0072](ADR-0072-separate-react-native-expo-mobile-app.md) (separate mobile app), [ADR-0094](ADR-0094-messaging-voice-notes-and-dictation.md) (dictation), architecture §10.5, and the note-closure ADR on PR #1065 (not yet on `main`). The full design is `docs/implementation/04-visit-note-drafting-redesign.md`, whose decision IDs are `VN-D1`…`VN-D30` (the M8 spec has its own D1-D13).
- **Amends:** nothing. It does not change Layer 2; it keeps it a stub. Decision 4 extends the M8 addendum path (M8 spec D2) without changing it.

## Context

Facts read from the repo on 2026-11-18:

- A scheduled visit seeds a draft that carries ids only. Nothing from the care plan, scale readings, vitals, medications or the last visit reaches the note, although the M8 spec promises vitals and scales in the narrative.
- Layer 2 (LLM enhancement) is a deny-stub, and AI is blocked platform-wide (`ai.full` off, M32 inference seams are deny-stubs).
- Gate check 9 (attestation confirmed) and check 7 (Layer 2 decisions) are `deferred`; nothing carries the clinician's confirmation.
- CMS requires the physician's certification narrative to show the patient's individual clinical circumstances and not standard language used for all patients. The top denial reason at CGS is "does not support a terminal prognosis" (53% of denied claims in one CGS quarter).
- A competitor markets, as vendor claims, a visit note drafted from the care plan and the clinician's key observations by a non-generative engine, and a nurse's public comment praises it (unverified). The same competitor also markets separate AI tools, rolling out one at a time (vendor-claimed).

## Decision

**Decision 1 (VN-D4) — The draft is compiled deterministically.** The visit-note draft is built from structured records (linked care-plan goals and interventions, scale readings with their change since the last visit, vitals, medication and order changes) and the clinician's own selections. No LLM and no generated free text is in the draft path. Layer 2 stays a stub; AI suggestions are a separate later decision with their own ADR.

**Decision 2 (VN-D6) — No text copy-forward.** Prior-note text is never carried into a new note. "Changes since last visit" is computed from structured data, and anything carried over needs per-item re-attestation.

**Decision 3 (VN-D7, with the binding clause of VN-D12) — Confirmation is per section and bound to content.** The clinician confirms, edits or deselects each drafted section; signing is blocked until every drafted section is resolved. A confirmation binds to the draft snapshot version, the phrase-corpus version and a hash of the section's rendered content, so a confirmation never covers content the clinician did not see. Source ids per section are kept in the audit trail only; the signed text reads as the clinician's own narrative.

**Decision 4 (VN-D30) — A signed note is amended, never overwritten.** A signed visit note stays modifiable only through an amendment on the existing addendum path. The signed text is preserved. Each amendment is attributed, dated, step-up authenticated and re-confirmed per changed section, and it re-triggers cosign when the author needed one.

## Considered options

- **LLM-first draft.** Rejected: AI is blocked platform-wide, surveyors cannot reconstruct what the clinician chose from what a model wrote, and the trials we found show small or no time savings (one randomised trial: about 9.5% for one scribe, not significant for another) and staff-reported hallucinations (47% of staff in one trial).
- **Copy-forward from the last note.** Rejected: OIG warned that it may facilitate inflated or duplicated claims. A structured "what changed" view gives the speed without that exposure.
- **Per-sentence confirmation.** Rejected: it would raise the click count and defeat the time-to-sign goal. The section is the unit.
- **In-place edit of a signed note.** Rejected: it destroys the record of what was signed, and the M8 spec locks signed encounters as immutable with changes through addenda.
- **Tenant-editable phrase library.** Deferred, not decided here: the platform corpus is curated and versioned in v1 because template sprawl is the known failure of smart-phrase systems.

## Consequences

- Slice 1 builds a per-author draft computed at open, as of the visit time, and enforces check 9 plus a new "every drafted section resolved" check. As-of time needs new as-of variants of the care-plan, scale and medication seams.
- Amendments must layer on a frozen authoritative text while source-derived sections render per viewer (Part 2). Modelling that on the M8 addendum state machine is the first task of slice 1.
- The mobile app and any offline path inherit Decision 3: offline confirmations are re-validated at sync and never silently accepted against newer data.
- Rolling this out is per tenant, default off, because `main` auto-deploys.
