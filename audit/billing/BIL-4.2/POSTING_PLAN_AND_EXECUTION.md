# Posting plan and execution

The existing v2 controlled-plan flow is extended to `claimmd-controlled-posting-plan-v3`. Its immutable digest binds the ordered claim facts, billed and paid cents, responsibility, adjustment classification and unresolved cents, along with the existing source, identity, review, and ledger dependencies. The server derives these values from the encrypted staged source and M25 assessment; the browser supplies no authoritative amounts or classifications.

The assessment runs at plan generation and is repeated by the M25 transaction posting port during execution. Unsupported facts block the entire approved plan. The existing distinct approval/executor, step-up, feature gate, transaction, idempotency, and tenant/provider checks remain in force. Posting invokes M25's existing transaction core, which stores the CAS as flagged review and emits the partial-payment event; it does not create new ledger semantics.
