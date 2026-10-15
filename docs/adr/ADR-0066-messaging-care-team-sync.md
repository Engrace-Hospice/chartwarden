# ADR-0066 — Care-team sync routes a removed clinician's open tasks to the review queue: access is cut by the existing roster check, nothing is reassigned or closed automatically, and handoffs are not queued, in WP 3.9

- **Status:** **Accepted** (2026-10-15; the decisions are closed in the WP 3.9 blueprint. No clinical-lead sign-off is recorded.)
- **Date:** 2026-10-15
- **Phase:** Messaging Hub Phase 3 (WP 3.9, care-team sync).
- **Extends:** [ADR-0054](ADR-0054-realtime-transport-socketio-valkey.md) (realtime rooms and per-user hints: unchanged, decision 8), [ADR-0061](ADR-0061-messaging-communication-tasks.md) (tasks, close-reason codes, eligibility), [ADR-0062](ADR-0062-messaging-clinical-handoffs.md) (handoff accountability, unchanged) and [ADR-0065](ADR-0065-messaging-lifecycle-review-queue.md) (the review table, routes, tab, permission and alerts are reused unchanged; its decision 10 is the contract this ADR fulfils). The channel membership lifecycle (GAP-104, `channel-membership-sync`) is unchanged except for the routing step.
- **Related:** [ADR-0010](ADR-0010-tenancy-rls-invariants.md), [ADR-0011](ADR-0011-ownership-inversion-rls-bypass.md) (no cross-module table access).
- **Amends the data model in** nothing. No migration.

## Context

Doc 02 section 9 and workflow F say a care-team change (M5) must update channel access at once and send the removed clinician's open work "for review". Most of it already exists and is live-proven:

- M5 publishes `m5.patient.assignment_ended` (`{patientId, organizationId, clinicianUserId, role}`) in the same transaction as the `unassigned_at` update. M17 visit reassignment publishes no care-team event and does not feed the roster.
- The push half (`channel-membership-sync`) soft-removes the clinician's `auto` channel-member row from a roster diff. The pull half (`effectivelyVisibleChannels`, inside `canViewChannel` and `listChannels`) re-reads the live roster on every decision, so access is lost the moment the assignment ends, before any consumer runs. A seam error is a denial.
- What was missing: the removed clinician's open tasks vanish from their list (task visibility re-checks channel access) and nobody is told they are orphaned.

## Decision

1. **D1. Extend the existing consumer, add no new one.** On `m5.patient.assignment_ended`, `channel-membership-sync` syncs membership as before and then calls `routeForReview(org, patient, clinician, outboxEventId)`. `clinicianUserId` becomes required (a malformed payload throws, as today). A routing failure throws so the relay retries; the sync is idempotent. The catalog already declares `m36` as consumer, so `arch:outbox-bindings` is unchanged.
2. **D2. Route only if the clinician is really off the team.** The roster is re-read through `CareTeamProvider.careTeamMembers` outside any transaction (a seam read inside one starves the pool). A clinician who still holds another open role stays on the team and nothing is queued. A seam failure is rethrown (retry), never read as "removed".
3. **D3. Nothing is reassigned, closed or flagged automatically.** The clinician is still employed and the task is still real work. `needs_owner` is not set (it would hide the task from the offboarding sweep). A supervisor decides through the ADR-0065 queue.
4. **D4. Tasks only.** An open task assigned to the removed clinician, for this patient, on a `care_team` channel, status open or accepted (flagged or not), becomes one `messaging_review_item` row: `source = 'care_team_change'`, `cause = 'care_team_removed'`, `item_kind = 'task'`, `subject_user_id` = the removed clinician, written through 3.8's exported `queueReviewItems` in one system-context transaction. Capped at 500 per event (counts only are logged). The existing unique indexes mean a task already under a lifecycle review is not queued twice.
5. **D5. The trigger reference is the outbox event id.** The payload carries no assignment id, and the event id is stable across redelivery, so a redelivered event inserts nothing.
6. **D6. Alerts.** The supervisor alert is 3.8's `m36.review.queued` (fixed text, hashed correlation id), sent only when the `messaging.tasks` flag is on. Rows are queued regardless of the flag, as in 3.8. It is re-sent on redelivery so a first attempt that failed after the insert still alerts; the correlation id dedupes. The removed clinician gets no alert: the 3.8 assignee text says the patient left hospice care, which would be false here, and a separate text was not worth a new provisional wording.
7. **D7. Manual membership is the one honest exception.** A `manual` member (added by `messaging.manage_members`, audited) is never touched by the sync, so that person keeps access. The reviewer removes it through the existing member route.
8. **D8. No realtime change.** Sockets join `careteam:<patientId>` at connect, but nothing emits to that room; hints go to per-user rooms resolved from live member rows and carry ids only. A static test fails if any backend source emits to a care-team room, so this is revisited before it changes.
9. **D9. Scope is M5 only.** Part 2 revocation (`m39-consent-revoked`) and offboarding (`access-revocation`) keep their own removal paths and are not routed. No route, screen, permission, flag, event or table is added; the web only gains a label.

## Known limits

- **Handoffs are not queued.** An offered handoff keeps the ADR-0062 guarantees: the sender stays accountable until it is accepted, and an unaccepted offer expires within 240 minutes and alerts supervisors. A handoff from a clinician who was removed from the team therefore stays visible to them as its participant (participant rule, Part 2 re-applied) until it is accepted or expires.
- Manual members keep access (D7).
- Id-only realtime hints can reach the removed clinician during relay lag; REST is denied at once and the web polls, so an open conversation stops loading on its next poll.
- The task read is outside the queue transaction. An assignee closing a task in that gap leaves an open row for a closed task; the 3.8 decision path resolves it as `closed_elsewhere`.
- A quick re-assignment can queue items for a clinician back on the team; the reviewer closes them. The roster check narrows but cannot remove this race.
- The label "Removed from the care team" and all alert text are provisional pending clinical-lead sign-off.

## Verification

Unit tests for the pure rules, the router and the consumer; two static tests (the care-team code writes nothing but queue rows and imports no other module; no backend source emits to a care-team room); the live suite `m36-care-team-review.live.test.ts` (`test:m36:care-team-review:live`) over the real catalog-validating publisher and the real alert emitter. The live suite delivers the real `m5.patient.assignment_ended` event shape to the consumer rather than running the M5 assignment service; the immediate loss of channel access is proven by `m36-channel-membership-lifecycle.live.test.ts`.
