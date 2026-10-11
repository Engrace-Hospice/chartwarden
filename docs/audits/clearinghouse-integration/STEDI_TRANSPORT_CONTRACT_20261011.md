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
| Auth | The 837I page shows `Authorization: <api key>`; the 837P page shows `Authorization: Key <api key>`. The bare key was observed working on payer search and event destinations (not on a claim route); `Key <key>` is documented but untried. Which form the claim route requires is **U**: send the bare key and confirm with one real call. | D, O, U |
| Idempotency | The adapter sends `Idempotency-Key` = SHA-256 of (org, provider, usage, caller key): Stedi's key space is account-wide, so the raw caller key would collide across tenants. `Idempotency-Key` (≤255 chars) replays safely for 24 h (https://www.stedi.com/docs/healthcare/submit-institutional-claims). The replay response shape, which feeds `replayed: true`, is **U** (never observed). We keep our own permanent attempt record, so the port's guarantee holds beyond that window. | D, U |
| Usage | Raw X12: ISA15 must be `T` for test (omitted gives 400 with a TA1); JSON: `usageIndicator: "T"`. `ctx.usage` maps to this and `test` must never reach `P`. | D, O |
| Success body | `status`, `controlNumber`, `tradingPartnerServiceId`, `claimReference{correlationId, patientControlNumber, timeOfResponse, formatVersion, rhClaimNumber, payerId, serviceLines[]}`, `meta.traceId`, `payer{payerName,payerID}`, `x12` (the initial Stedi 277CA), `httpStatusCode` | D |
| Newer API | The 837P page names `claims.us.stedi.com/2025-03-07/`; the 837I page does not. Stay on `2024-04-01` for 837I. | D |

## Error taxonomy (map onto `CH.*`)

| Stedi response | Meaning | `CH` code |
|---|---|---|
| 400 with `errors[]` (code `33`, description, followupAction) and a synchronous 277CA in `x12` | edit rejection: the claim is bad, nothing was filed | `INVALID_REQUEST` (report carries the findings, never PHI) |
| 400 schema errors `{errors:[{code,description,location}]}` or `{code: INVALID_REQUEST_BODY}` | body shape is wrong | `INVALID_REQUEST` |
| 400 `ACCOUNT_NOT_PROVISIONED` | **configuration error, not a claim rejection** | `NOT_PROVISIONED` |
| **U:** no response shape observed for "not enrolled" | provider not enrolled with the payer | `NOT_ENROLLED` once the real signal is known (Q15/Q16). Payer search shows `ENROLLMENT_REQUIRED` for every Part A payer whether or not we are enrolled, so it is not that signal; never pre-check it, and never apply `NOT_ENROLLED` to `validateOnly` (the port forbids gating validation on enrollment) |
| 401 (and 403, **U**) | bad or missing key | `NOT_WIRED` (operator must act; not retryable) |
| 409 / idempotency mismatch | key reused with a different payload | `IDEMPOTENCY_CONFLICT` |
| 429, 5xx, timeout, open breaker | | `UNAVAILABLE` (retryable) |

Rows for a bad (not missing) key and for 409 are inferred from convention: **U** until observed; a missing key returned
401 on events (O). Additional rules:

- `IDEMPOTENCY_CONFLICT` and `UNKNOWN_ORIGINAL` are decided from OUR attempt record, not from a Stedi response.
- The attempt record is `clearinghouse_submission_attempt` (migration 1067) and is written in two steps: **reserve** before the POST (live-unique on key and on control number per scope, so two concurrent submissions cannot both send), **complete** with Stedi's id after. A definitive refusal (4xx, 429) **releases** the reservation. An ambiguous failure (network error, timeout, 5xx) may have been filed, so the reservation is backdated and the next attempt re-sends at once under the **same wire key**, which Stedi replays inside its 24 h window; once 24 h have passed since the *first* reservation the adapter refuses to re-send, raises a `stale_reservation` anomaly and leaves it to reconciliation. A reservation another process made less than 15 minutes ago is held, not re-sent.
- `verifyAndParseEvent` returns `INVALID_SIGNATURE` on any mismatch, missing header, malformed value or stale
  timestamp (fail closed, constant-time compare, bounded tolerance).
