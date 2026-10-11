# Stedi sandbox findings (2026-10-09)

Test-mode key only, synthetic data only, no key in any file. Scripts: `submit.sh`, `gen.py`. Raw redacted responses: `responses/`. Payloads: `payloads/`.
Source docs for the OpenAPI shapes: github.com/Stedi/openApi (healthcare.json, event-destinations.json).

## Headline
1. The key authenticates (payer search, event-destination list, mock eligibility all 200).
2. **Claim submission cannot be completed on this account.** Any 837I (JSON or raw X12) that passes Stedi's edits returns HTTP 400 `ACCOUNT_NOT_PROVISIONED` ("does not have a provisioned environment for this operation. Contact Stedi support."). Same for `GET .../reports/v2/{id}/277|835` and `core.us.stedi.com/.../polling/transactions`. Stedi docs: test claims are "production accounts only" (https://www.stedi.com/docs/healthcare/test-mode). So no 277CA from the payer, no 835, no claimId/transactionId, no idempotency replay could be observed.
3. **But the edit engine runs before the provisioning check**, so it works as a validator: a request either gets a 400 with a synchronous 277CA (edit rejection) or gets `ACCOUNT_NOT_PROVISIONED` (inferred: passed edits). "Accepted" below means "passed edits", not accepted by any payer.
4. **Surprise:** payer search today shows `institutionalClaimSubmission: NOT_SUPPORTED` for NGS `MFPWU` (13001; only 835 = ENROLLMENT_REQUIRED). The state Part A payers are the 837I targets (ENROLLMENT_REQUIRED), e.g. Illinois `MCSFT` 06101, Minnesota `USFXM` 06201, Wisconsin `YUPFH` 06001, Connecticut `EVDRA` 13101, Massachusetts `JSYAJ` 14211, New York `MQYDS` 13201. All have `ptanRequired: true`. This contradicts the earlier review's "MFPWU supports 837I".

## Probe table
| # | Probe (no key) | Result |
|---|---|---|
| 1 | GET payers.us.stedi.com/2024-04-01/payers/search?query=MFPWU&pageSize=3 | 400, pageSize must be 10..100 |
| 1b | same, pageSize=10, also queries for Medicare/Palmetto/Part A/IL/MN/WI/Stedi Test | 200. Header `Authorization: <key>` works (docs say `Key <key>`) |
| 2 | POST 837I JSON, payer STEDI, usageIndicator T, occurrence list as flat objects | 400 INVALID_REQUEST_BODY: lists are arrays of arrays (one inner array per HI segment, max 2x12) |
| 3 | JSON, 811 (POS 81, freq 1), patient status 30 | 400 edit: "Invalid claim frequency and patient status usage. Status 30 conflicts with freq 1 (final bill)" |
| 4 | JSON, POS 81, freq 3, status 30, rev 0651 Q5001 | 400 ACCOUNT_NOT_PROVISIONED (passed edits) x2, stop |
| 5 | Raw X12 81:A:3 claim, 3 lines (0651, 0652 x32 units, 0655), CLM02=1500 = sum | ACCOUNT_NOT_PROVISIONED (passed edits) |
| 6 | Raw X12 same, freq 1 + status 30 | 400 edit, same message as #3 |
| 7 | Raw X12 same, CLM02=1400 vs lines 1500 | 400 edit: "Total claim charge amount ($1400.00) does not equal the sum of all service line charge amounts ($1500.00)" |
| 8 | Raw X12 NOE 81A, BHT06=CH, CLM02=0, SV2 0650 Q5009 charge 0 | 400 edit: "For Chargeable (CH) claims, total claim charge must be greater than zero" |
| 9 | Raw X12 NOTR 81B with DTP*096 D8 | 400 schema: "Element DTP-02 must equal 'TM'" (DTP*096 is discharge hour) |
| 10 | NOE 81A, BHT06=RP (not for adjudication), CLM02=0 | passed edits |
| 11 | NOTR 81B, BHT06=CH, charge 0 | 400 same CH>0 edit |
| 12 | NOTR 81B, BHT06=RP, no DTP*096 | passed edits |
| 13 | NOE with CLM05-3 = A, B, C, D, E (RP) | all passed edits |
| 14 | NOE 81A with charge 1.00 | passed edits |
| 15 | Claim, no NM1*71 attending (raw) | passed edits (the JSON route requires `attending`) |
| 16 | Claim, CL102 blank | 400 edit: "Missing admission source code ... required on all institutional claims" |
| 17 | Claim, no DTP*435 admission date | passed edits |
| 18 | Claim with only value code 61 (no G8) / no value codes at all | passed edits |
| 19 | TOB 82x (82:A:3) | passed edits |
| 20 | freq 7 without REF*F8 | 400 edit: "Payer Claim Control Number is missing... required for replacement or void (7, 8, G, I, X, Y)" |
| 21 | freq 7/8 with REF*F8 placed after NM1*71 | 400 schema: REF-01 must be 0B/1G/G2/LU (wrong loop) |
| 22 | freq 7/8 with REF*F8 right after CL1 (Loop 2300) | passed edits |
| 23 | Payer = Medicare Illinois Part A 06101 (claim and NOE) | passed edits (the payer record is not checked against enrollment before provisioning) |
| 24 | JSON claimFrequencyCode = "A" | passed edits (OpenAPI types it as a free string; docs list only 1,2,3,4,7,8,9) |
| 25 | GET events.us.stedi.com/2026-02-01/destinations and /events | 200, empty lists; no-key control = 401 |
| 26 | GET healthcare .../reports/v2/{uuid}/277 and /835; GET core .../polling/transactions | 400 ACCOUNT_NOT_PROVISIONED |
| 27 | POST healthcare.us.stedi.com/2026-06-01/eligibility-check, payerId CMS, memberId CMS12345678 | 200 mock 271 incl. Medicare Part A/B, STC 45 hospice benefit, QMB, and a mock UHC Medicare Advantage plan (MA overlay data) |

