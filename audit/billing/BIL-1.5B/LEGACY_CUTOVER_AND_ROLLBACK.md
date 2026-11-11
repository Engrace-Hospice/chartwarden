# Legacy cutover and rollback plan — not executed

1. Confirm the stack order and CI/reviews; migrate the full schema from the proper predecessor, with special operator-reviewed sequencing for contract migrations 1353 and 1358. Take and verify a backup.
2. Quiesce all legacy M23/M41 Claim.MD response pollers and legacy M25 ERA importer. Confirm no old binary/worker remains; configuration in a new binary cannot fence an older binary.
3. Deploy guarded code with every new Claim.MD worker flag off. Confirm account/environment, role grants, keyring and protected storage. Bootstrap account cursors from a reviewed point without resetting history.
4. Enable response capture alone in a controlled test environment. Inspect cursor, backlog, errors and lease metrics. Enable identity resolution separately, then acknowledgment shadow; compare with legacy results before any apply authorization.
5. Enable ERA discovery/capture separately; verify ownership before protected staging. Keep M25 posting off. Test operator recovery and alert thresholds before broader activation.
6. Stop on cursor stalls, ownership conflicts, abnormal held/duplicate growth, keyring failure, stale leases or unexpected status transition. Disable flags, quiesce workers, retain inbox/evidence/cursors, and reconcile in-doubt events before restart.

Never roll back account cursors or resend uncertain submissions blindly. For contract migrations, prefer a compatible application rollback or forward fix with operator review; the deploy script does not promise automatic schema rollback. No production cutover was performed.
