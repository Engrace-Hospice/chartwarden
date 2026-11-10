# Non-regression

The BIL-4.2 OA-only partial assessment remains the sole supported partial case and keeps its `flagged_review` disposition and partial-paid event. Fully-paid single- and multi-claim flows are unchanged. The transaction core and downstream consumer contracts are unchanged. No migration, event, ledger table, automatic posting behavior, or Claim.MD worker was added or enabled.

The M25 legacy manual/SFTP CO/PI routing remains unchanged in this phase; it is documented as distinct from the controlled Claim.MD policy gate and should be evaluated under the established legacy financial-policy governance.
