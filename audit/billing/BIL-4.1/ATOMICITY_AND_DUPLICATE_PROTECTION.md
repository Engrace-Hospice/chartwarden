# Atomicity and duplicate protection

`postValidatedClaimsInTransaction` extends the existing internal M25 posting port. It accepts an ordered association for each parsed CLP, validates count/scope/evidence and supported financial facts, locks the existing payment identity, then calls the existing `postClaimsInTransaction` once for the full batch. Any mismatch or insertion/outbox failure throws inside the caller's transaction; no partial line or success event commits. Each claim emits its existing paid event and the advice emits one existing advice-posted event.

The Claim.MD execution still locks the staged row and verifies the exact approved plan before creating the advice and invoking M25. The posted audit row retains the migration-required representative line reference; results and history return every line ID in approved plan order. Cross-source duplicate detection remains source/payer/provider/payment scoped and ambiguous identities block.
