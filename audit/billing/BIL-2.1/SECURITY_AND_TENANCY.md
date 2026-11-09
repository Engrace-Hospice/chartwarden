# Security and tenancy

- Route configuration is platform deployment configuration, not client input. Exact tenant and provider identity come from the authorized claim read/submit context; the browser cannot choose a payer ID.
- The M23 composition contract requires the server-side payer-route status reader; route registration cannot omit the preflight dependency and thereby bypass the submit guard.
- The preparation endpoint applies the same `billing.claim.read` and claim caseload/provider ABAC guards as detail and line reads, and is audited as a claim read.
- The route resolver matches organization, provider entity, MAC credential jurisdiction, account reference and environment. It returns only status/reason to tenant UI.
- Claim.MD account usage derives from `CLAIMMD_ACCOUNT_USAGE`. Test and production mappings cannot cross-match. `CLEARINGHOUSE_USAGE` disagreement fails closed.
- A global payer override is rejected for Claim.MD. The MAC jurisdiction fallback is not used on Claim.MD.
- Final payload and historical identity remain under existing M23/BIL-1 immutable evidence. The worker checks route context again immediately before transport, after rendering; no automatic reroute occurs.
- No raw X12, MBI, TIN, account key or payer/account identifier is returned by the preparation endpoint or added to logs.
- Legacy MAC-direct routing and M24/M41/M25 paths are not changed by the resolver.

No database schema or RLS change was needed. Static source/tests do not certify Claim.MD vendor configuration or runtime access policy.
