# Runbook: Stedi synthetic contract test (issue #727)

**Reviewed:** 2026-11-16. The test is
[`stedi-sandbox-contract.test.ts`](../../../packages/x12-837-client/src/clearinghouse/stedi-sandbox-contract.test.ts). It
is skipped unless all three required switches are set, so normal CI and `bun run test` do not contact Stedi. This runbook
describes a human-authorized synthetic test; no test was run as part of this documentation update.

## Keep the environments distinct

| Stedi mode/account | Documented use | Allowed for this contract test? |
|---|---|---|
| Free Sandbox account | Mock eligibility and portal exploration; it cannot submit test claims. | **No.** It may return `ACCOUNT_NOT_PROVISIONED` for claim submission. |
| Production account + **Test-mode API key** | Submit synthetic test claims; test data is processed in Stedi Test mode and not sent to payers. | **Yes**, only after the account owner confirms the key is a Test-mode key and Stedi has confirmed account eligibility. |
| Production account + Production-mode API key | Real payer transactions. | **Never** for this run. Do not provide this key to the test. |
| OAuth Integrated Account | OAuth app calls run against a real Production account; the OAuth-app setup guide says OAuth apps cannot use Test mode. | **No.** Do not submit claims or use OAuth credentials for this contract test. OAuth onboarding needs a separately approved, read-only plan. |

Current public references: [test claims workflow](https://www.stedi.com/docs/healthcare/test-claims-workflow),
[test mode](https://www.stedi.com/docs/healthcare/test-mode), [OAuth app setup](https://www.stedi.com/docs/healthcare/oauth-apps-setup),
and [Integrated Account overview](https://www.stedi.com/docs/healthcare/integrated-account-overview). These describe published
behavior, not ChartWarden-specific provisioning or commercial approval. See the ready-to-send Q14/Q32 for written
confirmation requests.

## Before running

1. Obtain written confirmation for Q14 and file it in
   [`STEDI_QUESTIONS_20261008.md`](./STEDI_QUESTIONS_20261008.md). The public docs say a Production **account** uses a
   Test-mode API key for claims; they do not make a Production-mode API key safe for testing. A key/usage mismatch is
   refused according to Stedi's docs, but do not use that as a safety mechanism.
2. Use only a Test-mode API key created in the authorized Stedi account. The test cannot inspect key mode itself; the
   operator must attest that the key is test mode. If account type or key mode is uncertain, stop.
3. Use repository synthetic fixtures only. Do not add or send real patient/provider identifiers, PHI, PII, or real payer
   transactions. Stedi explicitly says not to submit PHI/PII in test claims.
4. Keep the platform binding untouched: `CLEARINGHOUSE_VENDOR` must be unset or `in_memory` in the environment. The
   test constructs its own `StediTransport`; do not run it from a process configured for live sending.
5. Never paste the key into a file, shell history, issue, PR, logs, or results. Supply it only through a private
   environment variable for the one test command.
6. The current contract test submits a synthetic claim and NOE and checks local replay/refusal behavior. It does **not**
   retrieve/assert a 277CA or 835, test an OAuth install, or prove payer/MAC acceptance. Test Payer 835 generation is a
   separate workflow: Stedi's current guide says a provider must be enrolled with the Stedi Test Payer for 835 Claim
   payment, with that enrollment created outside Test mode; afterward use Test credentials. Confirm the synthetic
   provider/enrollment process with Stedi before setting it up. That enrollment is a test fixture workflow, not Medicare
   payer enrollment.

## Run

```bash
STEDI_TEST_API_KEY='<Stedi Test-mode key from an authorized Production account>' \
STEDI_CONTRACT_CONFIRM=synthetic-only \
STEDI_CONTRACT_KEY_IS_TEST=yes \
STEDI_CONTRACT_RESULTS_FILE=/tmp/stedi-contract-results.json \
bunx vitest run packages/x12-837-client/src/clearinghouse/stedi-sandbox-contract.test.ts
```

The test allocates a fresh control number and idempotency keys from the clock. That avoids local collisions, but it does
not guarantee a vendor-side outcome. Do not run this command with a Production-mode key or OAuth token.

## Existing test steps and safe interpretation

| Step | Current guard / expected observation | Interpretation |
|---|---|---|
| Submit synthetic claim (`usage: test`, X12 `ISA15=T`) | Success receipt or a known degraded result | `ACCOUNT_NOT_PROVISIONED` indicates the account/key path is not enabled; do not treat it as a successful claim test. |
| Identical resubmission | Local attempt store replays; no second request | Verifies local idempotency only, not Stedi's idempotency response. |
| Same idempotency key, changed body | Local conflict; no request | A failure to refuse is a stop condition. |
| Submit synthetic NOE 81A (`BHT06=RP`) | Success receipt or known degraded result | Edit/transport observation only; not evidence that a MAC received or accepted a notice. |
| Production-marked X12 (`ISA15=P`) in test context | Refused locally before request | Any outbound request is a critical defect; stop. |
| Replacement/frequency 7 | Refused locally without request | Q17/Q28 remain open; this is not a MAC policy determination. |
| Key leak check | Key is absent from result | Any leak is a critical defect; revoke the key and report. |

Stedi's docs say test claims to any payer return a test 277CA without payer routing. The current test itself does not
retrieve that response. A separate Test Payer test can produce a test 277CA and 835 after its required Test Payer
enrollment; it is outside this contract test and should be captured separately.

## After the run

1. Copy the PHI-free output into a dated copy of
   [`STEDI_SANDBOX_RESULTS_TEMPLATE_20261025.md`](./STEDI_SANDBOX_RESULTS_TEMPLATE_20261025.md). Do not include keys,
   response bodies, PHI/PII, or raw claim payloads.
2. Record only observed results in the template and the
   [`STEDI_TRANSPORT_CONTRACT_20261011.md`](./STEDI_TRANSPORT_CONTRACT_20261011.md), with date and evidence reference.
   Keep undocumented or unobserved behavior marked unknown; do not change adapter behavior from a single run without
   reviewing the written vendor answer.
3. If any result suggests production routing, stop, revoke the key, notify the security owner, and preserve only
   sanitized evidence.

## What this cannot prove

This contract test cannot establish real payer/MAC acceptance, Medicare enrollment, hospice-specific edits or NOE
timeliness, production 277CA/835 behavior, OAuth account isolation, legal approval, or compliance with CGS, NGS, or
Palmetto companion guides. Synthetic results are not MAC certification.
