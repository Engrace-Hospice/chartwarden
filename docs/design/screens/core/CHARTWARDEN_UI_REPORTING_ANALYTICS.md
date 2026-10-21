# CHARTWARDEN_UI_REPORTING_ANALYTICS

Version: 1.0
Status: Screen Specification
Module: Reporting & Analytics (M33)

---

## Purpose

Reporting & Analytics is the operational-visibility layer: a catalog of platform-shipped and
tenant-authored reports, parameterized runs, scheduled delivery, exports, and saved views —
all role-scoped, with no raw SQL ever exposed to the tenant.

---

## Primary Users

- Builders: Analyst, Report Admin, Org Admin
- Viewers: Report Viewer, Clinician (self), Clinical Supervisor (team), Compliance Officer,
  Billing Admin, Quality Director

---

## Layout Pattern

Use Dashboard.

```text
Page Header
Report Catalog (categories)  |  Dashboard / Report Viewer  |  Right: Parameters / Detail
```

---

## Data Domains

Census, productivity, clinical quality, medication, EVV, on-call, bereavement, field safety,
billing AR / denials, cap management, cost report, IPU.

---

## Catalog & Viewer

- Catalog: ~30 platform-shipped reports plus tenant-authored definitions, grouped by domain.
- Viewer: parameter bar (date range, location, team) auto-rendered from the report spec;
  tiles, tables, charts; drill-down to source records.
- Builder (analyst): pick base + dimensions/measures + filters + parameters + layout — no SQL.

---

## Statuses

- Definition: `Draft`, `Published`, `Archived`.
- Definition version: `Draft`, `Published`, `Superseded`.
- Saved view: `Private`, `Shared (role)`, `Shared (org)`, `Archived`.
- Schedule: `Active`, `Paused`, `Cancelled`.
- Schedule run: `Queued`, `Running`, `Rendered Pending`, `Rendered Complete`, `Delivered`,
  `Failed`.

---

## Scheduling & Export

- Schedule: cron with friendly presets (min 5-minute frequency), recipient picker, format
  `PDF` / `XLSX` / `CSV`.
- Export: PDF and XLSX rendered via Document Management; CSV streamed (row cap).

---

## Role Scoping & PHI

Every tile is scoped via the `reportable_scope` predicate (`self` / `team` / `location` /
`org`). Results are aggregates; drill-down to patient level is consent-narrowed (SUD /
family-violence redaction) and writes an audit row (7-year retention).

---

## Empty State

- No saved views: "No reports yet." → Browse Catalog, Build a Report.
- Report with no data for parameters: "No data for the selected filters."

---

## Actions

- Run report · adjust parameters
- Build / edit definition
- Schedule delivery
- Export (PDF / XLSX / CSV)
- Save view · share (role / org)
- Drill down

---

## Pencil Notes

Create versions for:

- Report catalog (by domain)
- Report viewer (parameters + tiles)
- Builder (no-SQL)
- Schedule delivery
- Drill-down (consent-narrowed)
