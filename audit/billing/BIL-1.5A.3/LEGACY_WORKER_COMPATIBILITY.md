# Legacy worker compatibility

The M23 provider-scoped legacy Claim.MD acknowledgment poll path now checks both account-wide response capture and the new acknowledgment dispatcher activation state. If either is active, the legacy Claim.MD pull is suppressed. Non-Claim.MD vendor paths, including Stedi, retain their previous behavior.

The M41 legacy `runAckPull` path returns without provider polling when its binding vendor is Claim.MD; it therefore does not compete with the account-scoped dispatcher on that path. M25 legacy Claim.MD ERA polling uses the existing capture/delivery mutual-exclusion guard. These are code-level guards and do not coordinate older binaries that do not contain them.

## Rollout constraint

During a rolling deployment, an old process may still run a legacy poller while a new process starts an account-wide worker. Configuration on the new version cannot fence an old binary that does not understand the shared mode. Before any activation, stop/quiesce old Claim.MD pollers, deploy the guarded version fleet-wide, verify no old workers remain, then enable only the intended pipeline. Keep other clearinghouse integrations unchanged. BIL-1.5B must verify deployment topology and shared lease/rate-limit behavior; no worker is enabled by this phase.
