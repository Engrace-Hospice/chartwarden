# BIL-3.3 handoff

The current screen and API provide nonposting review plus append-only acknowledgment of upstream verified claim identity. Before building adjustment classification/approval preparation, BIL-3.3 should consume the same stage-scoped records and keep approvals separate from matching and posting.

Prerequisites to close before calling matching complete: expose owner-controlled historical submission/attempt identity for candidate discovery; preserve immutable original claim-line snapshots and a trustworthy ERA line reference contract; implement audited candidate resolution for supported ambiguous cases; and execute migration 1394/RLS/concurrency on isolated PostgreSQL with the real NOBYPASSRLS application role. Keep PLB provider-level and do not translate parser adjustment codes into posting instructions.
