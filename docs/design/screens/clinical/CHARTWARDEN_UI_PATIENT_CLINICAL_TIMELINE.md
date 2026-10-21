# CHARTWARDEN_UI_PATIENT_CLINICAL_TIMELINE

Version: 1.0
Status: Screen Specification
Module: Patient Clinical Timeline (cross-cutting)

---

## Purpose

A unified, longitudinal view of everything that happened to a patient — admissions and
elections, visits, assessments, orders, medications, IDG decisions, level-of-care changes,
documents, and alerts — on one chronological surface. It is how a clinician orients quickly
(on-call, IDG prep, new-to-patient) and how a story is reconstructed for survey.

---

## Primary Users

All clinicians; especially on-call RN, IDG attendees, and anyone newly covering a patient.

---

## Layout Pattern

Use Patient Workspace + Timeline.

```text
Patient Banner
Timeline Filters (lanes · date range · discipline)
Chronological Event Stream  |  Right: Event Detail / Open Source
```

---

## Lanes (event types)

Visits & encounters, Assessments, Orders, Medications, Care Plan / IDG decisions, Documents,
Election & Certification, Level-of-care changes, Bereavement, Alerts. Each event is sourced
from its owning module.

---

## Filters & Presets

Filter by lane, date range, and discipline. Presets: "Since last IDG", "Since last visit",
"This benefit period". An **as-of / point-in-time** view reconstructs the record on a chosen
date (aligned with care-plan version snapshots).

---

## Behavior

- Read-only aggregation; every event deep-links to its source screen.
- Dense vs. comfortable density; collapse/expand lanes.
- Respects access scoping and privacy flags (SUD content gated by consent).

---

## Mobile Behavior

On-call quick-orient view: most-recent-first stream, lane chips, tap to open source.

---

## Empty State

Just-admitted patient: "The record starts here." showing admission/election as the first
events.

---

## Actions

- Filter lanes / date / discipline
- Apply preset (since last IDG / visit)
- View as-of date
- Open source event
- Export timeline summary

---

## Pencil Notes

Create versions for:

- Full timeline (all lanes)
- Filtered to one lane
- "Since last IDG" preset
- As-of / point-in-time
- Event detail
- Mobile on-call view