- Mapping an edit rejection to `INVALID_REQUEST` is a deliberate choice: the port defines it as "refused before send",
  and a Stedi edit rejection files nothing. During `validateOnly` an edit rejection is NOT a degraded envelope: it is
  `valid: false` with PHI-free `issues[]`.

## Acknowledgments (stages 5–6)

- The success body's `x12` field is documented as Stedi's initial 277CA (D). **No 200 has ever been observed** (Q14),
  and the only synchronous 277CA we saw was on a 400 edit rejection (O). Whether the initial 277CA is synchronous or
  arrives within about 30 minutes (D, claim-responses-overview) is **U**.
- The adapter emits `AckEvent{stage:"clearinghouse", disposition:"accepted"}` ONLY after parsing a 277CA whose status
  code is an acceptance. A bare HTTP 200 is never an accept; if `x12` is absent, emit nothing and let polling deliver
  the ack. A rejecting STC in a 200 is a `rejected` event. Payer 277CAs follow and are the `payer` stage.
  `routeAckEvent` already maps both stages. The STC values for accept/forward (A1/19, 16) in the findings are a design
  guess (**U**), not a sourced fact.
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
| Q15/Q16 payer id and enrollment for Part A (Oregon: `MDCKC` / `12M41`, `ptanRequired: true`; the findings' list of other states' Part A payers is for comparison) | production use; NOE/NOTR before enrollment |
| Q17 frequency 7/8 (Stedi's resubmit page says Medicare does not take 7/8 for resubmissions; whether that covers adjusting paid hospice claims is **U**, and the Stedi edit itself accepts 7/8 with `REF*F8`) | adjustment and cancel stay `not supported` |
| BHT06 `CH` vs `RP` for NOE/NOTR (Stedi rejects `CH` with $0 charge) | notice builders |
| signature signed-content format (above) | `verifyAndParseEvent` |

## Mapping to the port

| `ClearinghouseTransport` | Stedi |
|---|---|
| `validateOnly` | **MUST NOT call `submission` or `raw-x12-submission`.** On a provisioned account a claim that passes edits is filed (with `usage: production`, a real claim) and the idempotency key is consumed, both forbidden by the port. The sandbox showed edits running before the provisioning check, but that is evidence about an unprovisioned account, not an adapter strategy. No documented dry-run exists (**U**), so until one is confirmed with Stedi `validateOnly` returns a degraded `CH_NOT_WIRED` with a PHI-free reason; `checkStediEdits` (local) is the pre-submission gate |
| `submitClaim` | 837I JSON (our mapper) or raw X12. `adjustment` set returns `INVALID_REQUEST` until Q17 and sends nothing to Stedi. Claim frequency is 7 = replacement, 8 = void (the port comment at `types.ts:262` says 8/9 and is wrong; follow 7/8) |
| `submitNotice` | raw X12 837I TOB 81A/81B, **BHT06 = RP, no DTP*096** (BHT06 `CH` with a $0 charge is rejected; the repo's transfer-notice fixture uses `CH` and would 400). RP means "not for adjudication", so a receipt is NOT proof the MAC filed the notice: only a payer-stage ack is. TOB 82A/82B and transfer notices are **U** (not exercised) |
| `fetchAcknowledgments` | polling transactions filtered to 277, plus any 277CA returned at submit. The Stedi account is shared by all tenants, so every item is attributed to (organizationId, providerEntityId, usage) through our stored attempt record; an item that cannot be attributed is dropped and never returned |
| `fetchRemittances` | polling filtered to 835, then `reports/v2/{id}/835`. The tenant-attribution rule for an 835 is **U** (the sources do not cover it); until defined, return nothing rather than another tenant's remittance. The consumer side (the M25 835 worker port, plan item A5) is also undefined |
| `fetchClaimStatus` | 276/277 status inquiry **U**. Until implemented return a degraded `CH_NOT_WIRED`; never a `not_found` state, which could drive a duplicate resubmission |
| `verifyAndParseEvent` | Standard Webhooks verification, then a reference only |
| `checkEligibility` | eligibility-check endpoint (later PR) |
