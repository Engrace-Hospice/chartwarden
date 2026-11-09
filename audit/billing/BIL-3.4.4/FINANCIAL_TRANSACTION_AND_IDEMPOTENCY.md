# Financial Transaction and Idempotency

Execution locks the authorized stage row, verifies the immutable plan and approval, re-derives current source/review facts, creates a pointer-only `remittance_advice` envelope, calls the private `postValidatedClaimInTransaction` seam, and records the posting event in the same PostgreSQL transaction. No external network call occurs. A failure in the final posting-evidence insert rolls the envelope, remittance line, status change, and M25 outbox events back.

The M25 core applies its existing trace/payer/provider duplicate lock and uniqueness checks. The source adapter also holds a possible prior same-trace/amount effect as a blocker. Stage locking serializes concurrent executions; a subsequent execution returns the existing posted result. The M25 shared core now preserves existing `parse_summary` source metadata while adding posting outcome fields, so the stage and plan association survives posting.

The synchronous records are `remittance_advice`, `remittance_line`, and M25 outbox events. M23/M26 effects are delivered by their existing consumers after commit. They are not part of the synchronous transaction and do not prove bank cash settlement.
