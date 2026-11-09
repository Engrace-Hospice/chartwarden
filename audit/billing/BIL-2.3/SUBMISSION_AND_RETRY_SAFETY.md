# Submission and Retry Safety

M41's existing submission worker uses durable submission reservation and attempt state, performs the clearinghouse call outside its database transaction, and records ambiguous outcomes as in-doubt for reconciliation. BIL-2.3 reuses that path; it does not add a correction-specific sender or retry loop.

A clearinghouse-rejection correction creates a new draft, not a transmission. It receives a new internal claim/control identity and must pass ordinary M41 validation, readiness and submission authorization before sending. The original sent attempt and its evidence are retained. Existing retry and reconciliation rules continue to prevent blind retransmission after an uncertain send.

The new route is guarded by the existing authenticated write, caseload ABAC, non-AI and idempotency prehandlers. PostgreSQL tests verify one child per parent and replay behavior. Full two-worker concurrency and deployed payer-route certification remain outside this phase.
