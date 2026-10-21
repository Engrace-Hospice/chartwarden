# Stedi technical call: agenda (30 min)

Attendees: Engrace (Fabrice Adjam, engineering lead), Stedi (Customer Operations + engineer).
Context: ChartWarden is a multi-tenant hospice EHR. First tenant: Engrace Hospice, CCN 381588, Pendleton OR 97801.
Goal: leave with a provisioned sandbox, the payer/enrollment path for Oregon hospice, and answers on NOE/NOTR and adjustments.

## Volume (Engrace, estimated per month)
ADC 30-50. 837I ~35-60 (incl. ~10% adjustments), NOE ~10-15, NOTR ~10-15, eligibility ~25-45, 835s ~ claim count. About 100-170 transactions a month.

## 1. Sandbox provisioning (5 min)
- Test key authenticates (payer search, event destinations, mock eligibility return 200).
- Every 837I that passes edits returns 400 `ACCOUNT_NOT_PROVISIONED`; same on 277/835 report fetches and the polling endpoint.
- Ask: what enables test-mode claim submission on this account, and the Stedi Test Payer 835 flow?

## 2. Payer and enrollment (8 min)
- Payer search: Medicare Oregon Part A = `MDCKC` / `12M41`, 837I `ENROLLMENT_REQUIRED`. NGS `MFPWU` shows 837I `NOT_SUPPORTED`.
- Is `12M41` right for hospice 837I and for NOE/NOTR (TOB 81A/81B, 82A/82B)? Same payer ID and transaction?
- Enrollment requirements (CCN, NPI, PTAN, forms) and timeline. Can NOE/NOTR be tested before enrollment completes?

## 3. NOE/NOTR and adjustments (8 min)
- Edits we hit: BHT06=CH with $0 charge rejected, BHT06=RP passes. Is RP the correct value for notices?
- Frequency 7/8: docs say Original Medicare does not accept them; edit accepts with `REF*F8` directly after CL1. Does the MAC accept hospice adjustments (7) and cancels (8)? If not, what is the path?
- Any hospice-specific edits on Stedi's side (NOE timeliness, benefit periods, revenue/HCPCS pairing)? We found none.

## 4. Tenancy and responses (6 min)
- One integrated account per customer (OAuth) vs. our own account: recommended pattern for a multi-tenant platform; per-tenant event destinations and signing secrets.
- Event then fetch, with polling for reconciliation; ordering and retry guarantees. Idempotency keys last 24 h: our plan is a permanent local duplicate guard.
- HETS eligibility: per-NPI enrollment and attestation, `X-Forwarded-For`, production test coordination with CMS.

## 5. Next steps (3 min)
- Owners and dates for provisioning, enrollment paperwork, and the first test submission.

## Payloads to share (synthetic data only; in the session scratchpad `stedi/`)
- `FINAL_837I_hospice_claim.json` / `.x12`
- `FINAL_837I_hospice_NOE_81A.x12`, `FINAL_837I_hospice_NOTR_81B.x12`
- `FINAL_837I_hospice_adjust_817.x12`, `FINAL_837I_hospice_cancel_818.x12`
- Redacted sandbox responses in `responses/`

Full written question list: `STEDI_QUESTIONS_20261008.md` (Q1-Q19).
