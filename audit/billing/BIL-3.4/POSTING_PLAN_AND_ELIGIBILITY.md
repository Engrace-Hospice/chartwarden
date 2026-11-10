# Posting plan and eligibility

BIL-3.3's read-only `projectEraFinancialReview` remains a summary, not a ledger posting plan. It calculates safe minor-unit projections and flags blockers, but does not produce supported per-claim allocations or an immutable plan digest bound to ownership, match decisions, review version, and current ledger state.

No posting eligibility/plan endpoint was added. This avoids presenting an unbound preview as authorization. A future plan must distinguish unresolved amounts and PLB, reject unsupported adjustment semantics, and go stale on any source or decision revision.
