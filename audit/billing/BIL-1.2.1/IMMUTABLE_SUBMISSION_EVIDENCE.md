# Immutable submission evidence

## Current state: Missing

No immutable submission-evidence record is created at either Claim.MD send boundary. M23 `transportUpload` constructs the transport submission from `input.x12`, `controlNumber`, context and a derived idempotency key, then performs the network call (`apps/backend/src/modules/23-billing-medicare/jobs/clearinghouse-submission.ts:137-164`). Its attempt schema lacks the required historical identity fields (`packages/db/src/schema/billing/clearinghouse-submission-attempt.ts:33-53`).

M41 renders the X12, hashes that exact string, calls `bindPayloadAndMarkCallStarted`, then calls `submitClaim` (`apps/backend/src/modules/41-billing-commercial/jobs/submission-worker.ts:441-479`). The existing payload hash is valuable crash/changed-payload protection but is not a full immutable identity snapshot and is stored on the mutable logical submission row (`packages/db/src/schema/billing-commercial/submission.ts:19-70`).

## Target lifecycle (not implemented here)

1. Render and validate final X12.
2. Extract provider NPI/TIN, payer, claim type, PCN/CLM01, ISA/GS/ST controls, and service dates from the exact bytes that will be sent. Reject incomplete or contradictory extraction.
3. In one local transaction reserve an attempt and immutable evidence containing organization, provider entity, location, claim, module, logical submission, attempt, vendor, stable account reference, environment, identity, digest and creation time. Encrypt sensitive identity with a scheme whose AAD binds the evidence row; do not reuse M2 provider-row ciphertext without a compatible cryptographic design.
4. Commit before network I/O. Then upload outside the transaction.
5. Append receipt observations with source and timestamp. Preserve `in_doubt` on uncertain outcomes; reconcile before any retry.

The HTTP request and PostgreSQL commit cannot be atomic. Existing M41 ambiguous-send handling is reusable, but M23's `TransportUpload` legacy shape does not persist a complete pre-send snapshot. Do not claim atomicity or rely on current provider configuration to reconstruct old evidence.

## Security and historical records

The approved M2 cipher is an envelope cipher backed by injected tenant keys and binds AAD to `organizationId` and `providerEntityId` (`apps/backend/src/modules/02-identity/tax-id-cipher.ts:24-35,47-50,53-90`). A submission snapshot must preserve a verifiable historical TIN without exposing plaintext in logs or resolution history. A dedicated encrypted field / envelope contract and key-retention decision are prerequisites.

Existing payload files or receipts may support a separately audited dry-run inventory, but current provider NPI/TIN cannot establish what an old claim transmitted. No historical backfill was run.
