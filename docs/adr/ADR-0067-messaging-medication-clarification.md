# ADR-0067 — A medication question is one atomic, idempotent send-and-task over shipped parts, routed to the patient's primary nurse, and never an order

- **Status:** **Accepted** (2026-10-14; the decisions are closed in the WP 3.10 blueprint. No clinical-lead or pharmacy sign-off is recorded, and all wording is provisional pending that review.)
- **Date:** 2026-10-14
- **Phase:** Messaging Hub Phase 3 (WP 3.10, Medication-clarification flow).
- **Extends:** [ADR-0059](ADR-0059-messaging-clinical-links-read-through.md) (the read-only `medication` clinical link and its authorisation), [ADR-0060](ADR-0060-messaging-sbar-structured-messages.md) (per-tenant ops flag default off), [ADR-0061](ADR-0061-messaging-communication-tasks.md) (the communication task; this ADR fills decision 2's reserved `source_kind` column), [ADR-0062](ADR-0062-messaging-clinical-handoffs.md) (the recipient eligibility rule, the supervisor alert audience and the flag, route and web-gate pattern), [ADR-0010](ADR-0010-tenancy-rls-invariants.md), [ADR-0011](ADR-0011-ownership-inversion-rls-bypass.md) (no cross-module table access).
- **Related:** [ADR-0005](ADR-0005-manifest-single-source-of-truth.md) (no manifest change: no new table and no new import edge). [ADR-0063](ADR-0063-messaging-chart-promotion.md) (the same rule: nothing in chat reaches an order).
- **Amends the data model in** `docs/messaging-hub/02-architecture-and-domain.md` only by adding one column to `communication_task` (see "Data model").

## Context

The hub plan (`03-phases-0-to-3.md`, WP 3.10) wants an aide to ask a nurse about a medication from a patient-linked thread: link the medication, send it to the assigned nurse as a task, the nurse contacts the prescriber, and any order is entered in the orders module. Workflow D in `05-clinical-workflows-and-safety.md` states the safety rule: an instruction typed in chat never becomes an order, and the aide has no ordering route. The permission matrix denies "Create/modify order from chat" to every role, and hazard H-04 is mitigated by "No order route; banner on medication links".

Facts that shape the design:

- The parts already exist. WP 1.2 gives an idempotent send, WP 3.2 gives the read-only `medication` clinical link with its authorisation (feature flag, `prescribing.read`, caseload or scope, read-only seam), and WP 3.4 gives the communication task with a partial unique index per message and assignee.
- The care team seam `CareTeamProvider` already returns the patient's open primary nurse assignment (at most one per patient) and the care team member ids. It deliberately returns no roles, so there is no "all nurses" lookup.
- The offboarding reassign in WP 3.4 picks a successor as the task creator first. For a medication question the creator is the aide, so a nurse leaving would send the question back to the person who asked it.
- An aide often lacks `prescribing.read`, and granting it is a tenant decision.

## Decision

1. **One atomic, idempotent entry.** `POST /api/v1/messaging/channels/:id/medication-questions` builds the body on the server, sends it through the existing send core, and creates the task inside the same transaction. To do that the send core gains one optional hook, `inTransaction?: (tx, sent) => Promise<void>`, called after the clinical link rows are reconciled and only when the send is not a replay. This is a send-core extension: it is the only change to the send core, and the in-memory core calls the hook with a null transaction. If the hook throws, the message, the link and the task all roll back. Idempotency uses the existing `Idempotency-Key` middleware and a required `client_message_id`. On a replay the hook does not run, the service returns the task already stored for that message and creator, `created` is false, and nothing is published. `created` is true for a fresh unrouted send too. Rejected: send, then convert (an orphan message after a crash, and a second task if routing changed in between).
2. **The server builds the body and the text is never parsed.** A pure builder emits one paragraph with the text verbatim and, if a medication was given, one `medication` clinical link node. The result goes through the existing `resolveRichWrite` and `validateRichBodyLinks`, so the link authorisation is exactly WP 3.2's, with no bypass and no widening. There is no SBAR, attachment, mention, quote or thread reply on this route; root messages only. The text goes only into the sealed message and no code reads it.
3. **The medication link is optional.** A caller who can link picks a medication. Otherwise the dialog says to describe the medication in the question and the nurse links it in a reply. A supplied `medication_id` that fails the WP 3.2 checks is a 422 `CLINICAL_LINK_NOT_AVAILABLE` and nothing is written. This WP does not grant `prescribing.read`.
4. **One column, no new table.** `communication_task.source_kind` (migration `1104_m36_task_source_kind.sql`) with values `message` (default) and `medication_question`. It fills the column ADR-0061 decision 2 reserved. It is needed so that offboarding never returns a medication question to its asker, the nurse's list and close dialog can say "Medication question", and a CHECK forbids a medication-question task whose assignee is its creator, on insert, manual reassign, offboarding and handoff alike. It is immutable because it is left out of the column-level UPDATE grant. It is non-PHI and the audit trigger is unchanged.
5. **Who "the nurse" is.** A pure rule resolves the assignee: (1) if the caller chose a colleague, that user must be on the patient's care team, not the caller, and eligible, else 422 `MEDICATION_QUESTION_ASSIGNEE_INVALID` and nothing is written; (2) else the primary nurse, if not the caller and eligible, with routing `primary_rn`; (3) else unrouted. Eligible means the handoff recipient rule (active user, `messaging.read`, `messaging.send`, `patient.read`, Part 2 gate, fails closed) and `canViewChannel`. A seam or lookup error counts as ineligible. No M5 change: filtering by role would need a new seam method, which is a non-goal.
6. **No silent fallback.** If nobody is eligible and `allow_unrouted` is not true, the answer is 422 `MEDICATION_QUESTION_NO_NURSE` and nothing is written. With `allow_unrouted: true` the message and link are sent with no task, `m36.medication_question.unrouted` is published in the same transaction, supervisors (`clinical_supervisor`, `don`) get an in-app alert, and the response says `routed: false`. The UI states that this is not the emergency path. The same event is published when offboarding finds no successor (decision 9).
7. **Channel rule.** The channel must be a `care_team` channel with a patient, else 422 `MEDICATION_QUESTION_NOT_PATIENT_CHANNEL`. The patient comes from the server, never the client. An archived channel gives the send core's 410.
8. **No new permission.** Asking is sending a message: `messaging.send`, channel visibility and the `Idempotency-Key`. Reading the options needs `messaging.read` and visibility. The caller does not need `patient.read`. No order or prescribing permission is read, granted or implied anywhere, and the task grants its assignee nothing.
9. **Offboarding.** For `source_kind = 'medication_question'` the successor order is the primary nurse (a lookup error skips it), then the care team sorted and excluding the creator. If nobody is left the task is flagged `needs_owner` as today and the unrouted event is published. Ordinary tasks are unchanged.
10. **Flag.** A new ops flag `messaging.medication_questions`, default off. Enabled means the flag and `messaging.tasks`. When off, POST answers a uniform 404 and the options route answers 200 `{ enabled: false }`. The web reads only that `enabled`, never the feature-flag hook. The offboarding change runs whatever the flag says.
11. **Closing.** The nurse closes with the existing reason codes (usually `action_taken`). Closing never touches an order. The close dialog says: "If an order is needed, it is entered and signed in Orders. Closing this task does not change any order."
12. **H-04 banner.** The web clinical link chip for the `medication` kind always shows the fixed line "Messages can't change medications. Orders are entered in Orders."

## Deviations and clarifications

- **The send core is extended.** The `inTransaction` hook (decision 1) is an addition to `sendMessage` and its interface in `packages/messaging`. It is optional, runs after the link rows and before commit, never on a replay, and no other caller passes it.
- **Deep link.** The unrouted alert opens `/messaging?channelId=<id>&messageId=<id>`; access is re-checked on open.
- **`created` on the unrouted path.** `created` is true when a fresh send happened, including a fresh unrouted send with no task. It is false only on a replay.
- **Role key.** The supervisor audience copies WP 3.5's role keys exactly (`clinical_supervisor`, `don`).

## Data model

- Migration `packages/db/migrations/1104_m36_task_source_kind.sql`: `communication_task.source_kind text NOT NULL DEFAULT 'message'`, a CHECK on the two values, a CHECK `source_kind <> 'medication_question' OR assignee_id <> created_by`, and a partial index on `(organization_id, message_id, created_by)` for medication questions. No grant change: table-level INSERT covers the column and the column-level UPDATE grant leaves it out. RLS, FORCE and the audit trigger are inherited.
- Code mirrors: `packages/db/src/schema/messaging/communication-tasks.ts`, `packages/types/src/messaging-task.ts` (`TaskSourceKind`, `TaskDto.source_kind`), and `packages/types/src/messaging-medication-question.ts` (request and response types, error codes, flag key). No manifest change.
- Event: `m36.medication_question.unrouted`, payload `{ organizationId, channelId, messageId, askedByUserId, reason, at }`, no patient id and no text, outbox only, consumed by M36.

## Routes

Both under `/api/v1/messaging`, registered from `routes/medication-question-routes.ts`.

| Method and path | Guard | Notes |
|---|---|---|
| `POST /channels/:id/medication-questions` | `messaging.send`, channel visibility, `Idempotency-Key` | Body `{ text, medication_id?, assignee_user_id?, allow_unrouted?, client_message_id }`. 201 on a fresh send, 200 on a replay. Read-audit on the message with the patient id. |
| `GET /channels/:id/medication-questions/options` | `messaging.read`, channel visibility | `{ enabled, patient_linked, patient_id, nurse, colleagues, links_enabled }`. Discloses care team names, so it is read-audited. |

Errors: 404 uniform for a hidden channel or a flag that is off; 422 `MEDICATION_QUESTION_NOT_PATIENT_CHANNEL`, `MEDICATION_QUESTION_ASSIGNEE_INVALID`, `MEDICATION_QUESTION_NO_NURSE`, `CLINICAL_LINK_NOT_AVAILABLE`, `VALIDATION_FAILED`; 410 for an archived channel.

## Alternatives considered

- **Send, then convert to a task.** Leaves an orphan message if the process dies between the two, and a second task if routing changed. Rejected for the hook.
- **A new table for medication questions.** Everything needed is ids already held by `communication_task` and `clinical_link`. Rejected.
- **Parse the question to find the drug or detect an instruction.** Heuristics on free text invite false confidence either way. The text is never read.
- **Find a nurse by role.** Needs a new M5 seam method. Deferred; the primary nurse plus a care-team chooser covers the flow.
- **Fall back to any nurse or to the supervisor silently.** Hides that nobody owns the question. Rejected for an explicit unrouted send plus an alert.
- **Grant aides `prescribing.read` so they can always link.** A tenant decision, not ours.
- **Reuse the web clinical link picker gate.** It reads a feature-flag hook that is dead in the real app. The web reads the options route instead.

## Consequences

- A question, its link and its task exist together or not at all, and a retry never makes a second task.
- No code in this WP imports M11, M12 or the orders, prescribing or medication-administration packages, reads or grants an order permission, or names an `m11.` or `m12.` event.
- The migration is additive and the flag hides the feature, so rollback is safe: the column defaults to `message`, rows stay, and no rich-body node type was added.
- Accepted limits: a chosen colleague may not be a nurse (they can reassign; the default is the primary nurse); the supervisor alert is organisation-wide by role with no fallback if it reaches nobody (the aide is told to follow the agency phone procedure); a replay ignores a changed assignee or `allow_unrouted`; the options list can be stale (the server re-resolves on POST); no escalation, paging or due timers (Phase 4).
- The supervisor alert for an unrouted ask is deduplicated per channel, asker and 10-minute window (the emitter absorbs a repeat correlation id); each send still publishes its own event. The POST has no route-specific per-user limit beyond the platform-wide rate-limit tiers (SD-055), so a determined user can still create many messages, but not many supervisor alerts.
- A medication link must belong to the channel's patient (a mismatch is the single 422 `CLINICAL_LINK_NOT_AVAILABLE`). The options route runs up to 21 eligibility checks per call (the primary nurse plus the capped colleague list); it is read-only and behind the normal rate-limit tiers, and a batched eligibility seam is deferred.

## Verification

- Static tests: no order path (imports, event names, permission keys, seams, no regular expression or string parsing of the text, no `orders.*` or `prescribing.*` literal outside the read allowlist, no M36 migration granting order permissions) and no foreign writes (`m36-medication-question-no-order-path.test.ts`, `m36-medication-question-no-order-route.test.ts`, `m36-medication-question-no-foreign-writes.test.ts`).
- Route and event tests: `m36-medication-question-routes.test.ts`, `m36-medication-question-events.test.ts`.
- Live suite `test:m36:medication-question:live` (`m36-medication-question.live.test.ts`), on a private database as the real `wardenx_app` role with the real catalog-validating publisher: the Workflow D path, the "increase morphine" text leaving M11 and M12 tables and the outbox untouched, replay, rollback, unrouted and offboarding paths, the immutable `source_kind`, cross-tenant 404 and the read-audit row.
- Gates: `arch:tenancy`, `arch:migration-numbering`, `arch:outbox-bindings`, `arch:live-suites`, `arch:openapi-coverage`, `arch:error-envelope`, `arch:adr-docs`.

## Open questions

- Clinical-lead and pharmacy review of all wording and of the H-04 banner (the H-04 owner).
- Whether a tenant wants a role-based nurse lookup, which needs an M5 seam method.
- Escalation of an unanswered medication question belongs to Phase 4.
