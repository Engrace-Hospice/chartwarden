# Candidate adapter

## Current state: Missing

The BIL-1.2 store accepts `candidates(event)` as an injected function (`apps/backend/src/modules/23-billing-medicare/claimmd-identity/store.ts:33-39`). The matcher is deterministic and fails closed on missing/contradictory identity (`claimmd-identity/resolve.ts:81-130`). No actual database-backed M23/M41 candidate adapter was found, and no composition-root binding supplies one.

## Target query design

Use exact indexed correlations within `(vendor, stable account reference, environment)`: append-only upload claim/file/batch identifiers, attempt/control identifiers, then a bounded strict composite using immutable at-send PCN, NPI, protected TIN, payer, claim type and dates. Return only evidence-backed candidates. Provider IDs must be joined/validated against organization ownership and module submission records. Resolve multiple exact candidates as ambiguous; never select a newest row or trust event-supplied organization/provider IDs.

M23 sources are `clearinghouse_submission_attempt` plus claim submission history; M41 sources are `commercial_submission` plus `commercial_claim`. Existing M23 attempt schema has no claim ID; existing M41 submission has claim and provider/location but no per-attempt snapshot. Therefore these joins alone are insufficient. M24 must be excluded unless a concrete persisted route proves Claim.MD was used; direct state adapters remain separate.

## Performance and privacy

Candidate lookups must use account/environment/receipt indexes, fixed result limits and parameterized Drizzle queries. Do not scan all tenant/provider data or decrypt all provider Tax IDs. Decrypt only an indexed, narrowly selected immutable evidence record in memory. Current provider-profile reads are not a fallback.
