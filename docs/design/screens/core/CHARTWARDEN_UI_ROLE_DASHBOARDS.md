# CHARTWARDEN_UI_ROLE_DASHBOARDS

Version: 1.0
Status: Screen Specification
Module: REPORTING (M33)

---

## Purpose

Beyond the generic role home, several roles need a purpose-built landing dashboard that surfaces
their KPIs and work queues the moment they sign in. This spec defines the shared role-dashboard
pattern — KPI strip, a small set of charts/trends, and the queues that drive each metric — and
enumerates the metric/queue set for each role. One pattern, many configurations.

---

## Primary Users

- Medical Director
- Billing Manager
- Bereavement Coordinator
- Scheduler / Dispatcher
- QA Officer
- Compliance Officer
- Intake Coordinator

---

## Layout Pattern

Use Dashboard.

```text
Page Header (role · org · date range)
KPI Strip (role-specific metric cards; each card filters into a queue)
Charts (trend / distribution / forecast)
Contributing-records Table  |  Right: Risk / Alerts / Quick Actions
```

---

## Shared Dashboard Frame

- KPI strip cards are read-only summaries; clicking a card deep-links to its underlying queue
- Charts are role-scoped trends (last 30/60/90 days, fiscal period) with as-of selection
- Right panel carries the role's risk items, alerts, and one-tap quick actions
- Every metric carries a provenance treatment: system-derived figures show an `info` chip,
  AI-projected figures show the §9 suggestion treatment with a citation

## Role KPI / Queue Sets

- **Medical Director** — pending certifications/recerts, F2F due, IDG decisions awaiting sign,
  orders needing cosignature, eligibility-at-risk patients
- **Billing Manager** — NOEs due/late, claim scrubber failures, denials aging, unbilled days,
  cap-utilization projection (`tabular-nums` money)
- **Bereavement Coordinator** — newly deceased, bereavement contacts due (13-month plan),
  risk-flagged families, overdue follow-ups
- **Scheduler / Dispatcher** — unassigned visits, today's coverage gaps, missed/late check-ins,
  EVV exceptions, frequency-order mismatches
- **QA Officer** — unsigned notes aging, late-entry rate, HOPE/SFV timeliness, chart-audit
  findings, documentation-completion %
- **Compliance Officer** — break-glass sessions, consent/SUD access events, amendment-SLA
  timers, expiring contracts/credentials, audit-trail anomalies
- **Intake Coordinator** — open referrals by source, intake-to-admission cycle time, pending
  eligibility checks, election signatures outstanding, referral-source conversion

---

## Statuses

Each KPI card carries a tone: `on-track`, `at-risk`, `breach`. Queues inherit their module's
item statuses; the dashboard only summarizes counts and ages.

---

## Edit Rules & Sensitive Data

- Dashboards are read-only; all editing happens in the deep-linked module screen.
- Role visibility is permission-scoped — a card renders only if the user holds the underlying
  read permission; otherwise it is omitted, not shown empty.
- Metrics over consent-gated (SUD/M39) or masked PHI respect the same gates; counts never leak
  protected detail, and drill-through re-applies access checks.
- Break-glass and audit metrics are themselves audited on view.

---

## Actions

- Drill into a KPI's queue
- Change date range / as-of
- Export dashboard
- Acknowledge / snooze an alert
- Quick action (role-specific, e.g. assign visit, request signature)

---

## Empty State

A role with nothing pending: KPI strip shows all-clear tones, charts render a flat baseline, and
the right panel reads "No risks or alerts right now."

---

## Pencil Notes

Create versions for:

- Medical Director dashboard (cert/recert + cosign queues)
- Billing Manager dashboard (NOE/denials/cap, `tabular-nums`)
- Bereavement Coordinator dashboard (13-month follow-ups)
- Scheduler / Dispatcher dashboard (coverage gaps, EVV exceptions)
- QA Officer dashboard (unsigned notes, documentation %)
- Compliance Officer dashboard (break-glass, consent access)
- Intake Coordinator dashboard (referral funnel, cycle time)
- All-clear empty state
