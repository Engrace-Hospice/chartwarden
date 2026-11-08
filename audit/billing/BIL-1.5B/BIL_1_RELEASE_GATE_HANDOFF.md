# BIL-1 Release Gate handoff

Keep the linear dependency chain: local `develop` base → BIL-1.3 `feat/bil-1-3-claimmd-ack` → BIL-1.4 `feat/bil-1-4-claimmd-era` → BIL-1.5A/B `feat/bil-1-5a-claimmd-runtime-hardening`. Reconcile Draft PR #974 before #981 and #982; remote PR status was unavailable. The BIL-1.5A branch has cumulative uncommitted work through migrations 1359–1361 and BIL-1.5B corrections. Review the full diff and create scoped commits before opening/updating its dependent PR.

Before any ordered merge: finish the pending private-PG and in-place migration cases, re-run final combined build/test/architecture gates, obtain branch CI and independent code/security review, confirm correct PR bases, and secure explicit merge authorization. Then merge each validated branch in dependency order and verify `develop`. Do not start BIL-2 before that gate.

No branch merge, rebase, force-push, deploy or activation was performed here.
