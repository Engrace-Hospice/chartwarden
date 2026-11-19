# CHARTWARDEN_UI_NOTE_CLOSURE_POLICY

Version: 1.0
Status: Screen Specification
Module: Encounters / Visit Documentation (M08) — visit-note closure clock (ADR-0113)

---

## Purpose

The tenant's note-closure policy: how long clinicians have to close a visit note after starting it
(1 to 168 hours, default 24) and what happens when they do not. The screen is offered to, and the route
answers, exactly the holders of `encounter.closure_policy_admin`: the director of nursing (`director_of_nursing`,
`don`), the organization administrators (`org_admin`, `administrator`) and platform `superadmin`. Clinical
supervisors and clinical leads do not hold it: the policy is set by the tenant-level owners, not by the field
supervisors (ADR-0113 D7). The director of nursing is bound by the clock like any supervisor and still holds it, on
purpose; a director of nursing or administrator who sets `off` is guarded by step-up and an audit event, not by a second person. A mistaken `block` is undone here; if every holder is
blocked themselves, see the runbook `docs/runbooks/m8-note-closure-policy-reset.md`.

---

## Primary Users

Organization administrator, director of nursing.

---

## Layout Pattern

Use Admin Settings Layout.

```text
Page Header                                   [ Refresh ]
In force now   (effective mode, deadline, blocking-counts-from)
Change the policy   (mode choice with its effect · deadline hours · Save)
```

The impact of each choice is shown beside it, not behind a help link.

---

## Modes

| Mode | What it does |
| ---- | ------------ |
| **Off** | Notes are not tracked against a deadline. No alerts are sent and nobody is limited. |
| **Warn only** (default) | Clinicians get an alert before and after the deadline, and supervisors see overdue notes. Nobody is limited. |
| **Warn, then block** | As warn only, and a clinician whose note is past its deadline can only close notes and use patient-safety routes until it is closed or a supervisor grants a temporary override. |

The screen shows the **effective** values. A tenant that has never saved a policy is read as warn /
24 hours by the server, so the default is what the screen shows, not an empty form.

---

## Deadline

Whole hours, 1 to 168, counted from the moment the visit starts. Clinicians are first warned a fixed
lead time (6 hours) before it. The client check mirrors the server's bounds; the server stays the
authority and its refusal is shown in words beside the field.

---

## Confirm Before Blocking

Saving asks for confirmation when it could start limiting clinicians who are not limited now:

- **Turning blocking on.** The dialog explains that the server stamps `enforceFrom` when the mode moves
  to block, so notes that are already past the deadline get a fresh full window and nobody is limited by
  the switch itself; that afterwards an overdue clinician can only close notes and use the patient-safety
  routes (medication administration, orders, on-call and triage, field safety, emergency messaging) until
  the note is closed or a supervisor grants a temporary override; and that a stale sign-in will ask for
  step-up first.
- **Shortening the deadline while blocking is on.** A note older than the new deadline is overdue at once.

Every other change (off, warn, a longer deadline) saves without a confirm step. Save is disabled until
something changes.

After a save to blocking the screen shows the server's `enforceFrom` ("Blocking counts from ...").

---

## Write Rules

- `PUT /api/v1/encounters/closure-policy` requires a **fresh step-up** (one bad save can lock a tenant out).
  A refusal stashes the edit in memory, sends the admin to `/step-up`, and on return the edit is restored;
  nothing is sent for them. An abandoned draft is discarded.
- The write's Idempotency-Key is the shared API client's (one per write intent); the screen holds none.
- Success is shown only from the server's reply.

---

## States

- **Loading**: spinner.
- **Error**: "Closure policy unavailable" with **Try again**; the form is not shown with invented defaults.
- **No permission** (403): "Not available", no retry. The route is gated by the permission key.
- **Refusal** (422 and others): the server's field error or a plain sentence; the edit is kept.
- **No answer** (offline): "Could not reach the server"; no success is shown.

---

## Actions

- Refresh · Choose mode · Set deadline · Save policy · Confirm / Cancel the blocking dialog
