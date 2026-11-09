# Security and Posting Isolation

- Tenant route context is built from authenticated `request.context`, not query/body organization IDs.
- The review service scopes by the actor organization and server-derived provider entities under `withOrgContext`; detail lookup includes both organization and stage UUID, then provider scope. A cross-tenant guessed ID returns not found.
- Central `claimmd_era_inbox` and cursor tables are not queried or exposed by these tenant routes. No raw 835 is returned.
- Stage details remain encrypted at rest and decrypt only inside the authorized review service. List output is summary-only. Detail projection allowlists fields; it excludes TIN, member ID and free-text remark content.
- Claim links are emitted only for ownership outcomes carrying a claim ID and known billing module. They use existing module routes, whose own authorization still applies.
- No call to `receiveAdvice`, `postAdvice`, `m25.edi.835_received`, manual match, payment/adjustment ledger, or M25 financial command exists in the new UI path.
- No schema, RLS, grant or worker flag change was made.

Focused route tests cover `remittance.read`, missing permission, wrong organization, out-of-scope provider query and invalid IDs. Projection tests cover sensitive-field exclusion and summary/detail separation. These are source-level/focused tests; no real PostgreSQL RLS role was used in BIL-3.0. Cumulative live RLS validation remains outstanding.
