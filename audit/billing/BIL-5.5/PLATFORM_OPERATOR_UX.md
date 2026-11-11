# Platform operator UX

The existing admin application now exposes `/admin/ops/claimmd-recovery-readiness` to `billing.rule_config.platform_admin`.

It shows central aggregate availability, accepts an exact ERA inbox UUID and processing stage, and supports preflight or nonmutating dry-run. Results distinguish eligibility, completed work, blockers, lease state, attribution, and prior attempts. Copy states that no replay, vendor call, financial mutation, or execution authorization occurred.

There is no recovery execution button.
