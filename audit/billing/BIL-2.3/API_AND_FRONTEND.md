# API and Frontend

`POST /api/v1/billing/commercial/claims/:id/corrections/clearinghouse-rejection` accepts only a closed `reasonCode`; payer ID, route, external control number and tenant are server-derived. The route uses existing M41 write authorization, caseload scope, non-AI guard and idempotency middleware. The response identifies the created/replayed claim and original parent.

The claim read contract exposes bounded lineage and a server-computed eligibility reason. The detail screen presents a correction reason selector and creates a linked draft only when the server reports eligibility and the user has `commercial_billing.write`. It explains the unsupported payer-stage workflow and links related claims. The timeline displays original/correction relationships.

OpenAPI JSON and generated client types are regenerated from route schemas. The UI does not expose internal correction UUIDs as a substitute for payer identifiers and does not imply payer acceptance.
