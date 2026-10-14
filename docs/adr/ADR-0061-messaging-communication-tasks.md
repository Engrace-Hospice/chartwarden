# ADR-0061 — Communication tasks are a thin M36 row that points at a message, with one active task per message and assignee, a closing reason for clinical concerns, and reassignment when the owner leaves

- **Status:** **Accepted** (2026-10-14; the decisions are closed in the WP 3.4 blueprint. No clinical-lead sign-off is recorded.)
- **Date:** 2026-10-14
- **Phase:** Messaging Hub Phase 3 (WP 3.4, Communication tasks).
- **Extends:** [ADR-0059](ADR-0059-messaging-clinical-links-read-through.md) (a thin M36 row holds ids and no text, so there is no second PHI store), [ADR-0060](ADR-0060-messaging-sbar-structured-messages.md) (per-tenant ops flag, default off; the same migration and audit pattern), [ADR-0054](ADR-0054-realtime-transport-socketio-valkey.md) (this ADR fills the seam it left in WP 1.4: the owned-item reassignment hook that was a no-op), [ADR-0057](ADR-0057-escalation-ownership-m19-m36.md) (tasks do not escalate; ownership and escalation stay Phase 4), [ADR-0010](ADR-0010-tenancy-rls-invariants.md) (tenancy rule for the new tables), [ADR-0011](ADR-0011-ownership-inversion-rls-bypass.md) (no cross-module table access).
- **Related:** [ADR-0005](ADR-0005-manifest-single-source-of-truth.md) (shared types live in `packages/types`; table ownership lives in the manifest).

## Context

The hub plan (`03-phases-0-to-3.md`, WP 3.4) wants "Convert message to task": an assignee, a due date, a link back to the message, lifecycle events, inbox integration, and IDG-sourced items that delegate to M14. The architecture note also says there is no second action-item system, and Workflow F says offboarding never leaves an urgent item without an owner.

Five facts shape the design:

- M14 already owns action items (`idg_action_item`). An item can only be created by the IDG meeting route, can only be changed through M14's own route, and has no seam that another module can use to create, read or close it. An IDG action item also never reaches M36 as a message: it arrives as an alert. So there is nothing for a message to convert into an IDG item, and nothing in M36 may reach into M14 tables.
- The "Notifications & Tasks" screen already exists, and its Tasks tab is a placeholder. Assignment alerts can go through the same `AlertEmitter` seam that mention alerts use.
- The access-revocation consumer already calls `reassignOwnedItems` when a membership is revoked or a user is deactivated. It is bound to a no-op (`reassignOwnedItemsNoop`, left by WP 1.4). WP 3.4 is the first owned item that can use it.
- A task points at a message, and a message can be read only by people who can see its channel. A task must therefore never become a side door that shows a message to someone who could not read it.
- Messaging is not the emergency path. A task that looks like a work order must not be mistaken for paging or escalation.

## Decision

