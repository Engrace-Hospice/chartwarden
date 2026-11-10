# Financial Policy Governance

`apps/backend/src/modules/25-remittance/domain/adjustment-policy.ts` defines an exact-scope, versioned policy contract: organization, provider, payer, adjustment category/reason, action, effective dates, approval actor/time, authorization source, and permission. Resolution requires exactly one effective approved policy and its approval evidence; absent or ambiguous policy fails closed.

This repository has no authoritative M25 policy store, administrative approval lifecycle, or source of business authorization for these policies. The contract is not connected to a permissive seed or CRUD endpoint. Therefore no PLB/CO/PI financial action is authorized by this phase. A policy row merely existing would not be sufficient.

The policy resolver is a domain contract, not evidence that policy governance is operationally configured. A future phase must establish the legitimate policy owner and approval process before connecting a store or authorizing effects.
