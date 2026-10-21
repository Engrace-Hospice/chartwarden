# CHARTWARDEN_UI_DOCUMENT_MANAGEMENT

Version: 1.0  
Status: Screen Specification  
Module: Document Management

---

## Purpose

Document Management handles upload, classification, storage, review, patient linking, DocLens processing, signatures, and retention.

---

## Primary Users

- Medical Records Staff
- Intake Coordinator
- RN
- Office Manager
- Compliance Officer
- Administrator

---

## Layout Pattern

Use Work Queue + Review Workspace.

```text
Document Header
KPI Strip
Document Queue
Right: Document Detail / Preview / Actions
```

---

## KPI Cards

- Unreviewed Documents
- Missing Signatures
- Intake Packets
- Low Confidence DocLens
- Expiring Documents

---

## Document Queue Columns

- Document
- Patient
- Type
- Source
- Uploaded by
- Status
- Date
- Retention class
- Actions

---

## Document Types

- Referral packet
- Election form
- Certification
- ID card
- Insurance card
- Medication list
- Lab
- Imaging
- Discharge summary
- Advance directive
- DPOA
- POLST/MOLST
- Physician order
- Consent

---

## Detail Panel

Shows:

- Document preview
- Metadata
- Linked patient
- Classification
- Review status
- Signatures
- Retention
- Audit history

---

## Actions

- Upload
- Classify
- Link to patient
- Send to DocLens
- Request signature
- Mark reviewed
- Archive
