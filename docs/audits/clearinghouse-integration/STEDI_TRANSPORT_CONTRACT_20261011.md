# Stedi transport contract (input to the `StediTransport` adapter)

What the adapter may rely on, with its source. **D** = Stedi documentation, **O** = observed in our sandbox
(`STEDI_SANDBOX_FINDINGS_20261009.md`), **U** = unverified: do not build wire behaviour on a U row, and do not
mark it done until a live or documented answer exists. Checked against the public docs on 2026-10-11.

## Transport basics

| Item | Contract | Src |
|---|---|---|
| Claim base URL | `https://healthcare.us.stedi.com/2024-04-01/` | D |
| 837I JSON | `POST …/change/medicalnetwork/institutionalclaims/v1/submission` | D |
| 837I raw X12 | `POST …/change/medicalnetwork/institutionalclaims/v1/raw-x12-submission`, body `{"x12": "<ISA…>"}` | D, O |
| Auth | `Authorization: <api key>`; the docs also show `Authorization: Key <api key>` and both authenticated in the sandbox. Use the bare key as the 837I page shows it. | D, O |
| Idempotency | `Idempotency-Key` (≤255 chars) replays safely for 24 h. We keep our own permanent attempt record, so the port's guarantee holds beyond that window. | D |
| Usage | Raw X12: ISA15 must be `T` for test (omitted gives 400 with a TA1); JSON: `usageIndicator: "T"`. `ctx.usage` maps to this and `test` must never reach `P`. | D, O |
| Success body | `status`, `controlNumber`, `tradingPartnerServiceId`, `claimReference{correlationId, patientControlNumber, timeOfResponse, formatVersion, rhClaimNumber, payerId, serviceLines[]}`, `meta.traceId`, `payer{payerName,payerID}`, `x12` (the initial Stedi 277CA), `httpStatusCode` | D |
| Newer API | The 837P page names `claims.us.stedi.com/2025-03-07/`; the 837I page does not. Stay on `2024-04-01` for 837I. | D |

## Error taxonomy (map onto `CH.*`)

| Stedi response | Meaning | `CH` code |
|---|---|---|
| 400 with `errors[]` (code `33`, description, followupAction) and a synchronous 277CA in `x12` | edit rejection: the claim is bad, nothing was filed | `INVALID_REQUEST` (report carries the findings, never PHI) |
| 400 schema errors `{errors:[{code,description,location}]}` or `{code: INVALID_REQUEST_BODY}` | body shape is wrong | `INVALID_REQUEST` |
| 400 `ACCOUNT_NOT_PROVISIONED` | **configuration error, not a claim rejection** | `NOT_PROVISIONED` |
| payer record `ENROLLMENT_REQUIRED` for the transaction | provider not enrolled with the payer | `NOT_ENROLLED` |
| 401 | bad or missing key | `NOT_WIRED` (operator must act; not retryable) |
| 409 / idempotency mismatch | key reused with a different payload | `IDEMPOTENCY_CONFLICT` |
| 429, 5xx, timeout, open breaker | | `UNAVAILABLE` (retryable) |

Rows for 401 and 409 are inferred from convention: **U** until observed.

## Acknowledgments (stages 5–6)

- A synchronous 200 carries Stedi's own 277CA (`x12`): this is the **clearinghouse** stage accepting. A payer 277CA
  follows later and is the **payer** stage (D: initial Stedi 277CA within about 30 minutes, payer 277CAs after).
  The adapter emits `AckEvent{stage:"clearinghouse"|"payer", disposition}`; `routeAckEvent` already maps them.
- A 999 exists only for SFTP, not for API submissions (D). The clearinghouse accept is therefore derived from the
  synchronous 277CA, not from a 999.
- Fetch: `GET https://healthcare.us.stedi.com/2024-04-01/reports/v2/{transactionId}/277|835` (D). Both answered
  `ACCOUNT_NOT_PROVISIONED` in our sandbox (O).

## Events and polling (stage 16, event-then-fetch)

- Event destinations: `events.us.stedi.com/2026-02-01/destinations` (O). `transaction.processed` carries resource ids
  only, so the adapter fetches the resource (D).
- Signature: Standard Webhooks, headers `webhook-id`, `webhook-timestamp`, `webhook-signature: v1,<base64>`, HMAC-SHA256 with the
  destination secret (D). **U:** the Stedi page words the signed content as `timestamp.body`; the Standard Webhooks
  spec is `id.timestamp.body` with a `whsec_` base64 secret. Confirm against a real delivery or Stedi's sample before
  coding `verifyAndParseEvent`; our conformance suite uses an in-process signature, so it cannot catch this.
- Delivery: at-least-once, no ordering guarantee, retries at 5 m, 30 m, 2 h, 8 h, 24 h, 48 h, then the destination is
  disabled (D). Dedupe on `webhook-id` (D); every consumer idempotent on `eventId`.
- Reconciliation poll: `GET https://core.us.stedi.com/2023-08-01/polling/transactions?startDateTime=…|pageToken=…`,
  filter `direction=INBOUND` and `x12.transactionSetIdentifier` 277/835 (D). `ACCOUNT_NOT_PROVISIONED` in sandbox (O).

## Eligibility (later PR)

`POST https://healthcare.us.stedi.com/2026-06-01/eligibility-check`, `payerId: CMS` (mock `memberId CMS12345678`) (O).
The real CMS payer record shows eligibility `ENROLLMENT_REQUIRED`. HETS specifics are **U**.

## What blocks a live adapter

| Open item | Blocks |
|---|---|
| Q14 `ACCOUNT_NOT_PROVISIONED` on every claim that passes edits | any observed success body, 277CA, claim id, idempotency replay, events |
| Q15/Q16 payer id and enrollment for Part A (`MDCKC` / `12M41`, `ptanRequired: true`) | production use; NOE/NOTR before enrollment |
| Q17 frequency 7/8 (Stedi docs say Medicare does not take them for resubmission) | adjustment and cancel stay `not supported` |
| BHT06 `CH` vs `RP` for NOE/NOTR (Stedi rejects `CH` with $0 charge) | notice builders |
| signature signed-content format (above) | `verifyAndParseEvent` |

## Mapping to the port

| `ClearinghouseTransport` | Stedi |
|---|---|
| `validateOnly` | the same submission endpoint returns the edit result before the provisioning check (O); no submission may be created, so a validate call needs a vendor dry-run path that is **U** (do not send a real submission to validate) |
| `submitClaim` | 837I JSON (our mapper) or raw X12; `adjustment` set returns `INVALID_REQUEST` until Q17 |
| `submitNotice` | raw X12 837I TOB 81A/81B/82A/82B |
| `fetchAcknowledgments` | polling transactions filtered to 277, plus the synchronous 277CA stored at submit |
| `fetchRemittances` | polling filtered to 835, then `reports/v2/{id}/835` (needs A5 on our side) |
| `fetchClaimStatus` | 276/277 status inquiry **U** |
| `verifyAndParseEvent` | Standard Webhooks verification, then a reference only |
| `checkEligibility` | eligibility-check endpoint (later PR) |
