# ADR-0068 — Urgency is a fixed column set by one entry, "Urgent clinical": a patient care-team channel, an SBAR body and one named qualified recipient, behind a flag, with no paging, escalation or acknowledgment in WP 4.1

- **Status:** **Accepted** (2026-10-14; decisions closed in the WP 4.1 blueprint). **All wording, the qualified-role map and the stricter readings below are PROVISIONAL: no clinical-lead sign-off is recorded.** The sign-off items are listed in `docs/messaging-hub/brief-clinical-lead-signoff.md` (section 4) and the feature ships behind the ops flag `messaging.urgent_clinical`, default off.
- **Date:** 2026-10-14
- **Phase:** Messaging Hub Phase 4 (WP 4.1, Urgency model).
- **Extends:** [ADR-0056](ADR-0056-clinical-acknowledgment-vs-read-receipts.md) (urgency vocabulary, decisions 6 and 7; the "urgent cannot be edited" rule), [ADR-0060](ADR-0060-messaging-sbar-structured-messages.md) (SBAR; the urgency hint stays a label), [ADR-0062](ADR-0062-messaging-clinical-handoffs.md) (the recipient eligibility rule and the flag, route and web-gate pattern), [ADR-0067](ADR-0067-messaging-medication-clarification.md) (the atomic entry over the send `inTransaction` hook).
- **Related:** [ADR-0057](ADR-0057-escalation-ownership-m19-m36.md) (routing by role or on-call is WP 4.3 and belongs to the `EscalationRouter` seam), [ADR-0010](ADR-0010-tenancy-rls-invariants.md), [ADR-0011](ADR-0011-ownership-inversion-rls-bypass.md).
- **Amends the data model in** `docs/messaging-hub/02-architecture-and-domain.md` only by adding the `urgency` column the plan already lists on `message`, plus one nullable recipient column (see "Data model").

## Context

The plan (`04-phases-4-to-6.md`, WP 4.1) wants `routine / important / urgent` on `message`, and an "Urgent clinical" composer mode that needs a patient link, an SBAR body and a selected qualified recipient (or role). Its copy must say messaging is not the emergency path. Acceptance: an urgent send without a recipient or patient is rejected, and the UI shows the agency emergency-procedure notice.

Facts that shape the design:

- The acknowledgment request is WP 4.2, the `EscalationRouter` seam is WP 4.3, timers are WP 4.4 and per-urgency channel policy is WP 4.6. WP 4.1 must not create any of them or page anyone.
- The SBAR form already carries a sender-chosen `urgencyHint` label. A static test (`m36-sbar-no-escalation.test.ts`, threat E-4) fails the build if server code reads it. The label must not become the urgency, and message text must never be parsed.
- ADR-0056 already decided that an urgent message cannot be edited once sent, and that Critical is a later acknowledgment class, not a message urgency.
- The 05 matrix lets an assigned clinician, an aide and a team lead initiate an urgent escalation; an org admin conditionally; compliance not. Acknowledging clinical responsibility is for a qualified role; an aide is receipt only.
- Roster, on-call and shift resolution live in M19. A bare role without that resolution has no reliable person to notify (hazard H-02, wrong recipient).

## Decision

