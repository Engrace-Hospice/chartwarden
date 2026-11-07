# BIL-1.2.1 — implementation boundary and readiness

## Verdict

**NO-GO for BIL-1.3 implementation.** BIL-1.2 remains an inactive resolver foundation. The requested completion is not safely achieved in this workspace: no immutable send-time identity evidence exists for M23/M41, no concrete candidate adapter exists, and no resolver runtime is bound. An unused schema or an adapter backed by mutable provider profiles would create false confidence and could misroute account-wide events.

This turn made documentation-only changes under this directory. It did not alter application code, schemas, migrations, feature flags, workers, or frontend code. It made no network/API calls and ran no live database tests.

## Existing foundation

- BIL-1.1 encrypted account inbox and cursor/lease implementation: `apps/backend/src/modules/23-billing-medicare/claimmd-capture/` and migration `packages/db/migrations/1350_m23_claimmd_response_inbox.sql`.
- BIL-1.2 deterministic matcher, event extraction, store, worker facade, and false-by-default config: `apps/backend/src/modules/23-billing-medicare/claimmd-identity/` and migration `packages/db/migrations/1351_m23_claimmd_identity_resolution.sql`.
- Focused offline verification: 5 files / 16 tests passed (commands in [TEST_RESULTS.md](./TEST_RESULTS.md)). This is not database, runtime, or vendor certification.

## Blocking evidence

- M23 transport upload receives an X12 string and context, then calls the external transport in `apps/backend/src/modules/23-billing-medicare/jobs/clearinghouse-submission.ts:94-103,137-164`; it has no pre-send immutable-evidence persistence port.
- M23 attempt schema persists organization/provider/scope/usage/idempotency/control/kind/hash/status/vendor submission ID, but no location, account reference, billing NPI/TIN, payer/claim type, EDI digest, or claim/submission foreign identity: `packages/db/src/schema/billing/clearinghouse-submission-attempt.ts:33-53`.
- M41 hashes the rendered X12 and marks call started before sending (`apps/backend/src/modules/41-billing-commercial/jobs/submission-worker.ts:456-479`), but its logical submission schema lacks account reference, historical NPI/TIN, and per-attempt immutable identity evidence: `packages/db/src/schema/billing-commercial/submission.ts:19-70`.
- Account response stream already distinguishes internal account reference and usage (`packages/db/migrations/1350_m23_claimmd_response_inbox.sql`, `claimmd_response_stream`), but the outbound paths do not persist that same stable identity.
- Matcher store explicitly injects its candidate provider (`apps/backend/src/modules/23-billing-medicare/claimmd-identity/store.ts:33-39`). No concrete M23/M41 candidate adapter or runtime binding was found. The M23 job ID used by the capture/resolution stores is registered nowhere in `apps/backend/src/index.ts`.
- The existing M2 tax-ID cipher binds its envelope to organization and provider entity (`apps/backend/src/modules/02-identity/tax-id-cipher.ts:24-35,47-50`). Reusing that ciphertext for a new evidence object is not valid because its authenticated-data binding is to the provider row, not an immutable submission attempt.

## Required next corrective slice

Implement a single end-to-end, additive vertical slice before BIL-1.3: per-attempt immutable evidence prepared from the final transmitted EDI under an approved submission-scoped encryption/key lifecycle; transactional reservation before HTTP; receipt append-only association; M23/M41 indexed candidate readers; candidate/matcher integration; and a disabled-by-default platform runtime registration. Include private-PostgreSQL role/RLS/concurrency coverage. Historical submissions without verifiable original payload/evidence remain review-only. See [candidate adapter](./CANDIDATE_ADAPTER.md), [security](./SECURITY_AND_RLS.md), and [readiness](./BIL_1_3_READINESS.md).
