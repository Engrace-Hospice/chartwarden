# Phase 1.2 handoff

Phase 1.2 must first close Phase 1.1's P0 integrated certification gaps before treating any PR reconstruction as review-ready. Required live suites:

1. **Response pipeline:** actual encrypted capture store, actual M23/M41 candidate provider and owner readers, resolver history, approved ack interpreter/dispatcher, two synthetic organizations × providers × locations, status and ledger assertions.
2. **ERA pipeline:** actual X12 parser and evidence reader, encrypted central store, ownership history, duplicate classification, tenant delivery and review route, persisted non-posting financial assertions.
3. **Workers:** independent processes or isolated runtimes and connections; leases, generations, cursor fencing, concurrent event claims, crash injection at durable boundaries, restart idempotence.
4. **Recovery:** actual authentication plugin and authorization composition → registered route → real recovery store; real PostgreSQL audit, action idempotency, stale/concurrent requests, no cursor mutation and no posting.
5. **Deployment recovery:** disposable synthetic populated DB and test-double infrastructure around `deploy.sh`; prove migration ledger/data preservation and contract-migration operator hold.

Use `run-private-postgres.sh` as the safe baseline runner, extend its sequential suite list only after each new live suite is independently reviewed, and update package scripts/CI live-suite registration per repository policy. Do not merge or modify historical PR bases in the certification work. Preserve the dependency chain: BIL-1.3 → BIL-1.4 → BIL-1.5A/B → Release Gate Phase 1 → Phase 1.1 → Phase 1.2 → explicit Release Gate merge authorization.
