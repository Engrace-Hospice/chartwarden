# Stedi synthetic contract qualification results (TEMPLATE; copy per run)

Copy this template per authorized run and summarize the sanitized JSON artifact produced by `bun run test:stedi:contract`. Synthetic data only. Never attach an API key, response body, raw X12/JSON claim, PHI or PII. See [`STEDI_SANDBOX_RUNBOOK_20261025.md`](./STEDI_SANDBOX_RUNBOOK_20261025.md).

## Run identity and process result

- **Run date/time (UTC):**
- **Operator and role:**
- **Commit SHA:**
- **Sanitized JSON artifact reference:**
- **Authorization reference:**
- **Stedi written confirmation reference:**
- **Vitest exit code:**
- **Wrapper exit code:**
- **Overall qualification:** `PASS` / `FAIL` / `BLOCKED` / `NOT_RUN`
- **Gate reason codes, if any:**
- **Platform binding check:** unset / `in_memory` / refused
- **Production platform credential present:** no / yes (if yes, stop; do not run)
- **Live platform configuration changed:** no / yes (if yes, stop)

## Independent credential and authorization verification

- **Stedi account type confirmed in vendor console:** authorized Production account / free Sandbox / OAuth Integrated Account / other
- **Credential mode confirmed in vendor console:** Test / Production / OAuth / unknown
- **Verified by authorized account owner:** name/role (never credential value)
- **Verification date and vendor-controlled reference:**
- **Operator explicitly authorized synthetic run:** yes / no
- **Written Q14 applicability/account provisioning reference:**
- **Synthetic-only fixtures confirmed:** yes / no
- **Key appeared in logs or artifact:** no / yes (if yes, stop, revoke and escalate)

## Scenario outcomes

Copy only scenario name, evidence kind, state, sanitized reason code, `requestSent` and receipt-validation boolean from the JSON artifact. `local` evidence cannot satisfy a vendor scenario.

| Scenario | Evidence (`local` / `vendor`) | State | Sanitized reason code | Request sent | Receipt validated | Note/reference |
|---|---|---|---|---:|---:|---|
| Raw-X12 837I claim | | | | | | |
| JSON 837I claim via production mapper | | | | | | |
| NOE 81A raw X12 | | | | | | |
| Local JSON/X12 agreement and identity assertions | | | | | | |
| Local identical replay (no second request) | | | | | | |
| Local changed-body same-key conflict | | | | | | |
| Local control-number reuse conflict | | | | | | |
| Local `usageIndicator=P` refusal before request | | | | | | |
| Local provider identity mismatch refusal | | | | | | |
| Local malformed X12 refusal before request | | | | | | |
| Frequency 7/8 adjustment refusal | | | | | | |
| NOTR 81B local fake-HTTP shape | `local` | `PASS` / `FAIL` | `fake_http_bht06_rp_vendor_behavior_not_verified` | no vendor request | no vendor receipt | local fixture/transport coverage only |

## Correlated response evidence (not part of this contract run)

Set `NOT_RUN` unless a separately authorized workflow actually retrieved the response. Never infer a response from a submission receipt.

| Response | State (`PASS` / `FAIL` / `BLOCKED` / `NOT_RUN`) | Non-sensitive evidence reference | Scope and limitations |
|---|---|---|---|
| Initial Stedi 277CA retrieved | `NOT_RUN` | | |
| Payer-stage 277CA retrieved | `NOT_RUN` | | |
| Stedi Test Payer 835 ERA retrieved | `NOT_RUN` | | |
| Event/callback signature and replay handling | `NOT_RUN` | | |
| Stedi-side idempotency replay behavior | `NOT_RUN` | | |
| MAC acceptance/adjudication | `NOT_RUN` | | |

## Written answers and remaining approvals

| Question | Written answer reference/date | Internal decision/effect | Still pending |
|---|---|---|---|
| Q14 Test claims/provisioning | | | |
| Q16 Medicare Part A/hospice enrollment | | | |
| Q17/Q28 corrections, voids and FISS/DDE | | | |
| Q27/Q32 tenant account, OAuth and attribution | | | |
| Q33 BAA and responsibilities | | | |

## Final interpretation

- **Does overall qualification equal `PASS` in the sanitized artifact?** yes / no
- **Were all three required vendor scenarios successful with validated vendor receipt IDs?** yes / no
- **Outstanding vendor, Medicare/hospice or legal blockers:**
- **Follow-up owner:**
- **Can this evidence close #727?** no, until written answers and all acceptance evidence are filed
