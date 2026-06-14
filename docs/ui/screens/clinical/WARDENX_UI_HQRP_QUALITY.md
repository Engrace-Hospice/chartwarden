# WARDENX_UI_HQRP_QUALITY

Version: 1.0
Status: Screen Specification
Module: HQRP Quality & Compliance (M30)

---

## Purpose

The HQRP Quality screen is the agency's quality, compliance, and survey-readiness console:
CMS quality measures, CAHPS, regulatory submissions, QAPI, the Security Risk Assessment,
incident and infection surveillance, and mortality review — in one place, continuously
knowable.

---

## Primary Users

- Quality Manager / QAPI Coordinator
- Administrator
- Compliance Officer
- Security Officer
- Medical Director, Director of Clinical Services
- Infection Control Lead, Auditor

---

## Layout Pattern

Use Dashboard.

```text
Page Header (sections: Quality Hub · Measures · CAHPS · QAPI · SRA · Incidents · Mortality)
KPI Strip
Charts / Scorecards  |  Contributing Records Table  |  Right: Detail / Drill-down
```

---

## Quality Hub (KPI strip + CoP strip)

- HCI (Hospice Care Index) composite
- HVLDL rate (visits in last days of life)
- CAHPS top-box rates
- Open incidents · CAPs overdue
- CoP 23-citation traffic-light strip (`Compliant` / `At Risk` / `Deficient`)
- **APU risk banner** — 4-percentage-point Annual Payment Update penalty exposure

---

## Measures

- **HCI** — 10 indicators (CHC/GIP provision, skilled-nursing gaps, early/late live
  discharges, burdensome transitions, per-beneficiary spend, SN minutes per RHC day / on
  weekends, visits near death).
- **HVLDL** — % decedents with ≥ 2 qualifying visits in last 3 days of life.
- **HOPE-derived** — Timely Follow-Up for Pain Impact / Non-Pain Symptom Impact.
- **CAHPS** — composite + per-question top-box, via vendor adapter.

Measure detail: 8-quarter timeline with threshold bands, numerator/denominator breakdown,
and a reproducibility (snapshot-hash) viewer; drill-down to patient level.

---

## Statuses

- CoP compliance: `Compliant`, `At Risk`, `Deficient`.
- QAPI project: `Proposed`, `Active`, `Corrective Action`, `Completed`, `Abandoned`.
- PIP: `Chartering`, `Root Cause Analysis`, `Intervention In Progress`, `Measurement`,
  `Concluded`, `Suspended`.
- SRA cycle: `Chartered`, `In Progress`, `Review`, `Closed`, `Reopened`.
- Incident: `Draft`, `Submitted`, `Triaged`, `Under Investigation`, `Resolved`,
  `Closed`, `Reopened`.
- Mortality review: `Pending`, `In Progress`, `Completed`, `Overdue`.

---

## Sub-Surfaces

- **CAHPS** — active vendor, monthly decedent sample (with CMS exclusions), export retry,
  ingested results by period; size-exemption flag.
- **QAPI Workbench** — Kanban by project phase; PIPs per project; measure-trend overlay.
- **SRA Console** — 5×5 risk matrix (NIST 800-66r2), findings by risk band, remediation
  tracker, two-person close.
- **Incident List** — kind / severity / state filters; abuse-allegation rows flagged;
  mandatory-reporter visibility.
- **Risk Register** — union of open SRA findings, incidents, corrective-action QAPI
  projects, and at-risk/deficient CoP statuses.
- **Mortality Review** — clinical / satisfaction / compliance tabs; 30-day target.

---

## Submission Tracking & Alerts

Submission deadlines and reminders (e.g. SRA 90/60/30/7-day, mortality review 21/28/30-day,
CoP review-due) with at-risk badges. APU threshold breaches escalate on the Quality Hub.

---

## Empty State

"No quality data for this period yet." → View Prior Period, Configure CAHPS Vendor.

---

## Actions

- Open measure detail · Drill to patients
- Manage CAHPS vendor / sample
- Create QAPI project / PIP
- Run / close SRA cycle
- Log / triage incident
- Complete mortality review
- Export survey packet

---

## Pencil Notes

Create versions for:

- Quality Hub (KPIs + CoP strip + APU banner)
- Measure detail (timeline + drill-down)
- QAPI Kanban
- SRA console (risk matrix)
- Incident list (abuse flagged)
- Risk register
