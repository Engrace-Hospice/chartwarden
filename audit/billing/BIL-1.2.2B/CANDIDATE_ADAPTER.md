# Candidate adapter

## Data and query shape

`createClaimMdCandidateProvider` searches `claimmd_submission_evidence` with exact `(account_reference, usage, vendor='claimmd')` and either stored PCN or an `EXISTS` match on the receipt table's exact `source_field` and `external_value`. The evidence lookup index is `(account_reference,usage,pcn)`; the receipt lookup index is `(account_reference,usage,source_field,external_value,evidence_id)`. Candidate details are loaded in one bounded joined query, followed by one receipt-observation query for the selected evidence IDs. Maximum candidate evidence rows: 100; the 101st makes `complete=false`, so matcher returns `ambiguous/CANDIDATE_LIMIT_EXCEEDED` without claiming uniqueness.

M23 rows must join the exact `claim_submission` ID, organization, provider, claim, `claim_837i` kind, PCN and attempt index. The associated clearinghouse attempt must match organization/provider/usage/control/kind and be reserved or sent. M41 rows must join the exact `commercial_submission`, organization/provider/location/claim/control/payer and `claimmd` vendor key; its shared clearinghouse attempt must independently match. The evidence UUID is the attempt-specific immutable send identity because M41 can have several physical attempts under one logical submission row. `submissionAttemptId` in the resolver result is this evidence UUID; the same UUID is also explicitly preserved as `evidenceRef.evidenceId`.

Both modules require provider-entity ownership to match organization. A recorded location must belong to that provider entity (the source `location` table has no direct `organization_id`). Current NPI/TIN profile fields are not queried or used as historical evidence. TIN is decrypted only after exact account/environment and indexed candidate filtering; missing/decryption-failed key produces a retryable safe error.

## Namespace rules

Exact external fields remain distinct: `claimmd_id`, `remote_claimid`, and `claimid` compare only to the same field. `fileid` is file namespace, `batchid` is batch namespace, `pcn` is internal X12 claim control. `responseid` and opaque `clearinghouseSubmissionId` are excluded from outbound identity correlation. `inboundid` is retained with its own source field; it is not silently renamed to `fileid` or `claimid`.

File/batch correlation alone is insufficient: matcher requires the event PCN to equal the evidence PCN before a receipt match can resolve. A strong ID and a file/batch identifier pointing to different attempts is a conflict. All supplied historical NPI/TIN/payer/type/date/control facts are checked; omitted optional facts are not contradictions.

## Matcher contract

The existing BIL-1.2 `resolveClaimMdIdentity` remains the sole decision engine. It will resolve only an exactly scoped candidate; duplicates across tenants/providers/attempts remain ambiguous. A candidate count overflow is ambiguous. PCN-only/identity-only fallback requires the existing strict composite; current mutable provider profiles are never consulted. A previous resolved mapping remains bound; contradictory later evidence adds conflict history rather than reassigning it.
