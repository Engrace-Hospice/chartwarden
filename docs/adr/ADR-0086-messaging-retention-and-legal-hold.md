# ADR-0086 — Message retention and legal hold: an M4-owned hold applied to messages through an overlay

- **Status:** **Proposed** (2026-10-20). **Built:** the hold overlay (`legal_hold_message`, migration 1138) and its trigger backstop, the M4 seam, the retention scan (still plan-only), the governance routes under `/api/v1/messaging/governance` and the web retention and legal-holds screen. **NOT built:** the message destruction executor, redaction of held messages, the thread "Legal hold" chip and real staff names in the "placed by" column (the id is shown). Every default below is a build-team proposal accepted by the product owner for planning (decisions D1-D7); compliance sign-off and confirmation of the retention periods are NOT recorded.
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

A `BEFORE DELETE` trigger and a `BEFORE UPDATE OF body_cipher` trigger on `message` refuse a row whose overlay has an active hold, with `ERRCODE 23001`, whoever the caller is. SECURITY DEFINER, owned by `wardenx_admin`, pinned `search_path`, following migration 1053 exactly. The hold is joined on its own organisation (`l.organization_id = h.organization_id`) and `search_path` is `pg_catalog, public`, so an overlay row naming another tenant's hold uuid cannot make a message undeletable. It fires only on a bug or an out-of-band delete. The tenant eraser gets a pre-check so it fails cleanly instead of hitting the trigger: it refuses while ANY active `legal_hold` exists for the org (the M34 any-active-hold gate), not only holds that already have overlay rows.

### The four defects and their fixes

1. Patient matching follows D5 (channel subject, entity reference, bereavement channels).
2. M4 criteria gain `channelIds` and `userIds` (typebox, `LegalHoldCriteriaShape`, `hasSelector`); `legalHoldScopeOf` treats them as selectors, not org-wide; `holdCoversDataClass` ignores messaging-only holds for any non-`message.` class.
3. The scan excludes held rows in SQL (NOT EXISTS against active overlay) before applying the limit, so held rows cannot crowd out eligible ones.
4. Step-up on M4 create and release, and the web legal-holds screen handles the step-up redirect.

### Scan behaviour

Each run checks hold criteria live against messages (so supremacy never depends on materialisation being current) and then materialises overlay rows in bounded, idempotent, resumable batches (`ON CONFLICT DO NOTHING`). It is plan-only: it reports eligible, held and skipped counts and opens pending certificates through an idempotent `openMessageCertificate(tx, ...)` keyed on (data class, range start). A certificate that finds held rows is `partial_refused` or `held`, as in ADR-0051.

## What is NOT built

The message destruction executor; redaction of held messages; the thread "Legal hold" chip; real staff names in the "placed by" column; audit-event holding by messaging holds; any tenant-configurable period.

## Known limits

- Apply materialises at most four batches (20,000 rows) synchronously and the weekly scan completes the rest. Until then the backstop trigger does not cover not-yet-materialised messages.
- (a) A hold placed through M4's own create route with `channelIds` or `userIds` writes no overlay rows until the next scan. Its live criteria are still honoured by the scan, the eraser and the M34 gate.
- (b) Messages sent after a hold is applied are not in the overlay until the next scan. In that window the trigger does not cover them, but the edit path checks the live hold predicate (409 `MESSAGE_UNDER_LEGAL_HOLD`), and the scan's live predicate, the eraser (any active hold) and the M34 gate hold too, so nothing is edited, destroyed or erased.
- (c) The list screen's "held messages" is the materialised overlay count (one grouped query) and can lag the live criteria until the next scan. Release-preview, apply and the release confirmation use the exact live count.
- (d) `openMessageCertificate` is select-then-insert with no unique index, because `destruction_certificates` is M4's table and this work adds no index there. It assumes one scan worker per org; two concurrent scans could open two pending certificates for the same class and month.
- (e) Separation of duties (accepted by the product owner): `messaging.retention.manage` is granted to `administrator` and `org_admin` as well as `compliance_officer` (product-owner decision D3), so a tenant admin who cannot touch M4 holds can place or release a messaging hold. Conversely, an M4 `legalhold.manage` holder can release a governance hold through M4's own release route (step-up, but no preview confirmation).
- (f) Scope of org-wide and patient holds: an org-wide governance hold (`{resourceKinds:["message"], origin}`) is messaging-only. It blocks M34 tenant-key destruction through `legalHoldClear` (`messagingHeld`) but does NOT freeze other modules' retention (M10 HOPE) and holds no audit class. A governance hold WITH `patientIds` stays patient-scoped: it also holds that patient's other records in modules that read `legalHoldScopeOf`.
- (g) A future message destruction job must re-check holds inside its own destructive transaction. The tenant eraser does: it takes the per-org hold lock (`messagingHoldLockName`) SHARED and reads the active holds in the same transaction as its UPDATE/DELETE, and `applyLegalHoldInTx` takes the same lock EXCLUSIVE, so apply and erase serialise. Attachment object destruction re-looks immediately before each destroy batch; the window between that look and the batch's network calls is not closed (object bytes cannot be rolled back). The retention reaper (`purgeRetainedObjects`: quarantined files and files on tombstoned messages past the window) now respects holds the same way: held messages are excluded from its candidates (live criteria, so unmaterialised messages too) and it re-checks under the shared hold lock right before each destroy, counting `skippedLegalHold`; the residual window is the same (up to the storage destroy deadline, `REAP_DESTROY_DEADLINE_MS` plus abort grace).
- (h) Date-only M4 holds (a `dateRange` with no patient, channel or user selector) now protect only messages created inside the range. Accepted by the product owner.
- (i) A hold's free-text name and reason appear in the M4 audit row and in the `m4.legal_hold.applied` / `released` outbox payloads, so they reach every consumer of `m4.legal_hold.released` (bereavement, portal). Reasons must not contain patient identifiers; the web dialog should say so.
- (j) The M36 body backfill skips a message under an active hold (the 1138 guard raises 23001; each row runs in a savepoint), counts it as `skippedLegalHold` and leaves it on the legacy envelope, so the run's `complete` stays false until the hold is released and the backfill is re-run. Held legacy rows are re-examined on every backfill run and count toward the run budget, so many low-id held rows can starve a run until release; and applying a hold during a tenant erase waits for the erase transaction (the hold lock queues), so the apply route can appear slow.
- (k) M4's own release route reports a governance-origin hold's `restoredRecordCount` as its materialised overlay count rather than an audit-event count. It can still release such a hold (permissions unchanged, see (e)).

## Open human items

- Compliance sign-off on this design and on the conservative patient scope.
- Confirmation of the retention periods (D2); they are engineering placeholders, not a legal position.
- Whether the user scope should include messages in channels the user has since left (depends on whether membership history is retained).

## Slices

Built: S0 this ADR. S1 M4 seam (apply/release in a transaction, criteria, `holdCoversDataClass`, step-up, `openMessageCertificate`). S2 migration 1138, trigger, drizzle schema, manifest, permission, eraser pre-check. S3 scan. S4 routes. S5 web. S6 docs. Not built: the destruction executor, redaction of held messages, the thread chip, staff names in "placed by".
