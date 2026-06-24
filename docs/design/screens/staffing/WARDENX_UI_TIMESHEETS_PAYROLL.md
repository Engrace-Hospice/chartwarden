# WARDENX_UI_TIMESHEETS_PAYROLL

Version: 1.0
Status: Screen Specification
Module: Staffing (M34)

---

## Purpose

The Timesheets & Payroll queue collects clinician and staff hours by category, runs them through
an approval workflow, and exports approved time to an external payroll system. It also produces
the audit-ready daily staffing summary that documents hours by discipline, volunteer
participation, and continuous-home-care (CHC) compliance for survey.

---

## Primary Users

- Payroll Administrator
- Office Manager
- HR / Admin Staff
- Director of Nursing
- Administrator

---

## Layout Pattern

Use Work Queue.

```text
Page Header (pay period · approval progress · export status)
KPI Strip
Filter Bar (discipline · status · location · pay period)
Timesheet Table  |  Right Detail Panel (entries / approval / export)
```

---

## KPI Cards

- Hours Pending Approval
- Timesheets Unsubmitted
- Overtime Hours (period)
- Volunteer Hours (period)
- Export Errors

---

## Timesheet Entry

- Entry categories: visit, travel, on-call, admin, training/in-service, PTO
- Per-entry: date, patient/visit link (where applicable), start/end, computed hours
- Visit hours reconciled against EVV (M18) actuals; mismatch surfaces a Guard Chip
- Mileage/travel captured separately from billable visit time
- Daily and period totals shown with `tabular-nums`

---

## Payroll Export

- Approval workflow: `Draft` → `Submitted` → `Approved` → `Exported`
- Export target adapters: ADP, Paychex, Gusto (configurable per agency)
- Export batch shows record count, total hours, and per-record error rows
- Re-export blocked once a period is `Locked`; corrections route through an adjustment

---

## Daily Staffing Summary

- Audit-ready report: hours by discipline (RN / LPN / MSW / Chaplain / CHHA / Volunteer)
- **Volunteer percentage** computed against total patient-care hours (5% participation rule)
- **CHC compliance**: continuous-home-care periods meeting the ≥8-hour predominantly-nursing
  threshold flagged; shortfalls render an `alert` chip
- Exportable by date range for survey / cost-report support

---

## Statuses

Timesheet: `Draft`, `Submitted`, `Approved`, `Rejected`, `Exported`, `Locked`.
Export batch: `Queued`, `Succeeded`, `Partial`, `Failed`.

---

## Edit Rules & Sensitive Data

- Approved timesheets are read-only; changes after approval require an adjustment entry with reason.
- Visit-hour entries reconcile to EVV (M18); unreconciled visit time is gated before approval.
- A `Locked` pay period blocks new edits and re-export; only an adjustment batch can amend it.
- Payroll export payloads carry pay-rate-adjacent data — visible to payroll / HR roles only.
- Volunteer and CHC computations are derived (§9 system-derived) and labeled as such.

---

## Actions

- Add / edit timesheet entry
- Submit for approval
- Approve / reject (reason captured)
- Run payroll export (ADP / Paychex / Gusto)
- Generate daily staffing summary

---

## Empty State

No timesheets for the selected period: queue shows "No hours recorded for this pay period" with a
deep-link to start entries and a note that export remains disabled until at least one timesheet is
approved.

---

## Pencil Notes

Create versions for:

- Approval queue (mixed statuses, hours in `tabular-nums`)
- Timesheet detail with EVV-mismatch Guard Chip
- Payroll export batch with partial-failure error rows
- Daily staffing summary (discipline breakdown + volunteer %)
- CHC-shortfall `alert` chip on a continuous-care day
- Locked-period read-only state
- Empty pay period
