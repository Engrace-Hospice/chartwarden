# CHARTWARDEN_UI_COST_REPORT_WORKSPACE

Version: 1.0  
Status: Screen Specification  
Module: Cost Report

---

## Purpose

The Cost Report Workspace supports CMS hospice cost report preparation, worksheet validation, ECR generation, and submission readiness.

---

## Primary Users

- Administrator
- Finance Staff
- Cost Report Preparer
- Compliance Officer

---

## Layout Pattern

Use Stepper Workflow + Work Queue.

```text
Cost Report Header
Left: Worksheet Navigation
Center: Worksheet Data Entry / Review
Right: Validation / Source Data / ECR Status
```

---

## Worksheet Navigation

Include:

- S / S-1 / S-2
- A / A-1 / A-6 / A-7
- B / B-1
- C
- D
- E
- G
- ECR Export

---

## Header Data

- Fiscal year
- Provider entity
- CCN
- Report status
- Completion %
- Validation status
- ECR readiness

---

## Right Panel

- Validation errors
- Source mapping
- Prior year comparison
- Notes
- Supporting documents
- ECR export status

---

## Statuses

- Not Started
- In Progress
- Validation Failed
- Ready for Review
- Ready for ECR
- Submitted
- Amended

---

## Actions

- Import trial balance
- Map accounts
- Validate worksheet
- Attach support
- Generate ECR
- Export PDF
