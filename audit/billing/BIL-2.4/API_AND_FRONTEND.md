# API and frontend

## API contract

`ClaimDto` now returns a safe `routeReadiness` summary: state, program classification, requested channel, configuration-only transport signal, verification booleans, unverified output format, availability, stable status, reason code and user-readable message. All verification and submit-availability flags are currently false.

`PATCH /api/v1/medicaid-claims/:id` no longer accepts a tenant-supplied MCO assignment. Unknown fields such as `mcoId` are rejected by the TypeBox contract. Submission remains on the existing endpoint and uses server-side route checks.

OpenAPI and the generated API client were emitted after the contract update. No new route or migration was introduced.

## UI

Claim editor, workbench, assembly wizard, eligibility, surveyor view, AR/metrics surfaces, and credential setup no longer label a null MCO as FFS. They distinguish an unresolved program from a persisted but unverified MCO assignment and disclose that a configured transport is not certified. Submit actions remain disabled when the server returns a route refusal.

The existing status/history surfaces remain in use. No new claim acceptance state or state-specific correction workflow was added.
