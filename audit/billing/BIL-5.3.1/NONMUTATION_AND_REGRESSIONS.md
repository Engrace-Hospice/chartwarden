# Nonmutation and regressions

All new routes and projections are reads. The private PostgreSQL tests snapshot M25 advice/line/outbox state and M41 claim state around HTTP reads; no reporting read changed those records. Existing BIL-4 posting logic was not modified. No posting capability flag or production startup guard was changed.

The official private runner also passed legacy M25 posting/golden, M24 feedback, CAP consumer, clearinghouse-pull, M41 route and M23 reader regressions (120 checks total). No live Claim.MD/payer calls, production migration or deployment was performed.
