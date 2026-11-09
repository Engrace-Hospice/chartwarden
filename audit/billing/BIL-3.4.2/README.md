# BIL-3.4.2 — Approved-plan-bound M25 posting

## Outcome: NO-GO; posting path not implemented

The required executable Claim.MD posting slice is not present. Source inspection found that the existing M25 `postAdvice` accepts a remittance-advice ID, loads raw 835 from `RawAdviceStore`, performs its own automatic claim match, writes M25 remittance records, and emits downstream posting events inside a transaction it owns. Claim.MD staging instead stores an encrypted tenant stage and BIL-3.3 match/review decisions; those decisions are not supplied to `postAdvice`.

Calling `receiveAdvice` would publish the legacy automatic event. Calling `postAdvice` after a separate approval would leave a time-of-check/time-of-use gap and would still use the unrelated automatic matcher. Neither meets the requested approved-plan transaction. No posting plan/API/UI or ledger execution was added. Existing posting stays unchanged and Claim.MD posting remains disabled.

This phase preserves and verifies the BIL-3.4 line evidence work, runs posting-isolation regressions and records the precise source-level blocker. It does not claim financial integration completion.

Verification: focused M23/M41 line-evidence tests (63/63), Claim.MD stage/review nonposting tests (17/17), private PostgreSQL response/M23-RLS/M25-RLS suites (3/3, 14/14, 21/21), affected TypeScript and architecture/migration gates passed. No ledger-posting integration test was possible because the required execution path remains absent.
