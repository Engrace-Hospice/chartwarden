# Runbook: Stedi sandbox contract test (issue #727)

**Date:** 2026-10-25 · The test is [`stedi-sandbox-contract.test.ts`](../../../packages/x12-837-client/src/clearinghouse/stedi-sandbox-contract.test.ts).
It is skipped unless all three switches below are set, so CI and `bun run test` never reach the network. **Live sending stays
disabled**: this test builds its own `StediTransport` from the test key; the platform binding (`CLEARINGHOUSE_VENDOR`) is
not touched and must stay unset or `in_memory` in every environment you run this from.

## Before you run it

1. Stedi's written answer to Q14 is filed in `STEDI_QUESTIONS_20261008.md`, and a **production** Stedi account exists with a
   **test API key** (Stedi's docs: test claims are only available on production accounts; the mode is inferred from the key
   type; a production key on a test endpoint returns 404; whether this transport's single base URL counts as a "test endpoint"
   is NOT verified, so nothing in the code can detect a production key: you must create the key as a test-mode key and
   say so with `STEDI_CONTRACT_KEY_IS_TEST=yes`). A sandbox-account key will answer `ACCOUNT_NOT_PROVISIONED`;
   that is the Q14 symptom, not a code defect.
2. A signed BAA is not required for this run because the data is synthetic (the repo's `__fixtures__/stedi-*.x12`:
   fictional hospice, NPI `1234567893`, payer `STEDI`). Do not point it at real patients or edit the fixtures to hold any.
3. Never paste the key into a file, a shell history you share, an issue or a PR. Use an environment variable for one command.

## Run

```bash
STEDI_TEST_API_KEY='<test-mode key>' \
STEDI_CONTRACT_CONFIRM=synthetic-only \
STEDI_CONTRACT_KEY_IS_TEST=yes \
STEDI_CONTRACT_RESULTS_FILE=/tmp/stedi-contract-results.json \
bunx vitest run packages/x12-837-client/src/clearinghouse/stedi-sandbox-contract.test.ts
```

Each run uses a fresh control number and idempotency keys (derived from the clock), so a re-run never collides with an
earlier test claim.

## What it does

| Step | Expectation | What a surprise means |
|---|---|---|
| Submit the synthetic claim (`usage: test`, ISA15 `T`) | `ok` with a vendor id, or a degraded `CH_NOT_PROVISIONED` / `CH_INVALID_REQUEST` / `CH_NOT_WIRED` / `CH_UNAVAILABLE` | `CH_NOT_PROVISIONED`: key is not a production account's test key (Q14). `CH_NOT_WIRED`: Stedi rejected the key (401/403) |
| Resubmit identically | replays locally, no second send | A second send is a transport bug |
| Same key, different body | `CH_IDEMPOTENCY_CONFLICT`, no send | Anything else is a bug |
| Submit the synthetic NOE 81A (`BHT06 = RP`) | `ok` or a known degraded code | Evidence for Q21; record the code |
| Production-marked interchange (ISA15 `P`) under a test context | refused locally (`CH_INVALID_REQUEST`) before any request | Any request leaving the machine is a critical bug: stop and report |
| Replacement (frequency 7) | refused, nothing sent (Q17 open) | |
| Key leak check | the key appears in no result | A leak is a critical bug |

The PHI-free record (step, ok, degraded code, replayed) is written to `STEDI_CONTRACT_RESULTS_FILE`. It contains no
response body and no key.

## After the run

1. Copy the record into [`STEDI_SANDBOX_RESULTS_TEMPLATE_20261025.md`](./STEDI_SANDBOX_RESULTS_TEMPLATE_20261025.md) (a dated copy per run) and
   mark each unknown in `STEDI_TRANSPORT_CONTRACT_20261011.md` (success body shape, initial 277CA, idempotency replay) as
   observed, with the date. Do not change adapter behaviour from one run; confirm with Stedi's written answer first.
2. Receive-side checks (events, polling, 835 through the Stedi Test Payer) are separate manual steps in the template; the
   Test Payer enrollment must be submitted in production (Stedi: not possible with a test key).
3. If any step shows a request leaving for a production payer, revoke the key and report it.

## What this cannot prove

Payer or MAC acceptance, enrollment, NOE timeliness, real 277CA/835 payloads, event delivery shape and signing (Q22),
rate limits, OAuth/integrated accounts. Those need Stedi's written answers (Q15-Q17, Q22-Q27, Q32).
