# BIL-1.2 — Claim.MD identity resolution and multi-tenant routing

## Status

**Implemented as an inactive resolution foundation; not production-ready or wired for automatic execution.** The account-wide BIL-1.1 inbox is reused. This phase adds a deterministic pure matcher, encrypted-page identity extraction, internal resolution/history schema, a bounded worker facade, and offline tests. It does not dispatch acknowledgments or mutate M23/M24/M41 claims.

The activation blocker is substantive: existing outbound records do not consistently preserve the Claim.MD account/environment, provider NPI/TIN as sent, and vendor ID association for each original submission. The repository has no concrete cross-module candidate adapter that can validate those fields against immutable historical identity. The worker repository accepts an injected candidate provider for this reason; no production adapter or boot registration was added. The matcher fails closed when evidence is missing. Do not enable it.

## Files

- `apps/backend/src/modules/23-billing-medicare/claimmd-identity/resolve.ts` — deterministic resolution tiers and safe result contract.
- `apps/backend/src/modules/23-billing-medicare/claimmd-identity/event-identifiers.ts` — extracts identity fields from an already decrypted BIL-1.1 page in memory.
- `apps/backend/src/modules/23-billing-medicare/claimmd-identity/service.ts` — resolver orchestration and bounded, disabled-capable worker facade.
- `apps/backend/src/modules/23-billing-medicare/claimmd-identity/store.ts` — protected inbox decryption, resolution persistence/history, and DB leases; candidate source is explicitly injected.
- `apps/backend/src/modules/23-billing-medicare/claimmd-identity/config.ts` — absent/invalid setting means disabled.
- `packages/db/migrations/1351_m23_claimmd_identity_resolution.sql` — protected result/history records plus event seeding/backfill.
- `packages/db/src/schema/billing/claimmd-response-resolution.ts` — typed schema.
- `apps/backend/src/modules/23-billing-medicare/claimmd-identity/*.test.ts` — synthetic offline tests.

## Architecture

BIL-1.1 stores the account/environment cursor and encrypted response pages. BIL-1.2 derives only vendor identity fields from the encrypted page when the internal resolver runs. It stores a decision keyed to the captured event, and history is append-only by resolution version. Candidate data must come from trusted outbound submission history; vendor-provided organization/provider/claim identifiers are never treated as WardenX authority.

## Preconditions before wiring

1. Add immutable at-send identity snapshots and Claim.MD account/environment provenance to M23/M41 submission evidence. Legacy rows without a snapshot must remain review-only.
2. Implement and test a concrete candidate adapter joining M23 attempt + `claim_submission` + claim, M41 submission + claim, and only Claim.MD-routed M24 submissions.
3. Validate Claim.MD upload receipt semantics (`fileid`, `claimmd_id`, `remote_claimid`) for the deployed single-claim send path and account/environment namespace.
4. Add private-PostgreSQL role/RLS, atomic lease, insert/update race, and cross-tenant candidate tests.
5. Bind the job ID, internal platform principal, safe keyring, candidate adapter, observability, and explicit false-by-default flag at backend boot only after those gates pass.

See [identity strategy](./IDENTITY_RESOLUTION.md), [tenant isolation](./TENANT_ISOLATION.md), [replay and recovery](./REPLAY_AND_RECOVERY.md), [test results](./TEST_RESULTS.md), and [BIL-1.3 handoff](./BIL_1_3_HANDOFF.md).
