# ADR-0106 — Emergency message: a flagged send with a frozen audience, per-person acknowledgment and a 15-minute deadline

- **Status:** **Proposed** (2026-11-01)
- **Date:** 2026-11-01
- **Related:** ADR-0068/0069/0070 (urgent clinical message, ack requests, escalation), ADR-0097 (acknowledge-required broadcast, the pattern this follows), ADR-0105 (native push installations), ADR-0057 (EscalationRouter, M19).

## Context

A clinician needs to raise an emergency to a whole channel, a care team or specific tagged colleagues, have every recipient's phone alarm until they
acknowledge, see who has, and have it escalate if nobody does within 15 minutes. What exists today:

- `urgency = 'urgent'` is one message to one named assignee (a CHECK pins it), with a tracked response request and an escalation timer.
- `message_ack_broadcast` (ADR-0097) has a per-person acknowledgment and a frozen audience, but only for announcement-channel messages, display-only
  (no reminder, no escalation), and its guards hard-code the announcement channel.
- There is no repeating re-alert, and mentions only resolve to `staff` and `patient`.

## Decision

- **D1. A sibling, not a stretch.** `message_emergency` and `message_emergency_recipient` (migration 1300) follow the ADR-0097 guard/RLS/audit pattern
  but allow any channel and carry a deadline. They are not a widening of `message_ack_broadcast`, whose announcement-only invariants stay intact.
- **D2. Declaring an emergency.** The author of a live message marks it an emergency; one row per message. The declare route
  (`POST /messaging/messages/:messageId/emergency`) creates the emergency, freezes the audience and publishes one `m36.emergency.sent` event per
  recipient in ONE transaction, so a committed emergency always has its audience and its events. It acts on a message the author already posted (the
  composer posts, then declares; if the second call fails the message stays an ordinary message and the client retries the declare, which is
  idempotent). `urgency` is not used (it is 1:1).
- **D3. Audience frozen at send.** Recipients are written only in the transaction that created the emergency (`created_at = now()`), never include the
  author, and are never reduced or added to afterwards. The route resolves them: the active members of the message's channel, at most 500, at least one
  (typed 422 otherwise). Tagging does not widen the audience beyond the channel; role/team tags (step C) are resolved to people before the send and
  those people are channel members. Eligibility is re-checked when alerting, not by editing the frozen rows.
- **D4. Acknowledgment.** Each recipient acknowledges only for themself; NULL → database clock once, never withdrawn. A late acknowledgment (after the
  deadline) is recorded; the deadline drives escalation, not acceptance.
- **D5. Deadline.** Fixed at 15 minutes after creation on the database clock (the `urgent` default in `ACK_DEADLINE_POLICY`). A client cannot choose it.
- **D6. Visibility.** Only the author reads who has and has not acknowledged (the same uniform 404 as ADR-0097 D5). A recipient sees their own state.
- **D7. Gating.** Tenant flag `messaging.emergency`, absent = off, checked before the request is parsed (uniform 404). No new permission: sending needs
  `messaging.send`, acknowledging `messaging.read`.
- **D8. Alerts are PHI-free.** The alert text is fixed ("Emergency message. Open ChartWarden now.") and names no channel, patient or sender: a
  channel title can be a patient's name, and the push transport only ever sends fixed text, so the channel name appears only after unlock, in the app.
  This is stricter than the "from {channel name}" wording first agreed, deliberately. `m36.emergency.sent` joins the designated set (class always
  critical), so quiet hours and vacation forwarding cannot suppress or redirect it; its seeded rule carries `in_app` + `push` itself so the alarm does not
  depend on the optional notification-policy flag (the policy floor adds SMS on top when that flag is on). A CRITICAL alert is sent to native devices
  loud: FCM on the Android `emergency` channel, APNs `interruption-level: time-sensitive` (no Critical Alerts entitlement yet).
- **D9. Not an SLA.** An OS push is best-effort. The server-side deadline and escalation are the safety net.
- **D10. Re-alarm and escalation (step B).** A queue `messaging.emergency_sweep` runs every minute and stores nothing. For each recipient who has not
  acknowledged and whose emergency is under an hour old it raises the alarm for the current tick (whole minutes since the send, alert id
  `emergency:<id>:<user>:<tick>`, so a repeated tick converges on one alert). Once the deadline has passed with anyone unacknowledged it raises ONE
  `m36.emergency.escalated` alert (id `emergency-escalated:<id>`) to the sender and to the `clinical_supervisor` / `don` roles. The sweep needs no new
  columns: the tick and the deadline come from the existing rows and the clock. iOS cannot loop a sound from a push, so the repeated push is the alarm;
  the mobile app plays its own looping alarm while it is open.

## Consequences

- Two tables, no new permission, one new queue (`messaging.emergency_sweep`).
- The audience is immutable by design: someone who joins the channel after the send is not alarmed. Decided with the product owner on 2026-11-01:
  a frozen, auditable list is the right behaviour.
- The sweep re-alarms by raising a new alert each minute; each alert is its own delivery row, so the sender's roster and the audit trail show every
  repeat. Re-alarming stops after one hour whatever happened (the escalation fires at 15 minutes).
- **Multi-device fan-out (migration 1301).** A critical push is sent to EVERY verified native (FCM/APNs) device of the recipient. The first dispatch of
  the delivery takes the newest device and inserts one pending sibling `notification_delivery` per other device, each bound to its `endpoint_id`
  (`delivery_endpoint_fan_out`, only while the delivery is unbound, and only for devices with no delivery yet, so it is idempotent per
  (alert, device)). Each device therefore has its own status, retry budget and dead-token expiry: a failing token never blocks the others, and an
  `UNREGISTERED` token expires only its own endpoint. A bound critical delivery only ever resolves to its own endpoint. Web Push endpoints and
  non-critical alerts are unchanged (newest verified endpoint only).
- **APNs host per token.** `delivery_endpoint_for_delivery` also returns the `environment` ADR-0105 already records (`sandbox` | `production`); the
  dispatcher puts it in the destination and the APNs transport picks `api.sandbox.push.apple.com` or `api.push.apple.com` per token. A token with
  no recorded environment (older clients) falls back to `APNS_ENVIRONMENT`, so nothing changes for them. This implements ADR-0105 D6.
- Still unproven: delivery to a physical device through the real FCM/APNs vendors.
- ADRs are immutable once Accepted; this one stays Proposed until reviewed.
