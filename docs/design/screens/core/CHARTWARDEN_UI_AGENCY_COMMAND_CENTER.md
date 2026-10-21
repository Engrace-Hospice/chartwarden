# CHARTWARDEN_UI_AGENCY_COMMAND_CENTER

Version: 1.0
Status: Screen Specification
Module: Agency Operations Command Center (cross-cutting)

---

## Purpose

The Agency Operations Command Center is the real-time operational cockpit for agency
leadership: the live state of admissions, compliance deadlines, IDG, visits, EVV, and revenue
risk in one place — so managers act on what's slipping today. It is deeper and
agency-wide where the role Home is personal, and real-time/operational where Reporting is
analytical.

---

## Primary Users

- Administrator
- Director of Clinical Services
- Clinical Manager
- Office Manager
- Compliance Officer

---

## Layout Pattern

Use Dashboard.

```text
Page Header (location / PE / team scope)
KPI Strip
Operational Panels (drill-down)  |  Right: Alerts / Quick Actions
```

---

## KPI Cards

- Active Census
- Admissions Pending
- Recerts Due (14 / 7 / 2d)
- F2F Due
- IDG Due
- Missed Visits (today)
- Open EVV Exceptions
- NOE At-Risk
- Cap Risk
- Open Tasks / Overdue

---

## Operational Panels

- **Admissions pipeline** — referral → triage → accepted → admitted funnel with aging.
- **Compliance windows** — `initial_assessment_48h`, `care_plan_5d`, recert, F2F, notice of
  rights — by `open` / `closing_soon` / `overdue`.
- **Visits** — scheduled / completed / missed today; late check-ins.
- **EVV exceptions** — unresolved, aging.
- **Revenue risk** — NOE window, denials, cap projection.
- **Field / staffing** — clinicians in the field, coverage gaps.

Each panel drills into the owning screen (Admissions, Care Plan, Scheduling, EVV, Claims).

---

## Scope & Real-Time

Filter by location / provider entity / team. Panels update in near-real-time and surface the
alert feed; leadership can acknowledge or assign from here.

---

## Empty State

Clean state: "No overdue items — everything is within window." (Still shows census + pipeline.)

---

## Actions

- Drill into any metric / panel
- Filter by location / PE / team
- Acknowledge / assign
- Export snapshot

---

## Pencil Notes

Create versions for:

- Full command center (mixed risk)
- All-clear state
- Compliance-windows panel (overdue)
- Admissions pipeline funnel
- Scoped to one location
