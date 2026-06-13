# WARDENX_UI_NOTIFICATIONS_TASKS

Version: 1.0
Status: Screen Specification
Module: Notifications & Tasks / Worklist (M36 alerts + cross-cutting tasks)

---

## Purpose

The Notifications & Tasks screen is the single place a staff member sees what needs their
attention: event-driven alerts from every module and assigned action items / worklist tasks,
with acknowledgement, escalation, and delivery-preference controls.

---

## Primary Users

All staff roles (scoped to their own notifications and assigned tasks; supervisors see team
escalations).

---

## Layout Pattern

Use Work Queue.

```text
Page Header (tabs: Notifications · Tasks)
KPI Strip
List  |  Right: Detail + Deep-link Actions
```

---

## KPI Cards

- Unread Notifications
- Critical (unacknowledged)
- Tasks Due Today
- Overdue Tasks
- Escalations

---

## Notifications

Alert severities: `INFO`, `WARN`, `MEDIUM`, `HIGH`, `CRITICAL`. Delivery channels: in-app
(always), push, SMS, email, voice (SOS only).

Representative sources (cross-module): verbal-order expiry (M11), NOE window breach (M23),
care-plan review overdue (M07), EVV geofence/missing (M18), on-call triage (M19), missed dose
(M13), critical lab result (M22), IDG packet ready (M14), field-safety SOS (M20).

Delivery status: `Pending`, `Sent`, `Delivered`, `Failed`, `Skipped (quiet hours)`,
`Forwarded`. Alert outcome: `Delivered`, `Partial`, `Failed`.

---

## Tasks / Worklist

Action items aggregated from IDG (M14), Orders, Care Plan, reconciliation, etc.: assignee,
due date, linked record, status `Open` / `In Progress` / `Completed` / `Cancelled` /
`Auto Closed`. Each task deep-links to the record that resolves it.

---

## Preferences

- Quiet hours (with a severity override floor — critical always breaks through)
- Vacation forwarding (bounded, cycle-checked)
- Per-category × severity channel routing
- On-call routing for after-hours

> System-locked critical alerts (SOS, NOE late-risk, backup failure) cannot be disabled by
> any tenant or user.

---

## Empty State

"You're all caught up." → View All Notifications, View Completed Tasks.

---

## Actions

- Acknowledge · Snooze
- Open (deep-link to source)
- Escalate
- Complete / reassign task
- Configure notification preferences

---

## Pencil Notes

Create versions for:

- Notifications feed (severity mix)
- Critical unacknowledged
- Tasks worklist (overdue)
- Notification detail + deep-link
- Preferences (quiet hours / forwarding)
