# P2 — Operational & Regulatory

> Prepend the [Lantern preamble](./README.md#the-lantern-preamble-prepend-to-every-generation-prompt).
> Composes P0 chrome + overlays. Field detail lives in each linked spec.

## 2.1 Scheduling / Visit Calendar — M17 · `Use Scheduling Calendar`
[spec](../screens/clinical/WARDENX_UI_SCHEDULING_VISIT_CALENDAR.md)
```
Design "Scheduling / Visit Calendar" for WardenX. Page Header (Day · Week · Map switch) over Left
(clinician roster + proposal inbox) | Center (calendar grid: rows = clinicians, cols = time;
drag-drop visit blocks colored by status/LOC) | Right (visit detail · conflicts · optimized route).
SYSTEMS: conflict detection = ALERT; RRULE recurring visits; frequency proposals carry provenance;
route optimization is a degradable feature (show degraded path when off).
VARIANTS: week grid · day grid · map/route view · proposal inbox · conflict state · recurring-series ·
dark.
```

## 2.2 EVV — M18 · `Use Work Queue`
[spec](../screens/clinical/WARDENX_UI_EVV.md)
```
Design "EVV" for WardenX. Work Queue — KPI strip (events today, missing, unresolved, aggregator
rejects); filter bar; table (visit, clinician, check-in/out, geofence status, match state) | Right
(event detail · missing resolution · device).
SYSTEMS: geofence variance is ADVISORY (warning, not a block); only unresolved-missing blocks
billing (guard chip, never a claim gate); aggregator (Sandata) submission status.
VARIANTS: events queue · event detail · missing-resolution · geofence-policy · aggregator-submissions ·
devices · dark.
```

## 2.3 On-Call Triage — M19 · `Work Queue + Documentation Workspace`
[spec](../screens/clinical/WARDENX_UI_ON_CALL_TRIAGE.md)
```
Design "On-Call Triage" for WardenX (after-hours). Work Queue — incoming triage queue prioritized
by acuity (ALERT for urgent) | Center (triage documentation + protocol) | Right (patient context ·
on-call roster · escalation).
SYSTEMS: acuity ALERT coding; escalation path; document-and-close flow; deadline/response chips;
after-hours safety framing.
VARIANTS: triage queue · active triage doc · escalation · on-call roster · empty/quiet-night · dark.
```

## 2.4 Field Safety — M20 · `Dashboard + Mobile Task Flow`
[spec](../screens/clinical/WARDENX_UI_FIELD_SAFETY.md)
```
Design "Field Safety" for WardenX. DESKTOP: Dashboard — safety KPIs, active field staff map,
check-in status, incident list | Right (risk · alerts). MOBILE (separate layout — Mobile Task
Flow): one action per screen — check-in, panic/escalate, document-and-close.
SYSTEMS: missed check-in escalates warning→ALERT; panic = ALERT; 44px targets load-bearing on
mobile; offline-capable.
VARIANTS: desktop dashboard · mobile check-in · mobile escalate (ALERT) · incident detail · dark.
```

## 2.5 Supplies / DME / Comfort Kit — M21 · `Use Patient Workspace`
[spec](../screens/clinical/WARDENX_UI_SUPPLIES_DME_COMFORT_KIT.md)
```
Design "Supplies / DME / Comfort Kit" for WardenX. Patient Banner over supplies/DME orders, comfort
kit contents (controlled-substance tracking), and disposition (witnessed destruction).
SYSTEMS: controlled-substance items = ALERT + witnessed-destruction ceremony; par/reorder; DME
vendor status (cross-module).
VARIANTS: supplies list · DME orders · comfort-kit dispensing · witnessed destruction (ceremony) ·
dark.
```

## 2.6 IPU / GIP Bed Board — M37 · `Use Bed Board`
[spec](../screens/clinical/WARDENX_UI_IPU_BED_BOARD.md)
```
Design "IPU / GIP Bed Board" for WardenX. Unit Header (census KPIs · coverage status) over a bed
grid (cards grouped by room, colored by status: occupied/available/dirty/reserved) | Right
(resource/occupant detail + admit/transfer/discharge actions).
SYSTEMS: status colors carry glyphs (non-color signal); admit/transfer/discharge = guarded actions
/ ceremonies; coverage status.
VARIANTS: full board · occupied-bed detail · admit flow · transfer · discharge · dark.
```

## 2.7 HQRP Quality — M30 · `Use Dashboard`
[spec](../screens/clinical/WARDENX_UI_HQRP_QUALITY.md)
```
Design "HQRP Quality" for WardenX. Dashboard — quality-measure KPIs (numerator/denominator/rate,
meets-target), HOPE timeliness, the 2% APU penalty deadline, trend charts | contributing-records
table | Right (risk · assumptions · export).
SYSTEMS: APU penalty deadline = prominent countdown (warning→ALERT); measures tabular-nums.
VARIANTS: measures overview · single-measure detail · APU-deadline-critical · trend · dark.
```

## 2.8 Volunteer Management — M30 · `Use Work Queue`
[spec](../screens/clinical/WARDENX_UI_VOLUNTEER_MANAGEMENT.md)
```
Design "Volunteer Management" for WardenX (CoP 5% compliance). Work Queue — KPI (5% compliance
rate, volunteers active, hours this period); table (volunteer, status, assignment, hours) | Right
(onboarding/training · assignment · hours approval).
SYSTEMS: 5% compliance computed (tabular-nums; below-target = warning/ALERT); hours approval flow;
background-check/competency gates.
VARIANTS: roster · onboarding/training · assignment · hours-approval · compliance-below-target · dark.
```

## 2.9 Bereavement — M16 · `Work Queue + Patient/Family Detail`
[spec](../screens/clinical/WARDENX_UI_BEREAVEMENT.md)
```
Design "Bereavement" for WardenX. Work Queue — case list (risk level, next task deadline) | Right
(bereaved-family detail · 13-month outreach schedule · contacts/consent · assessment).
SYSTEMS: 13-month task schedule with deadline chips; consent-to-contact flags; compassionate
Fraunces copy; risk stratification.
VARIANTS: case list · case detail · outreach schedule · contact/consent · closed-case · dark.
```

## 2.10 Death & Pronouncement — M06 · M16 · `Use Stepper Workflow`
[spec](../screens/clinical/WARDENX_UI_DEATH_PRONOUNCEMENT.md)
```
Design "Death & Pronouncement" for WardenX. Stepper — Context Header (patient) over steps
(pronouncement details → notifications → disposition → bereavement handoff) with sticky footer.
SYSTEMS: recording death = Signature Ceremony with step-up + pronouncer identity; notifications
fan-out; compassionate tone; transitions chart to read-only + surfaces bereavement.
VARIANTS: pronouncement step · death-visit note · summary · notifications · ceremony · dark.
```

## 2.11 Discharge / Revocation / Transfer — M06 · `Use Stepper Workflow`
[spec](../screens/clinical/WARDENX_UI_DISCHARGE_REVOCATION_TRANSFER.md)
```
Design "Discharge / Revocation / Transfer" for WardenX. Stepper — Context Header over steps
(reason → HOPE submission → order discontinuation → med/DME disposition → billing closure →
NOTR/C-CDA) with a Gate Stepper showing closure invariants.
SYSTEMS: Episode Closure blocker (guard) until all gates clear; revocation signing ceremony +
NOTR; transfer generates C-CDA; billing-closure checklist.
VARIANTS: live-discharge · revocation (ceremony + NOTR) · transfer (C-CDA) · closure-blocked
(guard) · dark.
```
