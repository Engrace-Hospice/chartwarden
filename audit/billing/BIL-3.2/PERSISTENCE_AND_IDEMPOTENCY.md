# Persistence and idempotency

Migration `1394_m25_claimmd_era_match_decisions.sql` adds an additive append-only decision table. Its natural revision key is `(stage_id, transaction_set_control_number, claim_index, decision_version)`. It records tenant/provider/stage, version, confirmed/cleared outcome, optional server-derived claim UUID, source digest, safe evidence labels, reason, actor membership and timestamp.

The migration adds organization RLS with FORCE, an insert check tied to the stage's organization/provider, `chartwarden_app` select/insert grants, a mutation-rejecting trigger, and the separate `remittance.match_review` permission catalog row. It does not copy the legacy `remittance.manual_match` grants to the new permission.

The mutation locks the authorized stage row, uses a transaction-scoped advisory lock for a stage/transaction-set/claim tuple, checks the current source digest/version, and appends a new version. Identical immediate retries by the same actor are returned idempotently; incompatible stale actions conflict. PostgreSQL runtime enforcement has not been executed locally; see [POSTGRESQL_AND_RLS.md](./POSTGRESQL_AND_RLS.md).
