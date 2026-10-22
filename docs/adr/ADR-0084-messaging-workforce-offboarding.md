# ADR-0084 — Workforce offboarding: one idempotent, derived, audited operation that reuses what already exists and never leaves an urgent request silent

- **Status:** **Proposed** (2026-10-19). Built and always on (a security control, no tenant flag). **OPEN for the clinical lead and SEC: see "Open human decisions". Everything marked "conservative default" is an engineering proposal, not a decision.**
- **Date:** 2026-10-19
- **Phase:** Messaging Hub Phase 5, WP 5.9 (`docs/messaging-hub/04-phases-4-to-6.md` row 5.9; UI spec §5.9; capability SG-07; Workflow F in `05-clinical-workflows-and-safety.md`).
- **Extends:** [ADR-0083](ADR-0083-messaging-session-device-controls.md) (the session revoke is reused, not rebuilt), [ADR-0078](ADR-0078-messaging-supervisor-reassign.md) (acknowledgment requests move through the supervisor reassign), [ADR-0079](ADR-0079-messaging-unwatched-and-supervisor-attention.md) (the shared supervisor attention alert), [ADR-0054](ADR-0054-realtime-transport-socketio-valkey.md) (access revocation on `m2.user.deactivated` / `m2.membership.revoked`).
- **Related:** [ADR-0070](ADR-0070-messaging-escalation-timers.md) (escalation), [ADR-0080](ADR-0080-messaging-oncall-directory.md) / [ADR-0081](ADR-0081-messaging-role-send.md) (the on-call seam), [ADR-0010](ADR-0010-tenancy-rls-invariants.md) (tenancy).
- **Numbering note:** this branch started from 1de6f3e81 (last ADR 0083, last migration 1130). A later merge must re-check both numbers.

## Context

Checked in the code, not assumed. WP 1.4 already runs, **on the outbox event** (`m2.user.deactivated`, `m2.membership.revoked`), an access-revocation consumer (`access-revocation.ts`): channel memberships are soft-removed, the user's sockets are dropped, the WP 3.4 task sweep moves each active task to its creator then the care team (else flags it `needs_owner` and tells the creator), and the WP 3.5 handoff sweep declines a leaving recipient's offers and flags a leaving sender's to supervisors. It is idempotent and never depends on a tenant flag. It does **not**:

