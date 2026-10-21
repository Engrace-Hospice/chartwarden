# CHARTWARDEN_UI_STAFF_MESSAGING

Version: 1.0
Status: Screen Specification
Module: Internal Staff Secure Messaging (M36)

> **As-built PR 3 scope (2026-10-09):** the implemented workspace uses a responsive inbox/thread
> layout, authorized conversation summaries, newest-page-first history with upward progressive
> loading, visibility-aware REST polling, read receipts, and a multiline composer. Presence, typing,
> attachments, reactions, @-mentions, delivery confirmation, and clinical acknowledgement remain
> future capabilities; the UI does not fabricate them.

---

## Purpose

Secure staff-to-staff messaging: care-team channels, discipline and location channels,
on-call rooms, direct messages, and announcements — the internal counterpart to the
patient-facing Portal Care Team Messages.

---

## Primary Users

All staff roles. Channel access is scoped by caseload / membership; DMs are consensual and
never cross-tenant.

---

## Layout Pattern

Use Conversation View.

```text
Conversation List  |  Message Thread  |  Right: Members / Presence
```

---

## Channel Kinds

`care_team`, `discipline`, `location`, `on_call`, `dm`, `announcement`, `bereavement`.

Membership roles: owner, member, read-only, (portal caregiver — for consent-gated
patient-facing bridges, handled in the portal).

---

## Thread

- Chronological messages with day separators
- Author (user / system), edit and delete tombstones
- Attachments via Document Management (max 10 / message)
- @-mentions, typing indicator, presence dots
- Read receipts: `Delivered`, `Read`, `Ack`

---

## Statuses

- Channel: `Active`, `Archived`, `Destroyed` (on retention expiry).
- Message: `Sent`, `Edited`, `Deleted` (tombstone).
- Presence: `Online`, `Away`, `Offline`.

---

## Authorization

Care-team channels gate on caseload membership; other channels on explicit membership. Admins
(org_admin / clinical_lead, location-scoped) may force-add members — audited as elevated
access.

---

## Empty State

- No conversations: "No messages yet." → Start a conversation, Browse channels.
- Thread unselected: prompt to pick a conversation.

---

## Actions

- Send · Attach · @-mention
- Edit / delete (within window)
- Create channel / start DM
- Mark read · React
- View members / presence

---

## Pencil Notes

Create versions for:

- Conversation list (unread + presence)
- Care-team thread (read receipts)
- Announcement (read-only)
- On-call room
- Attachment picker
