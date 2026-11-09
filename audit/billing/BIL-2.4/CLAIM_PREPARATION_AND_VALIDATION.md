# Claim preparation and validation

## Existing path retained

M24 creates claims from patient/admission/service-window/provider inputs, resolves Medicaid coverage through the existing M5 reader, derives service state from the provider's active M24 trading-partner credential, loads the state plan-code catalog, assembles hospice and room-and-board lines from existing domain readers, and runs the existing validation registry. This phase did not replace the claim engine or add a new 837 renderer.

Validation continues to report unavailable/unbound inputs according to existing rule/seam semantics. A passing local validation does not certify program attribution, provider enrollment, trading-partner status, or transport readiness.

## Routing corrections

- Claim `mcoId` is not accepted from a tenant PATCH request.
- The API does not treat a missing MCO as proof of FFS.
- The preparation flow labels MCO assignment unverified and otherwise reports “State program not determined”.
- Claim reads include the server-derived `routeReadiness` object and stable reason code.
- Claim submit checks route refusal before creating a submission row or enqueuing work.
- The worker repeats the readiness check before credential decryption or adapter calls, covering old or stale queued jobs.
- A configured Oregon gateway alone does not make the route submit-capable.

## Limitations

An authoritative `coverage → state program → MCO/payer` mapping with effective dating is absent, as is an M40 state-MCO catalog. The correct source-owned contract and cardinality must be resolved before assigning FFS/MCO in a tenant-visible “verified” state. The existing M24 `state_plan_code` is not a substitute for a payer routing catalog.

Source evidence: claim assembly and coverage resolution at `apps/backend/src/modules/24-billing-medicaid/routes/write-service-drizzle.ts:448-523`; M24's plan-code lookup is separate and state-scoped at `write-service-drizzle.ts:470-505`; no MCO assignment is accepted on PATCH (`apps/backend/src/modules/24-billing-medicaid/routes/m24-typebox.ts`, `UpdateDraftClaimBody`, and `routes/claims.routes.ts`, route 4).
