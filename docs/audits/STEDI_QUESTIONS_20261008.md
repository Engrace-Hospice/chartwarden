# Questions for Stedi: hospice DDE/clearinghouse integration

**Date:** 2026-10-08
**Context:** WardenX is a multi-tenant hospice EHR. We want to submit Medicare hospice institutional
claims, Notices of Election (NOE, TOB 8xA) and Notices of Termination/Revocation (NOTR, TOB 8xB)
through Stedi, receive 277CA and 835 responses, and run Medicare eligibility checks.

Please answer in writing. Items marked **blocking** gate our build.

## Payer and transaction support

1. **(blocking)** Does the National Government Services payer record (Stedi ID `MFPWU`, payer ID 13001)
   cover hospice institutional claims (TOB 81x/82x) for the HH+H jurisdictions? Which MAC jurisdictions
   and payer IDs should we use for J6 and for other MACs?
2. **(blocking)** Are NOE (8xA) and NOTR (8xB) accepted through the 837I raw X12 endpoint? Does the 837I
   JSON endpoint accept `A`/`B`/`C`/`D`/`E` in `claimFrequencyCode` (the documented list is 1, 2, 3, 4, 7, 8, 9)?
3. **(blocking)** How are adjustments (TOB 8x7) and cancels (8x8) of already-adjudicated Medicare claims
   submitted? Your resubmission guidance says Original Medicare does not accept frequency codes 7 or 8
   and that the payer claim control number must be omitted. Does that apply only to rejected-claim
   resubmissions, or also to adjustments/cancels of paid claims?
4. Are transfer notices (8xC/8xD) supported?

## Enrollment

5. **(blocking)** What is the enrollment unit for Medicare institutional claims and 835: per NPI, per
   provider entity, or per tenant? Is a PTAN required? Typical lead time?
6. Is a separate enrollment needed for NOE/NOTR vs claims?

## Authentication and tenancy

7. **(blocking)** Your integrated-account docs say new apps must use OAuth. Please confirm the current
   recommended model for a multi-tenant SaaS: one integrated account per tenant, per provider entity, or
   a shared platform account? How do test and production API keys relate to integrated accounts?

## Responses and events

8. For API submissions, after Stedi's initial 277CA, how long until the MAC's 277CA typically arrives?
   Are any 999s delivered for API submissions?
9. What event types do event destinations emit for 277CA and 835 delivery? Are payloads references only?
   How are events signed, and how should we verify them? What are the retry/ordering guarantees?
10. Recommended polling window and endpoint for reconciliation of missed events.

## Eligibility

11. What is the recommended path for Medicare (HETS) eligibility, and can it accept our existing X12
    270 over a CORE-style endpoint with a bearer token? Requirements for `X-Forwarded-For` and for
    production test data.

## Testing and certification

12. What does test mode cover for hospice claims and NOE/NOTR? What certification or pilot steps do you
    and the MAC expect before production?
13. Idempotency keys last 24 hours. Any recommended pattern for longer-term duplicate protection?
