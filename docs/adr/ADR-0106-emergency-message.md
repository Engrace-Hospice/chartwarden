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
- **D2. Declaring an emergency.** The author of a live message marks it an emergency; one row per message. The send route (ADR-0106 A2) posts the
  message and creates the emergency + audience in one transaction, so a committed emergency always has its audience. `urgency` is not used (it is 1:1).
- **D3. Audience frozen at send.** Recipients are written only in the transaction that created the emergency (`created_at = now()`), never include the
  author, and are never reduced or added to afterwards. The route resolves them: channel members plus explicitly tagged people (roles/teams in a later
  step, via the escalation router). Eligibility is re-checked when alerting, not by editing the frozen rows.
- **D4. Acknowledgment.** Each recipient acknowledges only for themself; NULL → database clock once, never withdrawn. A late acknowledgment (after the
  deadline) is recorded; the deadline drives escalation, not acceptance.
- **D5. Deadline.** Fixed at 15 minutes after creation on the database clock (the `urgent` default in `ACK_DEADLINE_POLICY`). A client cannot choose it.
- **D6. Visibility.** Only the author reads who has and has not acknowledged (the same uniform 404 as ADR-0097 D5). A recipient sees their own state.
- **D7. Gating.** Tenant flag `messaging.emergency`, absent = off, checked before the request is parsed (uniform 404). No new permission: sending needs
  `messaging.send`, acknowledging `messaging.read`.
- **D8. Alerts are PHI-free.** The alert text is "Emergency message from {channel name}" and nothing else; the details show only after unlock in the app. The
  event types join the designated set so quiet hours and preferences cannot suppress the platform floor (ADR-0106 A2).
- **D9. Not an SLA.** An OS push is best-effort. The server-side deadline and escalation (ADR-0106 B) are the safety net.

## Consequences

- Two tables, no new permission, no new queue in this step. Re-alarm every 60 s to people who have not acknowledged and the 15-minute escalation to the
  sender and next on-call are step B (an expand migration adds their bookkeeping columns).
- Role/team tags (`@on-call`) are step C and need a new mention kind.
- The audience is immutable by design: someone who joins the channel after the send is not alarmed. That is deliberate (a frozen, auditable list) and is
  the first thing to revisit if clinicians expect late joiners to be alerted.
- ADRs are immutable once Accepted; this one is Proposed until step A2 ships.
