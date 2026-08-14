# WARDENX_UI_QAPI_INCIDENTS

Version: 1.0
Status: Screen Specification
Module: QUALITY (M30)

---

## Purpose

The Quality Assessment and Performance Improvement (QAPI) command surface required by the
hospice Conditions of Participation (§418.58): a program dashboard that monitors performance
indicators and active improvement projects (PIPs), the **incident-report** intake form (falls,
medication errors, elopement, equipment failure, complaints, adverse events), and the
**incident investigation** workflow — root-cause analysis, corrective action, and follow-up to
closure.

---

## Primary Users

- QAPI / Quality Officer
- Compliance Officer
- Administrator / Medical Director
- Clinical Manager

---

## Layout Pattern

Use Dashboard.

```text
Page Header
KPI Strip (open incidents · overdue investigations · active PIPs · incident rate trend)
Charts (incident type distribution · rate trend · severity heatmap)
Contributing Incidents Table  |  Right: Investigation / RCA / Corrective Action
```

---

## QAPI Program Overview

- Performance-indicator scorecards (clinical, safety, satisfaction, operational)
- Active Performance Improvement Projects (PIPs): aim, measure, current vs target, owner
- Governing-body review cadence + last-reviewed marker
- Trend charts feeding the annual QAPI evaluation

---

## Incident Report Form

- Patient (optional — some incidents are staff/visitor) + masked banner
- Type · date/time · location · severity (no-harm → sentinel)
- Narrative, contributing factors, immediate actions taken
- Witnesses, notifications made (physician, family, state agency where applicable)
- Auto-routes to investigation when severity ≥ threshold

---

## Incident Investigation

- **Root-cause analysis** (5-whys / fishbone capture)
- Corrective action plan: action, owner, due date, verification of effectiveness
- Linkage to a PIP when the cause is systemic
- Re-occurrence watch + closure sign-off

---

## Statuses

Incident: `Reported` → `Under review` → `Investigating (RCA)` → `Corrective action` →
`Monitoring` → `Closed`. PIP: `Proposed` → `Active` → `Sustained` / `Discontinued`.

---

## Edit Rules & Sensitive Data

- Requires `qapi.write` + the `incident.*` family (the registered M30 keys; `qapi.incident.manage` is not a key); closing an investigation requires sign-off authority.
- Patient PHI masked; reveal step-up + audited. QAPI/PIP analytics are de-identified where
  possible.
- Investigation findings may be protected quality-assurance material — access is
  permission-gated and audited; export is restricted.
- Sentinel/serious events carry an **investigation deadline countdown chip**; closing without a
  completed RCA + verified corrective action is blocked by a Guard Chip.
- Reportable adverse events (e.g., to the state agency) cross-link to the
  Patient-Rights/Grievances reporting flow.

---

## Actions

- File an incident report
- Open / conduct investigation (RCA + corrective action)
- Launch / update a PIP
- Verify corrective-action effectiveness · close incident (sign-off)
- Generate QAPI program report (for governing-body review)

---

## Empty State

No incidents this period: dashboard shows zeroed KPIs, "No incidents reported", and the active
PIP list; a "Report an incident" affordance is primary.

---

## Pencil Notes

Create versions for:

- QAPI dashboard with KPI strip + rate-trend chart + active-PIP cards
- Incident-report intake form (fall vs medication-error variants)
- Investigation panel with **RCA worksheet** and corrective-action tracker
- Investigation **deadline countdown chip** at warning/expiry with closure **Guard Chip**
- Masked patient context vs step-up reveal on a patient-linked incident
- PIP detail (aim · measure · current-vs-target trend)
