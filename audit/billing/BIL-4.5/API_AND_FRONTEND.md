# API and Frontend

The existing M25 ERA detail, matching/candidate, financial-review and posting-plan endpoints are reused. The candidate schema allows submitted-line evidence to be reported as `available` only when the immutable attempt-bound line snapshot is complete; otherwise it remains `unavailable`. The posting-plan claim contract includes `billingModule` so clients can preserve M23/M41 identity.

The existing `claimmd-era-review.tsx` view links a Medicare match to the M23 claim page and explains that Medicare Claim.MD financial posting is not certified. It continues to show review and history separately from financial execution; no Medicare posting action is enabled by the new path.

`bun run openapi:emit`, `bun run client:gen`, and `bun run client:check` were executed after the contract changes.
