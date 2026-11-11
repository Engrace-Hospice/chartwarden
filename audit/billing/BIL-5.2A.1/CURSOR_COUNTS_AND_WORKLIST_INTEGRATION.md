# Cursor, counts and worklist integration

The new endpoints preserve per-owner cursors; no global cursor or global snapshot is claimed. M23 orders by dispatch start and submission UUID. M41 orders by update timestamp and submission UUID while applying the existing caseload filter. Each response's `count` is explicitly `lower_bound` and equals only rows loaded on that page; it is never presented as a total backlog.

`/billing/operations` continues loading ordinary M23/M24/M41/M25 pages and independently loads the new M23/M41 submission feeds. Claim rows link to their existing module detail route. Feed errors remain read errors; no retry/resubmit action is offered. Provider changes invalidate requests and load a new provider-bound cursor.

M24 in-doubt visibility remains unavailable because M24 has no supported durable transport uncertainty contract. Central unattributed Claim.MD quarantine remains outside tenant operations.
