# WARDENX_UI_VOLUNTEER_MANAGEMENT

Version: 1.0
Status: Screen Specification
Module: Volunteer Management (M15 / M14)

---

## Purpose

Volunteer Management is the coordinator surface for CoP 418.78 compliance: the volunteer
roster, patient assignments, onboarding/compliance gates, hours logging, and the mandatory
≥ 5% volunteer-hours ratio. Gate expiry blocks scheduling; the ratio drives escalation.

---

## Primary Users

- Volunteer Coordinator
- RN Case Manager (co-signs the volunteer plan)
- Compliance Officer / DON (ratio escalation)

---

## Layout Pattern

Use Work Queue.

```text
Page Header (tabs: Roster · Assignments · Compliance · Hours & Ratio)
KPI Strip
Table / Queue  |  Right: Volunteer / Assignment Detail
```

---

## KPI Cards

- Active Volunteers
- Gates Expiring (30d)
- Inactive (gate expired)
- 5% Ratio (status)
- Open Assignments

---

## Roster

Each volunteer: name, status `Active` / `Inactive`, and a compliance summary (all gates
satisfied = green; expiring = yellow; any expired = red → inactive, no scheduling).

---

## Compliance Gates

Gate kinds: `background_check`, `tb_screening`, `confidentiality_agreement`,
`initial_training`, `annual_ce`, `assignment_specific_training`, `vaccination_status`.

Status: `Satisfied`, `Expiring Soon`, `Expired`, `Revoked`, `Not Yet Satisfied`. Show
`valid until` countdown and the source document; alerts fire at 30 / 14 / 7 / 1 days.

> Any `Expired` / `Revoked` / `Not Yet Satisfied` gate flips the volunteer to inactive and
> the scheduler rejects assignment (`VOLUNTEER_GATE_UNMET`).

---

## Assignments

Per patient: allowable activities (companionship, errands, respite, vigil presence, life
review, pet therapy, reading/music), start/end, coordinator acknowledgement. One active
assignment per (plan, volunteer).

The **Volunteer Plan** (`kind = volunteer_plan`) carries allowable activities and the
out-of-scope acknowledgement (no clinical care / no meds / no body care / no transport / no
clinical-document signing); signers: Volunteer Coordinator + RN Case Manager.

---

## Hours & 5% Ratio

Volunteer hours (signed `volunteer_visit` encounters + manual admin hours) ÷ total
patient-care hours. Status: green ≥ 5%, yellow 3–5% (corrective prompt), red < 3% (escalate
to DON + Compliance). 12-quarter trend. Before Cost Report (M27) is available, show "cost
basis unavailable."

---

## Empty State

"No volunteers yet." → Add Volunteer. Assignments: "No active volunteer assignments."

---

## Actions

- Add volunteer · mark inactive
- Record / revoke compliance gate
- Assign to patient · acknowledge
- Log admin hours
- Sign volunteer plan
- View 5% ratio / escalate

---

## Pencil Notes

Create versions for:

- Roster (compliance colors)
- Compliance gate tracker (7 gates)
- Assignment to patient
- Hours & 5% ratio dashboard (green/yellow/red)
- Gate expired → inactive
