# WARDENX_UI_ADMISSIONS_REFERRAL_INTAKE

Version: 1.0  
Status: Screen Specification  
Module: Admissions / Referral Intake

---

## Purpose

The Admissions / Referral Intake screen manages the first operational step of hospice onboarding: receiving referrals, capturing referral data, reviewing documents, checking eligibility, and preparing the patient for admission.

---

## Primary Users

- Intake Coordinator
- Admissions Nurse
- Office Manager
- Administrator
- Medical Director
- Biller

---

## Layout Pattern

Use Stepper Workflow + Review Workspace.

```text
Top Navigation
Referral Header
Left: Admission Steps
Center: Referral / Intake Form
Right: Documents / Eligibility / Risk
Sticky Footer Actions
```

---

## Intake Steps

1. Referral Received
2. Patient Demographics
3. Referral Source
4. Insurance / Eligibility
5. Clinical Eligibility Review
6. Documents
7. Admission Scheduling
8. Ready for Admission

---

## Header Data

- Referral ID
- Patient name
- Referral date/time
- Referral source
- Current intake status
- Assigned intake owner
- Admission urgency
- Hospice eligibility status

---

## Key Sections

### Referral Source

- Referring facility
- Referring physician
- Contact person
- Phone
- Fax/email
- Referral reason

### Patient Demographics

- Name
- DOB
- Address
- Phone
- Emergency contact
- Representative
- Preferred language

### Clinical Referral Data

- Primary diagnosis
- Secondary diagnoses
- Current location
- Hospital discharge date
- Functional decline summary
- Current medications
- DME needs
- Safety concerns

### Insurance

- Medicare / Medicaid / Commercial
- MBI / policy ID
- Eligibility status
- Benefit period history
- Prior hospice use

---

## Right Panel

Contains:

- Uploaded referral documents
- DocLens extraction status
- Eligibility status
- Missing information
- Risk indicators
- Assigned tasks

---

## Actions

- Create referral
- Upload documents
- Run DocLens
- Verify eligibility
- Schedule admission
- Convert to patient
- Reject referral
- Request more information

---

## Statuses

- New
- In Review
- Missing Information
- Eligibility Pending
- Admission Scheduled
- Converted to Patient
- Declined
- Duplicate

---

## Empty State

Message:

"No referrals are currently pending intake."

Actions:

- Create Referral
- Upload Referral Packet
- View Closed Referrals

---

## Pencil Notes

Create versions for:

- New referral
- Active referral review
- Missing information
- DocLens extraction available
- Ready for admission
