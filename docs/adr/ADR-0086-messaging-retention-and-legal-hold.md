# ADR-0086 — Message retention and legal hold: an M4-owned hold applied to messages through an overlay

- **Status:** **Proposed** (2026-10-20). **Built:** the hold overlay (`legal_hold_message`, migration 1138) and its trigger backstop, the M4 seam, the retention scan (plan-only, as before), the governance routes under `/api/v1/messaging/governance` and the web retention and legal-holds screen; and, in the WP 5.6 finish (see "Implementation status" below), the message destruction executor (off per tenant, a dry run by default, never a held message), redaction of messages (a two-person mask, held messages included), the "Legal hold" chip and real staff names in the "placed by" column. **NOT built:** destruction of attachment objects on the retention path, the single-officer redaction fallback and a redaction request/approve web screen. The executor ships OFF and deletes nothing until an operator turns on two switches. Every default below is a build-team proposal accepted by the product owner for planning (decisions D1-D7); compliance sign-off and confirmation of the retention periods are NOT recorded.
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

1. **D1: status and scope.** This ADR stays Proposed. Hold features are built; destruction of messages was plan-only when this was written and is now implemented but OFF (see "Implementation status": two switches, dry run first).
2. **D2: periods unchanged.** care_related 7y, bereavement 7y, operational 1y, from `message.created_at`. Read-only in the UI: no PUT, no tenant shortening.
3. **D3: permission and step-up.** New permission `messaging.retention.manage` (category compliance, resource `message_retention`) granted to `compliance_officer`, `administrator`, `org_admin`. Apply and release need step-up (keys `messaging.legal_hold.apply`, `messaging.legal_hold.release`) and a reason of at least 10 characters. The same step-up is added to M4's own create and release routes (defect 4). Release is a second confirmation, not a second person.
4. **D4: scan stays plan-only.** (The scan still only plans; the destruction executor is a separate step that runs after it and acts only on an APPROVED certificate.) It opens pending M4 destruction certificates (data class `message.<class>`, one per class per month, ids and counts only). There is no message executor, so an approved certificate destroys nothing yet and the UI says so.
5. **D5: scopes.**
   - patient: a care_team channel whose subject is the patient, OR any message with a `message_entity_reference` of `reference_kind = 'patient'` for the patient, OR every bereavement channel (deliberately conservative; fixes defect 1);
   - channel: that channel;
   - user: messages the user authored plus messages in channels they have or had membership in (an over-hold; whether ended memberships are retained must be verified before build);
   - `dateRange` applies to `created_at`; `resourceKinds` is ignored for messages;
   - a messaging-only hold does not hold `audit_event` rows.
6. **D6: no clock extension on release.** Release makes a message eligible again on its original clock.
7. **D7: out of scope when written.** Redaction of held messages (ADR-0055 governs) and the thread "Legal hold" chip. Both are now built, see "Implementation status".

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

Destruction of attachment objects on the retention path (a message that still bears an undestroyed object is kept); the single-officer redaction fallback (self-approval plus a countersign within an undecided period); a redaction request/approve web screen; the `messaging.history.read` revision reader; audit-event holding by messaging holds; any tenant-configurable period.

## Known limits

