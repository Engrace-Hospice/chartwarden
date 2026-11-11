# Revenue Cycle metric definitions

The read API is `GET /api/v1/remittance/revenue-cycle-summary`.

- **Received advice**: persisted M25 remittance advice with `received_at` in the inclusive requested UTC date window and within authenticated organization/provider scope.
- **Reported advice count**: advice whose parser status indicates complete parsed source facts.
- **Reported ERA payment**: BPR total, preserving that this is an ERA-level amount and can include PLB effects.
- **Reported claim payment**: sum of source CLP paid values from parse-complete advice.
- **Fully posted advice claim payment**: positive CLP04 sum from lines marked `posted` on advice in the fully `posted` state; CLP02 reversal/void status 22 is excluded.
- **M25 posted claim payment**: positive CLP04 sum from lines marked `posted` on advice in `posted` or `partial_posted` state; unmatched lines and CLP02 status 22 are excluded. This captures posted effects inside a partially posted envelope without counting its unresolved claims.
- **Reported adjustments**: CAS amount sums by source group; not accounting authorization.
- **Reported PLB**: source-signed advice-level PLB total, not a claim allocation.
- **Unmatched lines**: persisted M25 lines with no resolved matching state, within the same advice scope.
- **Completeness**: exact for M25 remittance advice under these filters. It is not an exact total for M23/M24/M41 claims, Claim.MD central stages, or all operational workload.
- **A/R**: explicit unavailable response (`NO_CANONICAL_RECEIVABLE_LEDGER`).

All monetary fields use integer cents encoded as strings. Date basis is explicit (`era_received_at_utc`); no submission/service/posting date is substituted.
