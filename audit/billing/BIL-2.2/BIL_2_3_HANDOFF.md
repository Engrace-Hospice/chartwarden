# BIL-2.3 handoff

Before BIL-2.3, validate the claim transmission lifecycle against a private PostgreSQL database and ensure the release candidate includes migration 1379 with its `compat: contract` deployment ordering. Cover the submit/retry queues, worker restart while `sending`, stale fencing token, clearhouse-attempt reconciliation, and no-send behavior for unresolved uncertainty.

Continue from existing claim preparation and correction services. Do not implement a parallel claim engine. Keep original submission evidence and claims histories immutable; do not map upload receipt to payer acceptance. Confirm production route configuration, account/environment binding and approved vendor tests separately.
