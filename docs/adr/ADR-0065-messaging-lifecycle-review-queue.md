# ADR-0065 — Patient lifecycle is a supervisor review queue, not a rule engine: discharge, death and transfer queue each open care-team task for a decision to reassign or close with a reason code, the existing channel archive is the only posting restriction, and nothing is ever deleted

- **Status:** **Accepted** (2026-10-14; the decisions are closed in the WP 3.8 blueprint. No clinical-lead sign-off is recorded.)
- **Date:** 2026-10-14
- **Phase:** Messaging Hub Phase 3 (WP 3.8, lifecycle rules).
- **Extends:** [ADR-0061](ADR-0061-messaging-communication-tasks.md) (tasks, the close-reason codes, the eligibility rule and the task events are reused unchanged; the org-level task view that ADR-0061 left out is met here for the lifecycle case only) and [ADR-0062](ADR-0062-messaging-clinical-handoffs.md) (pending handoff items are evaluated, not changed; the supervisor alert audience and the flag, route and web-gate pattern are reused).
- **Related:** [ADR-0010](ADR-0010-tenancy-rls-invariants.md), [ADR-0011](ADR-0011-ownership-inversion-rls-bypass.md) (no cross-module table access). WP 3.9 (care-team sync) reuses the table defined here (decision 10).
- **Amends the data model in** `docs/messaging-hub/02-architecture-and-domain.md` only by addition (one thin table).

## Context

Workflow E (`05-clinical-workflows-and-safety.md`) says that when a patient is discharged, dies or transfers out, routine posting is restricted per policy, open follow-ups are reassigned or closed with a justification, and history is reachable only under retention and authorization, with the bereavement channel unaffected. The gate named in `03-phases-0-to-3.md` is `lifecycle-no-delete`.

Facts that shape the design:

- Restriction already exists (GAP-104). `outbox-consumers/channel-membership-sync.ts` archives the patient's care-team channel on `m6.admission.discharged` and `m5.patient.deceased`. Every write path (send, edit, reactions, pins, polls, attachments, scheduled send and its dispatch recheck) answers `410 CHANNEL_ARCHIVED` for an archived channel. Delete (tombstone) is still allowed. Members keep read. `assertMayArchiveChannel` forbids unarchiving a care-team or bereavement channel. Readmission reopens. The bereavement channel is a separate kind with its own archive date.
- Nothing looks at the open `communication_task` rows of a patient who has left care, task create does not check `is_archived`, and no org-level task view exists.
- `m6.admission.discharged` carries no patient id (admission id, reason, date); `reason` is `death`, `moved_out_of_service_area`, `no_longer_terminal`, `for_cause`, `other`, `revocation` or `transfer`. `m5.patient.deceased` also fires when M5 records a death without M6, and an M6 death arrives a second time through the cascade.
- Closing a task for a patient already needs a close-reason code (a CHECK on `communication_task`). The task store waives the participant rule only for the system actor and for handoff reassignment.
- The message table has no urgency column (urgency is a label inside an SBAR body), so a routine/urgent split cannot be enforced.

## Decision

