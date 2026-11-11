# BIL-4.3 — CAS Responsibility & Controlled Adjustments

## Result

The Claim.MD posting assessment now preserves claim-level CAS group, CARC, signed cent amount, responsibility label and disposition separately. A balanced CO residual is identified as payer-reported provider responsibility but remains blocked with `CONTRACTUAL_ADJUSTMENT_POLICY_UNAVAILABLE`; no write-off policy/version is bound to the plan. PR remains reported only, OA keeps the BIL-4.2 flagged-review behavior, and PI remains blocked.

No new accounting effect, invoice, receivable, policy table, migration, or event was introduced. Existing fully-paid and OA partial paths are unchanged. The broad legacy M25 CO/PI routing remains an existing manual/SFTP behavior and is explicitly not treated as policy authorization for the controlled Claim.MD path.

See [POSTGRESQL_FINANCIAL_TESTS.md](POSTGRESQL_FINANCIAL_TESTS.md) and [REMAINING_BLOCKERS.md](REMAINING_BLOCKERS.md) for verification and scope limits.
