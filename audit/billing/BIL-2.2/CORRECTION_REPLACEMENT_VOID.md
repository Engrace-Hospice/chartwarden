# Correction, replacement, and void workflows

Existing behavior is retained rather than duplicated:

- `POST /api/v1/billing/claims/:id/replace` in `routes/claims.routes.ts` checks permission, provider ABAC, step-up and idempotency, copies original lines, and invokes `writeService.replaceClaim`.
- `POST /api/v1/billing/claims/:id/void` uses the corresponding gated service and creates a void draft without service lines.
- `write-service-drizzle.ts` preserves original/successor linkage and reason; the domain service restricts eligible original states. Subsequent submission uses the same reviewed preview and submit worker path.
- `claim-editor.tsx` provides replacement-chain navigation and TOB 817/818 draft ceremonies; state eligibility is presented before action.

These operations create new claim identities and do not mutate a sent X12 or prior submission row. This phase does not change Medicare correction eligibility rules or classify a clearinghouse receipt as payer acceptance. Focused tests should continue to cover route permission/step-up and domain replacement-chain rules in the cumulative BIL-2 suite.