- touch an **acknowledgment request** that waits on the leaver (the request keeps a departed assignee; the escalation timer and `canViewChannel` guard stop it from paging them, but nobody is told and nobody moves it);
- list **sessions and push endpoints** (M2 reaps sessions of a deactivation, but an endpoint registered before ADR-0083 or whose session ended is left `verified`; a **revoked membership** reaps nothing in M2);
- remove **scheduled sends, reminders, snoozes** (a scheduled send is blocked by the dispatcher's membership check but the sealed body stays queued);
- say anything about **urgent messages without a tracked request** (the recipient is fixed at birth by a trigger) or the **on-call roster**.

M19 owns the roster and does nothing on deactivation. M36 has no reader for it: the only M19 contact is the `EscalationRouter` seam, which is a fail-closed deny-stub today. M36 may not edit the roster (table ownership).

The lifecycle review queue (`messaging_review_item`) is keyed to a patient lifecycle trigger and an open communication task (`item_kind`), so it does not fit an acknowledgment request and was **not** reused as a store.

## Decision (proposed)

1. **One operation, no new store.** `GET /api/v1/messaging/governance/offboarding/:userId` is a dry run; `POST …/execute` does the work. Neither adds a table or a column: each step **recounts the live rows**, so the result is derived, a re-run after a partial failure finishes the remainder, and a re-run after success changes nothing (`acted` is 0 everywhere). The record of a run is its audit row. (Migration 1131 adds only the permission.)
2. **Steps, in execution order, each with a decision.** Access is cut first.

| Item | What M36 does | Through |
| --- | --- | --- |
| `sessions_devices` | revoke every live staff session of the user bound to the organisation (the endpoints linked to them are expired with each); endpoints no session links to are expired only when the whole account is `deactivated` (an endpoint belongs to the person and has no organisation, so an officer of one organisation must not expire a person's endpoints in another) | the ADR-0083 `revokeForUser` (transaction, audit, socket close); endpoints expired, never deleted |
| `channel_memberships` | soft-remove active memberships (history and attribution stay) | the existing `endChannelMembershipsForUser` |
| `tasks` | move to creator then care team, else flag `needs_owner` (flagged = needs a person) | the WP 3.4 sweep |
| `handoffs` | decline offers to the user; flag offers from the user to supervisors | the WP 3.5 sweep |
| `ack_assigned` | move each **waiting** request (pending, escalated, failed_unreachable) to the first eligible colleague of the existing picker with reason `assignee_left_organisation` (migration 1158; before it the run used `assignee_unable_to_sign_in`); one nobody can take **stays assigned** (visible in the unacknowledged queue) and raises the shared supervisor attention alert with the new reason `assignee_departed`, once per request and version; an **acknowledged but unresolved** request is only counted (a supervisor cannot move it) | the ADR-0078 `supervisorReassign`, the ADR-0079 `raiseSupervisorAttention` |
| `ack_sent` | keep (the sender is never changed); count only | none |
| `urgent_untracked` | count urgent messages addressed to the user in the last 72 hours that have no acknowledgment request; **needs a person** (the recipient cannot be changed) | read only |
| `oncall_seats` | **advisory only**: "check the roster" (M19's; M36 cannot read it) | none |
| `scheduled_sends` | delete the user's pending/blocked scheduled sends (the owner's own cancel operation); nothing is ever sent as them | owner-scope delete |
| `reminders_snoozes` | delete | owner-scope delete |
| `drafts` | **keep** (never sent, never shown); count only | none |

   Past messages are never touched: attribution is kept, nothing is deleted.
3. **State per item** is `done`, `pending` (preview), `needs_person`, `kept`, `advisory` or `failed`. After a run, work a reassign could not finish is `needs_person` and a sweep that left rows behind is `failed` (run again). `complete` is true only when nothing is `pending`, `needs_person` or `failed`; `kept` and `advisory` never block. A step that throws is `failed`, the others still run, and the response carries no error text.
4. **Fail closed, org-bounded.** The user must be in the officer's organisation (a membership row exists): another tenant's user and an unknown id are **the same 404**. A user who has not left (an active membership and an active account) is a **409** `OFFBOARDING_USER_ACTIVE`: this is not a way to inspect active staff. A person has left when their account is `deactivated` or **every** membership in the organisation is `revoked`; `pending` and `suspended` are reinstatable and are not offboarding.
5. **Permissions.** Preview needs the **new** key `messaging.offboarding.manage` (category `admin`; migration 1131 grants it to the two full-catalog admin roles only, exactly like `messaging.sessions.manage`). Execute needs that key **and** `messaging.read` + `messaging.review` (the keys of the supervisor-reassign route it calls through) **and** a fresh step-up for `messaging.offboarding.execute` (platform floor). The officer who runs it is the actor of every reassign.
6. **Audit.** `m36.offboarding.viewed` and `m36.offboarding.executed` (compliance retention): resource = the departed user, actor = the officer, per-item `{state, count, acted}` and `complete`. Ids, fixed keys and counts only. Every reassign and revoke also writes the audit rows of the services reused (`m36.session.revoked`, the ack `reassigned` event naming the officer and the reason).
7. **No double notification.** The supervisor attention alert is idempotent on `offboard-attn:<request>:<version>`; a reassign publishes the normal `m36.ack.reassigned` event only when it changes something; a re-run changes and notifies nothing. The reminder sweep never alerts a departed user because their reminders are removed.
8. **Trigger stays officer-initiated.** The access cut that must not wait (memberships, sockets, tasks, handoffs) is already event-driven (WP 1.4). Auto-running the rest on `m2.user.deactivated` was not built: moving a clinician's open urgent requests is a decision for a supervisor (open decision 1), and a new outbox binding would have needed the same sign-off. The screen is reached by the officer from the user's page.
9. **The web.** `/messaging/governance/offboarding/:userId` (`messaging.offboarding.manage`): a flat checklist on the shared kit, "Done N of M" as text, each state a word plus a glyph, counts, a confirm (alert dialog) before running, the server's answer replacing the list, a failed row labelled "Failed, run again" and the button becoming "Run again", a `needs_person` acknowledgment row linking to the unacknowledged queue, a stale step-up sent through the step-up screen, polite announcement, focus to the heading after a run. Not built from the UI-spec sketch: a per-row "Reassign…" dialog (the acknowledgment reassign and the task/handoff dialogs live on their own screens) and a stored "Mark complete" button (complete is derived, there is no store to set).

## Open human decisions and recommended defaults

The owner of each decision has not signed. Each item below carries an engineering **Recommended default (awaiting owner sign-off)**: what to choose if there is no better argument, why, and what it costs. **None of these changes runtime behaviour in this ADR**: the code keeps the "today" behaviour until an owner signs and a separate change is made.

### 1. Second approver for moving an offboarded clinician's open urgent request

- **Today:** the officer's run moves the request to the first eligible colleague; if nobody is eligible it stays assigned and raises the supervisor attention alert.
- **Recommended default (awaiting owner sign-off):** **no second approver for the move; a named clinical lead is paged when nobody is eligible.** Keep the single officer-initiated, step-up-protected run, and make the "nobody eligible" case page the clinical lead (the alert recipients of ADR-0079) instead of only listing the request.
- **Rationale:** the move never acknowledges anything (only the new assignee can take responsibility, in their own session), is fully audited with officer and reason, and is idempotent; a second approver adds latency to a request that is already waiting on a person who has left. The real risk is a request nobody owns, which the clinical-lead page addresses.
- **Consequence:** faster hand-over, one fewer approval surface; a mistaken reassign is correctable by the same supervisor reassign. Cost: the clinical lead must hold the existing supervisor attention keys, and a second approver for a clinician's whole workload (not per request) is not available. Owner: clinical lead and SEC.

### 2. Retention of the leaver's drafts

- **Today:** drafts are kept, never sent, never shown; counted only.
- **Recommended default (awaiting owner sign-off):** **keep unreadable for the tenant's messaging retention period, then delete through the ADR-0086 retention job; never hand to a supervisor.**
- **Rationale:** a draft is unsent PHI-bearing text written by someone who is gone; showing it to a supervisor creates a new read path to content that was never a record of care, while indefinite keeping has no purpose. ADR-0086 (retention and legal hold) already governs deletion and honours legal holds.
- **Consequence:** no new store or UI; needs the retention job to learn the draft table and the departed owner (a follow-up change). Until then drafts stay as today. Cost: a supervisor cannot recover useful clinical text from a draft, and the owner of that policy must say that is acceptable. Owner: privacy/compliance.

### 3. On-call vacancy ownership with M19

- **Today:** M36 shows an advisory "check the roster"; it cannot read M19's roster and may not edit it.
- **Recommended default (awaiting owner sign-off):** **M19 owns it: M19 reacts to the deactivation/revocation event and raises a coverage-gap alert for any seat the leaver held; M36 only links to it from the offboarding page.**
- **Rationale:** table ownership puts the roster in M19, so any M36 reader would be a second reader of M19 data (a new seam) and would leave M36 deciding what a gap is. An alert at the owner works even when nobody runs offboarding.
- **Consequence:** the item stays advisory in M36 until M19 ships the consumer; the seam stays a single-owner one. Cost: depends on M19 scheduling, so a vacated seat is invisible in the interim exactly as today. Owner: M19 module owner with the clinical lead.

### 4. Auto-trigger on `m2.user.deactivated`

- **Today:** the access cut (memberships, sockets, tasks, handoffs) is event-driven; the rest is officer-initiated.
- **Recommended default (awaiting owner sign-off):** **stay officer-initiated, but add a prompt**: a deactivation raises an in-app notice to the officers holding `messaging.offboarding.manage` ("run offboarding for this user") instead of running the operation automatically.
- **Rationale:** the run moves a clinician's urgent requests, which is a supervisor-level decision (decision 1), needs a fresh step-up that an event consumer cannot have, and an automatic run under no actor would need a system-actor audit model. A notice closes the "nobody remembered" gap without those.
- **Consequence:** one new outbox binding with a notice and no mutation (still needs `outbox-deferred-consumers` handling and an alert rule), everything else unchanged. Cost: a person must still act, so a leaver's requests wait until they do. Owner: SEC.

### 5. Who is "the security officer", and a second approver for the run

- **Today:** `messaging.offboarding.manage` is held by the two full-catalog admin roles; the run needs a fresh step-up; no second person.
- **Recommended default (awaiting owner sign-off):** **a designated, named security-officer role per organisation (not every admin), keyed to `messaging.offboarding.manage` and `messaging.sessions.manage` together; no second approver for the run, but the run is reported to a second named person.** The session policy that ADR-0083 leaves open for SEC should be decided in the same sign-off, so both features share one officer definition.
- **Rationale:** the run is org-bounded, idempotent, step-up protected and audited with actor and counts; a second approver blocks an urgent access cut, but a mandatory after-the-fact notice gives oversight. Using one officer definition for sessions and offboarding avoids two diverging role lists.
- **Consequence:** a role/grant migration and a notice (a follow-up change). Cost: until a role is created the two full-catalog admins remain the officers (today's behaviour); the "reported to" person is a new configuration. Owner: SEC.

### 6. The reason code (decided and built)

Not an owner decision, built as asked: the dedicated `assignee_left_organisation` (migration 1158 widens the ack-history CHECK of migration 1126; wording "The assigned person has left the organisation"; the offboarding reassign writes it). It is part of the shared reason set, so the supervisor reassign route and screen accept it too (accepted: it is accurate, non-clinical and audited). Rows written before 1158 keep `assignee_unable_to_sign_in`.

### 7. The untracked-urgent window

- **Today:** 72 hours, count only (`needs_person`); no alert and no send-time refusal.
- **Recommended default (awaiting owner sign-off):** **keep 72 hours; do not refuse at send time; raise a supervisor alert for an untracked urgent message addressed to the leaver.**
- **Rationale:** 72 hours covers a weekend plus a day of staffing change, and older urgent messages are history rather than live risk. Refusing at send time would block a sender from reaching a user who is already unreachable in the directory, which is a different (send-policy) decision that belongs to the urgent-messaging ADRs. A message with no request has no key for the alert, so it should be keyed on the message id.
- **Consequence:** a small change to raise the alert (idempotent on `offboard-urgent:<message>`); Cost: more alerts for a busy clinician and a fixed window that does not adapt per tenant. Owner: clinical lead.

## Consequences

- Two migrations. `1131_m36_workforce_offboarding.sql`: a permission row and its admin grants. `1158_m36_ack_reason_assignee_left.sql`: the ack-history reason CHECK widened by one value (mirrored in `packages/types`, the Drizzle schema, the web wording and the typed client). No table, no column, so no manifest, ownership or tenancy change.
- Two routes, one service with ports, three step files, two audit actions, one new supervisor-attention reason, one screen. OpenAPI enriched and the typed client regenerated.
- A live suite (`test:m36:workforce-offboarding:live`, CI row added) proves, as `wardenx_app` with REAL Better Auth sessions: preview changes nothing; execute moves the request an eligible colleague can take (history names officer and reason), leaves the stuck one assigned and visible with one alert, revokes both sessions (next REST call 401) and expires every endpoint (linked and unlinked), ends memberships, moves the task and handoff, removes the scheduled send / reminder / snooze, keeps the draft and past messages, leaves M19 untouched; re-run is a no-op; a step that failed once resumes; no step-up, no key, no review key and another tenant are refused (foreign = unknown); audit rows carry counts only.

## Known ceilings

- **The preview/execute counts are point-in-time.** Two officers running at once converge (every step is idempotent) but a request moved by the first may be reported by the second as `acted: 0`.
- **A stale reassign failure raises the supervisor alert** even when the request was acknowledged in the meantime (the alert is keyed to the request version, so it is not repeated).
- **The first eligible colleague** (name order) takes a moved request; there is no load balancing and no choice offered. The picker already excludes the sender and anyone the Part 2 gate walls off; an officer walled off from a patient moves nothing for that patient and the request stays visible.
- **On-call is never "done"**: it is advisory by construction until M19 exposes a reader.
- **Reminders and snoozes are deleted, not archived**; the scheduled send's sealed body is deleted with its row (the same as the owner's own cancel).
- **A person removed here but active elsewhere keeps their other organisation's sessions and every endpoint not linked to a session of this organisation** (found by review, covered by a live test). A platform-wide deactivation reaps the rest in M2.
- **An untracked urgent message raises no supervisor alert** (there is no request to key it to); it is only a `needs_person` count on the officer's page. Accepted gap, open decision 7.
- **Up to 2000 waiting requests are attempted per run**, each trying the picker's colleagues in order (never the officer or the leaver); a stuck one raises its alert once per version, and the ops notice for an unpaged alert is raised once per request and version per process.
- **No rate limit on the two routes** (they need the key, the reassign keys and a fresh step-up).
