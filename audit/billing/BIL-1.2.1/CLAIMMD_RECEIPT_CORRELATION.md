# Claim.MD receipt correlation

## Current state: Partial / semantics unverified

M23 maps the transport's single `clearinghouseSubmissionId` into a URI string (`apps/backend/src/modules/23-billing-medicare/jobs/clearinghouse-submission.ts:160-164`). M41 stores that same generic field after acceptance (`apps/backend/src/modules/41-billing-commercial/jobs/submission-worker.ts:462-479`; schema `packages/db/src/schema/billing-commercial/submission.ts:45-52`). This loses distinctions among file, batch, claim, remote-claim and message identifiers if the adapter parser has them.

The response extraction and BIL-1.2 matcher preserve separate field names (`apps/backend/src/modules/23-billing-medicare/claimmd-identity/event-identifiers.ts` and `resolve.ts`), but no durable outbound receipt history joins those values to an immutable attempt. A generic transport receipt cannot prove `fileid`, `claimid`, `claimmd_id`, `remote_claimid`, PCN and `responseid` have equivalent uniqueness or scope.

## Required model

Append receipt observations keyed to original attempt and `(stable account reference, environment, vendor)`. Retain source field name, identifier namespace (`file`, `batch`, `claim`, `remote_claim`, `pcn`, `message`), value, observation source (upload response/status response/reconciliation), and timestamp. Do not impose cross-namespace uniqueness or globally unique PCN. A file-level receipt may connect multiple claims only where vendor evidence establishes that relationship.

## Vendor verification

No Claim.MD API request was made. Consult [Claim.MD API documentation](https://api.claim.md/) for its documented response shapes; source-code parsers are not proof of deployed identifier semantics. Exact uniqueness/scope and single-claim versus multi-claim upload behavior still require vendor confirmation or a synthetic test-account transaction. Until then, ambiguous IDs cannot authorize automatic routing.

## Uncertain send

M41 has a sticky ambiguity protocol and refuses blind resend after an interrupted call (`submission-worker.ts:61-69,430-479`). M23 has durable attempt/idempotency seams, but `transportUpload` only returns a generic accepted URI and the path does not append complete receipt provenance. Reuse each module's existing idempotency and in-doubt handling; do not create a parallel submission workflow.
