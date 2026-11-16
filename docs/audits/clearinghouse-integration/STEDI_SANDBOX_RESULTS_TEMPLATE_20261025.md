# Stedi synthetic contract run: results (TEMPLATE, copy per run)

Copy to `STEDI_SANDBOX_RESULTS_<YYYYMMDD>.md` and fill after an authorized run. Synthetic data only: no API key,
response body, PHI/PII, or raw claim payload. Follow
[`STEDI_SANDBOX_RUNBOOK_20261025.md`](./STEDI_SANDBOX_RUNBOOK_20261025.md).

## Run identity and safety

- **Test date/time (UTC):**
- **Operator:**
- **Commit SHA (`git rev-parse HEAD`):**
- **Stedi account type:** production account / free Sandbox / OAuth Integrated Account / other (explain)
- **Credential mode used:** Test API key / Production API key / OAuth token / other (never include credential value)
- **Credential mode attested by account owner:** yes / no
- **Written Q14 confirmation reference/date:**
- **Test key obtained from:** authorized account name/reference only; no secret value
- **Platform binding (`CLEARINGHOUSE_VENDOR`):** unset / `in_memory` / other (stop and explain)
- **Synthetic-only confirmation:** yes / no
- **Test ran with Production credential or OAuth token:** no / yes (if yes, stop and report)
- **Test API request was expected to remain in Stedi Test mode:** yes / no

## Submission contract results

Paste only the sanitized fields from `STEDI_CONTRACT_RESULTS_FILE`; do not paste the JSON if it contains an unexpected
field. Never include a key, raw X12, response body, or PHI/PII.

| Step | Outcome (`ok`/degraded) | Degraded code | Local replayed | Expected? | Sanitized evidence reference / note |
|---|---|---|---|---|---|
| Synthetic claim submit | | | | | |
| Identical claim replay | | | | | |
| Same key / changed body conflict | | | | | |
| Synthetic NOE submit | | | | | |
| Production `ISA15=P` refused before request | | | | | |
| Replacement/frequency 7 refused before request | | | | | |
| Key absent from output | | n/a | n/a | | |

## Correlated response evidence (separate workflow)

Do not imply the existing contract test exercises these results; it currently does not retrieve 277CA/835 responses.
Record `NOT RUN` unless a separately approved test was actually performed.

| Response | Status (`PASS` / `FAIL` / `NOT RUN`) | Correlation reference (non-sensitive ID only) | Evidence location | Scope/limitations |
|---|---|---|---|---|
| 837I test submission receipt | | | | |
| Initial Stedi 277CA | | | | |
| Later payer-stage 277CA | | | | |
| Stedi Test Payer 835 ERA | | | | |
| Response retrieval by polling/report | | | | |
| Event/callback delivery | | | | |
| Retry/idempotency behavior at Stedi | | | | |

## Test Payer ERA setup, if separately performed

- **Test Payer enrollment created outside Test mode:** yes / no / not applicable
- **Synthetic provider record used:** yes / no (describe only non-identifying fixture reference)
- **Enrollment transaction type:**
- **Enrollment effective/ready date:**
- **No real Medicare payer enrollment or ERA routing changed:** yes / no

## Written answers and decisions

| Question | Stedi written answer reference/date | Internal decision or effect | Approval still needed? |
|---|---|---|---|
| Q14 test claims and test 277CA/835 | | | |
| Q16 Medicare Part A/hospice enrollment | | | |
| Q17 / Q28 rejected versus paid-claim correction/void | | | |
| Q27/Q32 tenant account, OAuth, attribution and isolation | | | |
| Q33 BAA and responsibilities | | | |

## Unverified scenarios and disposition

List each not tested or not established by this run, including MAC jurisdiction, hospice notice acceptance, real payer
adjudication, production routing, multi-NPI account behavior, tenant response isolation, OAuth approval, and any missing
test enrollment. Synthetic fixtures do not constitute CGS, NGS, or Palmetto certification.

- **Unverified:**
- **Follow-up owner:**
- **Live sending remained disabled:** yes / no (if no, stop and escalate)
- **Overall result:** PASS / FAIL / INCOMPLETE (explain; never convert a skipped test to PASS)
