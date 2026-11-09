# Candidate discovery and manual resolution

The existing `GET /api/v1/remittance/claimmd-era/:id/matching/claims/:claimIndex/candidates` is tenant-stage scoped and requires `remittance.read`. Candidate attempts are bounded and carry safe comparison facts. A candidate is selectable only when organization/provider/account/environment and PCN scope plus payer identifier, service period and exact charge cents agree. This is a reviewer eligibility rule, not automatic verification or a confidence score.

`confirm_candidate` uses the existing `remittance.match_review` permission, row lock/advisory lock, source digest and append-only migration 1394 decision rows. The service re-queries the selected evidence ID inside the write transaction; callers cannot establish eligibility by submitting a claim UUID. The projection labels the result `human_confirmed_candidate` and retains the original source outcome. A known conflict cannot be overridden. Clear/supersede remains append-only and audited.
