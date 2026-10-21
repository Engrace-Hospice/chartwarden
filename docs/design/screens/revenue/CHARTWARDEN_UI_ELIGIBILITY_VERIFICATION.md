# CHARTWARDEN_UI_ELIGIBILITY_VERIFICATION

Version: 1.0  
Status: Screen Specification  
Module: Eligibility Verification

---

## Purpose

Eligibility Verification manages Medicare/Medicaid/commercial eligibility checks, benefit period verification, hospice election history, and billing readiness.

---

## Primary Users

- Intake Coordinator
- Biller
- Office Manager
- Administrator

---

## Layout Pattern

Use Work Queue + Patient Detail.

```text
Page Header
KPI Strip
Eligibility Queue
Right: Eligibility Result Detail
```

---

## KPI Cards

- Pending Checks
- Eligibility Failed
- Active Medicare
- Hospice History Found
- Manual Review Needed

---

## Queue Columns

- Patient
- Payer
- Check type
- Status
- Last checked
- Result
- Owner
- Actions

---

## Detail Panel

Sections:

- Payer information
- Eligibility response
- Hospice benefit status
- Prior hospice episodes
- Medicare Advantage indicators
- Medicaid status
- Errors / warnings

---

## Statuses

- Not Checked
- Pending
- Eligible
- Not Eligible
- Manual Review
- Error

---

## Actions

- Run eligibility
- Re-run
- Mark reviewed
- Attach proof
- Create billing task