- Apply materialises at most four batches (20,000 rows) synchronously and the weekly scan completes the rest. Until then the backstop trigger does not cover not-yet-materialised messages.
- (a) A hold placed through M4's own create route with `channelIds` or `userIds` writes no overlay rows until the next scan. Its live criteria are still honoured by the scan, the eraser and the M34 gate.
- (b) Messages sent after a hold is applied are not in the overlay until the next scan. In that window the trigger does not cover them, but the edit path checks the live hold predicate (409 `MESSAGE_UNDER_LEGAL_HOLD`), and the scan's live predicate, the eraser (any active hold) and the M34 gate hold too, so nothing is edited, destroyed or erased.
- (c) The list screen's "held messages" is the materialised overlay count (one grouped query) and can lag the live criteria until the next scan. Release-preview, apply and the release confirmation use the exact live count.
- (d) `openMessageCertificate` is select-then-insert with no unique index, because `destruction_certificates` is M4's table and this work adds no index there. It assumes one scan worker per org; two concurrent scans could open two pending certificates for the same class and month.
- (e) Separation of duties (accepted by the product owner): `messaging.retention.manage` is granted to `administrator` and `org_admin` as well as `compliance_officer` (product-owner decision D3), so a tenant admin who cannot touch M4 holds can place or release a messaging hold. Conversely, an M4 `legalhold.manage` holder can release a governance hold through M4's own release route (step-up, but no preview confirmation).
- (f) Scope of org-wide and patient holds: an org-wide governance hold (`{resourceKinds:["message"], origin}`) is messaging-only. It blocks M34 tenant-key destruction through `legalHoldClear` (`messagingHeld`) but does NOT freeze other modules' retention (M10 HOPE) and holds no audit class. A governance hold WITH `patientIds` stays patient-scoped: it also holds that patient's other records in modules that read `legalHoldScopeOf`.
- (g) [The message destruction executor now does this: see "Implementation status".] A message destruction job must re-check holds inside its own destructive transaction. The tenant eraser does: it takes the per-org hold lock (`messagingHoldLockName`) SHARED and reads the active holds in the same transaction as its UPDATE/DELETE, and `applyLegalHoldInTx` takes the same lock EXCLUSIVE, so apply and erase serialise. Attachment object destruction re-looks immediately before each destroy batch; the window between that look and the batch's network calls is not closed (object bytes cannot be rolled back). The retention reaper (`purgeRetainedObjects`: quarantined files and files on tombstoned messages past the window) now respects holds the same way: held messages are excluded from its candidates (live criteria, so unmaterialised messages too) and it re-checks under the shared hold lock right before each destroy, counting `skippedLegalHold`; the residual window is the same (up to the storage destroy deadline, `REAP_DESTROY_DEADLINE_MS` plus abort grace).
- (h) Date-only M4 holds (a `dateRange` with no patient, channel or user selector) now protect only messages created inside the range. Accepted by the product owner.
- (i) A hold's free-text name and reason appear in the M4 audit row and in the `m4.legal_hold.applied` / `released` outbox payloads, so they reach every consumer of `m4.legal_hold.released` (bereavement, portal). Reasons must not contain patient identifiers; the web dialog should say so.
- (j) The M36 body backfill skips a message under an active hold (the 1138 guard raises 23001; each row runs in a savepoint), counts it as `skippedLegalHold` and leaves it on the legacy envelope, so the run's `complete` stays false until the hold is released and the backfill is re-run. Held legacy rows are re-examined on every backfill run and count toward the run budget, so many low-id held rows can starve a run until release; and applying a hold during a tenant erase waits for the erase transaction (the hold lock queues), so the apply route can appear slow.
- (k) M4's own release route reports a governance-origin hold's `restoredRecordCount` as its materialised overlay count rather than an audit-event count. It can still release such a hold (permissions unchanged, see (e)).

## Open human items

- Compliance sign-off on this design and on the conservative patient scope.
- Confirmation of the retention periods (D2); they are engineering placeholders, not a legal position.
- Whether the user scope should include messages in channels the user has since left (depends on whether membership history is retained).

## Slices

Built: S0 this ADR. S1 M4 seam (apply/release in a transaction, criteria, `holdCoversDataClass`, step-up, `openMessageCertificate`). S2 migration 1138, trigger, drizzle schema, manifest, permission, eraser pre-check. S3 scan. S4 routes. S5 web. S6 docs. S7 (WP 5.6 finish): the destruction executor, migration 1156 redaction, the chip, staff names. Not built: see "What is NOT built".

## Implementation status (WP 5.6 finish, 2026-10-22)

This ADR stays **Proposed**. What was built after the first slices, and how each part fails closed.

### The destruction executor (`36-messaging/jobs/retention-destruction.ts`)

It runs inside the weekly `messaging.retention_scan` tick, after the scan, once per org. A worker is not a request, so every transaction is `withOrgContext(systemOrgContext(org))`. It destroys PHI, so:

