# Runbook: Episode Alert trial capture (issue #758)

**Date:** 2026-10-25 · Status: checklist for a person with a trial account. Companion to the
[onboarding runbook](./EPISODE_ALERT_ONBOARDING_RUNBOOK_20261025.md) (BAA gate, trial start) and the
[secrets runbook](./EPISODE_ALERT_SECRETS_RUNBOOK_20261025.md). In the style of the
[Stedi sandbox runbook](./STEDI_SANDBOX_RUNBOOK_20261025.md).

The adapter (`episode-alert-transport.ts`, `episode-alert-eligibility.ts`) implements eligibility only. `fetchClaimStatus`
and `fetchRemittances` answer `CH_NOT_WIRED` because **no public document shows their request or response shape**. Nothing
below may be guessed into code; every item is a capture from the trial account.

## Rules

- Synthetic or vendor-sample data only until the BAA is executed. The adapter refuses `usage: "test"` (no vendor test
  mode is documented), so a trial call is a real call.
- `ELIGIBILITY_VENDOR=episode_alert` is the only binding for this adapter. Never set `CLEARINGHOUSE_VENDOR=episode_alert`
  (refused at boot; it would stop claim submission).
- Redact MBIs, names, keys and account numbers before filing anything. Keys go in the secret manager only.

## Capture list

| # | Capture | Fills in |
|---|---|---|
| 1 | Base URL and the exact eligibility path | `ELIGIBILITY_PATH` (`/eligibility`, UNVERIFIED) |
| 2 | Auth scheme (header name, prefix, key vs token, expiry) | `Authorization: <key>` placeholder |
| 3 | Eligibility request body (field names, date format, MBI format, NPI required?) | `{ mbi, serviceDate }` placeholder |
| 4 | One full redacted eligibility XML response (active, terminated, not found) | `EPISODE_ALERT_ELIGIBILITY_FIELDS`; add a fixture per case |
| 5 | Hospice section element names (start/end, days used, NPI, revocation code) | currently unread; needed for benefit-period data |
| 6 | Error responses: bad key, unprovisioned plan, bad MBI, rate limit (status plus body shape) | status sets `NOT_PROVISIONED_STATUSES` / `REFUSED_STATUSES` |
| 7 | Claim status: request (identifier used: ICN/DCN, claim control number, MBI plus dates?) and response XML, including every status code and category | `fetchClaimStatus` -> `ClaimStatus` mapping |
| 8 | Claim status timing: daily batch vs on demand; how a not-yet-adjudicated claim looks | polling cadence, "unknown" handling |
| 9 | Remittance retrieval: request, pagination/cursor, response format (raw X12 835, XML, or JSON), file identity and re-fetch behaviour | `fetchRemittances` -> `Page<RemittanceFile>`; idempotent ingest |
| 10 | Whether a test or sandbox mode exists | whether `usage: "test"` may ever be accepted |
| 11 | Rate limits and retention of responses at the vendor | retry policy, BAA review |

## Procedure

1. Do items 1 to 3 and 6 from the vendor guide and sample calls, then confirm each with a call from the trial account.
2. Save redacted responses as fixtures under `packages/x12-837-client/src/clearinghouse/__fixtures__/episode-alert-*.xml`
   (synthetic identifiers only).
3. Change the UNVERIFIED comments and placeholders only after a trial response confirms them (DoseSpot precedent,
   `docs/history/m12-dosespot-adapter.md`), then implement claim status and remits test-first against those fixtures, run
   the clearinghouse conformance suite, and update `docs/history/episode-alert-adapter.md`.
4. Wire the consumer: nothing in `apps/backend` calls `bindEligibilityTransport` yet. Medicare eligibility runs through
   `M23_HETS_TRANSPORT`; routing it to this adapter is a follow-up once item 4 is captured.

#758 closes when items 1 to 9 are recorded and claim status and remits are implemented or ruled out in writing.