1. **D1. The restriction is the existing archive: platform-fixed, tighten-only, no exceptions.** An archived care-team channel takes no new message of any kind on discharge, death and transfer. There is no new posting policy and no tenant knob: a grace window would loosen the rule, and there is no urgency column to split on. After death, coordination goes to the bereavement channel, direct messages or the phone, and the screen says so. Gap closed: creating a task on an archived channel answers `410 CHANNEL_ARCHIVED`.
2. **D2. Evaluation is a thin reusable review queue.** `messaging_review_item` holds one row per (trigger, open task). In WP 3.8 only tasks on care-team channels are queued; tasks on bereavement channels are excluded by joining the channel kind (the task's patient id is set for both kinds).
3. **D3. One consumer, convergent triggers.** `m36.patient-lifecycle-review` consumes `m6.admission.discharged` and `m5.patient.deceased`. The cause is a pure function: `m5.patient.deceased` and an M6 reason `death` give `death`; reason `transfer` gives `transfer`; anything else gives `discharge`. The trigger reference is the patient id for death (so the M6 and M5 copies converge on one row) and the admission id for discharge and transfer (a later readmission and discharge queues again). Uniqueness on (organisation, source, trigger, item kind, item) plus one open review per item makes redelivery and the double death event insert nothing the second time. For discharge and transfer only, the consumer skips when M6 reports another active or on-hold admission for the patient. Death is never skipped. The tenant comes from the envelope only; a malformed payload or an unresolvable admission throws (retry, then DLQ).
4. **D4. Resolution is reassign or close with a reason code; never delete.** A holder of `messaging.review` reassigns the task to an eligible person (active, can view the task's channel including the Part 2 gate, holds no other active task on the message) or closes it with one of the five existing codes. `action_taken` and `handled_elsewhere` complete the task; the other three cancel it. There is no free-text justification (there is no PHI store for it); the code is the justification and is kept on the task, its event and the review row. When the assignee or creator closes the task themselves, a database trigger resolves the review as `closed_elsewhere`. A reassignment by anyone else (manual, offboarding, handoff) keeps the review open and shows the live assignee, because only a supervisor decision or a close satisfies the rule.
5. **D5. Handoffs are evaluated, not changed.** Pending handoff items keep their ADR-0062 guarantees: the sender stays accountable until acceptance and the expiry (at most 240 minutes) alerts supervisors. An accepted task item moves the task and any open review follows the task id. Cancelling pending items would need new handoff event and close-reason values for no safety gain, so there are no handoff review rows (recorded limit).
6. **D6. No new flag; one new permission.** The queue is gated on the existing `messaging.tasks`. Flag off: the action routes answer the uniform 404 and the list answers `200 {enabled:false, items:[]}`. The consumer queues regardless of the flag (a safety record, like handoff expiry) and alerts only when the flag is on. The permission `messaging.review` (resource `review_item`, action `manage`, clinical, no ABAC) is inserted by migration `1103` and granted by role key to `clinical_supervisor`, `director_of_nursing`, `don` and `clinical_lead`; a key that does not exist is harmless. It is never granted to `org_admin` or `administrator` (excluded from the full-catalog templates). The `director_of_nursing` role template carries it as a `grant`, so a tenant materialized after `1103` has a role that can use the queue; there is no `clinical_supervisor` template, and any other role is granted the permission manually by the tenant.
7. **D7. Supervisor visibility is org-wide for permission holders, and Part 2 is re-applied per row.** The gate runs for the caller on every row. A refusal or a throw makes the row `restricted`: no patient label, no actions, but still listed and counted. Acting on a restricted row answers the uniform 404. Location scoping is a recorded limit.
8. **D8. Alerts are in-app only and carry no patient data.** `m36.review.queued` goes to the supervisor role set (severity warn) and `m36.review.task_needs_decision` to each affected assignee (an always-on fallback). If the supervisor audience resolves to nobody a warning is logged (ids only) and the assignees are still alerted. The correlation id is `review:<first 32 hex of sha256(source:trigger_ref)>:<alertType>[:<userId>]`, which dedupes across both death events and redeliveries and stores no raw patient id. Texts are fixed and provisional, name no patient and no cause. Deep links go to `/notifications?tab=review` and `?tab=tasks`.
9. **D9. Nothing is deleted; history is read under the unchanged rule.** `wardenx_app` has no DELETE on the new table (destruction only through `wardenx_destruction`), and nothing in the review code deletes. History stays readable to current channel members through the unchanged view rule, Part 2 included. M39 expires consents that do not survive death on `m5.patient.deceased`, so a restricted channel can become unreadable after death; that is an authorization rule and is stated here, not a deletion.
10. **D10. Contract for WP 3.9.** 3.9 reuses `messaging_review_item` unchanged: `source = 'care_team_change'`, `cause = 'care_team_removed'`, `trigger_ref` = the M5 assignment id (or the triggering event id), `subject_user_id` = the removed clinician, `item_kind = 'task'`. Both values are already in the CHECKs. 3.9 inserts through the exported `queueReviewItems` and gets the routes, the tab, the permission and the alerts free. 3.9 owns its own summary alert path and, if it queues handoffs, widens `messaging_review_item_kind_shape` in its own migration.

## Data model

One migration, `1103_m36_review_queue.sql`; the code mirrors are `packages/db/src/schema/messaging/review-items.ts` and `packages/types/src/messaging-review.ts` (the module manifest `ownedTables`, `.ts` and `.cjs`, lists the table).

- **`messaging_review_item`**: id, organisation, `source`, `cause`, `trigger_ref`, `patient_id` and `item_id` (logical pointers, no foreign key), `subject_user_id`, `item_kind` (`task`), `state` (`open` or `resolved`), `resolution` (`reassigned`, `closed`, `closed_elsewhere`), `resolution_reason`, `reassigned_to_user_id`, `resolved_by_user_id`, `resolved_at`, `version`, timestamps. CHECKs bind the source and cause pairing, the state and resolution shape, the five codes for `closed`, the target for `reassigned`, and a decider for `reassigned` and `closed`.
- **Indexes:** unique (organisation, source, trigger, item kind, item); partial unique one open review per item; queue, item, patient and subject lookups.
- **Triggers:** `messaging_review_item_refuse_resolved_update` makes a resolved row final. `communication_task_resolve_review` (AFTER UPDATE OF status on `communication_task`, when an open or accepted task becomes done or cancelled) resolves the open review as `closed_elsewhere`. Every task-close path goes through it. It is SECURITY INVOKER.
- **RLS and grants:** enabled and forced, an organisation isolation policy for `wardenx_app`, SELECT, INSERT and column UPDATE only, no DELETE.
- **Audit:** a bespoke PHI-write audit function scrubs `patient_id` and `trigger_ref`.
- **Permission:** the `messaging.review` row and its role grants (decision 6).

## Routes

Under `/api/v1/messaging`, guarded by `messaging.read`, `messaging.review` and `patient.read`: `GET /review-items?state=&limit=`, `POST /review-items/:reviewItemId/reassign` (`{to_user_id}`) and `POST /review-items/:reviewItemId/close` (`{reason}`). Errors are typed (`arch:error-envelope`) and no header is read. A missing, foreign, flag-off or restricted row is the same uniform 404; an ineligible, unchanged or already-holding target is `422 REVIEW_ASSIGNEE_INVALID`; a row or task that is no longer open is `409 REVIEW_ITEM_STATE_CONFLICT`; replaying the same action by the same user on a resolved row returns the current row. The service resolves the review row first and then moves the task, and the task store accepts a `reviewOverride` that behaves as the handoff override does (the actor stays the supervisor).

## Deviations and clarifications

- **Lock order.** The service locks the task, then the review row. The blueprint's text had the review first; the task-close trigger updates the review from the task side, so locking the review first could deadlock against a participant closing the task.
- **`closed_elsewhere` rows have a NULL `resolved_by_user_id`.** The trigger cannot read the closer: `arch:tenancy` bans `app.user_id` outside audit triggers. The closer is on the task event. The CHECK requires a decider only for `reassigned` and `closed`.
- **Restricted rows return `task: null`, `item_id: null`, `cause: null` and `source: null`.** Only `id`, `state`, `item_kind` and `created_at` remain, so the row is still listed and counted but names no patient, task or event (a cause alone says what happened to a patient the viewer may not see).
- **The queue insert cannot race a task close.** The lifecycle queue reads the patient's active tasks `FOR SHARE` in the same transaction as the insert, so an assignee closing a task concurrently waits and its trigger then finds the review (or the queue sees the task closed). As a backstop, a decision on an open row whose task is no longer active resolves the row as `closed_elsewhere` and answers `409`.
- **Reassign eligibility is judged inside the decision transaction**, after the task and review locks, so a target deactivated or removed from the channel in the gap is refused with `422 REVIEW_ASSIGNEE_INVALID` and nothing changes.
- **`messaging.review` is excluded from full-catalog role materialization.** `planRoleTemplateMaterialization` gives `org_admin` and `administrator` every non-platform permission; `FULL_CATALOG_EXCLUDED_KEYS` withholds this one, so a newly provisioned tenant has no default holder until it grants the key to a supervisory role it owns (migration 1103 grants the four supervisory role keys where they exist).
- **The consumer takes one `admissionCare` dependency**, bound to `AdmissionStatusReader.getAdmissionPatientCare`, which answers both the patient id and whether another admission is under care.
- **The list read audit** uses `resourceIdPayloadPath: "items.0.id"` plus `patientIdsPayload`. `list: true` does not combine with `patientIdsPayload` (the plugin's list branch ignores it), so it is not used.
- **The queue is org-wide for permission holders**, so a reviewer in the organisation who is not a member of the channel gets `422` on reassign (they cannot be a target) rather than `404`; the reviewer is not told why.
- `m36.task.reassigned` gains `review` in its `source` union and `TASK_REASSIGN_SOURCES` gains `"review"`; `handoff` stays unpublished. The M5 and M6 catalogs change by comment only (M36 now has two consumers).
- The routine/urgent restriction in the hub plan is dropped for the reasons in decision 1.

## Alternatives considered

- **A tenant posting-policy table with a routine/urgent split.** There is no urgency column, and a grace window loosens a safety rule. Rejected (D1).
- **Auto-reassign or auto-close on discharge.** The system would decide who owns a clinical follow-up. Rejected; a person decides (D4).
- **Free-text justification.** Needs a PHI text store with retention. Rejected; the code is the justification (D4).
- **Cancel pending handoff items on lifecycle events.** New event and reason values for no gain over the existing expiry. Rejected (D5).
- **Locking the review row first.** Deadlock risk against the task-close trigger. Rejected (see Deviations).
- **A new flag.** The tasks flag already gates the objects reviewed. Rejected (D6).

## Consequences

- **Rollback is safe.** The tasks flag hides the routes and the tab; the consumer keeps recording; rows stay.
- **Non-goals.** A tenant posting policy; cancelling or queuing handoff items; tasks on direct or group channels about the patient (no patient link); a location-scoped queue; free-text justification; message bodies in the queue; paging, escalation or reminders for unresolved reviews (Phase 4); queuing the needs-owner orphans of offboarding; re-evaluation on readmission (open reviews stay until resolved); analytics.
- **Known limits (accepted).**
  - The queue is org-wide by role (D7).
  - The list applies its limit in SQL before the per-row Part 2 gate. A supervisor who cannot see some Part 2 patients can therefore get a page with fewer actionable rows than the limit (restricted rows are listed and counted, not dropped, but they occupy page slots). Not redesigned; a keyset cursor or a visibility filter in SQL is the upgrade if it matters.
  - Display names for a page are looked up one at a time (at most 200 distinct people per response).
  - The supervisor decides from task metadata and may lack channel access.
  - Reassign eligibility is checked in two steps. The full check (active member, can view the channel, Part 2 included) runs before the decide transaction because it opens its own connections, which must not be taken while task and review row locks are held (concurrent reassigns would starve the pool). Inside the transaction only the target's active status (on the transaction's own connection) and the no-other-active-task rule are rechecked. A target who loses channel access in the few milliseconds between the two is still assigned; it is a supervisor action, audited, and the new assignee sees nothing they could not already be removed from.
  - A restricted (Part 2) row also hides its `resolution` and `resolution_reason`.
  - A reassignment by a participant, offboarding or a handoff does not resolve the review.
  - Tasks created on an archived channel before this change are not swept, and a task created between the discharge and the archive is queued only if it exists when the consumer runs.
  - Alert texts, close-reason labels and role grants are provisional pending clinical-lead sign-off.

## Verification

- **Pure rules** (`packages/messaging/__tests__/review-rules.test.ts`): every cause mapping, trigger references, the close mapping for all five codes, allowed actions, a stable correlation key that holds no patient id.
- **Static and pin tests:** `apps/backend/__tests__/m36-review-migration-pin.test.ts` (unions equal the CHECK text, both triggers, no DELETE grant, the permission row) and `m36-review-no-delete.test.ts` (no delete or truncate in the review code and the consumer, no other module's schema imported).
- **Route tests** (`apps/backend/__tests__/m36-review-routes.test.ts`) and the consumer test (`outbox-consumers/patient-lifecycle-review.test.ts`).
- **Live acceptance** (`apps/backend/__tests__/m36-lifecycle-review.live.test.ts`, script `test:m36:lifecycle-review:live`, the real `wardenx_app` role, the real catalog-validating publisher, a private container): death never deletes (row counts before and after both death events, the channel archived, history still readable, send answers 410), the bereavement channel is unaffected, open tasks reach the queue, reassign and close end to end, the trigger resolves `closed_elsewhere`, a transfer and an M5-only death queue, audit rows scrub the ids, a Part 2 row is restricted, and tenant isolation.
- **Fitness:** `arch:adr-docs`, `arch:tenancy`, `arch:migration-numbering`, `arch:manifest-mirror`, `arch:outbox-bindings`, `arch:live-suites`, `arch:error-envelope`, `arch:route-reachability`, `arch:openapi-coverage`, `arch:fitness`.

## Open questions

None gating. To confirm with the clinical lead: the alert and close-reason wording, the role grants for `messaging.review`, and whether org-wide supervisor visibility is acceptable before a location-scoped queue exists.
