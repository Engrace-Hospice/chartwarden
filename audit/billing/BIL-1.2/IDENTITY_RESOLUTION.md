# Identity resolution

## Vendor fields and boundaries

The [official Claim.MD API response guide](https://api.claim.md/) describes `/services/response/` as account-wide (up to 20,000 results) and shows claim attributes including `claimid`, `claimmd_id`, `remote_claimid`, `pcn`, `bill_npi`, `bill_taxid`, `payerid`, `batchid`, `fileid`, `response_time`, with nested `messages.responseid`. The examples show multiple messages for one claim. These names are not interchangeable. Current source responses are retained in the BIL-1.1 encrypted batch; BIL-1.2 does not collapse the response into one status.

The implementation treats the message-level `responseid` as captured event identity, `fileid` as a possible upload receipt discriminator, and each claim ID field as a separately named external correlation value. Exact semantics and namespace guarantees still require account-specific vendor confirmation. Values are compared only within `(accountReference, usage)`.

## Matching hierarchy

1. **Previously verified mapping** is an intended first tier for future replay. The present schema retains event decisions and history, but this implementation does not yet maintain a verified external-claim mapping table. A prior resolved decision is immutable; same-target replay is idempotent, new contradictory evidence becomes `conflict`.
2. **Exact vendor claim reference**: uniquely match a server-owned candidate's explicit Claim.MD claim reference within account/environment. Validate every supplied NPI, TIN, payer, claim-type, and date attribute against the candidate's historical send snapshot. Contradiction becomes `conflict`; missing historical identity becomes `needs_review`.
3. **Exact outbound receipt**: match `fileid` to the exact outbound receipt/file identity or a vendor batch plus PCN, scoped by account/environment. A unique result is still checked against every supplied identity fact.
4. **Strict composite fallback**: exact PCN + historical billing NPI + historical TIN + payer + claim type + service date range, and exactly one candidate. PCN, NPI, or TIN alone never authorizes a match. No fuzzy patient matching is present.
5. **Unmatched/ambiguous/conflicting**: retain the event and reason. No arbitrary first/newest candidate selection.

An event with multiple nested messages keeps one resolution record per captured message event, so message identity remains independent even where messages share a parent claim.

## Source-of-truth and current gap

M23 `clearinghouse_submission_attempt` has organization/provider/usage/control and a vendor submission ID; M23 `claim_submission` has claim/control/attempt and a generated file URI. M41 `commercial_submission` has organization/provider/location/claim/control/payer and a clearinghouse receipt, but no durable test/production field. Neither flow consistently snapshots the actual billing NPI/TIN and account reference on each submission. `provider_entity` stores current NPI and encrypted TIN; current values cannot prove old transmitted identity after profile changes. M24 `medicaid_submission` includes adapter/channel and a vendor transaction ID; most state integrations are not Claim.MD and must not be assumed to be.

Therefore the matcher requires the injected candidate source to return a verified route and historical identity. Legacy rows without that evidence are safely unresolved. No retroactive identity is invented.

## Module ownership and outcomes

Only original WardenX submission evidence supplies module ownership (`M23`, `M24`, or `M41`). Payer labels do not select a module. Malformed source envelopes receive a review state and are excluded from automatic reprocessing. The result is an identity decision only; it is not a 999/277CA, acknowledgment state, claim status, ERA, or payment instruction.
