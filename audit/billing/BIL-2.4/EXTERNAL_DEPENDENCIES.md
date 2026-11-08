# External dependencies and activation blockers

## Required before any controlled state transmission

1. Select the actual Medicaid states and programs WardenX will support, with FFS versus MCO evidence from dated coverage/payer contracts.
2. Establish a source-owned state program/MCO directory and a coverage-to-program mapping with effective dates; do not infer from state of residence or null `mcoId`.
3. Obtain the applicable current state 837I companion guide and determine the required version, envelope, acknowledgement, corrections, and submission transport.
4. Complete provider enrollment and trading-partner/submitter agreements for each billing provider entity and route.
5. Receive explicit state/clearinghouse testing approval for the transaction types and provider IDs used.
6. Build the actual approved transport and validate encrypted credentials, file delivery, acknowledgments, idempotency and reconciliation in a controlled test account.

## State specifics to resolve

- **OR:** OHA TPA/provider matching and required testing; replace the local reference JSON envelope with a verified transport only after the contract is confirmed.
- **WA:** ProviderOne TPA, 837I companion guide, and transaction testing; distinguish payment claims from encounter data.
- **ID:** Idaho Trading Partner Account and provider enrollment; obtain/verify applicable hospice institutional claim guide and supported submission method.
- **CA:** establish FFS DHCS billing versus provider's MCP contractual route. PACES managed-care encounter guides apply to plan encounter reporting, not automatically to provider claim payment. Verify the applicable current FFS institutional materials from DHCS.
- **NV:** complete the appropriate FFS or encounter-specific trading-partner certification; do not treat the separate encounter guide as a claim payment route.

Until these are resolved, local preparation is not a claim transmission capability and all M24 submissions remain blocked.