1. **A column, not a table.** `message.urgency` (`message_urgency` enum: `routine`, `important`, `urgent`; NOT NULL, default `routine`) and `message.urgent_recipient_user_id` (nullable, FK to `user`). A CHECK ties them: `(urgency = 'urgent') = (urgent_recipient_user_id IS NOT NULL)`. WP 4.2's request will hang off `message_id`. Migration `1105_m36_message_urgency.sql`; the existing `message` RLS, FORCE and the three-column rule are unchanged because every row already carries `organization_id`.
2. **Fixed at send.** A BEFORE UPDATE trigger refuses any change to either column, for any role including the superuser. An urgent message cannot be edited: the edit transaction refuses it with 422 `URGENT_MESSAGE_NOT_EDITABLE`, before the edit-window check. A soft delete (tombstone) stays allowed; **WP 4.2 must cancel the acknowledgment request when its message is deleted.**
3. **One writer.** Only `POST /api/v1/messaging/channels/:id/urgent-messages` sets `urgent`. The ordinary send, edit, schedule and draft paths accept no urgency field (their schemas are closed, and a static test pins it) and write the default. `important` has no writer in WP 4.1: its deadline policy is WP 4.2. The read surfaces return `urgency` only when it is not `routine`.
4. **Never inferred.** The server does not read the message text, the SBAR sections or `urgencyHint` to decide anything. The SBAR block must be present (`URGENT_SBAR_REQUIRED` otherwise) and pass the existing SBAR policy; the hint's value is irrelevant. The request schema has no urgency, role or deadline field (`additionalProperties: false`).
5. **Patient link.** The channel must be a patient `care_team` channel (the patient comes from the channel, as in WP 3.10), else 422 `URGENT_NOT_PATIENT_CHANNEL`. Clinical-link nodes are optional and authorised exactly like a normal send; a link to another patient's record is the single `CLINICAL_LINK_NOT_AVAILABLE`.
6. **Recipient: one named person, qualified, on the care team, in the channel.** The recipient must (a) be on the patient's care team (CareTeamProvider seam), (b) be an active member of the channel and able to view it, (c) be active, hold `messaging.read`, `messaging.send`, `patient.read` and the new `messaging.urgent.receive`, and pass the Part 2 gate (WP 3.5's `recipientEligible` plus the extra key), (d) not be the sender. Any seam or permission failure reads as "not qualified". Every failure is one uniform 422 `URGENT_RECIPIENT_INVALID` that names no reason, so it is not an oracle for who is on a team or what role they hold. The core re-checks the structure (patient channel, SBAR, active member, not the author) whatever the caller did.
7. **"Or role" is deferred (stricter reading).** WP 4.1 accepts a named individual only. Naming a role or the on-call person needs M19's roster, tier and shift resolution, which is the WP 4.3 `EscalationRouter` seam; guessing a person from a role here would put H-02 back. The plan wording "(or role)" is therefore met in WP 4.3.
8. **Permissions (stricter reading of the 05 matrix).** Two new M3 catalog keys, granted by migration to role keys wherever a tenant has created them (the 1102 pattern; a tenant tightens by removing a grant). `messaging.urgent.send` (raise one, on top of `messaging.send` and channel visibility): clinical roles, lpn, msw, chaplain, and the aide keys (`chha`, `aide`, `hospice_aide`, `home_health_aide`) per the matrix; **not** org admin (the matrix says "conditional") and **not** compliance. `messaging.urgent.receive` (be named as recipient): rn, rn_case_manager, director_of_nursing/don, physicians and prescribers (`md`, `physician`, `hospice_physician`, `medical_director`, `attending_clinician`, `np`, `nurse_practitioner`, `pa`), `clinical_supervisor`, `clinical_lead`; **not** lpn, msw, chaplain, aides, volunteers, org admin or compliance. An aide may raise but can never be a recipient.
9. **Flag.** `messaging.urgent_clinical` (ops flag, default off, absent = off, a read error = off) AND `messaging.sbar`. Off: POST is the uniform 404 (identical to a hidden channel) and the options read answers `200 {enabled:false}`.
10. **Atomic and idempotent.** The message, its link rows and the outbox event commit in one transaction (the send core's `inTransaction` hook); a failure anywhere removes the message. `client_message_id` plus the `Idempotency-Key` replay a retry; a reused `client_message_id` that names a different recipient (or turns a routine send urgent) is the idempotency conflict (409), never a silent replay.
11. **Notification, and where 4.1 stops.** The event `m36.message.urgent_sent` (ids and one instant: `organizationId, channelId, messageId, authorUserId, recipientUserId, at`; no patient id, no name, no text) is published in the send transaction. The consumer `m36.urgent-notifications` re-checks that the recipient can still view the channel and emits ONE generic in-app alert (`You have an urgent clinical message`, severity `warn`, category `clinical_urgent`, seeded rule limited to `in_app`), deduplicated per message and recipient. **Nothing pages, escalates, times out or asks anyone to acknowledge** in WP 4.1; the alert is an inbox entry, and it is not the emergency path. Opening or reading the message has no clinical meaning. Out-of-band channels, quiet-hours floors, templates, deep links, the acknowledgment request, timers and the unacknowledged queue are WP 4.2 to 4.9.
12. **UI.** A composer action "Urgent clinical" appears only on a patient care-team channel when the options route says the mode is on. Its dialog shows a permanent, non-dismissible notice that messaging is not the emergency path (follow the agency telephone/emergency procedure) and that sending does not page or escalate anyone; it asks for one recipient from the qualified list, restates "This goes to <name> and is marked urgent. It cannot be edited after sending." and puts the name on the send button (hazard H-02, confirm step), then the four SBAR sections with the tenant's length floors. Urgent messages carry a text-and-icon badge "Urgent clinical" (never colour alone, a labelled note for screen readers), absent on routine messages and tombstones. Wording is in `urgent-wording.ts`, one constants file, provisional. A tenant-specific agency phone line is **not** shown: the fixed sentence points at "the agency telephone/emergency procedure" and no tenant can remove or soften it.
13. **Audit.** The POST and the options read declare `auditRead` (the message or channel as resource, the patient id), like WP 3.10. The existing message write-audit trigger is unchanged (the new columns hold an enum and a user id, no PHI).

14. **Rate limit (provisional numbers).** The urgent POST runs a fail-closed per-route limiter after authorisation: 10 per minute per sender, 100 per minute per organisation, and 5 per 5 minutes per (sender, recipient) pair (`bootstrap/plugins/urgent-rate-limit.ts`, on the shared `RateLimitStore`; a store outage is a 503, never an unlimited send). A refusal is a 429 with `Retry-After`. Where only the in-memory store exists the caps are per replica. The numbers are provisional pending the clinical lead.
15. **Retry beats eligibility.** The service looks up an existing send by `(author, channel, client_message_id)` first; a retry to the SAME recipient skips the live eligibility check and the send core replays the original (200), even if the recipient has since left the channel or lost the key. A different recipient on a reused id is checked as usual and ends in the idempotency conflict. The core's structural check now runs after the insert and only for a new message (a refusal rolls the insert back).
16. **New-tenant role templates.** `messaging.urgent.send` and `.receive` are in `FULL_CATALOG_EXCLUDED_KEYS`, so the full-catalog `org_admin` / `administrator` roles never receive them; the only role templates that grant them are `director_of_nursing` and `medical_director`, matching migration 1105 (a pin test asserts the holders).
17. **Consume-time checks.** The consumer re-checks that the recipient can still view the channel AND still holds `messaging.urgent.receive`; either failure (or a lookup error) alerts nobody and writes an id-only log line with a reason code.
18. **Defence in depth in the database.** A BEFORE INSERT trigger on `message` refuses an urgent recipient who is not an active member of the message's own organization (`SECURITY DEFINER`, reads `membership` only). The options read examines at most 100 care-team members.

## Data model

- Migration `packages/db/migrations/1105_m36_message_urgency.sql`: enum `message_urgency`; `message.urgency`, `message.urgent_recipient_user_id`; CHECK `message_urgency_shape`; partial index `message_urgent_recipient_idx (organization_id, urgent_recipient_user_id, created_at)` (the foreign key's covering index, and what WP 4.9's queue will read); trigger `trg_message_urgency_immutable`; the two catalog rows and role grants.
- Code mirrors: `packages/db/src/enums.ts` (`messageUrgency`), `packages/db/src/schema/messaging/messages.ts`, `packages/types/src/messaging-urgency.ts` (`MESSAGE_URGENCIES`, flag and permission keys, DTOs, error codes), `packages/auth/src/permissions/contributed.ts`. No new table and no new import edge, so the manifest (`.ts` and `.cjs`) is unchanged.
- Event: `m36.message.urgent_sent` in `events-by-m36.ts` (outbox-only, consumer module `m36`); alert rule seed `m36.message.urgent_sent` in `packages/messaging/src/seed/alert-rules.ts`.

## Routes

Both under `/api/v1/messaging`, registered from `routes/urgent-routes.ts`.

| Method and path | Guard | Notes |
|---|---|---|
| `POST /channels/:id/urgent-messages` | `messaging.send`, `messaging.urgent.send`, channel visibility, `Idempotency-Key` | Body `{ body_doc, recipient_user_id, client_message_id }`, closed schema. 201 created, 200 replay. 422 `URGENT_NOT_PATIENT_CHANNEL`, `URGENT_SBAR_REQUIRED`, `URGENT_RECIPIENT_INVALID`, `SBAR_INVALID`, `CLINICAL_LINK_NOT_AVAILABLE`. |
| `GET /channels/:id/urgent-messages/options` | `messaging.read`, channel visibility | `{ enabled, patient_linked, patient_id, recipients[] }`, qualified care-team colleagues who can see the channel, names only, at most 30. |

404 is uniform for a hidden channel, a malformed id and a flag that is off.

## Alternatives considered

- **Let the ordinary send route take `urgency`.** Spreads the writer over send, schedule, draft and edit, and lets a client mark anything urgent without a recipient. Rejected for one entry.
- **Derive urgency from the SBAR `urgencyHint`.** Turns a free label into a safety trigger and breaks the E-4 guarantee. Rejected.
- **A separate `urgent_message` table.** Everything needed is one enum and one user id; the 4.2 request is the right place for lifecycle state. Rejected.
- **Accept a role as the recipient now.** Needs the M19 roster and tiers; deferred to WP 4.3 (H-02).
- **Make urgent messages editable inside the window.** The product owner decided otherwise (ADR-0056).
- **Page the recipient (SMS or push) now.** Needs the 4.6 policy floor, the 4.7 PHI-free templates and the 4.2 acknowledgment to mean anything; a page with no acknowledgment is the false assurance hazard (H-01). Rejected.
- **Show an agency-specific emergency phone number.** Needs a tenant setting and a place nobody can blank out; deferred by the product owner (2026-10-14) and recorded as an open item below and in the clinical-lead brief.
- **Lock the seeded alert rule (`systemLocked`).** The locked set is a platform-wide pinned list backed by database triggers; adding to it is a separate decision. **Accepted limit:** a tenant admin can disable the in-app rule `m36.message.urgent_sent`, which silences the recipient's alert; the message itself stays visible and marked.

## Consequences

- A sender cannot create an urgent message without a patient, SBAR and a qualified, named, reachable-in-channel colleague, and a database trigger and CHECK back that up.
- A routine message can never become urgent and an urgent one can never be softened or edited.
- The recipient is told in the app only. Until WP 4.2 to 4.4 land, nobody tracks whether the recipient acted: the dialog and the sent-status text say so, and the feature stays flag-off by default. **It must not be enabled for a tenant as a clinical safety net before those packages ship.**
- Accepted limits: the qualified-role map and the lack of an lpn recipient are provisional; an urgent message's deletion does not yet cancel anything (nothing exists to cancel); the alert is not guaranteed delivery beyond the existing in-app path.
- The rollback is safe: the columns default to `routine`, rows stay, the flag hides the entry, and no rich-body node type was added.

## Verification

- Pure and service tests: `packages/messaging/__tests__/urgent-rules.test.ts`, `urgent/urgent-service.test.ts`, `outbox-consumers/urgent-notifications.test.ts`.
- Route, event, static and pin tests: `m36-urgent-routes.test.ts`, `m36-urgent-events.test.ts`, `m36-urgent-no-escalation.test.ts` (one writer; no paging, escalation, timers, acknowledgment, `urgencyHint` or text parsing in the urgent code; closed request schemas elsewhere), `m36-urgency-migration-pin.test.ts` (enum, CHECK, trigger, permission grants).
- Live suite `test:m36:urgency:live` (`m36-urgency.live.test.ts`) on a private database as the real `wardenx_app` role with the real catalog-validating publisher, plus the urgent rows in `m36-tenant-idor.live.test.ts`.
- Web: `urgent-message-button.dom.test.tsx`, `urgent-badge.dom.test.tsx`.
- Gates: `arch:tenancy`, `arch:migration-numbering`, `arch:outbox-bindings`, `arch:abac-composed`, `arch:live-suites`, `arch:openapi-coverage`, `arch:error-envelope`, `arch:adr-docs`.

## Open questions

- Clinical-lead sign-off of every user-facing sentence, the qualified-recipient role map (including lpn), the sender role grants (including whether an org admin may raise one) and the wording of the sent-status text.
- **Open item (deferred by the product owner):** an agency-specific phone or procedure line shown beside the fixed notice (needs a tenant setting that cannot be left blank).
- Role or on-call recipients: WP 4.3 (named individual only in 4.1, confirmed 2026-10-14). The qualified-role maps stay as proposed.
- `important` gets its composer control with WP 4.2, when its deadline policy lands (decided 2026-10-14).
- **Flag policy (decided 2026-10-14): `messaging.urgent_clinical` stays off for every tenant until WP 4.2 to 4.4 ship.** Until then it is for development and sign-off review only.
- Duplicate recipient names are told apart by an ordinal in the chooser ("Sam Lee (2 of 2)"); a role label needs the care-team seam to return roles, which it deliberately does not. Accepted limit.
- Timing: whether the send path answers faster for some refusals than others (care team versus qualification) is an accepted limit, because the caller can already see the channel's members.