1. **A task is a thin M36 row, not a second action-item system.** Two tables: `communication_task` and an append-only `communication_task_event`. A task references one message and carries only ids, a status, a due time, two flags and a closing reason code. It has no title, no message excerpt and no free text. The message is read through the conversation, so there is no second PHI store (the same rule as ADR-0059).
2. **M14 delegation is a prohibition plus a reserved extension, not a call.** In WP 3.4, M36 never reads or writes M14. A static test fails the build if code under `tasks/` imports `14-idg` or `@wardenx/idg`, or names `idg_action_item`. A message that merely links an IDG meeting (WP 3.2) is an ordinary message and gets an ordinary task. If a later work package converts IDG alerts into tasks, the task gets `source_kind = 'idg_action_item'` and its lifecycle is read and written only through a new M14 reader and writer seam. This is the only reading of the acceptance text that adds no cross-module write surface. **It is a decision to confirm, not a silent assumption.**
3. **The feature is an ops flag, `messaging.tasks`, default off, per tenant.** It is read through the feature-flag port with the same 5-second cache as clinical links and SBAR. With the flag off, the single-task and write routes answer the uniform 404, the list route answers `200 {enabled:false, tasks:[]}` so the web can hide the UI without a flood of 404s, and the patient-context tile is absent.
4. **No new permission.** Reads need `messaging.read`. Every write needs `messaging.send` plus visibility of the task's channel (the same posture as reactions and pins). On top of that, only the task's creator or assignee may read or act on it. Anyone else gets the uniform 404. A new permission would need an M3 mirror migration and role grants for a gate that adds nothing the per-row rule does not already give.
5. **The assignee is a user id and must be able to read the channel.** The assignee must be an active user who can see the message's channel (the same `canViewChannel` rule, including the 42 CFR Part 2 gate), checked at create and at reassign. Otherwise the answer is the uniform `422 TASK_ASSIGNEE_INVALID`. Self-assignment is allowed. Visibility is checked again on every later read and action: a person who loses the channel no longer sees the task, and the row is unchanged.
6. **The patient is derived by the server, never sent by the client.** `patient_id` is the channel's subject when the channel kind is `care_team` or `bereavement`, and empty otherwise.
7. **Clinical concern is a stored flag with a closing-reason rule.** `clinical_concern` is computed by the server as: the task has a patient, or the creator asked for it. It can be raised at create and never lowered, and a patient-linked task is always clinical (database CHECK). A clinical task cannot move to `done` or `cancelled` without a reason from a closed set (`422 TASK_CLOSE_REASON_REQUIRED`, with a database CHECK as the backstop). A non-clinical task may close with or without a reason; a supplied reason is still validated and stored.
8. **The reason is a code, not text.** The set is `action_taken`, `handled_elsewhere`, `no_action_needed`, `unable_to_complete`, `duplicate`. There is no free-text note, so there is no PHI string to seal or scrub. Narrative belongs in the thread. The label wording is provisional pending clinical-lead review; the codes are the contract.
9. **Creating a task twice is safe.** A partial unique index allows one active (`open` or `accepted`) task per message and assignee. A second request returns the existing task with `200` and `created:false`, inserts no row, writes no event, publishes no outbox event, and does not change the task (a replayed due date or clinical flag is ignored). If the earlier task is closed, a new one is allowed: a closed task is history, and a fresh concern about the same message must be able to open fresh work. Two requests at the same instant are safe because the index decides (`INSERT ... ON CONFLICT DO NOTHING RETURNING`, then a read).
10. **When the owner leaves, the task is never left without one.** On `m2.membership.revoked` and `m2.user.deactivated` (not `suspended`, which can be reversed), each active task assigned to the leaver goes to the first eligible person in this order: the task's creator, then for a patient task the care-team members in a stable order. Eligible means: not the leaver, active, able to see the channel, and not already holding an active task on that message. The task returns to `open`, and a `reassigned` event records reason `offboarding` and the system actor. If nobody is eligible, the task keeps the leaver as assignee, gets `needs_owner = true` and a `needs_owner` event, and the creator (if active) is alerted and can reassign it. The handler runs again safely: after reassignment the query no longer matches. It works under an explicit organisation context (relay ticks are not requests), takes tasks in batches of 100 until none match, isolates a failure to its own task, and rethrows at the end so the dispatcher retries. The flag does not matter here: access revocation must never depend on a flag.
11. **No escalation, paging, timer or auto-close.** Overdue is a display state only. The UI says that tasks do not page anyone and are not for emergencies. Mapping tasks to escalation is Phase 4 work under ADR-0057.
12. **Statuses and moves.** `open`, `accepted`, `done`, `cancelled`:

    | From | Action | By | To |
    |---|---|---|---|
    | open | accept | assignee | accepted |
    | open, accepted | complete | assignee | done (reason rule above) |
    | open, accepted | cancel | creator or assignee | cancelled (reason rule above) |
    | open, accepted | reassign | creator or assignee | open (new assignee eligible, no active task of theirs on the message) |
    | done, cancelled | anything | none | `409 TASK_STATE_CONFLICT` |

    Done and cancelled are final; a new task is created instead of reopening. Repeating the same action by the same person on a task already in the target state returns `200` with the current row and writes no event. Writes use `UPDATE ... WHERE status IN (allowed from-states) RETURNING` with a version counter, and zero rows leads to a re-read that decides between replay and conflict. A due date is optional, not earlier than five minutes ago and not later than 366 days ahead (`422 TASK_DUE_INVALID`).
