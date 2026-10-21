# CHARTWARDEN_UI_ELECTION_CERTIFICATION

Version: 1.0  
Status: Screen Specification  
Module: Election & Certification

---

## Purpose

This screen manages hospice election, benefit periods, certifications, recertifications, F2F requirements, and physician attestations.

---

## Primary Users

- RN
- Medical Director
- Attending Physician
- Office Manager
- Biller
- Administrator

---

## Layout Pattern

Use Patient Workspace + Stepper Workflow.

```text
Patient Banner
Election / Certification Header
Benefit Period Timeline
Certification Detail
Right: Compliance / Deadlines / Signatures
```

---

## Header Data

- Current benefit period
- Election date
- Certification status
- Recert due date
- F2F required
- Physician signature status
- Billing impact

---

## Benefit Period Timeline

Events:

- Election signed
- Initial certification
- Benefit Period 1
- Benefit Period 2
- Recertification
- F2F due
- Revocation / discharge if applicable

---

## Core Sections

### Election

- Election date
- Patient / representative signature
- Hospice provider
- Attending physician selection
- Notice acknowledgments
- Uploaded election form

### Certification

- Certifying physician
- Terminal diagnosis
- Prognosis statement
- Certification period
- Signature date
- Attestation language

### Recertification

- Benefit period number
- Recert due window
- F2F status
- Clinical narrative
- Physician review

### F2F

- Required indicator
- Visit date
- Provider
- Completed status
- Linked encounter

---

## Right Panel

- Missing signatures
- Billing blockers
- Recert deadline
- F2F deadline
- Open tasks
- Audit timeline

---

## Statuses

- Not Started
- Draft
- Pending Signature
- Complete
- Overdue
- Billing Blocked
- Expired

---

## Actions

- Create election
- Upload signed election
- Generate certification
- Request signature
- Link F2F encounter
- Mark complete
- Amend
- View audit trail

---

## Pencil Notes

Design:

- Benefit period card
- Certification form
- Recert warning state
- F2F required state
- Billing blocked state
