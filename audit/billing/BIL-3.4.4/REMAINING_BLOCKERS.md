# Remaining Blockers

- Production controlled posting remains disabled and is prohibited by the runtime configuration guard.
- The implemented route only accepts the narrow M41 commercial case described in `SUPPORTED_POSTING_PATH.md`; Medicare and other financial shapes remain blocked.
- Tenant/provider/payer mapping and historical submission evidence must be correctly populated by their existing source owners. The plan fails closed when the payer route is not a UUID-backed canonical M40 identity or the stage ownership evidence is insufficient.
- No live Claim.MD calls, production migration, or production financial execution occurred.
- M25 commit creates remittance records and outbox events. Downstream claim/CAP consumers are separate transactions; bank settlement and full AR reconciliation are outside this phase.