13. **Inbox integration is two things.** First, an in-app assignment alert through the `AlertEmitter` seam, in the same way as mention alerts: the consumer takes the organisation from the event envelope only, checks again that the recipient can still see the channel, skips self-assignment, and sends fixed generic text with no names, no patient and no message text. Second, the Tasks tab of `/notifications` becomes the real "My tasks" list. There is no new screen and no new navigation entry.
14. **The open-tasks tile counts the caller's own tasks.** The patient-context tile "Your open tasks" counts active tasks on the patient that the caller created or holds, on channels the caller can see. A team-wide count would tell a viewer that clinical concerns were raised in conversations they cannot read. The tile uses the same guard as the other chart tiles (`patient.read` plus caseload or scope, break-glass not honoured) and is dropped when the flag is off.
15. **Retention, holds and erasure follow the message.** Both tables hold a composite foreign key to the message with `ON DELETE CASCADE`, so the eraser and any hard delete of a message remove the tasks (as for `clinical_link`). A message tombstone does not touch the task; the web shows "message no longer available". `wardenx_app` has no DELETE on either table, in line with the Phase 3 gate "lifecycle-no-delete". `wardenx_destruction` holds SELECT and DELETE under an organisation policy. There is no separate retention clock and no separate legal-hold logic: a held message cannot be erased, so its tasks stay.

## Data model

Migration `1100_m36_communication_task.sql` (check `arch:migration-numbering` against `main` first; `main` ends at 1099).

- **`communication_task`:** `id`, `organization_id`, `message_id`, `channel_id` (copied from the message at create, never changed, so lists need no join), `patient_id` (nullable), `created_by`, `assignee_id`, `due_at`, `status`, `clinical_concern`, `closed_reason`, `needs_owner`, `accepted_at`, `closed_at`, `version`, timestamps. Database CHECKs hold the status set, the reason set, "a reason only when closed", "a clinical task cannot close without a reason", "a patient task is clinical" and "closed_at is set exactly when closed". The partial unique index on (`organization_id`, `message_id`, `assignee_id`) for active statuses is the idempotency arbiter. Further indexes lead with `organization_id` for the assignee, creator and patient lookups. A unique (`organization_id`, `id`) lets the event table use a composite foreign key.
- **`communication_task_event`:** append-only; `event_type` (`created`, `accepted`, `done`, `cancelled`, `reassigned`, `needs_owner`), actor (a user, or the system actor with no user id), from and to status, from and to assignee, `reason_code` (the closing code, or `offboarding` or `manual` for a reassignment).
- **Tenancy and grants:** organisation-keyed, FORCEd row-level security on `app.org_id`. `wardenx_app` holds SELECT and INSERT on both tables, and on the task table a column-level UPDATE on only the columns that change (`assignee_id`, `status`, `closed_reason`, `needs_owner`, `accepted_at`, `closed_at`, `version`, `updated_at`), so `patient_id`, `created_by` and `message_id` cannot be rewritten. The event table has no UPDATE and no DELETE.
- **Audit:** the task table gets a bespoke write-audit trigger that scrubs `patient_id` (as for `clinical_link`), and records the actor as `system` when no user is set (offboarding). The event table gets the generic audit trigger, with ids and timestamps only.
- **Code mirrors:** closed unions in `packages/types/src/messaging-task.ts`, a pin test that compares them with the migration CHECK lists, the Drizzle schema, and `ownedTables` entries for both tables in the manifest (`.ts` and `.cjs`).

