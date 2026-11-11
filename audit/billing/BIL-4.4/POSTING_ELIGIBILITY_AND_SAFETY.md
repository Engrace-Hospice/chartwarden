# Posting Eligibility and Safety

`derivePostingFacts` continues to block unsupported financial facts and now adds `PROVIDER_ADJUSTMENT_POLICY_UNAVAILABLE` for a PLB-bearing ERA. The immutable plan document is versioned as `claimmd-controlled-posting-plan-v5-provider-adjustment-review` and binds source digest, PLB occurrence, provider/source facts, signed amount, classification and explicit no-policy/no-action status. Plan response returns that same provider-adjustment projection.

Source balance, historical identity, policy authorization and action eligibility remain distinct. A balanced ERA with PLB stays blocked as a whole; no partial posting or silent omission occurs. Existing separate approval/execution, duplicate checks, transaction core, feature gate and production startup guard are unchanged. No new financial effect is implemented.
