# ADR-0086 — Message retention and legal hold: an M4-owned hold applied to messages through an overlay

- **Status:** **Proposed** (2026-10-20). **Nothing in this ADR is built.** The retention scan exists and is plan-only; there is no `legal_hold_message` table, no `messaging.retention.manage` permission, no hold or retention route for messages and no web screen. Every default below is a build-team proposal accepted by the product owner for planning (decisions D1-D7); compliance sign-off and confirmation of the retention periods are NOT recorded.
- **Date:** 2026-10-20
- **Phase:** Messaging Hub Phase 5, WP 5.6 (capability SG-06).
- **Resolves (once accepted):** the open "full messaging hold/retention design" in [ADR-0055](ADR-0055-message-revisions-and-redaction.md) item 9.
- **Extends:** [ADR-0051](ADR-0051-legal-hold-is-an-overlay-not-a-retention-class-flip.md) (the overlay pattern), applied to `message`. Interacts with ADR-0055 (redaction never destroys cipher; a hold does not block edits).
- **Related:** M4 `legal_hold` and destruction certificates (`m34-destruction-workflow.ts` is the precedent), migration 1053 (audit overlay and trigger), M36 retention scan.

## Context

Messages carry PHI and have retention classes (care_related 7 years, bereavement 7 years, operational 1 year, from `message.created_at`). A weekly scan reports what is eligible; it destroys nothing. M4 owns legal holds, but a hold can only describe patients, resource kinds and a date range, and its enforcement is written for `audit_event`. A hold must be able to protect messages, and the destruction path must refuse a held message even if application code is wrong.

Four defects in the current seam must be fixed for that to be true:

1. A patient scope is matched only against `channel.subject_id`, so direct messages, discipline channels and bereavement channels that concern the patient are under-held.
2. Adding channel or user selectors to the M4 criteria breaks three existing readers: `legalHoldScopeOf` would read a channel-only hold as org-wide; `holdCoversDataClass` returns true for a hold with no `resourceKinds`, which would block every audit destruction certificate; `hasSelector` rejects a channel-only hold with 422.
3. The scan takes `ORDER BY created_at LIMIT 5000` and then filters held rows, so held rows crowd eligible rows out of the batch.
4. M4 `POST /legal-holds` and `/legal-holds/:id/release` have no step-up, so a step-up-gated messaging route would be bypassable through M4's own.

## Decision (proposed)

1. **D1: status and scope.** This ADR stays Proposed. Hold features are built; destruction of messages stays plan-only.
2. **D2: periods unchanged.** care_related 7y, bereavement 7y, operational 1y, from `message.created_at`. Read-only in the UI: no PUT, no tenant shortening.
3. **D3: permission and step-up.** New permission `messaging.retention.manage` (category compliance, resource `message_retention`) granted to `compliance_officer`, `administrator`, `org_admin`. Apply and release need step-up (keys `messaging.legal_hold.apply`, `messaging.legal_hold.release`) and a reason of at least 10 characters. The same step-up is added to M4's own create and release routes (defect 4). Release is a second confirmation, not a second person.
4. **D4: scan stays plan-only.** It opens pending M4 destruction certificates (data class `message.<class>`, one per class per month, ids and counts only). There is no message executor, so an approved certificate destroys nothing yet and the UI says so.
5. **D5: scopes.**
   - patient: a care_team channel whose subject is the patient, OR any message with a `message_entity_reference` of `reference_kind = 'patient'` for the patient, OR every bereavement channel (deliberately conservative; fixes defect 1);
   - channel: that channel;
   - user: messages the user authored plus messages in channels they have or had membership in (an over-hold; whether ended memberships are retained must be verified before build);
   - `dateRange` applies to `created_at`; `resourceKinds` is ignored for messages;
   - a messaging-only hold does not hold `audit_event` rows.
6. **D6: no clock extension on release.** Release makes a message eligible again on its original clock.
7. **D7: out of scope.** Redaction of held messages (ADR-0055 governs) and the thread "Legal hold" chip.

### The overlay (migration 1138, same shape as ADR-0051)

`legal_hold_message (id, organization_id, legal_hold_id, message_id, held_at)`: `legal_hold_id` is a plain uuid with no FK (M4 owns the hold); composite FK `(organization_id, message_id)` to `message` with `ON DELETE CASCADE`; `UNIQUE (legal_hold_id, message_id)`; index `(organization_id, message_id)`. RLS keyed only on `app.org_id`, ENABLEd and FORCEd. `wardenx_app` has SELECT and INSERT; `wardenx_destruction` has SELECT and DELETE. As in ADR-0051 there is no `released_at`: a row is held while its `legal_hold.status = 'active'`, so release is the one existing UPDATE and takes effect for every row at once.

### The trigger backstop

A `BEFORE DELETE` trigger and a `BEFORE UPDATE OF body_cipher` trigger on `message` refuse a row whose overlay has an active hold, with `ERRCODE 23001`, whoever the caller is. SECURITY DEFINER, owned by `wardenx_admin`, pinned `search_path`, following migration 1053 exactly. It fires only on a bug or an out-of-band delete. The tenant eraser gets a pre-check so it fails cleanly under a hold instead of hitting the trigger.

### The four defects and their fixes

1. Patient matching follows D5 (channel subject, entity reference, bereavement channels).
2. M4 criteria gain `channelIds` and `userIds` (typebox, `LegalHoldCriteriaShape`, `hasSelector`); `legalHoldScopeOf` treats them as selectors, not org-wide; `holdCoversDataClass` ignores messaging-only holds for any non-`message.` class.
3. The scan excludes held rows in SQL (NOT EXISTS against active overlay) before applying the limit, so held rows cannot crowd out eligible ones.
4. Step-up on M4 create and release, and the web legal-holds screen handles the step-up redirect.

### Scan behaviour

Each run checks hold criteria live against messages (so supremacy never depends on materialisation being current) and then materialises overlay rows in bounded, idempotent, resumable batches (`ON CONFLICT DO NOTHING`). It is plan-only: it reports eligible, held and skipped counts and opens pending certificates through an idempotent `openMessageCertificate(tx, ...)` keyed on (data class, range start). A certificate that finds held rows is `partial_refused` or `held`, as in ADR-0051.

## What is NOT built

The message destruction executor; redaction of held messages; the thread "Legal hold" chip; audit-event holding by messaging holds; any tenant-configurable period.

## Known limits

Apply materialises at most four batches (20,000 rows) synchronously and the weekly scan completes the rest. Until then the backstop trigger does not cover not-yet-materialised messages: an edit of such a message is not refused by the trigger. The scan's live criteria check, the plan-only scan and the M34 any-active-hold gate for tenant erasure still hold, so nothing is destroyed or erased in that window.

## Open human items

- Compliance sign-off on this design and on the conservative patient scope.
- Confirmation of the retention periods (D2); they are engineering placeholders, not a legal position.
- Whether the user scope should include messages in channels the user has since left (depends on whether membership history is retained).

## Slices (once accepted)

S0 this ADR. S1 M4 seam (extract apply/release in a transaction, criteria, `holdCoversDataClass`, step-up, `openMessageCertificate`). S2 migration 1138, trigger, drizzle schema, manifest, permission, eraser pre-check. S3 scan. S4 routes. S5 web. S6 docs.
