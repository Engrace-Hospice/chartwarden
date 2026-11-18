# Runbook: Stedi synthetic contract qualification (issue #727)

**Reviewed:** 2026-11-18. The local suite is [`stedi-sandbox-contract.test.ts`](../../../packages/x12-837-client/src/clearinghouse/stedi-sandbox-contract.test.ts), and the only supported vendor command is `bun run test:stedi:contract`. The ordinary `bun run test` suite and CI do not provide the gates and do not contact Stedi.

## Modes and credential requirements

| Stedi mode/account | Use | Contract test |
|---|---|---|
| Free Sandbox account/key | Mock eligibility and portal exploration; not provisioned to submit test claims | Not sufficient |
| Production Stedi account + Test-mode API key | Synthetic Test-mode claims, not routed to payers, subject to the account's enabled features | Required, after Stedi confirms account eligibility |
| Production-mode API key | Can send real payer transactions | Prohibited |
| OAuth Integrated Account token | Separate future customer-onboarding path; not the API-key Test-mode contract path described by Stedi's test-claim workflow | Prohibited for this contract runner |

Public docs explain these product modes; they do not prove that ChartWarden's account is enabled or that its hospice workflows are supported. Q14 written confirmation and a vendor authorization reference are prerequisites.

## Human authorization and environment isolation

Before execution, an authorized account owner must independently open the Stedi account console (or another vendor-controlled credential inventory) and verify that the selected credential is a **Test-mode API key created under an authorized Production Stedi account**. Record the account/reference and confirmation in an approved ticket or vendor correspondence. Do not copy the key into evidence. If key type, account type, authorization or written Q14 confirmation is uncertain, stop.

`STEDI_CONTRACT_KEY_IS_TEST=yes` and `STEDI_CONTRACT_OPERATOR_AUTHORIZED=yes` are human attestations only. The test cannot inspect key mode; there is no cryptographic or API-based credential-mode check in this workflow. The guard does not rely on key format, a key prefix, `ISA15`, or Stedi rejecting an unsafe request. Independent verification is the safety control.

The runner fails closed unless all gates are present:

- `STEDI_TEST_API_KEY`: the account owner's Test-mode API key, supplied only by an approved ephemeral secret mechanism.
- `STEDI_CONTRACT_CONFIRM=synthetic-only`: operator confirms approved synthetic fixtures only.
- `STEDI_CONTRACT_KEY_IS_TEST=yes`: operator attests key mode was verified in the vendor-controlled console.
- `STEDI_CONTRACT_OPERATOR_AUTHORIZED=yes`: operator explicitly authorizes this run.
- `STEDI_CONTRACT_AUTHORIZATION_REF`: a non-sensitive ticket reference such as `OPS-727`.
- `STEDI_CONTRACT_VENDOR_CONFIRMATION_REF`: a non-sensitive vendor confirmation reference such as `VENDOR-727`.
- `STEDI_CONTRACT_RESULTS_FILE`: a protected path for the sanitized JSON artifact.
- `CLEARINGHOUSE_VENDOR` must be unset or `in_memory`; `STEDI_API_KEY` must be unset; `NODE_ENV=production` is refused.

The test creates a standalone `StediTransport`; it does not bind the platform sender, use an OAuth token, or change tenant configuration. Its fetch wrapper allows only Stedi's two documented institutional submission paths, POST requests, redirects disabled, and Test-marked X12/JSON. Never run from a production process or with a real platform binding present. Keep the Test key out of command history, `.env`, files, logs and the results path.

Run only after the gates above are independently satisfied. Inject the key and other values through the approved secret manager or protected ephemeral shell environment; do not paste a literal key into a command:

```bash
bun run test:stedi:contract
```

The runner writes a sanitized artifact. If gates are missing it writes `NOT_RUN`, makes no request and exits nonzero. For a vendor run it records Vitest's actual exit code, the overall qualification state and per-scenario outcomes. A successful process is not qualification unless the artifact's `overallQualification` is `PASS`.

## What is tested

| Scenario | Network? | Evidence meaning |
|---|---:|---|
| Synthetic raw-X12 837I claim (`ISA15=T`, matching `ISA13`) | Yes | Stedi Test-mode submission response only |
| Synthetic JSON 837I claim | Yes | Uses `CLAIM_INPUT`, `buildStediClaimJson`, `build837iClaim` and the JSON/X12 agreement check used by M23's Stedi route; verifies Test indicator, billing NPI and patient control number locally before submit |
| Synthetic NOE 81A, raw X12 (`BHT06=RP`) | Yes | Stedi Test-mode submission response only; no MAC filing or acceptance claim |
| Identical JSON replay, changed-body same-key conflict and control-number reuse | No second request | ChartWarden's in-memory attempt-store behavior only; not Stedi idempotency behavior |
| Production-marked JSON, provider NPI mismatch and malformed X12 | No | Local refusal before the fetch boundary |
| Replacement/frequency 7 or void/frequency 8 | No | Continues to fail closed while Q17/Q28 are unanswered |
| NOTR 81B | No vendor call in this run | Covered by local transport tests/fixture review only; vendor behavior is not qualified |

Local mapper tests remain separate and run without credentials. The contract test records vendor observations only for operations whose fetch call occurred. A locally passing refusal is labeled `evidence: local` and cannot satisfy a required vendor scenario.

## Outcome states

- **PASS:** each mandatory vendor scenario was sent through the authorized Test-mode key, Stedi returned a successful response with a real extracted vendor receipt identifier, local safety assertions passed, and no required scenario is missing.
- **FAIL:** a safety assertion failed, Stedi contradicted the expected contract, a required operation returned an unexpected refusal, or a successful response lacked a usable receipt identifier.
- **BLOCKED:** Stedi reports the account is not provisioned, rejects credentials, is unavailable, times out, or gives an ambiguous outcome. Blocked is not qualification and must not be converted to PASS.
- **NOT_RUN:** prerequisites were missing, the suite was skipped, or a required vendor scenario was not executed.

Vitest's exit status and vendor qualification are recorded independently. The wrapper exits nonzero for `FAIL`, `BLOCKED` or `NOT_RUN`; use the JSON artifact's `process` and `overallQualification` fields together. No response body, claim payload, API key, or free-form vendor error is written to the artifact. It contains only closed reason codes, booleans, scenario names and non-sensitive authorization references.

## What this does not prove

The test does not retrieve a 277CA or 835, prove vendor-side idempotency, establish payer/MAC routing, Medicare enrollment, hospice-specific edits, NOE timeliness, paid-claim correction rules, tenant account isolation, OAuth approval, or MAC acceptance. Test-mode receipts are not payer certification. Test Payer ERA setup is a separate vendor-authorized workflow; do not include it here unless separately approved and documented.

## Before declaring #727 complete

Attach the sanitized artifact, verify all mandatory vendor scenarios are `PASS`, preserve the Vitest exit code, and file Stedi's written Q14, Q16, Q17/Q28, Q27/Q32 and Q33 answers with references. Keep outstanding payer/MAC, enrollment and legal approvals explicit. A `BLOCKED` or `NOT_RUN` artifact keeps #727 open.
