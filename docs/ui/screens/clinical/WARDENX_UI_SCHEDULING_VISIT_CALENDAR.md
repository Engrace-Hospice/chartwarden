# WARDENX_UI_SCHEDULING_VISIT_CALENDAR

Version: 1.0
Status: Screen Specification
Module: Scheduling / Visit Calendar (M17)

---

## Purpose

The Scheduling / Visit Calendar turns care-plan frequency, supervisory cadence, orders, and
IDG decisions into concrete scheduled visits: assign clinicians, resolve conflicts, optimize
routes, and give field clinicians their day. It is the staff-side counterpart to the
patient-facing Portal Visit Schedule.

---

## Primary Users

- Scheduler
- Clinical Supervisor / Clinical Manager
- Field Clinicians (day view): RN, LPN, CHHA, MSW, Chaplain, Volunteer

---

## Layout Pattern

Use Scheduling Calendar.

```text
Page Header (view switch: Day · Week · Map)
Left: Roster + Proposal Inbox  |  Center: Calendar Grid  |  Right: Visit Detail / Conflicts / Route
```

---

## Views

- **Day** — rows = clinicians, columns = time (15-min granularity)
- **Week** — per-clinician lanes with PTO bars and recurring-visit markers
- **Map** — visit pins + OSRM route polylines, color-coded by status

---

## Proposal Inbox

Visit proposals by source: `frequency_driven` (M07 care plan), `supervisory_cadence`
(M15 aide), `order_required` (M11), `idg_decision` (M14). Scheduler publishes or dismisses.

---

## Visit Detail

- Patient · purpose · setting (home / facility / inpatient / telephonic)
- Assigned clinician + discipline
- Scheduled start–end · service date
- EVV bracket state
- Proposed route position + inbound miles / drive time
- Linked care-plan intervention / order

Visit purposes include: routine, PRN, aide POC, MSW assessment, chaplain visit, volunteer
visit, F2F, recert, level-of-care change, pronouncement, admission, discharge.

---

## Statuses

`Proposed`, `Published`, `En Route`, `In Visit`, `Completed`, `No Show`, `Cancelled`,
`Rescheduled`.

> `En Route` / `In Visit` / `Completed` are driven by EVV (M18) events; `Completed` also
> triggers on the signed encounter (M08).

---

## Assignment & Publish Gates

- Drag-drop reassignment with optimistic concurrency (conflict → show current state).
- Same-clinician time overlaps are blocked (hard constraint).
- Publishing re-runs gates: clinician credential active, volunteer compliance active,
  supervisory cadence respected. A failed gate blocks publish with the specific reason.

---

## Routing & PTO

- Proposed route order + per-segment miles/drive-time; clinician can override; M08 odometer
  is authoritative for billing.
- PTO request → supervisor approval surfaces conflicting visits and triggers a
  reassignment scan.
- Recurring visits use daily/weekly rules only.

---

## Mobile / Field Clinician Day View

- Visit cards in route order: patient, address (one-tap directions), scheduled time, EVV
  state, "Start visit", "View chart".
- Status colors mirror the desktop grid; optional map overlay.

---

## Empty State

- Scheduler, no proposals: "No pending visit proposals." → Create Visit.
- Clinician day, none scheduled: "No visits scheduled today."

---

## Actions

- Create visit · Publish proposal · Dismiss proposal
- Reassign (drag-drop) · Set recurring
- Request / approve PTO
- Optimize route
- Cancel · Reschedule

---

## Pencil Notes

Create versions for:

- Day grid (clinician × time)
- Week view (PTO + recurring)
- Map / route view
- Proposal inbox
- Publish gate blocked
- Mobile clinician day view
