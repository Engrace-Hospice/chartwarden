# M25 transaction core

## Existing path and effect boundary

`apps/backend/src/modules/25-remittance/ingest/service-drizzle.ts` implements `receiveAdvice` and `postAdvice`. `receiveAdvice` inserts `remittance_advice` and the `m25.edi.835_received` outbox event transactionally. `postAdvice` loads the envelope, reads/parses staged raw 835 and checks the payee before opening its write transaction. Inside that transaction it locks the advice row, serializes the financial identity with a PostgreSQL advisory transaction lock, checks prior posted identities, then persists claim lines, service lines, CAS adjustments, remarks, denial/PR rows, parse status and outbox events.

Those M25 rows and transactional outbox entries are the synchronous effect boundary. M23 claim-state updates and M26 CAP accrual records are downstream event-consumer effects; they do not happen synchronously in `postAdvice`. This implementation does not describe M25 persistence as bank cash reconciliation or a general AR ledger.

## Extraction

`postClaimsInTransaction(tx, ...)` is the shared caller-owned transaction core. It applies the claim-level persistence and event rules without opening a transaction. Legacy `postAdvice` retains its automatic matcher and calls this core from its existing locked/deduplicated transaction. `postValidatedClaimInTransaction` is an internal M25 service seam for future source-owner-validated associations; it has no route, is not added to the module barrel as a separate operation, and does not open/commit a transaction. The builder removes that privileged operation from the ingest service object passed to route registrars; M25 internal code/tests obtain it through a direct-file WeakMap accessor.

The explicit seam verifies advice organization, provider, immutable file SHA-256, parsed-content digest, payer program, payment total, trace identity and a source-owner candidate for the selected claim. It does not invoke `autoMatch`; the selected claim must be returned by the payer-routed owner reader and agree with an exact payer ICN or patient control number. Claim association and the existing claim-paid/advice-posted events are persisted through the shared core.

## Deliberate support boundary

The explicit path currently accepts one status-1 claim with a positive payment equal to charge, zero patient responsibility, and no service lines, CAS, remarks, PLB, or unknown segments. It refuses other facts before writes. This is a persistence-core slice, not an approved Claim.MD posting workflow. Approval, staged-ERA source adaptation, posting authorization and a public execution route remain for BIL-3.4.4.