## Events and the outbox

Four events are added to the M36 catalog. All are outbox-only, owned by M36, published inside the write transaction, and carry no patient id and no reason:

- `m36.task.created` (consumer: M36 task notifications)
- `m36.task.reassigned` (consumer: M36 task notifications; source `manual` or `offboarding`)
- `m36.task.needs_owner` (consumer: M36 task notifications)
- `m36.task.status_changed` (no consumer, like `attachment.cleared`)

A replay publishes nothing. The notification consumer is bound in `apps/backend/src/index.ts` next to the mention consumer, and the offboarding closure replaces the `reassignOwnedItemsNoop` binding (the no-op function stays exported for other tests). Three alert rules are seeded in the platform defaults, in-app only, in the same shape as the mention rule.

## Routes

All under `/api/v1/messaging`; the organisation and the actor come from the request context only.

| Route | Guard | Behaviour |
|---|---|---|
| `POST /channels/:id/messages/:messageId/tasks` | `messaging.send` + channel visibility | Create. `201 {task, created:true}`, replay `200 {task, created:false}` |
| `GET /tasks` | `messaging.read` | `scope=assigned\|created`, `state=active\|closed\|all`, limit default 50, max 100 |
| `GET /tasks/:taskId` | `messaging.read` | Creator or assignee only; includes events; read-audited with a resource id |
| `POST /tasks/:taskId/accept` | `messaging.send` | Assignee |
| `POST /tasks/:taskId/complete` | `messaging.send` | Assignee; optional reason |
| `POST /tasks/:taskId/cancel` | `messaging.send` | Creator or assignee; optional reason |
| `POST /tasks/:taskId/reassign` | `messaging.send` | Creator or assignee; `409 TASK_ASSIGNEE_ALREADY_HAS_ACTIVE` |

Errors: the uniform `404` for flag off (single-task routes), missing, not a participant, hidden channel and deleted message; `422` `TASK_ASSIGNEE_INVALID`, `TASK_DUE_INVALID`, `TASK_CLOSE_REASON_REQUIRED`, `TASK_CLOSE_REASON_INVALID`; `409` `TASK_STATE_CONFLICT`, `TASK_ASSIGNEE_ALREADY_HAS_ACTIVE`. Responses carry a server-computed `allowed_actions` list, so the web never re-derives the policy. No `Idempotency-Key` header is needed: idempotency rests on state and the database index, so no header read is added.

## Alternatives considered

- **Add a task path through M14 for IDG items.** M14 has no seam for it, and an IDG item never arrives as a message. Building the seam now would add a cross-module write surface for a case that cannot occur. Rejected; the extension is reserved in decision 2.
- **Store a title or note on the task.** It would be a second PHI store with its own sealing, scrubbing and retention. Rejected; the message is the content and the thread is the place for narrative.
- **A new `messaging.task` permission.** It needs an M3 mirror migration and role grants and adds nothing the per-row participant rule does not give. Rejected.
- **A team-wide open-tasks count on the tile.** It would disclose that clinical concerns exist in conversations the viewer cannot read. Rejected in favour of the caller's own count.
- **A free-text closing reason.** It would put PHI in a column that needs sealing and a lint. Rejected in favour of a closed code set.
- **Reopen a closed task.** It would blur history and the audit trail. Rejected; a new task is created.
- **Escalate overdue tasks or page the assignee.** It would be an escalation path before the on-call and acknowledgment design (ADR-0056, ADR-0057) exists. Rejected until Phase 4.
- **Reassign on `suspended`.** A suspension can be reversed, and the existing handler already treats it as such. Rejected.

## Consequences

