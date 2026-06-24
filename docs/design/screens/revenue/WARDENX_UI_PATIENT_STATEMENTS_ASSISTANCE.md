# WARDENX_UI_PATIENT_STATEMENTS_ASSISTANCE

Version: 1.0
Status: Screen Specification
Module: Billing (M23, M24)

---

## Purpose

The Patient Statements & Financial Assistance queue is where billing staff generate patient-
responsibility statements, record payments, and administer financial-assistance programs. It
covers the amounts a patient owes after payer adjudication — coinsurance, deductible, and non-
covered services — and the charity-care, hardship, sliding-scale, and payment-plan paths that
reduce or restructure that balance.

---

## Primary Users

- Biller / Patient Accounts Specialist
- Office Manager
- Financial Counselor
- Administrator
- Compliance / Privacy Officer

---

## Layout Pattern

Use Work Queue.

```text
Page Header (statement run · open balance total · assistance requests)
KPI Strip
Filter Bar (balance band · payer · assistance status · aging)
Patient Balance Table  |  Right Detail Panel (statement / payments / assistance)
```

---

## KPI Cards

- Open Patient Balance
- Statements Ready to Send
- Payments Posted (period)
- Assistance Requests Pending
- Balances >90d Aging

---

## Patient Statement

- Statement lines: coinsurance, deductible, non-covered services, prior balance, credits
- Amounts in `tabular-nums`; statement total and aging bucket shown
- Source linkage to the adjudicated claim / remittance (M24) for each responsibility line
- Generate / preview / send (print + portal delivery); delivery channel + date captured
- Itemized vs summary statement variant

---

## Payment Recording

- Method: cash, check, card, ACH, money order
- Posting: applied to specific statement lines or as an unapplied credit
- Reference number, posting date, posted-by; reversal/refund creates a new offsetting row
- Receipt generation; overpayment surfaces a credit-balance chip

---

## Financial Assistance

- Programs: charity care (full write-off), hardship waiver, payment plan, sliding scale
- Eligibility intake: income, household size, documentation upload + reviewer decision
- Sliding-scale tier computes adjusted responsibility (derived, §9-labeled) in `tabular-nums`
- Payment plan: installment amount, schedule, next-due countdown chip, missed-payment flag
- Approved assistance posts an adjustment against the statement with reason + approver

---

## Statuses

Statement: `Draft`, `Ready`, `Sent`, `Paid`, `Partially Paid`, `In Collections`, `Written Off`.
Assistance request: `Submitted`, `Under Review`, `Approved`, `Denied`, `Plan Active`.

---

## Edit Rules & Sensitive Data

- Charity-care and hardship write-offs require approver authority; the adjustment captures actor,
  reason, and amount to audit — no silent balance changes.
- Posted payments are immutable; corrections are reversals/refunds as new offsetting rows.
- Financial-assistance income and household documentation is sensitive PII — visible to
  financial-counselor / billing roles only, never on the general patient banner.
- Statements never disclose clinical detail beyond service dates and responsibility amounts;
  SUD-related lines honor §8 redaction.
- Sending a statement on an account with a pending assistance request is gated by a Guard Chip.

---

## Actions

- Generate / preview / send statement
- Record / reverse payment
- Start financial-assistance request
- Approve / deny assistance (reason captured)
- Set up / adjust payment plan
- Apply write-off (gated)

---

## Empty State

No patient balances after the latest remittance: queue shows "No outstanding patient
responsibility" with a note that statements generate only after payer adjudication posts a
patient-owed amount, and a deep-link to the remittance posting queue (M24).

---

## Pencil Notes

Create versions for:

- Balance queue (aging bands, amounts in `tabular-nums`)
- Statement detail (coinsurance / deductible / non-covered lines, `tabular-nums`)
- Payment recording with method + reference, receipt
- Sliding-scale assistance with derived adjusted balance
- Payment plan with next-due countdown chip
- Charity-care write-off approval (gated, reason captured)
- Pending-assistance Guard Chip blocking a statement send
- Empty state (no patient responsibility)
