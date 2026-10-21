# CHARTWARDEN_UI_APP_SHELL_HOME

Version: 1.0
Status: Screen Specification
Module: App Shell & Role Home (cross-cutting — M02 session, M03 role)

---

## Purpose

The App Shell is the global chrome every authenticated screen renders inside: top navigation,
module navigation, and the content outlet. Its landing is a **role-based home** — the tiles a
user sees on login are determined by their role.

---

## Primary Users

All staff roles. The shell adapts; it is not role-specific.

---

## Layout Pattern

Use App Shell.

```text
Top Navigation (org context · global search · notifications · user menu)
[ Support / Degraded-mode Banner ]
Left Nav Rail (module groups, role-filtered)  |  Content Outlet (active screen)
```

The Role Home rendered in the content outlet uses Dashboard.

---

## Top Navigation

- Org context — persistent "Working in: [Org]" with location/PE switcher
- Global search (patients, screens, records — scoped by permission)
- Notifications bell (unread count → Notifications & Tasks)
- User menu (profile, security, sign out)
- **Support-mode banner** when an audited support session is active
- **Degraded-mode banner** when System Health has flipped degraded mode on

---

## Left Nav Rail

Module groups, filtered to the user's permitted screens: Clinical, Revenue, Admin, Quality,
Platform (ChartWarden Ops only), Portal-admin. Collapsible; remembers state.

---

## Role-Based Home

Landing tiles vary by role — for example:

- **Clinician** — My Patients, Today's Visits, Tasks, Documentation to sign, Alerts
- **Biller** — AR snapshot, NOE/NOTR window, claims to work, denials
- **Administrator** — Org health, staff/credentials, compliance posture
- **Clinical Supervisor** — Team caseload, cosign queue, field-safety status

> Role governs the home (M03 owns roles; M02 binds the org-scoped session). A user with
> multiple roles sees a merged, de-duplicated home.

---

## Session Behavior

- Idle screen-lock and timeouts hand off to the Auth screen-lock overlay.
- Location/PE switch is in-session; **org** switch signs out (see Auth).

---

## Empty State

Freshly provisioned user with no caseload/assignments: a "Get started" home with the
permitted entry points rather than empty tiles.

---

## Actions

- Navigate (rail / search)
- Switch location / provider entity
- Open notifications
- Open user menu · sign out
- Lock screen

---

## Pencil Notes

Create versions for:

- Clinician home
- Biller home
- Administrator home
- Supervisor home
- Collapsed nav rail
- Support-mode / degraded-mode banner active
