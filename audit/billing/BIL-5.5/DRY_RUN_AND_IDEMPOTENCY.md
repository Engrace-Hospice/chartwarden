# Dry-run and idempotency

The dry-run repeats the authoritative preflight in a repeatable-read platform transaction. It reports `mutatesSource=false`, `callsVendor=false`, and `authorizesExecution=false`.

Two concurrent dry-runs return independently while the private test verifies unchanged cursor, generation, lease, capture state, retry count, and error code. The only expected durable side effect is the existing mandatory platform-bypass audit evidence.

Dry-run output is point-in-time evidence and cannot be submitted as a later execution token.
