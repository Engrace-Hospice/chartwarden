# WARDENX_UI_STAFF_SCHEDULING_CASELOAD

Version: 1.0
Status: Screen Specification
Module: Staffing (M02, M17, M34)

---

## Purpose

The Staff Scheduling & Caseload queue manages the supply side of visit scheduling: each
clinician's weekly availability, time-off requests, and patient-caseload capacity. Schedulers use
it to keep caseloads within limits, honor geographic preferences, and route PTO approvals before
the visit calendar (M17) assigns work.

---

## Primary Users

- Scheduler / Staffing Coordinator
- Office Manager
- Director of Nursing
- Administrator

---

## Layout Pattern

Use Work Queue.

```text
Page Header (open PTO requests · caseload over-limit count)
KPI Strip
Filter Bar (discipline · zone · availability · request status)
Staff Roster Table  |  Right Detail Panel (availability / PTO / caseload)
```

---

## KPI Cards

- Available Today
- PTO Requests Pending
- Caseloads Over Limit
- Unassigned Capacity (visit slots)
- Out on PTO This Week

---

## Availability

- Day-of-week availability grid (Mon–Sun) with start/end windows per day
- Max visits per day and max weekly hours (FTE / part-time / per-diem)
- Geographic preference: preferred zones / ZIP clusters and a hard-exclude list
- Telehealth-only vs in-home capability flags
- On-call rotation eligibility marker

---

## PTO Requests

- Request rows: type (PTO / sick / bereavement / unpaid), dates, hours, reason
- Approval workflow: `Submitted` → `Approved` / `Denied` (approver + note captured)
- Coverage-impact preview: visits already scheduled in the requested window surface a Guard Chip
- Accrual balance shown alongside the request (informational)

---

## Caseload Assignment

- Max caseload (patients) vs current load with a utilization bar
- Over-limit load renders a `warning`/`alert` chip and surfaces first in the queue
- Geographic zone assignment + drive-time fit against the clinician's preferred zones
- Discipline match (RN / LPN / MSW / Chaplain / CHHA) enforced on assignment
- Continuity flag: patients this clinician already carries (avoid reassignment churn)

---

## Statuses

Availability: `Available`, `Limited`, `Unavailable`, `On PTO`. PTO request: `Submitted`,
`Approved`, `Denied`, `Cancelled`. Caseload: `Under Limit`, `At Limit`, `Over Limit`.

---

## Edit Rules & Sensitive Data

- Approving PTO that conflicts with already-scheduled visits is gated by a Blocking Dialog
  (reassign or override-with-reason, captured to audit).
- Caseload changes feed M17 routing; assignment beyond max caseload requires an override + reason.
- Availability windows respect credential validity (M02) — an expired license narrows availability
  via a Guard Chip rather than silently.
- PTO reason fields may contain sensitive personal info; visible to HR / approver roles only.

---

## Actions

- Edit availability / max visits
- Submit / approve / deny PTO
- Assign / reassign caseload
- Set geographic zones
- Toggle on-call eligibility

---

## Empty State

No availability configured for a clinician: detail shows "Availability not set — this clinician
will not be offered visits", with a deep-link to set day-of-week windows and max visits before
the scheduler can route work.

---

## Pencil Notes

Create versions for:

- Roster queue (mixed availability + over-limit caseload chips)
- Availability detail (day-of-week grid + zone preferences)
- PTO approval with coverage-conflict Guard Chip
- PTO approval Blocking Dialog (reassign vs override)
- Caseload utilization bar at / over limit
- Unset-availability empty state