- **New flag `messaging.tasks`, default off.** It gates the routes, the web UI and the tile, following the `messaging.clinical_links` and `messaging.sbar` pattern.
- **Rollback is safe.** No rich-body node was added. The flag only hides the UI and the routes; the rows stay and are removed with their messages. Offboarding reassignment keeps running with the flag off.
- **Migration `1100`** creates both tables, the triggers, the grants and the policies described above.
- **OpenAPI and client.** The routes are added to the generated OpenAPI document and the typed client.
- **Known limits (accepted).**
  - A replay ignores a changed due date or clinical flag.
  - A person who loses access to the channel no longer sees their task. If both the creator and the assignee lost access or left, the task stays flagged `needs_owner` with no organisation-level view until the Phase 4 ownership model (ADR-0057).
  - The tile counts only the caller's own tasks.
  - The list is capped at 100 with no cursor.
  - Display names are resolved per request.
  - The reason labels are provisional; clinical-lead sign-off is not recorded.
  - A clinical task may close with `no_action_needed`. The reason is recorded and audited, not judged.
  - A task can be created in any channel kind the caller can see, including an announcement channel.
- **Non-goals.** Escalation, paging, SLA timers, reminders and auto-close; free-text titles or notes; any M14 read or write and any conversion of IDG alerts; coupling to handoff (3.5) or chart promotion (3.6); bulk actions; a team task board or supervisor view; a new permission; scheduled or recurring tasks.

## Migration / rollout

**Rollout order.** (a) Deploy this build to every instance (API and worker) with `messaging.tasks` off. (b) Enable the flag for one pilot tenant. (c) Ask the clinical lead to review the reason labels and the alert wording before wider use.

**Rollback.** Turn the flag off. The server stops accepting task routes within a few seconds (5-second flag cache), and the web hides the UI at the next page load. Rows stay. There is nothing to undo in the data. Rolling the build back leaves the two tables in place and unused, which is harmless.

## Verification

- Pure rules: every from-state, action and actor combination including repeats; the closing-reason rule for a patient task, a flagged task and a plain task; due-date bounds; patient derivation for every channel kind.
- Service with a fake store: a replay returns the existing task and publishes nothing; a closed earlier task allows a new one; an assignee who cannot see the channel gets the uniform `TASK_ASSIGNEE_INVALID`; a clinical close without a reason is refused before the store.
- Offboarding: the creator is preferred, the care-team order is stable, a throwing care-team seam still reassigns or flags, no successor gives `needs_owner` and an event, and a second run changes nothing.
- Route tests: flag off per route, byte-identical 404s for missing, not a participant, hidden channel and deleted message, `201` versus `200`, each `422` and `409`, and the read-audit configuration with a resource id.
- Static tests: `tasks/` code does not import M14 or name `idg_action_item`; no task code reads `request.headers`; a pin test keeps the TypeScript unions equal to the migration CHECK lists.
- Event catalog test: four events, and no `patientId` or `reason` key in any payload.
- Live suite `test:m36:tasks:live` as the real `wardenx_app` role over the real catalog-validating publisher, on a private container: cross-tenant isolation, concurrent creates giving one row, one event and one outbox row, the CHECKs refusing a clinical close without a reason even through raw SQL, no DELETE and no UPDATE of protected columns, audit rows without `patient_id`, offboarding paths and redelivery, a read event with a non-empty resource id, cascade on message hard delete, and the tile counting only the caller's tasks.
- Fitness: `arch:tenancy`, `arch:manifest-mirror`, `arch:migration-numbering`, `arch:outbox-bindings`, `arch:route-reachability`, `arch:error-envelope`, `arch:live-suites`, `arch:openapi-coverage`, `arch:adr-docs`, `arch:fitness`.

## Open questions

None gating. To confirm with the product owner: decision 2 (no M14 call in WP 3.4). Left for Phase 4: whether tasks map to escalation or an acknowledgment deadline, and an organisation-level view of tasks with no reachable owner.