## Final payloads (synthetic; "passed Stedi edits" only)
- `FINAL_837I_hospice_claim.json` (JSON route, 811/813 style) and `FINAL_837I_hospice_claim.x12` (raw)
- `FINAL_837I_hospice_NOE_81A.x12`, `FINAL_837I_hospice_NOTR_81B.x12` (BHT06=RP)
- `FINAL_837I_hospice_adjust_817.x12`, `FINAL_837I_hospice_cancel_818.x12` (REF*F8 in 2300)
Claim shape: CLM05 `81:A:3`, CL1 `1*1*30`, HI `ABK`, `BH:27`, `BE:61` and `BE:G8` (CBSA as amount), NM1*71 attending, SV2 0651/0652/0655 with HC Q500x, DTP*472 line dates, CLM02 equals line sum. Endpoints: `https://healthcare.us.stedi.com/2024-04-01/change/medicalnetwork/institutionalclaims/v1/{submission|raw-x12-submission}`, headers `Authorization`, `Content-Type`, `Idempotency-Key`. Raw X12: body `{"x12": "..."}`, ISA15 must be `T` (docs: omitted gives 400 with TA1), ST03 `005010X223A2`.

## Answers to STEDI_QUESTIONS_20261008.md
Legend: D documented, O observed in sandbox, U unknown.
1. NGS MFPWU for hospice 837I: O, payer search shows 837I NOT_SUPPORTED for MFPWU (835 enrollment required). State Part A records (e.g. 06101 IL, 06201 MN, 06001 WI) show 837I ENROLLMENT_REQUIRED, PTAN required. Hospice-specific coverage: U (no doc mentions hospice; https://www.stedi.com/docs/healthcare/submit-institutional-claims).
2. NOE/NOTR via raw X12: O, edits pass for 81A/81B with BHT06=RP and zero charge; BHT06=CH is rejected for $0. Real payer acceptance U. JSON route accepts "A" in claimFrequencyCode past edits (O), though D lists only 1,2,3,4,7,8,9 (https://www.stedi.com/docs/healthcare/api-reference/post-healthcare-institutional-claims).
3. Adjustments/cancels: D, "Medicare does not accept Claim Frequency Codes 7 or 8 for resubmissions"; institutional claims "resubmit with the same CFC" and omit the PCCN (https://www.stedi.com/docs/healthcare/resubmit-cancel-claims). O: the Stedi edit itself accepts 7/8 with REF*F8 and rejects them without. The doc text is about resubmitting; whether it covers adjusting paid hospice claims: U.
4. Transfer 8xC/8xD: U (not exercised; same edit path as NOE expected).
5. Enrollment unit/PTAN/lead time: O, payer records carry `ptanRequired: true` for Part A; 835 enrollment `MULTI_STEP`, timeframe WEEKS (MFPWU). Unit (NPI/entity/tenant): U. Test mode does not support transaction enrollment (D, test-mode page).
6. Separate enrollment for NOE/NOTR: U.
7. OAuth/tenancy: U for sandbox; test key listed `/destinations` fine. Test claims production-accounts-only (D).
8. 277CA timing/999: D, initial Stedi 277CA within about 30 min, the payer's 277CAs follow; 999 only for SFTP (https://www.stedi.com/docs/healthcare/claim-responses-overview). O: the synchronous response already carries a 277CA in `x12` (Stedi edit result, STC A3/A7, REF*BLT = TOB). MAC timing: U.
9. Events: D, `transaction.processed` carries resource IDs, not data; Standard Webhooks signature (`webhook-id`, `webhook-timestamp`, `webhook-signature`, HMAC-SHA256); retries 5m, 30m, 2h, 8h, 24h, 48h then destination disabled; ordering not guaranteed; at-least-once; dedupe on `webhook-id` (https://www.stedi.com/docs/healthcare/event-destinations-message-handling, .../event-destinations-event-types). Not exercised (no deliveries possible).
10. Polling: D, `GET https://core.us.stedi.com/2023-08-01/polling/transactions?startDateTime=...|pageToken=...`, filter `direction=INBOUND` and `x12.transactionSetIdentifier` 277/835; fetch via `GET .../reports/v2/{transactionId}/277|835` (https://www.stedi.com/docs/healthcare/receive-claim-responses). O: both return ACCOUNT_NOT_PROVISIONED here.
11. Medicare eligibility: O mock via `POST https://healthcare.us.stedi.com/2026-06-01/eligibility-check` payerId CMS, memberId CMS12345678, STC 30 only (D: https://www.stedi.com/docs/healthcare/api-reference/mock-requests-eligibility-checks). CMS payer record: eligibility ENROLLMENT_REQUIRED. HETS CORE/X-Forwarded-For: U.
12. Hospice coverage in test mode: O, edits only; no hospice-specific edit seen (no NOE timing, benefit period, revenue/HCPCS pairing, or 0652 unit edits). Certification steps: U.
13. Idempotency: D, `Idempotency-Key` up to 255 chars, 24 h. O: not observable (no successful submission). Keep a permanent local guard.
Other D: no 835 in test mode except via the Stedi Test Payer (payer FRCPB, id STEDI; member ID prefixes STEDI_PAID_, STEDI_PARTIALLY_PAID_, STEDI_DENIED_ drive the 835), but that also needs provisioning here (https://www.stedi.com/docs/healthcare/test-claims-workflow). 835 for Medicare needs enrollment.

## Design implications for Phase 4
- Ack states: model `edit_rejected` (sync 400 + 277CA), `clearinghouse_accepted` (sync 200, STC A1/19), `forwarded` (16), `payer_277ca_accepted/rejected`, then 835. Drop the 999 step for API submissions.
- Edit errors come back as HTTP 400 with `errors[]` (code `33`, description, followupAction) plus a 277CA in `x12`; parse both; schema-level errors have `{errors:[{code,description,location}]}`, and body-shape errors `{code:INVALID_REQUEST_BODY}`. Treat `ACCOUNT_NOT_PROVISIONED` as a config error, not a claim rejection.
- Prefer events (`transaction.processed`, resource IDs only) plus a polling reconciler on the Poll Transactions endpoint; dedupe on `webhook-id`, never rely on order.
- Idempotency: send a key (nanoid), keep a permanent claim/PCN-based duplicate guard. PCN max 17 chars.
- ClaimDocument837i must add: admission type (CL101), admission source (CL102, edit-required), attending NPI/name, billing address/EIN, payer routing id (state Part A, not MFPWU), value codes 61/G8 (CBSA), line items whose charges sum to CLM02 (SIA/G0679 must be lines), revenue code + HCPCS Q500x per line, line dates, frequency/status consistency (final bill 1 needs a discharge status; ongoing hospice uses 2/3 with status 30), and REF*F8 payer claim control number for any 7/8.
- Notices: send NOE/NOTR as raw X12 with BHT06=RP and no DTP*096 (D8). Whether the real MAC wants CH or RP is U; check the CMS NOE companion guide, because the repo's transfer-notice fixture uses BHT06 `CH` with CLM02 0 and Stedi would reject that.
- Adjustments: Stedi's own docs say Medicare does not take 7/8; confirm with Stedi/MAC before building 817/818 as clearinghouse submissions, else DDE.

## What a sandbox cannot prove
Payer or MAC acceptance, enrollment, PTAN checks, NOE timeliness, benefit period rules, real 277CA/835 payloads, event delivery shape, idempotency replay, rate limits, OAuth/integrated accounts. "Passed edits" is inferred from the error ordering (proven for several rejections that occur before the provisioning error, but not for every field).
Ask Stedi to provision this account for test claims (or use a production account with `usageIndicator: "T"`).
