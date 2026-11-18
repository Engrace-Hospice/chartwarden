# Runbook: Episode Alert trial capture (issue #758)

**Date:** 2026-10-25 · **Safety update:** 2026-11-18 · Status: human capture checklist only; the current ChartWarden adapter is not activatable. Companion to the
[onboarding runbook](./EPISODE_ALERT_ONBOARDING_RUNBOOK_20261025.md) (BAA gate, trial start) and the
[secrets runbook](./EPISODE_ALERT_SECRETS_RUNBOOK_20261025.md) and the [2026-11-18 architecture/evidence review](./EPISODE_ALERT_ARCHITECTURE_AND_EVIDENCE_20261118.md). Current prepared questions are in [EPISODE_ALERT_FOLLOWUP_QUESTIONS_20261118.md](./EPISODE_ALERT_FOLLOWUP_QUESTIONS_20261118.md). In the style of the
[Stedi sandbox runbook](./STEDI_SANDBOX_RUNBOOK_20261025.md).

The adapter (`episode-alert-transport.ts`, `episode-alert-eligibility.ts`) contains local eligibility plumbing only. Its
production factory refuses to bind until the vendor wire and exact API origin are verified; `fetchClaimStatus` and
`fetchRemittances` remain `CH_NOT_WIRED` because **no verified request or response contract is recorded**. Nothing below may
be guessed into code; every item is a human capture, and it does not authorize application traffic.

## Rules

- A trial account is not a demonstrated sandbox. No test/sandbox mode is documented or verified, so any manual trial call may
  be a real service transaction. Keep it synthetic and follow contractual approval. The ChartWarden environment factory and
  DDE binding currently fail closed; do not try to bypass them or send a request from the application.
- Local parser and plumbing tests use `LocalFakeHttpClient`, which returns scripted in-memory `Response` objects and cannot
  open a socket. Their green result is local fixture evidence only, not Episode Alert contract verification.
- `ELIGIBILITY_VENDOR=episode_alert` selects the package registry seam only; no backend consumer binds it today. Never set
  `CLEARINGHOUSE_VENDOR=episode_alert` (refused at boot; it would stop claim submission).
- Redact MBIs, names, keys and account numbers before filing anything. Keys go in the secret manager only.
- Episode Alert's public API/product pages advertise REST POST, XML responses, eligibility/hospice fields, claim status,
  remittances, SmartDDE and hosted DDE. These are `PUBLICLY_ADVERTISED`, not an API schema. The guide, exact auth/origin,
  operation list, test isolation and ChartWarden account authorization remain unverified.
- CMS requires a current HETS enrollment relationship for each NPI submitted through a third-party vendor since 2026-05-11.
  This does not grant DDE or institutional claim/ERA authorization. Oregon HH+H is J6; current CMS sources identify Wellpoint
  Federal (formerly NGS) from 2026-04-01. Confirm the actual provider's payer and enrollment instead of assuming a legacy
  Oregon Part A route.

## Capture list

| # | Capture | Fills in |
|---|---|---|
| 0 | Written yes/no for programmatic hospice NOE and NOTR; for each, identify institutional EDI, individually attributed DDE API, another documented API, or hosted/manual-only path | Primary product priority and which existing port/workflow could be used; this answer does not authorize activation |
| 0a | NOE/NOTR formats, receipt, later MAC decision and acceptance-date source, correction/cancel rules, idempotency, timeout/uncertain-send lookup and per-operator attribution if DDE | Notice attempt provenance and safe reconciliation; no duplicate route |
| 1 | Base URL and the exact eligibility path | `ELIGIBILITY_PATH` (`/eligibility`, UNVERIFIED) |
| 2 | Auth scheme (header name, prefix, key vs token, expiry) | `Authorization: <key>` placeholder |
| 3 | Eligibility request body (field names, date format, MBI format, NPI required?) | `{ mbi, serviceDate }` placeholder |
| 4 | Vendor-provided synthetic eligibility XML response (active, terminated, not found), with source/date and redaction verified | Candidate fixture only; current `EligibilityResponse` root and Part A element names are guessed and must remain UNVERIFIED until checked |
| 5 | Hospice section element names (start/end, days used, NPI, revocation code) | currently unread; needed for benefit-period data |
| 6 | Error responses: bad key, unprovisioned plan, bad MBI, rate limit (status plus body shape) | status sets `NOT_PROVISIONED_STATUSES` / `REFUSED_STATUSES` |
| 7 | Claim status: request (identifier used: ICN/DCN, claim control number, MBI plus dates?) and response XML, including every status code and category | `fetchClaimStatus` -> `ClaimStatus` mapping |
| 8 | Claim status timing: daily batch vs on demand; how a not-yet-adjudicated claim looks | polling cadence, "unknown" handling |
| 9 | Remittance retrieval: request, pagination/cursor, response format (raw X12 835, XML, or JSON), file identity and re-fetch behaviour | `fetchRemittances` -> `Page<RemittanceFile>`; idempotent ingest |
| 10 | Whether a segregated test/sandbox mode exists, how it is selected, and whether operations can affect payer/MAC systems | whether a separately reviewed contract runner may ever execute; trial credentials alone do not qualify |
| 11 | Rate limits and retention of responses at the vendor | retry policy, BAA review |

## Procedure

1. Obtain and review the written API guide, response schemas and test-environment isolation terms before any application
   request. Record the exact approved origin and whether the test account is contractually isolated. A trial response alone is
   not proof of a sandbox.
2. Capture only vendor-provided synthetic/sample responses or responses proven to contain no real beneficiary/provider data.
   Store approved sanitized fixtures under `packages/x12-837-client/src/clearinghouse/__fixtures__/episode-alert-*.xml`.
3. Change UNVERIFIED comments and placeholders only after the source and a controlled observation agree; keep the guessed
   local parser mapping labeled as such until then. Implement claim status and remits only after documented contracts exist,
   then run local fixture/conformance tests and update `docs/history/episode-alert-adapter.md`.
4. Wire the consumer: nothing in `apps/backend` calls `bindEligibilityTransport` yet. Medicare eligibility runs through
   `M23_HETS_TRANSPORT`; routing it to this adapter is a follow-up once item 4 is captured.

#758 closes when the documented API facts and account-specific authorization are recorded and claim status/remittances are
implemented or ruled out in writing. Any vendor contract run additionally requires an approved isolated test procedure and
explicit human authorization. Do not use a green local test process as vendor qualification evidence.
