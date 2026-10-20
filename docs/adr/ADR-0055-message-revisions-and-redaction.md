# ADR-0055 — Message edits keep an append-only revision chain; redaction is a separate audited act that masks, and physical destruction stays on the retention path and honours holds

- **Status:** **Accepted** (2026-10-11, product owner). The single-officer countersign period is **72 hours**. WP 1.3 implements items 1–4 and 6 (revision chain, edit window); items 5 and 7 (history read, redaction) ship with Phase 5.
- **Date:** 2026-10-11
- **Phase:** Messaging Hub Phase 1 (WP 1.3); redaction UI and approvals are Phase 5 (WP 5.6).
- **Extends:** M36 spec §3.4 (message envelope, `body_sha256`, tombstone) and ADR-0004 (clinical retention; the "retain the cipher
  through the retention window" rule that M36-F02 already applies to deletes).
- **Related:** [ADR-0051](ADR-0051-legal-hold-is-an-overlay-not-a-retention-class-flip.md) (overlay pattern; hashed columns are
  never rewritten by a hold), [ADR-0010](ADR-0010-tenancy-rls-invariants.md), ADR-0054 (`message.edited` hint),
  ADR-0056 (acknowledgment targets a specific revision).


## Context

Verified in the repo today:

- `packages/db/src/schema/messaging/messages.ts`: `message` holds `body_cipher` (envelope-encrypted under the tenant DEK),
  `body_sha256` (SHA-256 of the **plaintext**, pre-encryption), `status` in `sent|edited|deleted` (enum `message_status`),
  `edited_at`, `deleted_at`; CHECKs `message_status_shape` and `message_sha256_shape`. Delete is a tombstone that retains the
  cipher and never zeroes the hash.
- `editMessage` in `apps/backend/src/modules/36-messaging/messaging-route-service-db.ts` (about line 1191, route
  `PATCH /api/v1/messaging/messages/:id`) checks author-only and not-deleted, then **overwrites `body_cipher` and `body_sha256` in
  place** and deletes the message's `message_entity_reference` rows. The previous body and references are therefore
  unrecoverable except from backups. The code comment says "within the window" but no window comparison was found in that
  function (**unconfirmed**; the spec says default 5 minutes, M36 spec line 357). Treat the 5-minute window as unenforced until a
  test proves otherwise.
- No `message_revision` table or code exists (grep of `packages`, `apps/backend/src`, migrations). The plan's table is
  `02-architecture-and-domain.md` §4 Phase 1.
- Hash verification: `runHashVerify` is in `packages/messaging/src/jobs/processors.ts`; audit F8 found no scheduler for it.
  Integrity checking therefore does not run today.
- Tenant erasure is crypto-erase (destroy the tenant DEK first): `packages/messaging/src/destruction` and
  `apps/backend/src/modules/36-messaging/erasers/messaging-eraser.ts`.
- Legal hold: the M36 retention processor already takes a `legalHold` flag per candidate (`packages/messaging/src/jobs/processors.ts`),
  but nothing feeds it from M4 for messages (audit F8, "Not wired"). ADR-0051 solved this for `audit_event` only and lists other
  modules as "not decided here".
- Authorization: message routes use `messaging.send`/`messaging.read` (+ author); no redaction or history-read permission exists.

## Decision

1. **Revision chain.** New table `message_revision` (working name): `organization_id`, `message_id`, `revision_no` (starts at 1 =
   the original), `body_cipher`, `body_sha256`, `body_kind`, `references_snapshot` (encrypted or normalised from
   `message_entity_reference`), `edited_by`, `created_at`. Three-column rule per ADR-0010 (org column, RLS keyed on `app.org_id`,
   FORCE), PHI write-audit trigger, org-composite index, FK index-covered. `wardenx_app` gets `SELECT, INSERT` only: no UPDATE, no
   DELETE. Unique `(organization_id, message_id, revision_no)`.
2. **Edit algorithm** (one transaction): lock the message row; insert the **current** body as the next revision; write the new body
   to `message` (so the hot read path and `body_sha256` verify stay unchanged); set `status='edited'`, `edited_at`; emit
   `m36.message.revised.v1`; audit with actor. `message.body_sha256` always equals the hash of the head body. Revisions are never
   rewritten.
3. **Edit window.** Author-only edit within the tenant's edit window, default 5 minutes, measured from `created_at` on the
   **server clock**; a tenant may only **shorten** it (tighten-only, platform maximum 5 minutes unless the clinical lead signs off a
   different ceiling). After the window, the author cannot edit; a correction is a new message that quotes the old one
   (`quoted_message_id`). **Edit lock (D8, decided 2026-10-11 by the product owner):** a message that is **urgent** or carries an
   **acknowledgment request** is locked against edits from the moment it is sent, whether or not the window is still open
   (ADR-0056): an acknowledged instruction must not change under the acknowledger. A correction after that point is a **new linked
   amendment message** (visible as an amendment of the original, via `quoted_message_id` or an equivalent link; exact column is an
   implementation choice) and **never an overwrite**. The original stays unchanged and acknowledgeable.
4. **Edit while reads exist.** Readers who saw revision n keep seeing it in their audit trail; the UI shows an "edited" marker with
   the time, never silently swaps. The revision number is part of the realtime hint and of any acknowledgment target.
5. **Who may read history.** The author sees their own prior revisions inside the edit window only. Reading any revision list
   requires a new permission `messaging.history.read` (D9; default holders to be proposed by compliance and the clinical lead, **not**
   org admin by default, **not** ordinary members), plus current channel/patient access (ABAC). Each read writes a read-audit event with
   `resourceIdParam` set (the repo's standing lesson: without it the audit insert fails silently). Ordinary members see only the
   head and the "edited" marker.
6. **Tombstone unchanged.** Delete still flips `status='deleted'`, sets `deleted_at`, retains cipher and hash. Revisions of a
   deleted message are retained identically and are history-readable only under item 5.
7. **Redaction is a distinct act, not edit or delete (D9, decided 2026-10-11 by the product owner).**
   - **Two-person approval.** Three separate permissions, none of which exists in the repo today (grep of `apps`, `packages`,
     `docs`, `architecture`, `scripts`): `messaging.history.read` (item 5), `messaging.redact.request`, `messaging.redact.approve`.
     The requester and the approver **must be different people**; org admin has no implicit right to either. The request carries a
     reason and scope (message, optionally specific revisions).
   - **Single-officer fallback.** If the agency has only one eligible person, that person may approve their own request only if a
     **second role** (org admin or privacy officer) **countersigns within a set period**. Until countersigned (or if the period
     lapses) the redaction is not final. The length of the period is **not decided** (Open questions).
   - **Restricted revision store, never hard-deleted.** The original body and its revisions are retained in the restricted
     `message_revision` store (item 1). It is legal-hold aware (item 9), readable only with `messaging.history.read`, and is never
     hard-deleted by redaction; physical destruction remains on the retention path (item 8).
   - **Tombstone.** The message shows a tombstone stating **who** redacted it, **when** and **why**; the body is masked at the
     access layer for everyone else. A `message_redaction` record (requester, approver, countersigner if any, reason, scope,
     timestamps) and a `redacted_at`/`redaction_id` marker on the message (a new `message_status` value `redacted` or a nullable
     column; migration choice recorded at implementation, noting Postgres cannot drop enum values).
   - Redaction is audited with requester, approver, countersigner and reason, and emits an event. The cipher and hash are **not**
     destroyed by redaction. (The earlier draft's `messaging.redaction.review` and `messaging.redact` permissions are replaced by
     the three above.)
8. **Physical destruction stays where it is.** Cipher bytes (message and revisions) are destroyed only by the retention scan or the
   tenant eraser, never by redaction. A retained cipher under a mask is the same trade-off ADR-0004 accepted for tombstones.
9. **Legal hold.** Apply the ADR-0051 overlay pattern to messages (append-only `legal_hold_message` overlay, M4-owned hold, no
   rewrite of any hashed column, enforced at the retention-scan DELETE and by a BEFORE DELETE backstop trigger). A message under an
   active hold: can be redacted-masked (so the hold never forces a patient-harm exposure) but its cipher cannot be destroyed; a
   hold does not block edits inside the window (the revision chain preserves both). The full messaging hold/retention design is its own
   ADR, now drafted as [ADR-0086](ADR-0086-messaging-retention-and-legal-hold.md) (Proposed, not built); this ADR fixes only the interaction rules
   above so Phase 1 does not paint that ADR into a corner.
10. **Integrity.** `message_revision.body_sha256` is the same plaintext-SHA-256 construct. `runHashVerify` is extended to verify
    revisions and must be **scheduled and proven** (WP 1.9); a seeded tampered revision must be detected and recorded.
11. **Backfill.** Existing rows have no revisions: their head body is revision 1 implicitly. No migration of old plaintext history
    is possible (it was overwritten).

## Alternatives considered

- **Keep overwrite-in-place (status quo).** Rejected: loses the prior clinical wording permanently and defeats the integrity story
  the hash is meant to support (§164.312(c)).
- **Store edits as new `message` rows linked by `supersedes_id`.** Keeps one table, but every list/read/receipt/ack query must
  filter heads, and `message_receipt` / `message_entity_reference` keyed on `message.id` would fragment. Rejected for blast radius.
- **JSON revision array on `message`.** Needs UPDATE grants on a row that is otherwise append-oriented and cannot be locked down to
  insert-only. Rejected.
- **Redaction = crypto-shred the revisions' ciphers.** Strongest confidentiality, but irreversibly destroys possibly held or
  record-relevant content and conflicts with ADR-0051's supremacy of holds. Rejected as the default; available later through the
  retention path with hold checks.
- **No edit window (edits forever).** Rejected: an acknowledged or acted-on message changing later is a clinical-safety hazard
  (plan hazard H-04 family).
- **Disallow edits entirely.** Simplest and arguably safest; rejected for usability, but the window plus the ack/urgent lock
  (D8) approaches it for the safety-critical cases.

## Consequences

- Storage grows by roughly one ciphertext per edit; bounded by the edit window and the rate of edits.
- The edit path becomes a multi-statement transaction; the `message` hot row layout is unchanged, so inbox queries do not change.
- Reference history (mentions) must be snapshotted per revision or it is lost on edit as it is today.
- Redacted-but-retained content is a deliberate residual: anyone with database plus KEK access can still read it; the control is
  procedural and the audit trail.
- Compliance/clinical-lead roles gain a sensitive read surface that must itself be audited and reviewed.

## Migration / rollout

1. Migration: `message_revision` (+ grants, RLS, audit trigger, indexes); mirror enums/tables in `packages/db/src/enums.ts`,
   `packages/types`, and both manifests (`.ts` + `.cjs`) under M36 `ownedTables`; check `arch:migration-numbering` against `main`.
2. Ship edit-with-revision and window enforcement together (WP 1.3); then the hash-verify scheduler (WP 1.9).
3. Redaction record, permissions and UI with Phase 5 (WP 5.6); until then redaction is not exposed.
4. Register new permission keys in M3 and compose each in a route (`arch:abac-composed`).

## Verification

- Live (real `wardenx_app` role): edit writes a revision and the head; the prior body decrypts from the revision; `wardenx_app`
  cannot UPDATE or DELETE a revision; revision RLS cross-tenant read returns nothing; edit after the window is refused with the
  server clock (clock-skew test); edit of an ack-bound or urgent message is refused even inside the window, and the correction path creates a linked amendment message leaving the original unchanged.
- Hash: seeded tampered head and tampered revision are both detected by `runHashVerify`; the scheduled run is recorded in audit.
- Access: ordinary member and org admin get 403 on history; compliance gets it; the read event lands in `audit_event`.
- Redaction (Phase 5): requester and approver being the same person is refused (except the single-officer path, which stays
  non-final until a second role countersigns); a lapsed countersign period leaves it non-final; masked for ordinary readers with a
  tombstone (who/when/why), original readable only with `messaging.history.read` and that read audited, cipher still present,
  retention scan skips a held message, destruction removes revisions together with the message.
- Gates: `arch:tenancy`, `check-fitness-gaps` (PHI RLS + audit triggers), `arch:manifest-mirror`, `arch:abac-composed`,
  `test:fk-indexes:live`.

## Open questions

- ~~Is the 5-minute window enforced in `editMessage`?~~ It was not. WP 1.3 enforces it on the database clock and a live test proves it.
- ~~Single-officer fallback: the length of the countersign period.~~ Decided 2026-10-11 by the product owner: **72 hours**; a redaction not countersigned within it stays non-final.
- Who are the default holders of `messaging.history.read`, `messaging.redact.request` and `messaging.redact.approve`? Needs
  compliance input.
- The messaging legal-hold ADR owner and date (the retention scan has been scheduled and plan-only since WP 1.9, so nothing is destroyed until this ADR lands).

Resolved (Decided 2026-10-11 by the product owner): edits lock once urgent or ack-requested, correction is a linked amendment (D8);
four-eyes redaction with distinct requester/approver and a single-officer fallback (D9). The earlier question "no edits after send
for patient-linked channels" is superseded by D8's narrower lock.

## Implementation status (WP 1.3)

- Migration `1070_m36_message_revision.sql`: `message_revision` with the org column, RLS and FORCE, the PHI write-audit trigger (cipher
  and snapshot scrubbed), a composite cascade FK to `message`, and `wardenx_app` limited to `SELECT, INSERT`. The destruction role has
  `SELECT, DELETE` so retention and the tenant eraser remove revisions with their message.
- `editMessage` locks the message row, writes the replaced body and its mention snapshot as the next revision, then overwrites the head
  (so `body_sha256` verification on `message` is unchanged), inside one transaction. The window is 5 minutes from `created_at`,
  measured with `clock_timestamp()` in Postgres (so a wait on the row lock counts), and a late edit returns 409 `MESSAGE_EDIT_WINDOW_CLOSED`.
- Revisions follow the message's retention: an author's soft delete keeps `body_cipher` (M36-F02), so earlier edit bodies stay with it
  until retention or the tenant eraser removes the message (the foreign-key cascade removes its revisions). Redaction (Phase 5) is the
  only path that removes a body early.
- The existing `m36.message.edited` event is kept (it already feeds the hint consumer); a separate `m36.message.revised.v1` was not
  added because nothing consumes it yet.
- The read DTO carries an optional `editedAt` (live edited messages only; no revision count). **Phase 5 acceptance criterion:** redaction must hide it (`visibleEditedAt` returns null for a redacted message).
- **Not in WP 1.3:** the edit lock for urgent and acknowledgment-requested messages (the columns arrive with ADR-0056 in Phase 4);
  tenant shortening of the window (needs per-tenant messaging settings); `messaging.history.read` and the history route (item 5);
  redaction (Phase 5).

## Implementation status (WP 1.9)

- **Revision verification is done.** The nightly `messaging.hash_verify` run (04:00 UTC, `apps/backend/src/modules/36-messaging/jobs/`)
  verifies message heads and `message_revision` rows per tenant in three bounded passes (a guaranteed `(created_at, id)` rotation of
  `HASH_VERIFY_SAMPLE_LIMIT` rows per table per run, resuming from the previous run row's `cursorEnd` and wrapping; the rows created since
  the previous run, which includes every edit because an edit adds a revision row; and a random primary-key page), deduplicated. The
  worst-case latency for an old row tampered just behind the cursor is `ceil(rows / limit)` nights, and for a new row the next run
  (unless more than the limit arrived or its transaction outlived the one-hour overlap, in which case the rotation and the random page
  apply). Each row is decrypted under the tenant DEK and its SHA-256 compared to the stored hash. A divergence, or a cipher that no longer authenticates, is recorded as `m36.integrity.hash_mismatch` (critical; ids and hashes
  only, plus `revisionNo` for a revision) and the run as `m36.hash_verify.run`; the tick then fails so the DLQ alert fires. A held
  message is still verified: a hold blocks destruction, it does not excuse tampering. Proven live as `wardenx_app`, with the tamper
  seeded over the superuser connection (`test:m36:integrity-jobs:live`). `hash_verify` is one attempt by design (a mismatch is
  deterministic; a retry would only duplicate the critical rows); a tamper alert to the security officer through the M36 alert emitter
  is a follow-up. Because `hash_verify` is one attempt, a transient database or Redis error also gets no retry: that tenant stays
  unverified until the next night (alerted through the failed tick and the DLQ alert, not retried). A malformed or missing cursor restarts
  the rotation and is recorded on the run row (`cursorReset`); only the newest 50 `m36.hash_verify.run` rows are searched for the system-written cursor row. Migration 1080 supplies the `(organization_id, created_at, id)` indexes.
  Rolling deploys: an old replica still running the legacy `add({ repeat })` registration can re-create the legacy trigger until a new replica next boots, which causes a transient double run (read-only, harmless). The largest remaining evasion path is the recent-pass overflow: more than `limit` new rows inside one window can bury a tampered new row, which is then covered only by the rotation and the random page (`recentOverflow` is recorded on the run row). Run rows by a non-system actor are ignored and counted (`ignoredNonSystemRuns`), a future-dated previous run is clamped to now, and an impossible calendar date in a cursor takes the `malformed_cursor` reset. Migration 1080 builds its indexes with a plain `CREATE INDEX`, which holds a SHARE lock (blocking writes to `message` and `message_revision`) while it builds. Because `hash_verify` is one attempt, a transient database or Redis error also gets no retry: that tenant stays
- **The retention scan is scheduled but plan-only.** `messaging.retention_scan` (Sunday 02:00 UTC) selects messages past their channel's
  window, withholds those covered by an active M4 legal hold (conservative reading: org-wide hold, or one naming the channel's patient),
  and records `m36.retention_scan.run` with counts. It deletes nothing and files no certificate: destruction, and the message hold
  overlay of item 9, remain the messaging retention ADR's work. The `operational` window (1 year) is provisional until that ADR.
  The scan counts from `created_at` and `toDestroy` means "past the age window and not held", not an approved destruction plan; the
  retention design anchors on the last patient contact, with state overrides, custodian holds and destruction certificates (WP 5.6),
  and where they differ the architecture wins and the scan changes then.
- A reply's `parentMessageId` must be in the same channel (422 `PARENT_MESSAGE_NOT_IN_CHANNEL`), checked in the one insert helper both
  the route service and the provider seam use.
