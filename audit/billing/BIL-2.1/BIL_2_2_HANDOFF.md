# BIL-2.2 handoff

Reuse the M23 `claim_submission` attempt store, Claim.MD immutable evidence/receipt ledger, response inbox, identity resolver, and acknowledgment dispatcher. Preserve the distinction between queued, uploaded, clearinghouse receipt, payer response and adjudication.

Before adding submission-history fields, inspect existing attempt projections and prove where payer ID, account/environment and route version are retained. Currently the scoped route is resolved at send and immutable X12 evidence captures the actual outbound payer ID; deployment route configuration itself has no persistent version/audit row.

Do not add acknowledgment mappings or alter NOE/NOTR/transfer semantics. Focus BIL-2.2 on safe correction, retry/in-doubt, and claim history UX. Keep Claim.MD external certification and controlled activation as separate gates.