- **Two switches, both off by default.** The tenant ops flag `messaging.retention_destruction` (tenant row wins, absent = off) lets it run at all for a tenant. With the flag on and nothing else, a run is a **dry run**: it reports what it would destroy, deletes nothing and writes one `m36.retention_destruction.run` audit row. It deletes only when the deployment also sets `M36_RETENTION_DESTRUCTION_EXECUTE=true`. It needs the destruction credential (`DATABASE_DESTRUCTION_URL`); without it the executor is not bound. The retention screen states the mode (`destruction_mode`: off, dry_run, live).
- **Only under an APPROVED M4 certificate** (`message.<class>`, approved through M4's route: permission, step-up, a person other than the scan). The window is measured from when the scan opened the certificate; a message that aged past it later waits for a later certificate. **The approved count is a ceiling and is never rewritten.** The scan records the EXACT number of destroyable messages (held, object-bearing and still-referenced ones excluded; not the 5000-id plan list) in `record_count`, which a guard trigger freezes once the certificate leaves `pending` (migration 1159). Spending is tracked in `destroyed_count` and `reserved_count`: a batch RESERVES its planned count in its plan transaction under a row lock on the certificate (a second or stalled executor waits, then sees the reduced remainder), deletes, then SETTLES (reservation released, `destroyed_count` up by what was really deleted, the difference refunded). remaining = record_count - destroyed_count - reserved_count, with a CHECK keeping the spend within the approved figure, so a crash or a persistent recording failure after the reserve can only UNDER-delete. The spend columns are written only by two SECURITY DEFINER functions (`destruction_certificate_reserve` / `_settle`, owned by the admin role, pinning the tenant, the `message.*` class, the approved status and the ceiling); the app role's table-wide UPDATE was replaced by a column grant that leaves them, `data_class` and the rest out, and its DELETE was revoked. The guard trigger also refuses a `data_class` change and a return to `pending`, and the only `record_count` change it allows after `pending` is M4's own audit sweep moving an `audit_event.*` certificate out of `approved`. A reservation stranded by a crash (batch still `reserved` after 6 hours in `message_destruction_batch`, which stores the planned ids) is RECONCILED at the start of the next live run: planned ids already gone count as destroyed, the rest are refunded; the batch row is locked and flips state in the same transaction, `destroyed_count` only goes up and never exceeds what was reserved, so capacity can never exceed the approved figure (a dry run only reports them). **The approval expires**: an approved certificate older than `CERTIFICATE_VALIDITY_DAYS` (35, from when the scan opened it) is filtered out in the SQL (so stale approvals, which stay `approved`, can never fill the per-run limit and starve a fresh one) and reported (`expiredCertificateIds`), and freshness and "still approved" are re-checked in the plan transaction and again in the destructive transaction (M4's reader, before the DELETE), so a message held at approval and released long after is not destroyed under a stale approval. The certificate is closed (`executed`, `executed_at`) when its count is spent or no message past its window remains for the class. Held, object-bearing or referenced messages keep it `approved`, so a release lets the next run finish it ("release restores eligibility"). M4's own execute sweep ignores `message.*` classes.
- **A held message is never touched.** One batch is: (A) planned in the app role's tenant transaction (shared per-org hold lock, active holds read, candidates selected with the hold excluded by the overlay OR the live criteria, then an audit row `batch_started` naming the ids, COMMITTED before the delete); (B) removed in the destruction credential's own tenant transaction, which takes the shared lock again, **re-reads the holds** and **re-evaluates the whole predicate inside the DELETE** (the id list is a request, never an authority); (C) audited (`batch_completed`: planned, destroyed, refused at delete, the ids). The migration 1138 trigger stays the backstop. An apply takes the lock exclusive, so apply and destroy serialise. A hold that lands between plan and delete is refused (`refusedAtDelete`); a live test blinds the plan to prove it.
- **Kept, not destroyed:** a message with an attachment whose object is not yet destroyed (the bytes cannot be rolled back, and object destruction on this path is NOT built), and a parent or quote target that a message still points at (replies go first, the parent follows in the same run).
- **A failing batch is not fatal to the org run.** It ends its own certificate; the other certificates still run, the run summary records it, and the run then reports it (AggregateError, so the tick fails visibly). If recording a committed batch fails, it is retried (3 attempts, audit row and spent count in one transaction); if it keeps failing, the destroyed ids are carried on the error and in the run summary (ids only) and the certificate is left open.
- **Idempotent and bounded.** Removing a gone row is a no-op and an executed certificate is not picked up again. Limits: 500 messages per transaction pair, 40 batches per certificate per run, 6 certificates per org per run; the rest resumes next week.
- **Audit.** Ids and counts only (`m36.retention_destruction.run|batch_started|batch_completed|certificate_executed`), plus the existing per-row PHI audit of each removed message. If a crash lands between B and C, the `batch_started` row still names the ids that were about to go.

### Redaction (migration 1156, ADR-0055 item 7)

`message_redaction` has one row per message: a request (reason 10 to 1000 characters), then an approval by a **different** person (CHECK, a guard trigger bound to `app.user_id`, a 403 in the service, and a fresh step-up `messaging.redact.approve`). New permissions `messaging.redact.request` and `messaging.redact.approve` go to the compliance officer only, and the full-catalog admin roles skip them (ADR-0055 D9: org admin has no implicit right). Routes live under `/api/v1/messaging/governance/redactions`.

