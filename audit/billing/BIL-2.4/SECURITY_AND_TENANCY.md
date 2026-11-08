# Security and tenancy

- M24 remains responsible for Medicaid claim reads/writes and existing org/provider ABAC.
- The tenant cannot set a payer channel or MCO through the draft PATCH body.
- The server refuses every route not proven submit-capable, before creating a submission attempt/outbox entry.
- Workers independently refuse unsupported persisted work before decrypting partner credentials or invoking adapters.
- Provider credential state/channel/MCO must match the claim's server-owned route identity.
- Route readiness contains no protected payer credentials, patient identifiers, or raw EDI.
- No RLS, grants, migrations, or ownership metadata were changed in this phase.
- All Medicaid transmission remains blocked; no Claim.MD worker was used or activated.

Focused tests validate tenant API route composition and no client-side MCO mutation. Database RLS runtime certification was not repeated because no database schema or RLS policy changed; it remains part of the cumulative billing gate.
