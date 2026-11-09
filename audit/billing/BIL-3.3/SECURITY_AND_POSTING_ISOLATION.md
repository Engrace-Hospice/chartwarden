# Security and posting isolation

- Reads remain behind `remittance.read`; matching remains `remittance.match_review`; decisions require `remittance.financial_review`.
- Actor, organization, provider scope and membership come from authenticated request context, not the request body.
- Service query starts with the tenant/provider-authorized M25 stage. No central inbox record or raw 835 is returned.
- RLS on the decision table is `ENABLE` + `FORCE`, organization scoped; insert policy also requires an organization/provider-matching stage.
- Decision rows are append-only and contain no raw ERA, member identifiers, TIN, credentials, or payment allocation.
- Decision code has no dependency on `receiveAdvice`, `postAdvice`, financial ledger, balance writer, or event publisher.
- No Claim.MD worker or posting flag was enabled.

An ERA being staged, balanced, matched, or marked reviewed does not establish bank receipt and does not authorize accounting effects.
