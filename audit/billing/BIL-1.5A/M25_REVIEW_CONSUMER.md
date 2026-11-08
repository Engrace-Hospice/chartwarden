# M25 staging review consumer

`GET /api/v1/remittance/claimmd-era` and `GET /api/v1/remittance/claimmd-era/:id` are registered by `routes/claimmd-era-review.routes.ts` with `remittance.read`; actor scope comes from authenticated request context. `ingest/claimmd-era-review.ts` filters organization and provider scope under `withOrgContext`, then decrypts only selected tenant-stage rows using the stage-purpose cipher. The service does not read central inbox tables and has no posting/outbox dependency.

Projection is allowlisted: payer/payee summaries, payment identifiers, claim/service-line adjustments, PLB summaries and ownership outcomes; TIN, member identifiers, and free text are omitted. Possible duplicates remain ineligible. Focused projection tests pass. Authorization under a real NOBYPASSRLS role and API route permission tests remain pending; no review operation posts money.
