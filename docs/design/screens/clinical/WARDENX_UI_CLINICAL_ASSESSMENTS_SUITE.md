# WARDENX_UI_CLINICAL_ASSESSMENTS_SUITE

Version: 1.0  
Status: Screen Specification  
Module: Clinical Assessments Suite

---

## Purpose

The Clinical Assessments Suite supports hospice assessment tools such as PPS, FAST, PAINAD, ESAS, fall risk, wound assessments, and symptom assessments.

---

## Primary Users

- RN
- LPN/LVN
- Social Worker
- Chaplain
- Medical Director
- Quality Manager

---

## Layout Pattern

Use Patient Workspace + Documentation Workspace.

```text
Patient Banner
Assessment Header
Left: Assessment List
Center: Assessment Form / Results
Right: Trends / Risk / AI Suggestions
```

---

## Assessment List

Grouped by:

- Functional
- Pain / Symptoms
- Cognitive
- Psychosocial
- Spiritual
- Safety
- Wound
- Custom

---

## Common Assessment Header

- Assessment name
- Date/time
- Discipline
- Performed by
- Linked visit
- Status
- Prior score

---

## Assessment Detail

Each assessment should show:

- Questions/items
- Score
- Interpretation
- Trend
- Required follow-up
- Care plan link

---

## Supported Initial Assessments

- PPS
- FAST
- PAINAD
- ESAS
- Fall Risk
- Braden / Skin Risk
- Wound Assessment
- Psychosocial Assessment
- Spiritual Assessment
- Bereavement Risk
- Medication Risk

---

## Right Panel

- Previous scores
- Trend chart
- Related care plan problems
- Triggered alerts
- Suggested interventions
- Required follow-up

---

## Statuses

- Not Started
- In Progress
- Completed
- Reviewed
- Amended
- Voided

---

## Actions

- Start assessment
- Save draft
- Complete
- Link to care plan
- Add follow-up task
- Compare previous scores

---

## Mobile Behavior

Assessments should be step-based on mobile.

Show:

- One section at a time
- Score preview
- Required missing items
- Save draft