A redaction **masks, it never destroys**: the cipher, hash and status are untouched. It is therefore neither blocked by an active hold nor does it weaken one: a held message can be redacted and stays retained. A request already blocks edits (409 `MESSAGE_REDACTED`) and takes the message out of the search index (tokens deleted in the same transaction; the writer, the reconcile sweep and the query all honour it, ADR-0058 d6/7). An approval masks the body, mentions, attachments, links and poll for every reader (`redactedAt` on the message view; hydration, inbox preview, the provider seam, attachment access, chart promotion, in-channel search and exports all honour it). Physical destruction stays on the retention path, which removes a redacted message together with its redaction row (FK cascade) once it is eligible and unheld.

### The chip and staff names

`legalHold: true` is on a message view only when the viewer holds `messaging.retention.manage`: that a hold exists is itself sensitive, and a custodian must not learn they are under one. The web shows a shared-kit "Legal hold" pill (lock glyph and the words) on the message and on the thread header. `placed_by_name`, and the redaction requester and approver names, come through an injected by-id directory port bound at the composition root to M2's reader (`02-identity/staff-names.ts`). A name resolves only for a user with a membership in this organisation.

### Open decisions

- **Redaction requests cannot be withdrawn or rejected.** Today a request can only be approved; a mistaken or unwanted request stays pending forever (it already takes the message out of search and blocks edits). Recommended default: add `POST .../redactions/:id/withdraw` (the requester) and `.../reject` (any holder of `messaging.redact.approve` other than the requester, with a reason), both audited and both lifting the edit block and re-indexing the message. Not built; needs a product decision on who may reject.
- **The redaction reason is stored in plaintext** (`message_redaction.reason`, left out of the audit row and every response). Entering PHI or patient identifiers in it is forbidden: the web copy and the runbook must say so (the hold dialog already does). Sealing it under the tenant DEK like a message body is cheap if compliance wants it; not done.

### Known limits of this slice

- **Certificate check to DELETE (TOCTOU).** The destructive transaction re-reads the certificate (`certificateIsLive`) and then deletes in a separate statement; M4's hold route (`POST /destruction-certificates/:id/hold`) takes no advisory lock, so a certificate held in that window can still lose the few rows of the batch already reserved. The ceiling is unaffected (they were reserved) and a held CERTIFICATE is not a legal hold: legal holds are serialised by the advisory lock and cannot be raced.
- **Lock order.** Plan transaction: the certificate row lock (`FOR UPDATE`), then the SHARED per-org hold lock. The only EXCLUSIVE holder of that hold lock is `applyLegalHoldInTx` (grep over `apps` and `packages`), and it writes `legal_hold`, an audit row and an outbox row, never `destruction_certificate`; M4's approve and hold routes write the certificate without the advisory lock. So no path takes them in the opposite order, and no deadlock cycle exists today. A future writer of both must keep this order.
- **Lost-commit settle retry.** If the commit of the settle transaction succeeds but its acknowledgement is lost, the retry finds the batch already settled, fails, and the destroyed ids are reported on the error; the audit row of the first attempt exists, and a reconcile does not touch a settled batch. A duplicate `batch_completed` row is possible only if the first attempt's audit row committed and the retry's also commits (the settle guard makes that retry fail first), so at most the error path, not the evidence, is duplicated.
- **Platform carrier.** The platform provisioning role (`PLATFORM_PROVISION_UPDATE_TABLES` in `scripts/db/provision-runtime-roles.ts`) keeps table-wide UPDATE on `destruction_certificate` for M34. The guard trigger still binds it (approved count, class, no return to pending) but it could rewrite the spend columns; it is a platform-operator credential outside the tenant threat model and is a recorded residual.
- **Planned-id window.** The reconcile threshold (6 hours) must stay far above the longest delete transaction; a reconcile racing a still-running delete could undercount `destroyed_count` by that batch's remainder.

- The single-officer fallback is not built: a tenant with one compliance officer cannot redact yet.
- The redaction tombstone shows when, not who or why (the people are in the governance list and the audit trail); ADR-0055 asks for who, when and why.
- There is no redaction web screen and no realtime hint on approval: a reader sees the mask on the next fetch.
- A redacted message's attachment OBJECT is retained (access is refused). No route reads revisions yet.
- `record_count` is the approved figure and never changes; the spend is in `destroyed_count` and `reserved_count` on the certificate, and the destroyed counts per run are in the run's audit rows. A batch whose recording failed leaves its reservation in place (conservative).
- Until an object-destruction step exists, a message with a retained clean attachment is never destroyed by this executor.
