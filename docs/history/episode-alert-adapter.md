# Episode Alert clearinghouse adapter (#758, ADR-0053 / ADR-0103)

- **Built:** eligibility only (`packages/x12-837-client/src/clearinghouse/episode-alert-transport.ts`, PR #769). The path,
  `Authorization` scheme, request body and XML element names are UNVERIFIED guesses from the public sample report labels;
  anything unrecognised yields eligibility outcome `unknown`, never `active`.
- **Claim status and remits stay `CH_NOT_WIRED`.** Episode Alert lists them publicly but publishes no request or response
  shape; the guide is given after signup. Inventing one would be a fabricated contract. What a trial must capture is in
  `docs/audits/clearinghouse-integration/EPISODE_ALERT_TRIAL_CAPTURE_RUNBOOK_20261025.md`.
- **Binding finding (review of 0882c4eb8, H1):** `CLEARINGHOUSE_VENDOR` is platform-wide and routes the M23 submit workers
  and acknowledgment crons, so an eligibility-only adapter bound there would stop claim submission. `transport-registry.ts`
  omits `episode_alert`; the separate `ELIGIBILITY_VENDOR` setting (`eligibility-vendor-registry.ts`, values `episode_alert`
  or `in_memory`, `in_memory` refused in production, submission vendors refused) binds it fail-closed.
- **Open:** no backend consumer calls `bindEligibilityTransport` yet; M23 Medicare eligibility still goes through
  `M23_HETS_TRANSPORT`. `ClearinghouseVendor` has no db/types/manifest mirror, so there is nothing to sync there.
