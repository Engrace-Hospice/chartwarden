# Posting plan and ledger effects

The immutable plan document version is now `claimmd-controlled-posting-plan-v4-cas-policy`, with accounting rule `m25-claimmd-fully-paid-or-oa-review-partial-no-co-policy-v4`. It binds the claim financial assessment and exact reported adjustment facts into the existing source/review/identity digest. Plans previously approved under the prior rule no longer match current recomputation and cannot be executed as current.

For CO/PR/PI the plan carries `policyVersion: null`, `accountingDisposition: policy_required`, and `m25Action: not_authorized`. Eligibility is false. The existing transaction core re-assesses source facts before effects; no alternate ledger or adjustment write path was added. The only supported partial financial operation remains the BIL-4.2 OA review-only case.

No policy-approved CO adjustment can be posted in this phase; the API accurately represents the blocker rather than accepting browser classifications.
