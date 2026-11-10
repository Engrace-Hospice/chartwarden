# Security and Nonposting

- M23 candidate discovery is scoped by the authenticated organization, provider, Claim.MD account, environment and payer control number, and runs under the restricted application role/RLS.
- Immutable line amounts are accepted only when bound to the exact submission evidence digest and identity tuple. Current mutable claim totals are not historical evidence.
- M25 confirms the module from owner-returned evidence, records Medicare's posting blocker server-side and recomputes it before approval. A reviewer cannot approve the blocked plan.
- The test asserts no `remittance_advice`, `remittance_line`, or success outbox effect for the Medicare review.
- `CLAIMMD_ERA_CONTROLLED_POSTING_ENABLED` remains default-off; the production startup guard and automatic-posting boundary are unchanged. No external request or production migration ran.
