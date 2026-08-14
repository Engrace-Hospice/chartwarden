# WARDENX_UI_QUALITY_MEASURES_CHART_AUDIT

Version: 1.0
Status: Screen Specification
Module: QUALITY (M30)

---

## Purpose

The quality-measures and chart-audit cockpit: hospice **quality-measure results** (HIS/HOPE,
HVLDL, Hospice Care Index components) shown as numerator/denominator/rate with meets-target and
trend, the **chart-audit** workflow that samples records and records findings against Conditions
of Participation, and **CAHPS Hospice Survey** tracking (caregiver experience scores, response
rate, vendor administration). It links measure shortfalls to audit findings to corrective action.

---

## Primary Users

- QAPI / Quality Officer
- Compliance Officer
- Clinical Manager / Medical Director
- Administrator

---

## Layout Pattern

Use Dashboard.

```text
Page Header
KPI Strip (measures below target · open audit findings · CAHPS top-box · response rate)
Charts (measure trend · meets-target distribution · CAHPS composites)
Measure / Finding Table  |  Right: Measure Detail / Audit Finding / Corrective Action
```

---

## Quality Measures

- Per measure: numerator · denominator · rate · benchmark · **meets-target** flag · trend
- Source timepoints (HIS/HOPE admission/discharge, HVLDL last-days-of-life)
- Drill from a failing measure to the contributing records (the denominator roster)
- Reporting-period selector + national/state comparison

---

## Chart Audit Workflow

- Audit definition: scope, sample method (random / targeted), period, CoP reference set
- Sampled charts queue; per chart, an audit checklist (documentation timeliness, signatures,
  care-plan/IDG compliance, F2F, election validity)
- **Findings** captured with a **CoP citation**, severity, and a required corrective action
- Auditor notes; chart locked from audit edits once finding is recorded

---

## CAHPS Survey Tracking

- Composite scores (communication, timely help, respect, emotional/spiritual support, rating,
  willingness-to-recommend) with top-box %
- Response rate, eligible/excluded counts, vendor + fielding window
- Trend vs national percentile

---

## Statuses

Audit: `Defined` → `Sampling` → `In review` → `Findings recorded` → `Corrective action` →
`Closed`. Finding: `Open` → `Action assigned` → `Verified` → `Resolved`.

---

## Edit Rules & Sensitive Data

- Requires `quality.measure.audit` (registered M30 key); measure config requires `quality.measure.read` / `quality.measure.recompute` (registered M30 keys).
- Sampled charts carry full PHI — masked by default, reveal step-up + audited; SUD/Part 2
  content stays sealed unless consent permits, and audit findings never quote sealed content.
- Measure rates are computed/derived — shown with a **system-derived provenance chip**
  ("derived from HIS/HOPE timepoints") so they read as factual, not entered.
- Findings cite the specific CoP and require a corrective action with owner + due date;
  closing an audit with open findings is blocked by a Guard Chip.
- Corrective-action follow-up carries a deadline countdown chip.

---

## Actions

- Define / run a chart audit · pull a sample
- Audit a chart (checklist) · record a finding (with CoP citation)
- Assign / verify corrective action · close audit
- Open a measure → contributing-records roster
- Export quality / CAHPS report

---

## Empty State

No active audits and measures within target: dashboard shows green meets-target tiles, "No open
findings", and a "Start a chart audit" affordance.

---

## Pencil Notes

Create versions for:

- Measure dashboard with numerator/denominator/rate tiles + trend chart + **meets-target** flags
- A failing measure drilled to its contributing-records roster (**system-derived** provenance chip)
- Chart-audit review with the audit checklist and a **finding + CoP citation**
- Corrective-action tracker with a **deadline countdown chip** and closure **Guard Chip**
- CAHPS composites panel with top-box % and national-percentile trend
- Masked sampled-chart PHI vs step-up reveal; a sealed Part 2 block in an audited chart
