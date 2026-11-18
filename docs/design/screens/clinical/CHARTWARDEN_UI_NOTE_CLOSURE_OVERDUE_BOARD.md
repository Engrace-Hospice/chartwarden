# CHARTWARDEN_UI_NOTE_CLOSURE_OVERDUE_BOARD

Version: 1.0
Status: Screen Specification
Module: Encounters / Visit Documentation (M08) — visit-note closure clock (ADR-0113)

---

## Purpose

A clinician has 24 hours (tenant-configurable, 1 to 168) from the moment a visit starts to close
the visit note. The Overdue Notes board is the supervisor's view of every note that is **at risk**,
**overdue** or **escalated**, oldest first, so a director of nursing or clinical supervisor can chase
the note, and — when the tenant policy **blocks** — grant a clinician a short, audited **override**
so they can keep working while a note stays open.

The board decides nothing. The stage, the deadline and the hours overdue are the server's clock
(`closure/note-clock.ts`), the same one the alerts and the request gate use, so the board can never
disagree with them.

---

## Primary Users

Director of Nursing, clinical supervisor, clinical lead (permission `encounter.closure_override`).
Organization-wide roles see every site; other holders see only the sites they are scoped to (the server
narrows the list; the screen never filters scope).

---

## Layout Pattern

Use Work Queue.

```text
Page Header                                      [ Refresh ]
[ KPI Strip: Escalated · Overdue · At risk ]
[ Mode notice (warn / off) · Truncated notice ]
Work Table (oldest first)  |  Right Detail Panel: Grant override
```

The detail panel is the redesign's flat right drawer (`wx-list-drawer`), opened from a row; its URL
carries `?note=<encounterId>` (an id, never PHI) so a step-up round trip returns to it.

---

## Table

One row per at-risk, overdue or escalated clocked open note (status draft or finalized):

- Patient (name and MRN, resolved per patient on the visible page only)
- Clinician (name when the care-team staff list is readable, else a short id)
- Visit (type, discipline) · Service date · Status
- Clock started · Deadline
- Stage chip (At risk, Overdue, Escalated) and Timing (`Due in 3h`, `6h overdue`)
- Override column (block mode only): **Grant override**, or **Manage override** with an **Override active** chip

The board asks for the server's maximum (200). When more matched, a notice says so and tells the
supervisor to work the oldest first. Paged client-side (10, 25, 50).

---

## Grant Override (right panel)

Opens from **Grant override** or the row. Shows the note's facts, a consequence line, then:

- **Reason** (required, at least 40 characters, counted as the server counts it; the running count is in
  the hint, never in the alert). It is stored with the override and copied, as `context.justification`, into the
  `m8.encounter.closure_override_granted` audit event; no screen reads it back. The server refuses an SSN- or
  Medicare-number-shaped reason (422, field `reason`), and the hint says not to enter patient names.
- **Hours** (whole number 1 to 24, default 4). The override ends by itself.

Consequence line: the clinician can use the rest of the app for the hours chosen; the note stays open,
its alerts and deadline do not change, and the override does not replace a late-entry override; the
supervisor's name and the reason are recorded in the audit trail.

Write rules:

- Requires a **fresh step-up**. A step-up refusal stashes what was typed (in memory only: the reason is
  free text and is never put in Web Storage), sends the supervisor to `/step-up`, and on return the panel
  reopens with the form restored. Nothing is sent for them; an abandoned draft is discarded.
- One **Idempotency-Key** per attempt, held by the shared attempt-key hook: a retry of the same attempt
  after a lost reply keeps the key; an edit, or any answer from the server, renews it.
- After a grant the panel shows **Override active** with its expiry and **Revoke override** (also
  step-up). There is no route that lists existing overrides yet, so the board can revoke only a grant
  made in this session; listing and revoking earlier grants is a later slice.
- **Self-grant is hidden**: a note the viewer authored shows "Your own note. Another supervisor can grant
  it." and no action. If the server still refuses (403), the panel says an override cannot be granted for
  one's own note.

---

## Mode Behaviour

- **block**: full board with the override column.
- **warn**: the board is read-only. A notice says clinicians are alerted but nobody is limited, so there
  is nothing to override.
- **off**: the board is empty and says note closure is switched off.

---

## States

- **Loading**: spinner.
- **Error**: "Overdue notes unavailable" with **Try again**; never an empty board.
- **No permission** (the server answers 403): "Not available", no retry. The route itself is gated by the
  permission key in the screen registry.
- **Empty**: "No notes need attention."
- **Refresh**: keeps the rows and an open panel mounted (stale-while-revalidate).

---

## Accessibility

- The table is a labelled, keyboard-focusable scroll region; rows that open the panel are keyboard
  operable and hand focus back to the row when the panel closes.
- Form errors are announced; the counter is a hint, not an alert.
- Stage and status are always text in a chip, never colour alone.

---

## Actions

- Refresh · Grant override · Manage override · Revoke override (session grants) · Close panel
