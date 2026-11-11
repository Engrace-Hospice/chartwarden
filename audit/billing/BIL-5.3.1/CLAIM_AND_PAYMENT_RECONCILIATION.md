# Claim and payment reconciliation

The M41 route accepts only the claim UUID in its path. M41's `getClaim` supplies the authorized claim, provider and plan payer after existing organization/provider/caseload checks. The M25 service then reads persisted remittance lines by that exact claim UUID and source payer/provider scope. It returns both complete line-history totals and up to 100 newest line details, with an explicit truncation marker.

This is an M41-to-M25 persisted remittance association, not a general historical 837 attempt resolver. The generic M41 reader does not prove original transmitted charge, so no such amount is returned. Distinct payment lines remain distinct rows; no attempt count or current charge is used to deduplicate obligations.
