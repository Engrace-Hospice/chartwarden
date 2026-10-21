# Questions for Stedi: hospice DDE/clearinghouse integration

**Date:** 2026-10-08
**Context:** ChartWarden is a multi-tenant hospice EHR. We want to submit Medicare hospice institutional
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

## Answers received 2026-10-09 (Customer Operations, by email)

- **Raw X12 837I:** Stedi generates the envelopes. Set `ST03` to `005010X223A2` and put the payer ID in 2010BB `NM109`. (Q1/Q2 in part)
- **Responses:** 999s, Stedi's 277CA, the MAC's 277CA and 835s all arrive as processed transaction events. Payloads are references (`transactionId`, `fileExecutionId`). Each destination has its own rotatable signing secret. Use the poll transactions endpoint to reconcile missed events. (Q9, Q10)
- **Eligibility:** Medicare runs through HETS (payer ID `CMS`) via raw X12 or the CAQH CORE SOAP endpoint. Each NPI needs CMS enrollment and attestation, which Stedi handles. Pass upstream IPs in `X-Forwarded-For`. Requests from outside the U.S. are blocked, and production testing with CMS is coordinated through Stedi. (Q11)
- **Testing:** test claims to any payer ID return test 277CAs, and the Stedi Test Payer returns test 835s. (Q12 in part)
- **Not yet answered:** hospice-specific items and tenant setup, to be covered on a 30-minute technical call. Stedi also asked for expected weekly or monthly volume of checks and claims.

Note: the answer that test claims to any payer ID return test 277CAs does not match what the sandbox
returned on 2026-10-09 (`ACCOUNT_NOT_PROVISIONED` on every 837I that passed edits). See follow-up Q14.

## Follow-up questions (sandbox probe, 2026-10-09)

Payer search with the sandbox key shows Medicare Oregon Part A as Stedi ID `MDCKC`, payer ID `12M41`,
with 837I, 835 and eligibility all `ENROLLMENT_REQUIRED`. NGS `MFPWU` (13001) shows 837I
`NOT_SUPPORTED`.

14. Our sandbox key returns `ACCOUNT_NOT_PROVISIONED` (HTTP 400) on every 837I that passes your edits,
    and on 277/835 report fetches and the polling endpoint. Your reply says test claims to any payer ID
    return test 277CAs. What provisioning does this account need, and can you enable it?
15. Is `MDCKC` / `12M41` the right payer for Oregon hospice 837I and for NOE/NOTR (TOB 81A/81B, 82A/82B)?
    Our CCN is 381588 (Pendleton, OR 97801). Do NOE/NOTR use the same payer ID and the same 837I
    transaction?
16. What does enrollment for `12M41` require (CCN, NPI, PTAN, signed forms), and how long does it take?
    Can we test NOE/NOTR before enrollment completes?
17. Your docs say Original Medicare does not accept claim frequency 7 or 8 for resubmissions, yet your
    edit accepts them when `REF*F8` follows `CL1`. Does the MAC accept hospice adjustments (7) and
    cancels (8)? If not, what is the supported path?
18. Does your edit engine apply any hospice-specific rules (NOE timeliness, benefit-period dates,
    revenue-code/HCPCS pairing)? Our tests found none, and we treat our own validation as the gate.
19. Volume estimate (you asked): ADC 30-50; per month about 35-60 837I claims (incl. ~10% adjustments), 10-15 NOE, 10-15 NOTR, 25-45 eligibility checks; about 100-170 transactions in total.

Evidence for the technical call: payloads that pass your edits are in the session scratchpad
(`FINAL_837I_hospice_*`); synthetic data only.

## Follow-up questions (transport build, 2026-10-11)

These come from building the submit side against your sandbox. Each is something the code now depends on
an assumption for; we will not build wire behaviour on an unconfirmed answer. **Blocking** items gate
the receive side.

20. **(blocking)** Is there a documented validate-without-filing mode? We need to check a claim without it
    being filed or consuming the idempotency key. Does `usageIndicator: T` on a provisioned account
    never file? Do edits still run on an account that is not provisioned for the payer?
21. **(blocking)** NOE/NOTR use `BHT06 = RP` in our tests (`CH` with a $0 charge is rejected). Is `RP` the
    value a Medicare MAC expects for notices, or does it mean "not for adjudication" and risk the MAC
    ignoring the notice? Is a notice accepted on `CH` with any other shape?
22. **(blocking)** Webhook signatures: what exact content is signed? Your page words it as `timestamp.body`;
    the Standard Webhooks form is `id.timestamp.body`. How is the secret encoded (is a `whsec_` prefix
    stripped and the rest base64-decoded)? Which header names carry the id, timestamp and signature?
23. Claim routes: is the `Authorization` header the bare key or `Key <key>`? The 837I and 837P pages
    differ, and we have only seen the bare key work, on payer search and event destinations.
24. Idempotency: what does a replay return (same body, a marker header)? What does a reused key with a
    different body return?
25. Is the initial 277CA returned in the 200 body or delivered later (about 30 minutes)? Which STC codes
    mean "accepted by Stedi" versus "forwarded to the payer"?
26. What response shape means "provider not enrolled with this payer"? Payer search shows
    `ENROLLMENT_REQUIRED` for every Part A payer whether or not we are enrolled.
27. **(blocking)** On a shared account, how do we attribute an 835 or a 277CA to a tenant? Can polling
    results be filtered by billing NPI, or does each report carry a per-provider identifier?
28. If frequency 7/8 is refused for Medicare, how is a **paid** hospice claim adjusted or cancelled?
    Does your restriction cover TOB 8x7/8x8 at all?
29. Is claim status inquiry (276/277) available through the API for hospice institutional claims?
30. Is TOB 82A/82B and 8xC/8xD (transfer) accepted? Not yet exercised in the sandbox.
31. Why does NGS `MFPWU` show 837I `NOT_SUPPORTED` while Medicare Oregon Part A (`MDCKC`, `12M41`) does not?
    Which is correct for an Oregon hospice (CCN 381588)?
