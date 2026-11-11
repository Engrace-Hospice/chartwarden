# BIL-5.2 handoff

## Recommended bounded objective

**BIL-5.2 — Source-Owned In-Doubt and Exception Worklists**

Extend owner APIs for M23 submission uncertainty, M25 financial blockers, and attributable processing exceptions with stable source cursors, safe reason codes, timestamps, and deep links. Keep central unattributed Claim.MD quarantine out of tenant views. Do not add replay/recovery or posting actions in that first increment.

Before work, add an authenticated restricted-role HTTP-to-PostgreSQL test across the owner route contracts and resolve the independent-cursor/count semantics for the aggregate UI. Any account-wide recovery or quarantine UI remains a separately authorized operator capability.
