# BIL-1.4.1A — Parsed 835 Identity & Verified ERA Ownership

**Implementation status: Implemented as inactive internal code. Runtime activation: NO-GO pending private PostgreSQL/RLS and synthetic-source certification.** The change connects captured encrypted ERA files to the existing TypeScript M25 parser, routes payee identity against immutable Claim.MD send evidence, verifies provider and location ownership through M1, correlates PCNs to historical claim submissions, and stores encrypted, versioned decisions. The ownership worker is separately false-by-default. No Claim.MD call, migration execution, worker activation, or financial posting was performed.

The artifact decision has one tenant/provider scope at most. Different or unresolved payees hold the whole captured artifact. Verified payee ownership and claim correlation are separate fields in the encrypted decision: an unmatched claim stays unmatched and does not become a WardenX claim. No automatic transaction-set splitting occurs.

No path in the resolver invokes `receiveAdvice`, `postAdvice`, `m25.edi.835_received`, financial ledger writes, A/R changes, or patient-balance changes. BIL-1.4.1B must revalidate the persisted digest, owner, algorithm/version and encrypted source before staging.

See [parser integration](./X12_835_PARSER_INTEGRATION.md), [ownership](./ERA_OWNERSHIP_RESOLUTION.md), [tenant security](./MULTI_TENANT_SECURITY.md), [test results](./TEST_RESULTS.md), [blockers](./RELEASE_BLOCKERS.md), and [readiness](./NEXT_PHASE_READINESS.md).
