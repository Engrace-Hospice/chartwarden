# Downstream status and events

M25 emits `m25.remittance.claim_partial_paid` for a partial claim and includes the actual payer payment. It does not reuse `m25.remittance.claim_paid`. M41's existing consumer maps this event to `partially_paid`; M26 accrues only the received payment cents. M23 has an existing partial-payment consumer. M24 does not subscribe to this commercial partial event.

The financial plan and posting result do not claim bank settlement. Outbox dispatch and consumer completion are separate evidence from the committed M25 transaction. This phase changes no event catalog or consumer contract.
