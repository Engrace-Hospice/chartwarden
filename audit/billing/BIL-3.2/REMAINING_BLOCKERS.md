# Remaining blockers

## Critical for the requested full matching workflow

1. **Candidate discovery/manual exception resolution is incomplete.** Existing claim-reader seams do not expose the immutable historical submission attempt/account/environment tuple needed for safe candidate selection. Add an owner-exported, tenant/provider-scoped historical-attempt reader and use it to enumerate eligible candidates without touching the legacy posting path.
2. **Service-line matching is unavailable.** Staged 835 facts have no verified link to an original submitted claim-line snapshot/reference. Add immutable send-time line identity to the owner contracts and a safe reader before implementing line decisions.
3. **Correction-chain adjudication identity is unresolved.** Do not pick the newest/original claim automatically when attempts or linked corrections make the payer response ambiguous.
4. **Private PostgreSQL/RLS run is pending.** Use the private disposable Postgres image and real application role; do not run the destructive live suite against the current shared local cluster.
5. **Migration numbering gate is already red in the preserved worktree.** Ordinal `1378` is claimed by `1378_fk_supporting_indexes_code_status_emergency_recipient.sql` and `1378_m23_claim_reviewed_source_fingerprint.sql`. The BIL-3.2 migration uses 1394; resolve the inherited collision in the owning BIL-2 delivery before migration certification.

These gaps are intentionally visible in the API/UI. There is no claim candidate override or service-line match masquerading as complete.
