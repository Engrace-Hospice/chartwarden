# WARDENX_UI_REMITTANCE_ERA_POSTING

Version: 1.0  
Status: Screen Specification  
Module: Remittance / ERA Posting

---

## Purpose

The Remittance / ERA Posting screen manages 835 files, payments, adjustments, posting exceptions, and reconciliation.

---

## Primary Users

- Biller
- Billing Manager
- Administrator
- Finance Staff

---

## Layout Pattern

Use Work Queue.

```text
Page Header
KPI Strip
ERA File Queue
Right: ERA Detail / Posting Exceptions
```

---

## KPI Cards

- ERA Files Received
- Payments Unposted
- Posting Exceptions
- Denials Found
- Total Payments

---

## ERA Queue Columns

- ERA file
- Payer
- Received date
- Payment amount
- Claims count
- Posted count
- Exception count
- Status

---

## ERA Detail

Sections:

- Payment summary
- Claim payments
- Adjustments
- CARC/RARC codes
- Unmatched claims
- Posting exceptions
- Deposit reconciliation

---

## Statuses

- Received
- Parsed
- Partially Posted
- Posted
- Exception
- Reconciled

---

## Actions

- Import ERA
- Parse
- Auto-post
- Resolve exception
- Match claim
- Export posting report
